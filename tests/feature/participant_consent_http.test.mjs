import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { participantConsentHttp, participantWithdrawHttp } from "../../app/participant-consent-http.ts";
import { createPendingParticipant, participantPendingCookie, acceptParticipantConsent } from "../../app/participant-consent.ts";
import { getParticipantSession, participantSessionCookie } from "../../app/participant-session.ts";
import { GET as disabledGet, POST as disabledPost } from "../../app/api/participant/consent/route.ts";
import { POST as disabledWithdraw } from "../../app/api/participant/consent/withdraw/route.ts";

const origin = "https://puzzle.example";
const config = { origin };
const now = 1_700_000_000_000;
const person = { sub: "verified-google-sub", email: "p@example.com", name: "Person" };
const header = (cookie) => cookie.split(";")[0];

function database(sqlite, beforeUpdate) {
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() {
        if (beforeUpdate && sql.startsWith("UPDATE participant_consent_state SET status='revoked'")) await beforeUpdate();
        const row = sqlite.prepare(sql).get(...values);
        return row ? { ...row } : null;
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      sql, values,
    };
  }
  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, values }) => {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "participant-http-"));
  const path = join(dir, "local.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  for (const file of readdirSync("drizzle").filter((name) => /^00(?:0[0-9]|10).*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + file, "utf8"));
  }
  sqlite.prepare("INSERT INTO participant_terms VALUES (?,?)").run("v1", "條款 <script>alert(1)</script>\n第二行");
  sqlite.prepare("INSERT INTO participant_terms_current VALUES (1,?)").run("v1");
  return { sqlite, path, db: database(sqlite), close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function request(path, { method = "GET", cookie = "", csrf = origin, body, urlOrigin = origin, type = "application/json" } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET" && csrf !== null) headers.Origin = csrf;
  if (body !== undefined && type !== null) headers["Content-Type"] = type;
  return new Request(urlOrigin + path, { method, headers, ...(body === undefined ? {} : { body }) });
}
const consentReq = (options) => request("/api/participant/consent", options);
const withdrawReq = (options) => request("/api/participant/consent/withdraw", { method: "POST", ...options });
const n = (sqlite, table) => sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
function sessionFrom(response) {
  const item = response.headers.getSetCookie().find((value) => value.startsWith("__Host-puzzle-participant="));
  assert.ok(item);
  assert.match(item, /; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  return header(item);
}

test("public APIs are hard disabled with no cookies", async () => {
  for (const handler of [disabledGet, disabledPost, disabledWithdraw]) {
    const result = await handler();
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("set-cookie"), null);
  }
});

test("GET provides only current plain terms for valid pending token", async () => {
  const f = fixture();
  try {
    const pending = await createPendingParticipant(f.db, person, now);
    const cookie = header(participantPendingCookie(pending.token));
    const response = await participantConsentHttp(consentReq({ cookie }), f.db, config, now);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { version: "v1", content: "條款 <script>alert(1)</script>\n第二行" });
    assert.equal((await participantConsentHttp(consentReq(), f.db, config, now)).status, 409);
    assert.equal((await participantConsentHttp(consentReq({ cookie: cookie + "; " + cookie }), f.db, config, now)).status, 409);
    assert.equal((await participantConsentHttp(consentReq({ cookie }), f.db, config, now + 600_000)).status, 409);
  } finally { f.close(); }
});

test("GET to POST version change is rejected atomically without account or session", async () => {
  const f = fixture();
  try {
    const pending = await createPendingParticipant(f.db, person, now);
    const cookie = header(participantPendingCookie(pending.token));
    const shown = await (await participantConsentHttp(consentReq({ cookie }), f.db, config, now)).json();
    f.sqlite.prepare("INSERT INTO participant_terms VALUES (?,?)").run("v2", "Updated terms");
    f.sqlite.prepare("UPDATE participant_terms_current SET version='v2' WHERE id=1").run();
    const result = await participantConsentHttp(consentReq({ method: "POST", cookie, body: JSON.stringify({ version: shown.version, checked: true }) }), f.db, config, now + 1);
    assert.equal(result.status, 409);
    assert.equal(n(f.sqlite, "participants"), 0);
    assert.equal(n(f.sqlite, "participant_consents"), 0);
    assert.equal(n(f.sqlite, "participant_sessions"), 0);
    assert.equal(n(f.sqlite, "participant_pending_identities"), 1);
  } finally { f.close(); }
});

test("POST rejects forged identity, bad methods, origins and malformed bodies", async (t) => {
  const f = fixture();
  try {
    const pending = await createPendingParticipant(f.db, person, now);
    const cookie = header(participantPendingCookie(pending.token));
    const cases = [
      ["cross origin", { method: "POST", cookie, csrf: "https://evil.example", body: JSON.stringify({ checked: true, version: "v1" }) }, 403],
      ["missing origin", { method: "POST", cookie, csrf: null, body: JSON.stringify({ checked: true, version: "v1" }) }, 403],
      ["wrong url origin", { method: "POST", cookie, urlOrigin: "https://evil.example", body: JSON.stringify({ checked: true, version: "v1" }) }, 403],
      ["wrong method", { method: "DELETE", cookie }, 405],
      ["wrong content type", { method: "POST", cookie, type: "text/plain", body: "{}" }, 400],
      ["wrong json", { method: "POST", cookie, body: "{" }, 400],
      ["large body", { method: "POST", cookie, body: "x".repeat(4097) }, 400],
      ["unchecked", { method: "POST", cookie, body: JSON.stringify({ checked: false, version: "v1" }) }, 400],
      ["forged id", { method: "POST", cookie, body: JSON.stringify({ checked: true, version: "v1", participantId: "victim" }) }, 400],
      ["forged sub", { method: "POST", cookie, body: JSON.stringify({ checked: true, version: "v1", sub: "victim" }) }, 400],
      ["wrong version", { method: "POST", cookie, body: JSON.stringify({ checked: true, version: "v2" }) }, 409],
    ];
    for (const [name, opts, status] of cases) {
      await t.test(name, async () => {
        const response = await participantConsentHttp(consentReq(opts), f.db, config, now);
        assert.equal(response.status, status);
        assert.equal(response.headers.get("set-cookie"), null);
      });
    }
    assert.equal(n(f.sqlite, "participants"), 0);
    assert.equal(n(f.sqlite, "participant_sessions"), 0);
    assert.equal(n(f.sqlite, "participant_pending_identities"), 1);
    assert.equal(f.sqlite.prepare("SELECT claim FROM participant_pending_identities").get().claim, null);
  } finally { f.close(); }
});

test("successful consent binds displayed version, returns session and rejects replay", async () => {
  const f = fixture();
  try {
    const pending = await createPendingParticipant(f.db, person, now);
    const cookie = header(participantPendingCookie(pending.token));
    const result = await participantConsentHttp(consentReq({ method: "POST", cookie, body: JSON.stringify({ checked: true, version: "v1" }) }), f.db, config, now + 1);
    assert.equal(result.status, 200);
    const session = sessionFrom(result);
    assert.ok(result.headers.getSetCookie().some((value) => value.startsWith("__Host-puzzle-participant-pending=;") && value.includes("Max-Age=0")));
    assert.ok(await getParticipantSession(f.db, session, now + 2));
    assert.equal(n(f.sqlite, "participant_pending_identities"), 0);
    assert.equal(n(f.sqlite, "participant_consents"), 1);
    const replay = await participantConsentHttp(consentReq({ method: "POST", cookie, body: JSON.stringify({ checked: true, version: "v1" }) }), f.db, config, now + 3);
    assert.equal(replay.status, 409);
    assert.equal(n(f.sqlite, "participant_consents"), 1);
  } finally { f.close(); }
});

test("stale session cannot revoke consent freshly accepted on second connection", async () => {
  const f = fixture();
  const second = new DatabaseSync(f.path);
  second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  try {
    const p1 = await createPendingParticipant(f.db, person, now);
    const old = await acceptParticipantConsent(f.db, p1.token, true, "v1", now + 1);
    const p2 = await createPendingParticipant(f.db, person, now + 2);
    let fresh;
    const racedDb = database(f.sqlite, async () => {
      fresh = await acceptParticipantConsent(database(second), p2.token, true, "v1", now + 3);
    });
    const result = await participantWithdrawHttp(withdrawReq({ cookie: header(participantSessionCookie(old)) }), racedDb, config, now + 4);
    assert.equal(result.status, 401);
    assert.ok(await getParticipantSession(f.db, header(participantSessionCookie(fresh)), now + 5));
    assert.equal(f.sqlite.prepare("SELECT status FROM participant_consent_state").get().status, "active");
  } finally { second.close(); f.close(); }
});

test("withdraw checks current session atomically, deletes only own sessions and pending and retains records", async () => {
  const f = fixture();
  try {
    const p1 = await createPendingParticipant(f.db, person, now);
    const s1 = await acceptParticipantConsent(f.db, p1.token, true, "v1", now + 1);
    const p2 = await createPendingParticipant(f.db, { sub: "other-sub", email: "other@example.com" }, now + 2);
    const s2 = await acceptParticipantConsent(f.db, p2.token, true, "v1", now + 3);
    await createPendingParticipant(f.db, person, now + 4);
    await createPendingParticipant(f.db, { sub: "other-sub", email: "other@example.com" }, now + 4);
    const cookie = header(participantSessionCookie(s1));
    assert.equal((await participantWithdrawHttp(withdrawReq({ cookie, csrf: "https://evil.example" }), f.db, config, now + 5)).status, 403);
    assert.equal((await participantWithdrawHttp(withdrawReq({ cookie, body: JSON.stringify({ participantId: "victim" }) }), f.db, config, now + 5)).status, 400);
    const result = await participantWithdrawHttp(withdrawReq({ cookie }), f.db, config, now + 5);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.ok(result.headers.getSetCookie().some((value) => value.startsWith("__Host-puzzle-participant=;") && value.includes("Max-Age=0")));
    assert.equal(await getParticipantSession(f.db, cookie, now + 6), null);
    assert.ok(await getParticipantSession(f.db, header(participantSessionCookie(s2)), now + 6));
    assert.equal(n(f.sqlite, "participants"), 2);
    assert.equal(n(f.sqlite, "participant_consents"), 2);
    assert.equal(n(f.sqlite, "participant_pending_identities"), 1);
    assert.equal(f.sqlite.prepare("SELECT google_sub FROM participant_pending_identities").get().google_sub, "other-sub");
    assert.equal((await participantWithdrawHttp(withdrawReq({ cookie }), f.db, config, now + 6)).status, 401);
  } finally { f.close(); }
});

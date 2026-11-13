import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { participantRegistrationHttp } from "../../app/participant-registration-http.ts";
import { POST as disabledRegistration } from "../../app/api/participant/registrations/route.ts";
import { POST as disabledQr } from "../../app/api/participant/qr/route.ts";
import { POST as disabledRevoke } from "../../app/api/participant/qr/revoke/route.ts";
import { POST as disabledPrefill } from "../../app/api/participant/prefill/route.ts";
import { POST as disabledMine } from "../../app/api/participant/registrations/mine/route.ts";

const origin = "https://puzzle.example";
const config = { origin };
const slug = "a".repeat(32);
const memberToken = "a".repeat(64);
const participantToken = "c".repeat(64);
const memberCookie = "puzzle_admin_session=" + memberToken;
const participantCookie = "__Host-puzzle-participant=" + participantToken;
const bothCookies = memberCookie + "; " + participantCookie;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const paths = { registration: "/api/participant/registrations", "qr-issue": "/api/participant/qr", "qr-revoke": "/api/participant/qr/revoke", prefill: "/api/participant/prefill", mine: "/api/participant/registrations/mine" };
const formBody = (key = "same-key", value = "John") => ({ slug, answers: { name: value }, consent: true, idempotencyKey: key, formVersion: 1 });

function database(sqlite) {
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
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
  const dir = mkdtempSync(join(tmpdir(), "participant-registration-http-"));
  const path = join(dir, "local.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  for (const migration of readdirSync("drizzle").filter((name) => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + migration, "utf8"));
  }
  sqlite.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) VALUES ('m1','member1','same@example.com','Member','member','active','2026')").run();
  sqlite.prepare("INSERT INTO participants VALUES ('p1','sub1','same@example.com','Participant','2026')").run();
  sqlite.prepare("INSERT INTO participant_terms VALUES ('v1','Terms')").run();
  sqlite.prepare("INSERT INTO participant_terms_current VALUES (1,'v1')").run();
  sqlite.prepare("INSERT INTO participant_consent_state VALUES ('p1','active',1,'v1')").run();
  const expires = Date.now() + 3_600_000;
  sqlite.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(hash(memberToken), "m1", expires);
  sqlite.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) VALUES (?,?,?,1)").run(hash(participantToken), "p1", expires);
  const schema = { id: "form1", activityId: "activity1", title: "Activity", description: "", status: "open", fields: [{ id: "name", label: "Name", type: "short_text", required: true, profileKey: "displayName", sensitive: true }], privacyNotice: "Notice" };
  sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("form1", "activity1", slug, "Activity", "", "open", JSON.stringify(schema), "Notice", 1, "admin-kao19950411", "2026", "2026");
  sqlite.prepare("INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES ('legacy','form1',1,'[]','{}',1,'legacy-key','legacy','2026')").run();
  return { sqlite, db: database(sqlite), close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function req(operation, body, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (!Object.hasOwn(options, "identity") || options.identity !== null) headers["X-Participant-Identity"] = options.identity ?? "member";
  if (!Object.hasOwn(options, "csrf") || options.csrf !== null) headers.Origin = options.csrf ?? origin;
  if (!Object.hasOwn(options, "cookie") || options.cookie !== null) headers.Cookie = options.cookie ?? bothCookies;
  return new Request((options.requestOrigin ?? origin) + (options.path ?? paths[operation]), {
    method: options.method ?? "POST", headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const call = (f, op, payload, options = {}, cfg = config) =>
  participantRegistrationHttp(req(op, payload, options), f.db, cfg, op);
const number = (sqlite, table) => sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
function secureHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("location"), null);
}

test("external POST routes fail closed when the Workers environment is unavailable", async () => {
  for (const handler of [disabledRegistration, disabledQr, disabledRevoke, disabledPrefill, disabledMine]) {
    const response = await handler();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("location"), null);
  }
});

test("mine endpoint only returns chosen identity records and rejects forged bodies", async () => {
  const f = fixture();
  try {
    for (const [body, options, status] of [
      [{ cursor: null, memberId: "m1" }, {}, 400], [{}, {}, 400], [{ cursor: {} }, {}, 400],
      [{ cursor: null }, { identity: null }, 400], [{ cursor: null }, { csrf: "https://evil.example" }, 403],
      ["x".repeat(4097), {}, 400],
    ]) assert.equal((await call(f, "mine", body, options)).status, status);
    const member = await (await call(f, "registration", formBody("member"))).json();
    const participant = await (await call(f, "registration", formBody("participant"), { identity: "participant" })).json();
    for (const [identity, receipt] of [["member", member.receiptId], ["participant", participant.receiptId]]) {
      const response = await call(f, "mine", { cursor: null }, { identity });
      assert.equal(response.status, 200); secureHeaders(response);
      const data = await response.json();
      assert.deepEqual(data.registrations.map(row => row.submissionId), [receipt]);
      assert.equal(data.nextCursor, null);
      assert.ok(!JSON.stringify(data).includes("same@example.com"));
      assert.ok(!JSON.stringify(data).includes("John"));
    }
    assert.equal((await call(f, "mine", { cursor: null }, { cookie: null })).status, 401);
    f.sqlite.exec("UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'");
    assert.equal((await call(f, "mine", { cursor: null }, { identity: "participant" })).status, 401);
    assert.equal(f.sqlite.prepare("SELECT answers_json FROM registration_submissions WHERE id='legacy'").get().answers_json, "{}");
  } finally { f.close(); }
});

test("mine uses its own rate limit and never accepts a spoofed source by default", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await call(f, "mine", { cursor: null }, { headers: { "cf-connecting-ip": `192.0.2.${i}` } })).status, 200);
    assert.equal((await call(f, "mine", { cursor: null })).status, 429);
    assert.equal((await call(f, "registration", formBody())).status, 201);
    assert.equal(number(f.sqlite, "auth_attempts"), 2);
  } finally { f.close(); }
});

test("prefill returns only the explicitly selected account's mapped fields", async () => {
  const f = fixture();
  try {
    for (const [identity, expected] of [["member", "Member"], ["participant", "Participant"]]) {
      const response = await call(f, "prefill", { slug }, { identity });
      assert.equal(response.status, 200);
      secureHeaders(response);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.deepEqual(await response.json(), { formVersion: 1, values: { name: expected } });
    }
    for (const options of [{ cookie: null }, { identity: "participant", cookie: memberCookie }, { identity: "member", cookie: participantCookie }]) {
      const response = await call(f, "prefill", { slug }, options);
      assert.equal(response.status, 404);
      secureHeaders(response);
      assert.deepEqual(await response.json(), { error: "目前無法完成操作" });
    }
    f.sqlite.prepare("UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'").run();
    assert.equal((await call(f, "prefill", { slug }, { identity: "participant" })).status, 404);
    f.sqlite.prepare("UPDATE registration_forms SET status='closed' WHERE id='form1'").run();
    assert.equal((await call(f, "prefill", { slug })).status, 404);
  } finally { f.close(); }
});

test("prefill rejects forged identity, malformed requests and untrusted origins before rate or data writes", async () => {
  const f = fixture();
  try {
    const cases = [
      [{ slug, memberId: "m1" }, {}, 400],
      [{ slug, participantId: "p1" }, {}, 400],
      [{ slug, email: "same@example.com" }, {}, 400],
      [{ slug: "not-a-slug" }, {}, 400],
      [{ slug }, { identity: null }, 400],
      [{ slug }, { identity: "member, participant" }, 400],
      [{ slug }, { csrf: null }, 403],
      [{ slug }, { csrf: "https://evil.example" }, 403],
      [{ slug }, { requestOrigin: "https://evil.example" }, 403],
      [{ slug }, { path: paths.prefill + "?id=m1" }, 403],
      [{ slug }, { headers: { "Content-Type": "text/plain" } }, 400],
      ["{", {}, 400],
      ["x".repeat(4097), { headers: { "Content-Length": "1" } }, 400],
    ];
    for (const [body, options, status] of cases) {
      const response = await call(f, "prefill", body, options);
      assert.equal(response.status, status);
      secureHeaders(response);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    const request = new Request(origin + paths.prefill, { method: "GET", headers: { Origin: origin } });
    assert.equal((await participantRegistrationHttp(request, f.db, config, "prefill")).status, 405);
    assert.equal((await participantRegistrationHttp(req("prefill", { slug }), null, config, "prefill")).status, 503);
    assert.equal((await call(f, "prefill", { slug }, {}, { origin: "http://puzzle.example" })).status, 503);
    assert.equal(number(f.sqlite, "auth_attempts"), 0);
    assert.equal(number(f.sqlite, "registration_identities"), 0);
  } finally { f.close(); }
});

test("prefill limits streams and uses an independent shared rate bucket", async () => {
  const f = fixture();
  try {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(4097))); controller.close(); } });
    const request = new Request(origin + paths.prefill, { method: "POST", headers: { Origin: origin, Cookie: bothCookies, "Content-Type": "application/json", "X-Participant-Identity": "member" }, body: stream, duplex: "half" });
    assert.equal((await participantRegistrationHttp(request, f.db, config, "prefill")).status, 400);
    for (let i = 0; i < 30; i++) {
      assert.equal((await call(f, "prefill", { slug }, { headers: { "cf-connecting-ip": `192.0.2.${i}` } })).status, 200);
    }
    const limited = await call(f, "prefill", { slug });
    assert.equal(limited.status, 429);
    secureHeaders(limited);
    assert.equal((await call(f, "registration", formBody())).status, 201);
    assert.equal(number(f.sqlite, "auth_attempts"), 2);
  } finally { f.close(); }
});

test("same-origin, server origin, identity selection, body bounds and exact keys fail before writes", async (t) => {
  const f = fixture();
  try {
    const cases = [
      ["missing identity", formBody(), { identity: null }, config, 400],
      ["ambiguous identity", formBody(), { identity: "member, participant" }, config, 400],
      ["cross-site", formBody(), { csrf: "https://evil.example" }, config, 403],
      ["missing origin", formBody(), { csrf: null }, config, 403],
      ["wrong request origin", formBody(), { requestOrigin: "https://evil.example" }, config, 403],
      ["query rejected", formBody(), { path: paths.registration + "?id=attacker" }, config, 403],
      ["untrusted HTTP config", formBody(), {}, { origin: "http://puzzle.example" }, 503],
      ["bad trust config", formBody(), {}, { origin, trustedCloudflareEdge: "yes" }, 503],
      ["wrong type", formBody(), { headers: { "Content-Type": "text/plain" } }, config, 400],
      ["malformed JSON", "{", {}, config, 400],
      ["forged member id", { ...formBody(), memberId: "someone" }, {}, config, 400],
      ["forged participant id", { ...formBody(), participantId: "someone" }, {}, config, 400],
      ["invalid slug", { ...formBody(), slug: "evil" }, {}, config, 400],
      ["lying small content-length", "x".repeat(60_001), { headers: { "Content-Length": "1" } }, config, 400],
      ["declared large content-length", formBody(), { headers: { "Content-Length": "60001" } }, config, 400],
    ];
    for (const [name, payload, options, cfg, status] of cases) {
      await t.test(name, async () => {
        const response = await call(f, "registration", payload, options, cfg);
        assert.equal(response.status, status);
        secureHeaders(response);
        assert.equal(response.headers.get("set-cookie"), null);
      });
    }
    assert.equal(number(f.sqlite, "auth_attempts"), 0);
    assert.equal(number(f.sqlite, "registration_identities"), 0);
    const method = new Request(origin + paths.registration, { method: "GET", headers: { Origin: origin } });
    assert.equal((await participantRegistrationHttp(method, f.db, config, "registration")).status, 405);
    assert.equal(number(f.sqlite, "auth_attempts"), 0);
    assert.equal((await participantRegistrationHttp(req("registration", formBody()), null, config, "registration")).status, 503);
  } finally { f.close(); }
});

test("stream without content-length is bounded independently of headers", async () => {
  const f = fixture();
  try {
    let emitted = false;
    const stream = new ReadableStream({ pull(controller) { if (!emitted) { emitted = true; controller.enqueue(new TextEncoder().encode("x".repeat(60_001))); } else controller.close(); } });
    const request = new Request(origin + paths.registration, {
      method: "POST", headers: { Origin: origin, Cookie: bothCookies, "Content-Type": "application/json", "X-Participant-Identity": "member" }, body: stream, duplex: "half",
    });
    const response = await participantRegistrationHttp(request, f.db, config, "registration");
    assert.equal(response.status, 400);
    assert.equal(number(f.sqlite, "auth_attempts"), 0);
  } finally { f.close(); }
});

test("member/participant select their own session, replay is owner-scoped, and QR operations do not expose other owner", async () => {
  const f = fixture();
  try {
    const memberResult = await call(f, "registration", formBody(), { identity: "member" });
    secureHeaders(memberResult);
    assert.equal(memberResult.status, 201);
    const member = await memberResult.json();
    const participantResult = await call(f, "registration", formBody(), { identity: "participant" });
    assert.equal(participantResult.status, 201);
    const participant = await participantResult.json();
    assert.notEqual(participant.receiptId, member.receiptId);
    const retry = await call(f, "registration", formBody(), { identity: "member" });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), member);
    assert.equal((await call(f, "registration", formBody("same-key", "Changed"), { identity: "member" })).status, 409);
    assert.equal((await call(f, "registration", formBody(), { identity: "participant", cookie: memberCookie })).status, 401);
    assert.equal((await call(f, "qr-issue", { submissionId: member.receiptId }, { identity: "participant" })).status, 404);
    const oneResponse = await call(f, "qr-issue", { submissionId: member.receiptId }, { identity: "member" });
    secureHeaders(oneResponse);
    assert.equal(oneResponse.status, 201);
    const one = (await oneResponse.json()).token;
    for (const [, value] of oneResponse.headers) assert.ok(!value.includes(one));
    const two = (await (await call(f, "qr-issue", { submissionId: member.receiptId }, { identity: "member" })).json()).token;
    assert.match(one, /^[a-f0-9]{64}$/);
    assert.notEqual(one, two);
    assert.equal((await call(f, "qr-revoke", { token: one }, { identity: "participant" })).status, 404);
    const revoked = await call(f, "qr-revoke", { token: one }, { identity: "member" });
    assert.equal(revoked.status, 200);
    secureHeaders(revoked);
    assert.ok(!(await revoked.text()).includes(one));
    const retryRevoke = await call(f, "qr-revoke", { token: one }, { identity: "member" });
    assert.equal(retryRevoke.status, 404);
    assert.ok(!(await retryRevoke.text()).includes(one));
    assert.ok(f.sqlite.prepare("SELECT revoked_at FROM registration_qr_tokens WHERE token_hash=?").get(hash(one)).revoked_at);
    assert.equal(f.sqlite.prepare("SELECT revoked_at FROM registration_qr_tokens WHERE token_hash=?").get(hash(two)).revoked_at, null);
    assert.equal(f.sqlite.prepare("SELECT answers_json FROM registration_submissions WHERE id='legacy'").get().answers_json, "{}");
  } finally { f.close(); }
});

test("QR payload rejects extra identity and token parameters outside their intended operation", async () => {
  const f = fixture();
  try {
    for (const [operation, payload] of [
      ["qr-issue", { submissionId: "id", memberId: "m1" }],
      ["qr-issue", { submissionId: "id", token: "a".repeat(64) }],
      ["qr-revoke", { token: "a".repeat(64), participantId: "p1" }],
      ["qr-revoke", { token: "a".repeat(64) + "\n" }],
    ]) assert.equal((await call(f, operation, payload)).status, 400);
    assert.equal(number(f.sqlite, "auth_attempts"), 0);
    assert.equal(number(f.sqlite, "registration_qr_tokens"), 0);
  } finally { f.close(); }
});

test("default untrusted edge uses one shared bucket even when header is spoofed", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 30; index++) {
      const result = await call(f, "registration", formBody(), { headers: { "cf-connecting-ip": "192.0.2." + index } });
      assert.ok(result.status === 201 || result.status === 200);
    }
    const blocked = await call(f, "registration", formBody(), { headers: { "cf-connecting-ip": "198.51.100.99" } });
    assert.equal(blocked.status, 429);
    secureHeaders(blocked);
    assert.equal(number(f.sqlite, "auth_attempts"), 1);
    assert.equal(number(f.sqlite, "registration_identities"), 1);
    const receiptId = f.sqlite.prepare("SELECT submission_id FROM registration_identities").get().submission_id;
    assert.equal((await call(f, "qr-issue", { submissionId: receiptId })).status, 201);
  } finally { f.close(); }
});

test("trusted Cloudflare edge addresses have distinct rate buckets", async () => {
  const f = fixture();
  try {
    const trusted = { origin, trustedCloudflareEdge: true };
    for (let index = 0; index < 30; index++) {
      assert.ok([200, 201].includes((await call(f, "registration", formBody(), { headers: { "cf-connecting-ip": "203.0.113.1" } }, trusted)).status));
    }
    assert.equal((await call(f, "registration", formBody(), { headers: { "cf-connecting-ip": "203.0.113.1" } }, trusted)).status, 429);
    assert.equal((await call(f, "registration", formBody(), { headers: { "cf-connecting-ip": "203.0.113.2" } }, trusted)).status, 200);
    assert.equal(number(f.sqlite, "auth_attempts"), 2);
  } finally { f.close(); }
});

test("cleanup removes at most 100 expired keys from this operation and leaves other keys untouched", async () => {
  const f = fixture();
  try {
    const insert = f.sqlite.prepare("INSERT INTO auth_attempts (key,attempts,window_start) VALUES (?,1,1)");
    for (let i = 0; i < 105; i++) insert.run("participant-registration-http:" + String(i).padStart(64, "0"));
    insert.run("participant-qr-issue-http:" + "0".repeat(64));
    insert.run("admin-auth-key");
    assert.equal((await call(f, "registration", formBody())).status, 201);
    const oldRegistration = f.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key LIKE 'participant-registration-http:%' AND window_start=1").get().n;
    assert.equal(oldRegistration, 5);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key='admin-auth-key'").get().n, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key LIKE 'participant-qr-issue-http:%'").get().n, 1);
  } finally { f.close(); }
});

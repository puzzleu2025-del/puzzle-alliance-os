import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  getPublishedParticipantTerms, createPendingParticipant,
  acceptParticipantConsent, revokeParticipantConsent,
} from "../../app/participant-consent.ts";
import {
  createParticipantSession, getParticipantSession, participantSessionCookie,
} from "../../app/participant-session.ts";

const now = 1_700_000_000_000;
const google = { sub: "verified-sub", email: "user@example.com", name: "User" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cookieHeader = (token) => participantSessionCookie(token).split(";")[0];

function makeDatabase(sqlite) {
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() {
        const row = sqlite.prepare(sql).get(...values);
        return row ? { ...row } : null;
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      sql,
      values,
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
  const dir = mkdtempSync(join(tmpdir(), "participant-consent-"));
  const path = join(dir, "test.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  for (const migration of readdirSync("drizzle").filter((name) => /^00(?:0[0-9]|10).*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + migration, "utf8"));
  }
  return {
    sqlite, path, db: makeDatabase(sqlite),
    close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function publish(sqlite, version = "v1", content = "Published terms one") {
  sqlite.prepare("INSERT INTO participant_terms (version,content) VALUES (?,?)").run(version, content);
  sqlite.prepare("INSERT INTO participant_terms_current (id,version) VALUES (1,?)").run(version);
}
function counts(sqlite) {
  return Object.fromEntries([
    "participants", "participant_consents", "participant_consent_state",
    "participant_sessions", "participant_pending_identities",
  ].map((table) => [table, sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get().n]));
}

test("no current terms means pending and session creation fail closed", async () => {
  const f = fixture();
  try {
    assert.equal(await getPublishedParticipantTerms(f.db), null);
    assert.equal(await createPendingParticipant(f.db, google, now), null);
    f.sqlite.prepare("INSERT INTO participants VALUES (?,?,?,?,?)").run("existing", google.sub, google.email, google.name, "2026-11-07");
    await assert.rejects(createParticipantSession(f.db, "existing", now), { message: "PARTICIPANT_SESSION_CREATE_FAILED" });
    assert.equal(counts(f.sqlite).participant_pending_identities, 0);
    assert.equal(counts(f.sqlite).participant_sessions, 0);
  } finally { f.close(); }
});

test("published terms are immutable including REPLACE and current pointer cannot be reset", async () => {
  const f = fixture();
  try {
    publish(f.sqlite);
    assert.deepEqual(await getPublishedParticipantTerms(f.db), { version: "v1", content: "Published terms one" });
    for (const sql of [
      "UPDATE participant_terms SET content='changed' WHERE version='v1'",
      "DELETE FROM participant_terms WHERE version='v1'",
      "INSERT OR REPLACE INTO participant_terms VALUES ('v1','changed')",
      "DELETE FROM participant_terms_current WHERE id=1",
      "INSERT OR REPLACE INTO participant_terms_current VALUES (1,'v1')",
    ]) assert.throws(() => f.sqlite.exec(sql));
    assert.deepEqual(await getPublishedParticipantTerms(f.db), { version: "v1", content: "Published terms one" });
  } finally { f.close(); }
});

test("unchecked, malformed, expired, wrong token and changed version leave no mutations", async () => {
  const f = fixture();
  try {
    publish(f.sqlite);
    const pending = await createPendingParticipant(f.db, google, now);
    assert.deepEqual(pending.terms, { version: "v1", content: "Published terms one" });
    assert.equal(f.sqlite.prepare("SELECT token_hash FROM participant_pending_identities").get().token_hash, hash(pending.token));
    const before = counts(f.sqlite);
    assert.equal(await acceptParticipantConsent(f.db, pending.token, false, "v1", now), null);
    assert.equal(await acceptParticipantConsent(f.db, "garbage", true, "v1", now), null);
    assert.equal(await acceptParticipantConsent(f.db, "b".repeat(64), true, "v1", now), null);
    assert.equal(await acceptParticipantConsent(f.db, pending.token, true, "v1", now + 600_000), null);
    assert.deepEqual(counts(f.sqlite), before);
    f.sqlite.prepare("INSERT INTO participant_terms VALUES (?,?)").run("v2", "Published terms two");
    f.sqlite.prepare("UPDATE participant_terms_current SET version=? WHERE id=1").run("v2");
    assert.equal(await acceptParticipantConsent(f.db, pending.token, true, "v1", now + 1), null);
    assert.deepEqual(counts(f.sqlite), before);
    assert.equal(f.sqlite.prepare("SELECT claim FROM participant_pending_identities").get().claim, null);
  } finally { f.close(); }
});

test("acceptance is atomic, only one of two connections can claim, replay has no effect", async () => {
  const f = fixture();
  const second = new DatabaseSync(f.path);
  second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  try {
    publish(f.sqlite);
    const pending = await createPendingParticipant(f.db, google, now);
    const [a, b] = await Promise.all([
      acceptParticipantConsent(f.db, pending.token, true, "v1", now + 1),
      acceptParticipantConsent(makeDatabase(second), pending.token, true, "v1", now + 1),
    ]);
    const tokens = [a, b].filter(Boolean);
    assert.equal(tokens.length, 1);
    assert.equal((await getParticipantSession(f.db, cookieHeader(tokens[0]), now + 2)).participantId.length > 0, true);
    assert.deepEqual(counts(f.sqlite), { participants: 1, participant_consents: 1, participant_consent_state: 1, participant_sessions: 1, participant_pending_identities: 0 });
    assert.equal(await acceptParticipantConsent(f.db, pending.token, true, "v1", now + 2), null);
    assert.equal(f.sqlite.prepare("SELECT version FROM participant_consents").get().version, "v1");
  } finally { second.close(); f.close(); }
});

test("SQL failure and ignored session write rollback all writes and release claim", async () => {
  const f = fixture();
  try {
    publish(f.sqlite);
    const pending = await createPendingParticipant(f.db, google, now);
    const before = counts(f.sqlite);
    f.sqlite.exec("CREATE TRIGGER fail_participant_session BEFORE INSERT ON participant_sessions BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(acceptParticipantConsent(f.db, pending.token, true, "v1", now + 1));
    assert.deepEqual(counts(f.sqlite), before);
    assert.equal(f.sqlite.prepare("SELECT claim FROM participant_pending_identities").get().claim, null);
    f.sqlite.exec("DROP TRIGGER fail_participant_session");
    assert.ok(await acceptParticipantConsent(f.db, pending.token, true, "v1", now + 2));
  } finally { f.close(); }
});

test("revoke invalidates sessions and pending while retaining participant and consent records", async () => {
  const f = fixture();
  try {
    publish(f.sqlite);
    const pending = await createPendingParticipant(f.db, google, now);
    const session = await acceptParticipantConsent(f.db, pending.token, true, "v1", now + 1);
    const participantId = (await getParticipantSession(f.db, cookieHeader(session), now + 2)).participantId;
    const extra = await createParticipantSession(f.db, participantId, now + 2);
    await createPendingParticipant(f.db, google, now + 2);
    const epoch = f.sqlite.prepare("SELECT epoch FROM participant_consent_state").get().epoch;
    assert.equal(await revokeParticipantConsent(f.db, cookieHeader(session), now + 3), true);
    assert.equal(await getParticipantSession(f.db, cookieHeader(session), now + 3), null);
    assert.equal(await getParticipantSession(f.db, cookieHeader(extra), now + 3), null);
    await assert.rejects(createParticipantSession(f.db, participantId, now + 3), { message: "PARTICIPANT_SESSION_CREATE_FAILED" });
    assert.deepEqual(counts(f.sqlite), { participants: 1, participant_consents: 1, participant_consent_state: 1, participant_sessions: 0, participant_pending_identities: 0 });
    const state = f.sqlite.prepare("SELECT status,epoch FROM participant_consent_state").get();
    assert.equal(state.status, "revoked");
    assert.equal(state.epoch, epoch + 1);
  } finally { f.close(); }
});

test("fresh verified consent on an existing identity advances epoch and invalidates old sessions", async () => {
  const f = fixture();
  try {
    publish(f.sqlite);
    const first = await createPendingParticipant(f.db, google, now);
    const oldSession = await acceptParticipantConsent(f.db, first.token, true, "v1", now + 1);
    const existingId = (await getParticipantSession(f.db, cookieHeader(oldSession), now + 2)).participantId;
    const previousEpoch = f.sqlite.prepare("SELECT epoch FROM participant_consent_state").get().epoch;
    const second = await createPendingParticipant(f.db, { ...google, name: "Updated" }, now + 2);
    const newSession = await acceptParticipantConsent(f.db, second.token, true, "v1", now + 3);
    assert.equal(await getParticipantSession(f.db, cookieHeader(oldSession), now + 4), null);
    assert.equal((await getParticipantSession(f.db, cookieHeader(newSession), now + 4)).participantId, existingId);
    assert.equal(f.sqlite.prepare("SELECT epoch FROM participant_consent_state").get().epoch, previousEpoch + 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM participant_consents").get().n, 2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 1);
  } finally { f.close(); }
});

test("legacy null-epoch sessions stay invalid and published terms changes cannot revive old sessions", async () => {
  const f = fixture();
  try {
    publish(f.sqlite);
    f.sqlite.prepare("INSERT INTO participants VALUES (?,?,?,?,?)").run("legacy", "legacy-sub", "legacy@example.com", "Legacy", "2026-11-07");
    const legacyToken = "a".repeat(64);
    f.sqlite.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at) VALUES (?,?,?)").run(hash(legacyToken), "legacy", now + 60_000);
    f.sqlite.prepare("INSERT INTO participant_consent_state VALUES (?,?,?,?)").run("legacy", "active", 1, "v1");
    assert.equal(await getParticipantSession(f.db, cookieHeader(legacyToken), now), null);
    const token = await createParticipantSession(f.db, "legacy", now);
    assert.ok(await getParticipantSession(f.db, cookieHeader(token), now));
    f.sqlite.prepare("INSERT INTO participant_terms VALUES (?,?)").run("v2", "Terms two");
    f.sqlite.prepare("UPDATE participant_terms_current SET version='v2' WHERE id=1").run();
    assert.equal(await getParticipantSession(f.db, cookieHeader(token), now), null);
    f.sqlite.prepare("UPDATE participant_terms_current SET version='v1' WHERE id=1").run();
    assert.equal(await getParticipantSession(f.db, cookieHeader(token), now), null);
    assert.equal(f.sqlite.prepare("SELECT status FROM participant_consent_state WHERE participant_id='legacy'").get().status, "revoked");
  } finally { f.close(); }
});

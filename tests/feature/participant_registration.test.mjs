import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { submitParticipantRegistration } from "../../app/participant-registration.ts";

const slug = "a".repeat(32);
const memberToken = "a".repeat(64);
const memberToken2 = "b".repeat(64);
const participantToken = "c".repeat(64);
const otherParticipantToken = "d".repeat(64);
const memberCookie = "puzzle_admin_session=" + memberToken;
const memberCookie2 = "puzzle_admin_session=" + memberToken2;
const participantCookie = "__Host-puzzle-participant=" + participantToken;
const otherParticipantCookie = "__Host-puzzle-participant=" + otherParticipantToken;
const body = (key = "idempotency-1", answer = "John") => ({
  answers: { name: answer }, consent: true, idempotencyKey: key, formVersion: 1,
});
const hash = (value) => createHash("sha256").update(value).digest("hex");

function database(sqlite, beforeBatch) {
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
      sql, values,
    };
  }
  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      if (beforeBatch) await beforeBatch();
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map(({ sql, values }) => {
          const row = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(row.changes) } };
        });
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "participant-registration-"));
  const path = join(dir, "local.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  for (const file of readdirSync("drizzle").filter((name) => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + file, "utf8"));
  }
  for (const [id, username] of [["m1", "member1"], ["m2", "member2"]]) {
    sqlite.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) VALUES (?,?,?,'Member','member','active','2026')").run(id, username, "same@example.com");
  }
  for (const [id, sub] of [["p1", "sub1"], ["p2", "sub2"]]) {
    sqlite.prepare("INSERT INTO participants VALUES (?,?,?,?,?)").run(id, sub, "same@example.com", "Participant", "2026");
  }
  sqlite.prepare("INSERT INTO participant_terms VALUES (?,?)").run("v1", "Terms");
  sqlite.prepare("INSERT INTO participant_terms_current VALUES (1,?)").run("v1");
  for (const id of ["p1", "p2"]) sqlite.prepare("INSERT INTO participant_consent_state VALUES (?, 'active', 1, 'v1')").run(id);
  const expires = Date.now() + 3600_000;
  for (const [token, id] of [[memberToken, "m1"], [memberToken2, "m2"]]) {
    sqlite.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(hash(token), id, expires);
  }
  for (const [token, id] of [[participantToken, "p1"], [otherParticipantToken, "p2"]]) {
    sqlite.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) VALUES (?,?,?,1)").run(hash(token), id, expires);
  }
  const schema = { id: "form1", activityId: "activity1", title: "Activity", description: "", status: "open", fields: [{ id: "name", label: "Name", type: "short_text", required: true }], privacyNotice: "Notice" };
  sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("form1", "activity1", slug, "Activity", "", "open", JSON.stringify(schema), "Notice", 1, "admin-kao19950411", "2026", "2026");
  sqlite.prepare("INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES ('legacy','form1',1,'[]','{}',1,'legacy-key','legacy','2026')").run();
  return { sqlite, path, db: database(sqlite), schema, close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const submit = (db, kind, cookie, payload = body()) => submitParticipantRegistration(db, kind, cookie, slug, payload);
const countNew = (sqlite) => sqlite.prepare("SELECT COUNT(*) AS n FROM registration_submissions WHERE id<>'legacy'").get().n;
const countIdentities = (sqlite) => sqlite.prepare("SELECT COUNT(*) AS n FROM registration_identities").get().n;

test("member and participant sharing email remain separate; same key replay is owner scoped", async () => {
  const f = fixture();
  try {
    const bothCookies = memberCookie + "; " + participantCookie;
    assert.deepEqual(await submit(f.db, undefined, bothCookies), { ok: false, code: "invalid" });
    const m = await submit(f.db, "member", bothCookies);
    const p = await submit(f.db, "participant", bothCookies);
    assert.equal(m.ok, true);
    assert.equal(p.ok, true);
    assert.notEqual(m.receiptId, p.receiptId);
    assert.deepEqual(await submit(f.db, "member", bothCookies), { ok: true, receiptId: m.receiptId, replayed: true });
    assert.deepEqual(await submit(f.db, "member", bothCookies, body("idempotency-1", "  John  ")), { ok: true, receiptId: m.receiptId, replayed: true });
    assert.deepEqual(await submit(f.db, "participant", bothCookies), { ok: true, receiptId: p.receiptId, replayed: true });
    assert.deepEqual(await submit(f.db, "member", bothCookies, body("idempotency-1", "Other")), { ok: false, code: "conflict" });
    const otherMember = await submit(f.db, "member", memberCookie2);
    const otherParticipant = await submit(f.db, "participant", otherParticipantCookie);
    assert.equal(otherMember.ok, true);
    assert.equal(otherParticipant.ok, true);
    assert.notEqual(otherMember.receiptId, m.receiptId);
    assert.notEqual(otherParticipant.receiptId, p.receiptId);
    assert.equal(countNew(f.sqlite), 4);
    assert.equal(countIdentities(f.sqlite), 4);
    assert.equal(f.sqlite.prepare("SELECT answers_json FROM registration_submissions WHERE id='legacy'").get().answers_json, "{}");
  } finally { f.close(); }
});

test("replay remains owner scoped if form closes and is refused if the session is revoked during lookup", async () => {
  const f = fixture();
  try {
    const first = await submit(f.db, "member", memberCookie);
    assert.equal(first.ok, true);
    f.sqlite.exec("UPDATE registration_forms SET status='closed',version=version+1 WHERE id='form1'");
    assert.deepEqual(await submit(f.db, "member", memberCookie), { ok: true, receiptId: first.receiptId, replayed: true });
    const raceDb = {
      ...f.db,
      prepare(sql) {
        const prepared = f.db.prepare(sql);
        if (!sql.startsWith("SELECT s.id,i.status")) return prepared;
        return { bind(...values) {
          const bound = prepared.bind(...values);
          return { async first() {
            f.sqlite.exec("DELETE FROM admin_sessions WHERE user_id='m1'");
            return bound.first();
          } };
        } };
      },
    };
    const result = await submit(raceDb, "member", memberCookie);
    assert.equal(result.ok, false);
    assert.equal("receiptId" in result, false);
  } finally { f.close(); }
});

test("rejects invalid body, identity injection, unselected or invalid cookies", async (t) => {
  const f = fixture();
  try {
    const cases = [
      ["missing consent", "member", memberCookie, { ...body(), consent: false }, "invalid"],
      ["member injection", "member", memberCookie, { ...body(), memberId: "m2" }, "invalid"],
      ["participant injection", "participant", participantCookie, { ...body(), participantId: "p2" }, "invalid"],
      ["bad version", "member", memberCookie, { ...body(), formVersion: "1" }, "invalid"],
      ["invalid key", "member", memberCookie, body("bad key"), "invalid"],
      ["newline key", "member", memberCookie, body("key\n"), "invalid"],
      ["oversized body", "member", memberCookie, body("key", "x".repeat(61_000)), "invalid"],
      ["bad answer", "member", memberCookie, body("key", ""), "invalid"],
      ["missing cookie", "member", "", body(), "unauthorized"],
      ["wrong cookie kind", "participant", memberCookie, body(), "unauthorized"],
      ["duplicate cookie", "member", memberCookie + "; " + memberCookie, body(), "unauthorized"],
      ["invalid kind", "admin", memberCookie, body(), "invalid"],
    ];
    for (const [name, kind, cookie, payload, code] of cases) {
      await t.test(name, async () => assert.deepEqual(await submit(f.db, kind, cookie, payload), { ok: false, code }));
    }
    assert.equal(countNew(f.sqlite), 0);
    assert.equal(countIdentities(f.sqlite), 0);
  } finally { f.close(); }
});

test("expired or disabled member and revoked or stale participant cannot submit", async (t) => {
  for (const [name, statement, kind, cookie] of [
    ["expired member", "UPDATE admin_sessions SET expires_at=1 WHERE user_id='m1'", "member", memberCookie],
    ["disabled member", "UPDATE members SET status='inactive' WHERE user_id='m1'", "member", memberCookie],
    ["expired participant", "UPDATE participant_sessions SET expires_at=1 WHERE participant_id='p1'", "participant", participantCookie],
    ["revoked participant", "UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie],
    ["stale epoch", "UPDATE participant_consent_state SET epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie],
  ]) await t.test(name, async () => {
    const f = fixture();
    try {
      f.sqlite.exec(statement);
      assert.deepEqual(await submit(f.db, kind, cookie), { ok: false, code: "unauthorized" });
      assert.equal(countNew(f.sqlite), 0);
    } finally { f.close(); }
  });
});

test("form closing, version/schema edits and session changes before batch reject without orphan", async (t) => {
  for (const [name, mutate, expected] of [
    ["closed", "UPDATE registration_forms SET status='closed' WHERE id='form1'", "closed"],
    ["version", "UPDATE registration_forms SET version=version+1 WHERE id='form1'", "closed"],
    ["schema", "UPDATE registration_forms SET schema_json=schema_json || ' ' WHERE id='form1'", "closed"],
    ["session removed", "DELETE FROM admin_sessions WHERE user_id='m1'", "unauthorized"],
  ]) await t.test(name, async () => {
    const f = fixture();
    try {
      const db = database(f.sqlite, async () => f.sqlite.exec(mutate));
      assert.deepEqual(await submit(db, "member", memberCookie), { ok: false, code: expected });
      assert.equal(countNew(f.sqlite), 0);
      assert.equal(countIdentities(f.sqlite), 0);
    } finally { f.close(); }
  });
  const f = fixture();
  try {
    const db = database(f.sqlite, async () => f.sqlite.exec("UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'"));
    assert.deepEqual(await submit(db, "participant", participantCookie), { ok: false, code: "unauthorized" });
    assert.equal(countNew(f.sqlite), 0);
  } finally { f.close(); }
});

test("same account/key concurrency returns same receipt, different keys allow only one active", async () => {
  for (const sameKey of [true, false]) {
    const f = fixture();
    const second = new DatabaseSync(f.path);
    second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    try {
      const [a, b] = await Promise.all([
        submit(f.db, "member", memberCookie, body("key-a")),
        submit(database(second), "member", memberCookie, body(sameKey ? "key-a" : "key-b")),
      ]);
      assert.equal(countNew(f.sqlite), 1);
      assert.equal(countIdentities(f.sqlite), 1);
      if (sameKey) {
        assert.ok(a.ok && b.ok);
        assert.equal(a.receiptId, b.receiptId);
        assert.notEqual(a.replayed, b.replayed);
      } else {
        assert.equal([a, b].filter((result) => result.ok).length, 1);
        assert.equal([a, b].find((result) => !result.ok).code, "conflict");
      }
    } finally { second.close(); f.close(); }
  }
});

test("silent identity failure triggers transaction guard and leaves no orphan", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("CREATE TRIGGER ignore_identity BEFORE INSERT ON registration_identities BEGIN SELECT RAISE(IGNORE); END");
    assert.deepEqual(await submit(f.db, "member", memberCookie), { ok: false, code: "unavailable" });
    assert.equal(countNew(f.sqlite), 0);
    assert.equal(countIdentities(f.sqlite), 0);
  } finally { f.close(); }
});

test("cancelled retry is not success; new key may create a new active registration", async () => {
  const f = fixture();
  try {
    const first = await submit(f.db, "member", memberCookie);
    assert.equal(first.ok, true);
    f.sqlite.prepare("UPDATE registration_identities SET status='cancelled' WHERE submission_id=?").run(first.receiptId);
    assert.deepEqual(await submit(f.db, "member", memberCookie), { ok: false, code: "conflict" });
    const second = await submit(f.db, "member", memberCookie, body("new-key"));
    assert.equal(second.ok, true);
    assert.notEqual(second.receiptId, first.receiptId);
    assert.equal(countNew(f.sqlite), 2);
    assert.equal(countIdentities(f.sqlite), 2);
  } finally { f.close(); }
});

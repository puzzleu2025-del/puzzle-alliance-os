import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { issueParticipantQr, revokeParticipantQr } from "../../app/participant-qr.ts";

const memberToken = "a".repeat(64);
const memberToken2 = "b".repeat(64);
const participantToken = "c".repeat(64);
const participantToken2 = "d".repeat(64);
const memberCookie = "puzzle_admin_session=" + memberToken;
const memberCookie2 = "puzzle_admin_session=" + memberToken2;
const participantCookie = "__Host-puzzle-participant=" + participantToken;
const participantCookie2 = "__Host-puzzle-participant=" + participantToken2;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function database(sqlite, beforeFirst) {
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() {
        if (beforeFirst) await beforeFirst(sql);
        const row = sqlite.prepare(sql).get(...values);
        return row ? { ...row } : null;
      },
    };
  }
  return { prepare(sql) { return statement(sql); } };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "participant-qr-"));
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
  const expires = Date.now() + 3_600_000;
  for (const [token, id] of [[memberToken, "m1"], [memberToken2, "m2"]]) {
    sqlite.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(hash(token), id, expires);
  }
  for (const [token, id] of [[participantToken, "p1"], [participantToken2, "p2"]]) {
    sqlite.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) VALUES (?,?,?,1)").run(hash(token), id, expires);
  }
  sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("form1", "activity1", "slug1", "Activity", "", "open", "{}", "Notice", 1, "admin-kao19950411", "2026", "2026");
  for (const id of ["member-sub", "participant-sub", "legacy"]) {
    sqlite.prepare("INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES (?,'form1',1,'[]','{}',1,?,'source','2026')").run(id, "key-" + id);
  }
  sqlite.prepare("INSERT INTO registration_identities (submission_id,form_id,member_id) VALUES ('member-sub','form1','m1')").run();
  sqlite.prepare("INSERT INTO registration_identities (submission_id,form_id,participant_id) VALUES ('participant-sub','form1','p1')").run();
  return { sqlite, path, db: database(sqlite), close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const count = (sqlite) => sqlite.prepare("SELECT COUNT(*) AS n FROM registration_qr_tokens").get().n;

test("each redisplay issues a new token and stores only hashes; both old and new remain unrevoked", async () => {
  const f = fixture();
  try {
    const first = await issueParticipantQr(f.db, "member", memberCookie, "member-sub");
    const second = await issueParticipantQr(f.db, "member", memberCookie, "member-sub");
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.match(second, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    const rows = f.sqlite.prepare("SELECT token_hash,submission_id,issued_at,revoked_at FROM registration_qr_tokens ORDER BY token_hash").all();
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.token_hash)), new Set([hash(first), hash(second)]));
    assert.ok(rows.every((row) => row.revoked_at === null && row.submission_id === "member-sub" && row.issued_at > 0));
    assert.ok(!JSON.stringify(rows).includes(first));
    assert.ok(!JSON.stringify(rows).includes(second));
    assert.equal(f.sqlite.prepare("SELECT answers_json FROM registration_submissions WHERE id='legacy'").get().answers_json, "{}");
  } finally { f.close(); }
});

test("explicit identity selection verifies each cookie and does not merge matching emails", async () => {
  const f = fixture();
  try {
    const both = memberCookie + "; " + participantCookie;
    assert.equal(await issueParticipantQr(f.db, undefined, both, "member-sub"), null);
    assert.equal(await issueParticipantQr(f.db, "member", both, "participant-sub"), null);
    assert.equal(await issueParticipantQr(f.db, "participant", both, "member-sub"), null);
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie2, "member-sub"), null);
    assert.equal(await issueParticipantQr(f.db, "participant", participantCookie2, "participant-sub"), null);
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie + "; " + memberCookie, "member-sub"), null);
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie, "legacy"), null);
    assert.equal(count(f.sqlite), 0);
    assert.ok(await issueParticipantQr(f.db, "member", both, "member-sub"));
    assert.ok(await issueParticipantQr(f.db, "participant", both, "participant-sub"));
    assert.equal(count(f.sqlite), 2);
  } finally { f.close(); }
});

test("expired, disabled, revoked consent and cancelled registration cannot issue", async (t) => {
  for (const [name, sql, kind, cookie, id] of [
    ["member session expired", "UPDATE admin_sessions SET expires_at=1 WHERE user_id='m1'", "member", memberCookie, "member-sub"],
    ["member disabled", "UPDATE members SET status='inactive' WHERE user_id='m1'", "member", memberCookie, "member-sub"],
    ["participant session expired", "UPDATE participant_sessions SET expires_at=1 WHERE participant_id='p1'", "participant", participantCookie, "participant-sub"],
    ["participant consent revoked", "UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie, "participant-sub"],
    ["participant stale epoch", "UPDATE participant_consent_state SET epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie, "participant-sub"],
    ["registration cancelled", "UPDATE registration_identities SET status='cancelled' WHERE submission_id='member-sub'", "member", memberCookie, "member-sub"],
  ]) await t.test(name, async () => {
    const f = fixture();
    try {
      f.sqlite.exec(sql);
      assert.equal(await issueParticipantQr(f.db, kind, cookie, id), null);
      assert.equal(count(f.sqlite), 0);
    } finally { f.close(); }
  });
});

test("validation and ownership are checked in same INSERT even after a race", async () => {
  const f = fixture();
  try {
    const db = database(f.sqlite, async () => f.sqlite.exec("UPDATE registration_identities SET status='cancelled' WHERE submission_id='member-sub'"));
    assert.equal(await issueParticipantQr(db, "member", memberCookie, "member-sub"), null);
    assert.equal(count(f.sqlite), 0);
  } finally { f.close(); }
  const participant = fixture();
  try {
    const db = database(participant.sqlite, async () => participant.sqlite.exec("UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'"));
    assert.equal(await issueParticipantQr(db, "participant", participantCookie, "participant-sub"), null);
    assert.equal(count(participant.sqlite), 0);
  } finally { participant.close(); }
});

test("individual revocation only affects that code and permits later reissue", async () => {
  const f = fixture();
  try {
    const first = await issueParticipantQr(f.db, "participant", participantCookie, "participant-sub");
    const second = await issueParticipantQr(f.db, "participant", participantCookie, "participant-sub");
    assert.equal(await revokeParticipantQr(f.db, "participant", participantCookie2, first), false);
    assert.equal(await revokeParticipantQr(f.db, "member", memberCookie, first), false);
    assert.equal(await revokeParticipantQr(f.db, "participant", participantCookie, first), true);
    assert.equal(await revokeParticipantQr(f.db, "participant", participantCookie, first), false);
    assert.ok(f.sqlite.prepare("SELECT revoked_at FROM registration_qr_tokens WHERE token_hash=?").get(hash(first)).revoked_at);
    assert.equal(f.sqlite.prepare("SELECT revoked_at FROM registration_qr_tokens WHERE token_hash=?").get(hash(second)).revoked_at, null);
    const third = await issueParticipantQr(f.db, "participant", participantCookie, "participant-sub");
    assert.ok(third);
    assert.notEqual(third, first);
    assert.equal(count(f.sqlite), 3);
  } finally { f.close(); }
});

test("parallel redisplay on two connections persists distinct hashes for the same active registration", async () => {
  const f = fixture();
  const second = new DatabaseSync(f.path);
  second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  try {
    const [first, next] = await Promise.all([
      issueParticipantQr(f.db, "member", memberCookie, "member-sub"),
      issueParticipantQr(database(second), "member", memberCookie, "member-sub"),
    ]);
    assert.ok(first && next);
    assert.notEqual(first, next);
    assert.equal(count(f.sqlite), 2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM registration_qr_tokens WHERE revoked_at IS NULL").get().n, 2);
  } finally { second.close(); f.close(); }
});

test("cancelled registration prevents issuance; scanner must still check active status for old hashes", async () => {
  const f = fixture();
  try {
    const token = await issueParticipantQr(f.db, "member", memberCookie, "member-sub");
    f.sqlite.exec("UPDATE registration_identities SET status='cancelled' WHERE submission_id='member-sub'");
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie, "member-sub"), null);
    assert.equal(await revokeParticipantQr(f.db, "member", memberCookie, token), false);
    assert.equal(f.sqlite.prepare("SELECT revoked_at FROM registration_qr_tokens WHERE token_hash=?").get(hash(token)).revoked_at, null);
  } finally { f.close(); }
});

test("ignored INSERT and disabled account fail without persisting a code", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("CREATE TRIGGER ignore_qr_insert BEFORE INSERT ON registration_qr_tokens BEGIN SELECT RAISE(IGNORE); END");
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie, "member-sub"), null);
    assert.equal(count(f.sqlite), 0);
    f.sqlite.exec("DROP TRIGGER ignore_qr_insert");
    const issued = await issueParticipantQr(f.db, "member", memberCookie, "member-sub");
    f.sqlite.exec("UPDATE members SET status='inactive' WHERE user_id='m1'");
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie, "member-sub"), null);
    assert.equal(await revokeParticipantQr(f.db, "member", memberCookie, issued), false);
    assert.equal(f.sqlite.prepare("SELECT revoked_at FROM registration_qr_tokens WHERE token_hash=?").get(hash(issued)).revoked_at, null);
  } finally { f.close(); }
});

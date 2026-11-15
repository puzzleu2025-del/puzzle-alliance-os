import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { listMyRegistrations } from "../../app/participant-my-registrations.ts";
import { issueParticipantQr } from "../../app/participant-qr.ts";

const memberToken = "a".repeat(64), participantToken = "b".repeat(64), otherToken = "c".repeat(64);
const memberCookie = `puzzle_admin_session=${memberToken}`;
const participantCookie = `__Host-puzzle-participant=${participantToken}`;
const otherCookie = `puzzle_admin_session=${otherToken}`;
const both = `${memberCookie}; ${participantCookie}`;
const hash = value => createHash("sha256").update(value).digest("hex");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("drizzle").filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync("drizzle/" + file, "utf8"));
  for (const [id, username] of [["m1", "member1"], ["m2", "member2"]]) sqlite.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) VALUES (?,?,?,'Member','member','active','2026')").run(id, username, "same@example.com");
  sqlite.prepare("INSERT INTO participants VALUES ('p1','sub1','same@example.com','Participant','2026')").run();
  sqlite.prepare("INSERT INTO participant_terms VALUES ('v1','Terms'),('v2','New terms')").run();
  sqlite.prepare("INSERT INTO participant_terms_current VALUES (1,'v1')").run();
  sqlite.prepare("INSERT INTO participant_consent_state VALUES ('p1','active',1,'v1')").run();
  for (const [token, id] of [[memberToken, "m1"], [otherToken, "m2"]]) sqlite.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(hash(token), id, Date.now() + 3600000);
  sqlite.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) VALUES (?,'p1',?,1)").run(hash(participantToken), Date.now() + 3600000);
  function add(id, owner, status = "active", formStatus = "open", time = "2026-01-01T00:00:00.000Z") {
    const formId = "form-" + id;
    sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(formId, "activity-" + id, "slug-" + id, "Title " + id, "", formStatus, "{}", "notice", 1, "admin-kao19950411", "2026", "2026");
    sqlite.prepare("INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES (?,?,1,'[]',?,1,?,'source',?)").run(id, formId, '{"secret":"private answer"}', "key-" + id, time);
    if (owner) sqlite.prepare("INSERT INTO registration_identities (submission_id,form_id,member_id,participant_id,status) VALUES (?,?,?,?,?)").run(id, formId, owner === "m1" || owner === "m2" ? owner : null, owner === "p1" ? owner : null, status);
  }
  const queries = [];
  let beforeQuery = null;
  const db = { prepare(sql) { return { bind(...args) { return {
    async all() { queries.push(sql); if (beforeQuery) beforeQuery(); return { success: true, results: sqlite.prepare(sql).all(...args).map(row => ({ ...row })) }; },
    async first() { const row = sqlite.prepare(sql).get(...args); return row ? { ...row } : null; },
  }; } }; } };
  return { sqlite, db, add, queries, setBeforeQuery(fn) { beforeQuery = fn; }, close() { sqlite.close(); } };
}

test("selected cookie isolates matching email, old anonymous, cancelled and closed forms", async () => {
  const f = fixture();
  try {
    f.add("member", "m1", "active", "closed"); f.add("participant", "p1"); f.add("other", "m2"); f.add("cancelled", "m1", "cancelled"); f.add("anonymous", null);
    const before = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
    const member = await listMyRegistrations(f.db, "member", both);
    const participant = await listMyRegistrations(f.db, "participant", both);
    assert.deepEqual(member, { ok: true, registrations: [{ submissionId: "member", title: "Title member", submittedAt: "2026-01-01T00:00:00.000Z", feeAmount: 0, remittanceLast5: "" }], nextCursor: null });
    assert.deepEqual(participant.registrations.map(row => row.submissionId), ["participant"]);
    assert.deepEqual((await listMyRegistrations(f.db, "member", otherCookie)).registrations.map(row => row.submissionId), ["other"]);
    assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, before);
    assert.ok(!JSON.stringify([member, participant]).includes("same@example.com"));
    assert.ok(!JSON.stringify([member, participant]).includes("private answer"));
    for (const sql of f.queries) assert.ok(!/answers_json|\.email|token_hash\s+AS/i.test(sql));
  } finally { f.close(); }
});

test("empty authorized results differ from missing or invalid sessions", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await listMyRegistrations(f.db, "member", memberCookie), { ok: true, registrations: [], nextCursor: null });
    assert.deepEqual(await listMyRegistrations(f.db, "member", null), { ok: false, code: "unauthorized" });
    assert.deepEqual(await listMyRegistrations(f.db, "participant", memberCookie), { ok: false, code: "unauthorized" });
    assert.deepEqual(await listMyRegistrations(f.db, "member", memberCookie + "; " + memberCookie), { ok: false, code: "unauthorized" });
    assert.deepEqual(await listMyRegistrations(f.db, "both", both), { ok: false, code: "invalid" });
  } finally { f.close(); }
});

test("expiry, disabled member, revoked consent, stale epoch and terms fail closed", async t => {
  for (const [sql, kind, cookie] of [
    ["UPDATE admin_sessions SET expires_at=1 WHERE user_id='m1'", "member", memberCookie],
    ["UPDATE members SET status='inactive' WHERE user_id='m1'", "member", memberCookie],
    ["UPDATE participant_sessions SET expires_at=1 WHERE participant_id='p1'", "participant", participantCookie],
    ["UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie],
    ["UPDATE participant_consent_state SET epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie],
    ["UPDATE participant_terms_current SET version='v2'", "participant", participantCookie],
  ]) await t.test(sql, async () => {
    const f = fixture();
    try { f.add("entry", kind === "member" ? "m1" : "p1"); f.sqlite.exec(sql); assert.deepEqual(await listMyRegistrations(f.db, kind, cookie), { ok: false, code: "unauthorized" }); assert.equal(await issueParticipantQr(f.db, kind, cookie, "entry"), null); }
    finally { f.close(); }
  });
});

test("bounded keyset pagination handles equal timestamps without skips or duplicates", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 111; i++) f.add("id" + String(i).padStart(3, "0"), "m1");
    let cursor = null; const ids = []; const sizes = [];
    do { const result = await listMyRegistrations(f.db, "member", memberCookie, cursor); assert.equal(result.ok, true); sizes.push(result.registrations.length); ids.push(...result.registrations.map(row => row.submissionId)); cursor = result.nextCursor; } while (cursor);
    assert.deepEqual(sizes, [50, 50, 11]);
    assert.equal(new Set(ids).size, 111);
    assert.deepEqual(ids, [...ids].sort().reverse());
  } finally { f.close(); }
});

test("cursor validation rejects malformed and oversized input", async () => {
  const f = fixture();
  try {
    for (const cursor of ["bad", [], {}, { submittedAt: "2026", submissionId: "a", identity: "m2" }, { submittedAt: "x".repeat(65), submissionId: "a" }, { submittedAt: "2026\n", submissionId: "a" }, { submittedAt: "2026", submissionId: "a\n" }, { submittedAt: "2026", submissionId: "a".repeat(101) }]) assert.deepEqual(await listMyRegistrations(f.db, "member", memberCookie, cursor), { ok: false, code: "invalid" });
    assert.equal(f.queries.length, 0);
  } finally { f.close(); }
});

test("revocation at query time and cancellation block listing and QR issuance", async () => {
  const f = fixture();
  try {
    f.add("entry", "p1");
    f.setBeforeQuery(() => { f.setBeforeQuery(null); f.sqlite.exec("UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'"); });
    assert.deepEqual(await listMyRegistrations(f.db, "participant", participantCookie), { ok: false, code: "unauthorized" });
    assert.equal(await issueParticipantQr(f.db, "participant", participantCookie, "entry"), null);
    f.add("member-entry", "m1");
    f.sqlite.exec("UPDATE registration_identities SET status='cancelled' WHERE submission_id='member-entry'");
    assert.deepEqual((await listMyRegistrations(f.db, "member", memberCookie)).registrations, []);
    assert.equal(await issueParticipantQr(f.db, "member", memberCookie, "member-entry"), null);
  } finally { f.close(); }
});

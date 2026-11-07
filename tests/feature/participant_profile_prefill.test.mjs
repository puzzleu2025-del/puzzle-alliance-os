import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getParticipantProfilePrefill } from "../../app/participant-profile-prefill.ts";

const slug = "a".repeat(32);
const memberToken = "a".repeat(64);
const participantToken = "b".repeat(64);
const memberCookie = "puzzle_admin_session=" + memberToken;
const participantCookie = "__Host-puzzle-participant=" + participantToken;
const both = memberCookie + "; " + participantCookie;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const field = (id, type, profileKey) => ({ id, label: id, type, required: false, ...(profileKey ? { profileKey, sensitive: true } : {}) });
const targetFields = [
  field("name", "short_text", "displayName"), field("mail", "email", "email"),
  field("tel", "phone", "phone"), field("company", "short_text", "organization"),
  field("job", "short_text", "position"),
];
function database(sqlite, hooks = {}) {
  function statement(sql, values = []) {
    return {
      bind(...args) { return statement(sql, args); },
      async first() {
        if (hooks.beforeFirst) await hooks.beforeFirst(sql);
        const row = sqlite.prepare(sql).get(...values);
        return row ? { ...row } : null;
      },
      async all() {
        if (hooks.beforeAll) await hooks.beforeAll(sql);
        const rows = sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
        if (hooks.afterAll) hooks.afterAll(sql, rows);
        return { success: true, results: rows };
      },
    };
  }
  return { prepare(sql) { return statement(sql); } };
}
function fixture(fields = targetFields) {
  const dir = mkdtempSync(join(tmpdir(), "participant-profile-prefill-"));
  const path = join(dir, "local.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  for (const migration of readdirSync("drizzle").filter((name) => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + migration, "utf8"));
  }
  sqlite.prepare("INSERT INTO members (user_id,username,email,display_name,phone,organization,position,role,status,created_at) VALUES (?,?,?,?,?,?,?,'member','active','2026')")
    .run("m1", "member1", "same@example.com", "Internal Name", "0911111111", "Internal Org", "Internal Role");
  for (const [id, sub, name] of [["p1", "sub1", "Google Name"], ["p2", "sub2", "Other Person"]]) {
    sqlite.prepare("INSERT INTO participants VALUES (?,?,?,?,?)").run(id, sub, "same@example.com", name, "2026");
  }
  sqlite.prepare("INSERT INTO participant_terms VALUES ('v1','Terms')").run();
  sqlite.prepare("INSERT INTO participant_terms_current VALUES (1,'v1')").run();
  for (const id of ["p1", "p2"]) sqlite.prepare("INSERT INTO participant_consent_state VALUES (?, 'active', 1, 'v1')").run(id);
  const expires = Date.now() + 3_600_000;
  sqlite.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(hash(memberToken), "m1", expires);
  sqlite.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) VALUES (?,?,?,1)").run(hash(participantToken), "p1", expires);
  const schema = { id: "target", activityId: "activity-target", title: "Activity", description: "", status: "open", fields, privacyNotice: "Notice" };
  sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("target", "activity-target", slug, "Activity", "", "open", JSON.stringify(schema), "Notice", 1, "admin-kao19950411", "2026", "2026");
  return { sqlite, db: database(sqlite), close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function history(sqlite, id, owner, fields, answers, time, status = "active") {
  const formId = "form-" + id;
  sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(formId, "activity-" + id, "slug-" + id, "Old", "", "closed", "{}", "Notice", 1, "admin-kao19950411", "2026", "2026");
  sqlite.prepare("INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES (?,?,1,?,?,1,?,'source',?)")
    .run("submission-" + id, formId, JSON.stringify(fields), JSON.stringify(answers), "key-" + id, time);
  sqlite.prepare("INSERT INTO registration_identities (submission_id,form_id,participant_id,status) VALUES (?,?,?,?)")
    .run("submission-" + id, formId, owner, status);
}
const prefill = (f, kind, cookie = both, formSlug = slug) => getParticipantProfilePrefill(f.db, kind, cookie, formSlug);

test("member reads only own mapped fields and explicit identity selection is required", async () => {
  const f = fixture();
  try {
    assert.equal(await prefill(f, undefined), null);
    assert.equal(await prefill(f, "member", participantCookie), null);
    assert.equal(await prefill(f, "member", memberCookie + "; " + memberCookie), null);
    const result = await prefill(f, "member");
    assert.equal(result.formVersion, 1);
    assert.deepEqual({ ...result.values }, {
      name: "Internal Name", mail: "same@example.com", tel: "0911111111", company: "Internal Org", job: "Internal Role",
    });
  } finally { f.close(); }
});

test("participant uses Google name/email and only own latest valid explicitly mapped active history", async () => {
  const f = fixture();
  try {
    history(f.sqlite, "valid", "p1", [field("oldphone", "phone", "phone"), field("oldorg", "short_text", "organization"), field("oldjob", "short_text", "position")],
      { oldphone: "0922222222", oldorg: "My Org", oldjob: "My Role", ignored: "secret" }, "2026-01-01");
    history(f.sqlite, "blank", "p1", [field("org", "short_text", "organization"), field("phone", "short_text", "phone")],
      { org: "", phone: "bad phone" }, "2026-02-01");
    history(f.sqlite, "duplicate", "p1", [field("x", "short_text", "organization"), field("y", "short_text", "organization")],
      { x: "Ambiguous A", y: "Ambiguous B" }, "2026-03-01");
    history(f.sqlite, "legacy", "p1", [field("organization", "short_text"), field("phone", "phone")],
      { organization: "Guessed Org", phone: "0933333333" }, "2026-04-01");
    history(f.sqlite, "cancelled", "p1", [field("org", "short_text", "organization")], { org: "Cancelled Org" }, "2026-05-01", "cancelled");
    history(f.sqlite, "other", "p2", [field("org", "short_text", "organization")], { org: "Other Person Org" }, "2026-06-01");
    history(f.sqlite, "wrong-sensitive", "p1", [{ ...field("org", "short_text", "organization"), sensitive: 1 }], { org: "Invalid Sensitive" }, "2026-07-01");
    const captured = [];
    const db = database(f.sqlite, { afterAll(sql, rows) { captured.push(...rows); } });
    const result = await getParticipantProfilePrefill(db, "participant", both, slug);
    assert.equal(result.formVersion, 1);
    assert.deepEqual({ ...result.values }, {
      name: "Google Name", mail: "same@example.com", tel: "0922222222", company: "My Org", job: "My Role",
    });
    assert.ok(captured.every((row) => !Object.hasOwn(row, "answersJson") && !Object.hasOwn(row, "schemaJson")));
    assert.ok(!JSON.stringify(result).includes("Other Person Org"));
    assert.ok(!JSON.stringify(result).includes("Guessed Org"));
    assert.ok(!JSON.stringify(result).includes("secret"));
  } finally { f.close(); }
});

test("latest valid mapping is found beyond 50 newer unrelated registrations", async () => {
  const f = fixture([field("company", "short_text", "organization")]);
  try {
    history(f.sqlite, "earliest-mapped", "p1", [field("org", "short_text", "organization")], { org: "Latest Mapped Org" }, "2024-01-01");
    for (let index = 0; index < 55; index++) {
      history(f.sqlite, "unrelated-" + index, "p1", [field("legacy", "short_text")], { legacy: "Ignored" }, "2025-01-01");
    }
    let pages = 0;
    const db = database(f.sqlite, { afterAll() { pages++; } });
    const result = await getParticipantProfilePrefill(db, "participant", participantCookie, slug);
    assert.deepEqual({ ...result.values }, { company: "Latest Mapped Org" });
    assert.equal(pages, 1);
  } finally { f.close(); }
});

test("keyset pagination finds a valid answer after 50 mapped but invalid values", async () => {
  const f = fixture([field("tel", "phone", "phone")]);
  try {
    history(f.sqlite, "valid-old", "p1", [field("phone", "phone", "phone")], { phone: "0922222222" }, "2024-01-01");
    for (let index = 0; index < 55; index++) {
      history(f.sqlite, "invalid-phone-" + index, "p1", [field("phone", "short_text", "phone")], { phone: "not a phone" }, "2025-01-01");
    }
    let pages = 0;
    const db = database(f.sqlite, { afterAll() { pages++; } });
    const result = await getParticipantProfilePrefill(db, "participant", participantCookie, slug);
    assert.deepEqual({ ...result.values }, { tel: "0922222222" });
    assert.equal(pages, 2);
  } finally { f.close(); }
});

test("legacy target form with suggestive labels has no implicit mappings", async () => {
  const f = fixture([field("name", "short_text"), field("email", "email"), field("phone", "phone")]);
  try {
    assert.deepEqual({ ...(await prefill(f, "member")).values }, {});
    assert.deepEqual({ ...(await prefill(f, "participant")).values }, {});
  } finally { f.close(); }
});

test("target mapping projects only explicitly requested values", async () => {
  const f = fixture([field("name", "short_text", "displayName")]);
  try {
    assert.deepEqual({ ...(await prefill(f, "member")).values }, { name: "Internal Name" });
    assert.deepEqual({ ...(await prefill(f, "participant")).values }, { name: "Google Name" });
  } finally { f.close(); }
});

test("malformed historical JSON and disagreeing target JSON status fail safely", async () => {
  const f = fixture();
  try {
    history(f.sqlite, "badjson", "p1", [field("org", "short_text", "organization")], { org: "Old" }, "2026-01-01");
    f.sqlite.exec("UPDATE registration_submissions SET schema_json='invalid' WHERE id='submission-badjson'");
    assert.deepEqual({ ...(await prefill(f, "participant")).values }, { name: "Google Name", mail: "same@example.com" });
    const schema = JSON.parse(f.sqlite.prepare("SELECT schema_json FROM registration_forms WHERE id='target'").get().schema_json);
    schema.status = "closed";
    f.sqlite.prepare("UPDATE registration_forms SET schema_json=? WHERE id='target'").run(JSON.stringify(schema));
    assert.equal(await prefill(f, "member"), null);
  } finally { f.close(); }
});

test("closed form, invalid cookies, expired sessions and inactive consent fail closed", async (t) => {
  for (const [name, sql, kind, cookie] of [
    ["closed", "UPDATE registration_forms SET status='closed' WHERE id='target'", "member", memberCookie],
    ["member disabled", "UPDATE members SET status='inactive' WHERE user_id='m1'", "member", memberCookie],
    ["member expired", "UPDATE admin_sessions SET expires_at=1 WHERE user_id='m1'", "member", memberCookie],
    ["participant expired", "UPDATE participant_sessions SET expires_at=1 WHERE participant_id='p1'", "participant", participantCookie],
    ["consent revoked", "UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie],
    ["participant stale epoch", "UPDATE participant_consent_state SET epoch=epoch+1 WHERE participant_id='p1'", "participant", participantCookie],
  ]) await t.test(name, async () => {
    const f = fixture();
    try { f.sqlite.exec(sql); assert.equal(await prefill(f, kind, cookie), null); }
    finally { f.close(); }
  });
  const f = fixture();
  try {
    assert.equal(await prefill(f, "participant", memberCookie), null);
    assert.equal(await prefill(f, "member", memberCookie + "; " + memberCookie), null);
    assert.equal(await prefill(f, "member", memberCookie, "invalid"), null);
  } finally { f.close(); }
});

test("session revocation or target form mutation between sensitive reads yields no values", async () => {
  for (const sql of [
    "UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE participant_id='p1'",
    "UPDATE registration_forms SET status='closed' WHERE id='target'",
    "UPDATE registration_forms SET version=version+1 WHERE id='target'",
  ]) {
    const f = fixture();
    try {
      let changed = false;
      const db = database(f.sqlite, { beforeAll() { if (!changed) { changed = true; f.sqlite.exec(sql); } } });
      assert.equal(await getParticipantProfilePrefill(db, "participant", participantCookie, slug), null);
      assert.equal(changed, true);
    } finally { f.close(); }
  }
});

test("reassigning the same session between profile read and final validation cannot leak previous owner's data", async () => {
  const f = fixture();
  try {
    let changed = false;
    const db = database(f.sqlite, { beforeFirst(sql) {
      if (sql.startsWith("SELECT 1 AS ok")) {
        changed = true;
        f.sqlite.prepare("UPDATE participant_sessions SET participant_id='p2' WHERE token_hash=?").run(hash(participantToken));
      }
    } });
    assert.equal(await getParticipantProfilePrefill(db, "participant", participantCookie, slug), null);
    assert.equal(changed, true);
  } finally { f.close(); }
});

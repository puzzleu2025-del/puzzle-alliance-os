import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

// Test the actual route exports, replacing only the deployment-owned Workers
// environment; the request handlers and database calls remain unchanged.
globalThis.__participantTestEnv = {};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__participantTestEnv", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { POST: register } = await import("../../app/api/participant/registrations/route.ts");
const { POST: issue } = await import("../../app/api/participant/qr/route.ts");
const { POST: mine } = await import("../../app/api/participant/registrations/mine/route.ts");
const { POST: start } = await import("../../app/api/participant/auth/start/route.ts");
const { GET: consent } = await import("../../app/api/participant/consent/route.ts");
const env = globalThis.__participantTestEnv;
const origin = "https://puzzle.example";
const slug = "a".repeat(32);
const memberToken = "b".repeat(64);
const sha = value => createHash("sha256").update(value).digest("hex");

function dbAdapter(sqlite) {
  function statement(sql, values = []) {
    return {
      sql, values,
      bind(...args) { return statement(sql, args); },
      async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  return {
    prepare: sql => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, values }) => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }));
        sqlite.exec("COMMIT"); return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}
function request(path, body, extras = {}) {
  return new Request(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Participant-Identity": "member", Cookie: "puzzle_admin_session=" + memberToken, ...extras }, body: JSON.stringify(body) });
}

test("actual routes remain unavailable unless deployment settings are complete", async () => {
  for (const settings of [ {}, { PARTICIPANT_ENABLED: "true" }, { PARTICIPANT_ENABLED: "false" } ]) {
    Object.assign(env, settings);
    const response = await issue(request("/api/participant/qr", { submissionId: "x" }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("configured actual routes submit, recover and issue QR for their own member", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync("drizzle").filter(name => /^[0-9]{4}_.*[.]sql$/.test(name)).sort()) sqlite.exec(readFileSync("drizzle/" + file, "utf8"));
    sqlite.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) VALUES ('m1','member1','m@example.com','Member','member','active','2026')").run();
    sqlite.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(sha(memberToken), "m1", Date.now() + 3_600_000);
    const form = { id: "form1", activityId: "activity1", title: "Activity", description: "", status: "open", fields: [{ id: "name", label: "Name", type: "short_text", required: true }], privacyNotice: "Notice" };
    sqlite.prepare("INSERT INTO registration_forms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("form1", "activity1", slug, "Activity", "", "open", JSON.stringify(form), "Notice", 1, "admin-kao19950411", "2026", "2026");
    Object.assign(env, { DB: dbAdapter(sqlite), PARTICIPANT_ENABLED: "true", PARTICIPANT_ORIGIN: origin,
      PARTICIPANT_GOOGLE_CLIENT_ID: "123-client.apps.googleusercontent.com", PARTICIPANT_GOOGLE_CLIENT_SECRET: "test-secret", PARTICIPANT_TERMS_VERSION: "v1" });
    const submission = await register(request("/api/participant/registrations", { slug, answers: { name: "Member" }, consent: true, idempotencyKey: "test-key", formVersion: 1 }));
    assert.equal(submission.status, 201);
    const { receiptId } = await submission.json();
    const result = await issue(request("/api/participant/qr", { submissionId: receiptId }));
    assert.equal(result.status, 201);
    assert.match((await result.json()).token, /^[a-f0-9]{64}$/);
    const list = await mine(request("/api/participant/registrations/mine", { cursor: null }));
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).registrations.map(row => row.submissionId), [receiptId]);
    assert.equal((await issue(request("/api/participant/qr", { submissionId: receiptId }, { Origin: "https://evil.example" }))).status, 403);
    assert.equal((await issue(request("/api/participant/qr", { submissionId: receiptId }, { Cookie: "" }))).status, 404);
    const missingTerms = await consent(new Request(origin + "/api/participant/consent"));
    assert.equal(missingTerms.status, 409);
    const crossOrigin = await start(new Request(origin + "/api/participant/auth/start", { method: "POST", headers: { Origin: "https://evil.example" } }));
    assert.equal(crossOrigin.status, 403);
    const normalLogin = await start(new Request(origin + "/api/participant/auth/start", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "",
    }));
    assert.equal(normalLogin.status, 303);
    assert.equal(new URL(normalLogin.headers.get("location")).origin, "https://accounts.google.com");
    env.PARTICIPANT_ORIGIN = "http://puzzle.example";
    assert.equal((await issue(request("/api/participant/qr", { submissionId: receiptId }))).status, 503);
  } finally {
    for (const key of Object.keys(env)) delete env[key];
    sqlite.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { participantOauthStart } from "../../app/participant-oauth-start.ts";
import { POST as disabledStart } from "../../app/api/participant/auth/start/route.ts";

const origin = "https://puzzle.example";
const callbackUri = origin + "/api/participant/auth/callback";
const config = { clientId: "123456-abcdefghijklmnop.apps.googleusercontent.com", origin, callbackUri, consentVersion: "v1" };
const now = 1_700_000_000_000;
const sha = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const migration of readdirSync("drizzle").filter((name) => /^000[0-8].*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + migration, "utf8"));
  }
  const db = {
    prepare(sql) {
      return { bind(...values) {
        return {
          async first() {
            const row = sqlite.prepare(sql).get(...values);
            return row ? { ...row } : null;
          },
          async run() { return sqlite.prepare(sql).run(...values); },
        };
      } };
    },
  };
  return { sqlite, db };
}
function request(options = {}) {
  return new Request(options.url ?? origin + "/api/participant/auth/start", {
    method: options.method ?? "POST",
    headers: { Origin: options.origin ?? origin, ...options.headers },
    ...(options.body ? { body: options.body } : {}),
  });
}
function count(sqlite, table) { return sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get().n; }

test("real route is always disabled, no-store, without cookies or redirect", async () => {
  const response = await disabledStart();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
});

test("invalid server configuration, method and origin cause no writes", async (t) => {
  const { sqlite, db } = fixture();
  try {
    const cases = [
      ["missing config", request(), null, 503],
      ["empty client", request(), { ...config, clientId: "" }, 503],
      ["client syntax", request(), { ...config, clientId: "evil.example" }, 503],
      ["client with newline", request(), { ...config, clientId: config.clientId + "\n" }, 503],
      ["missing consent", request(), { ...config, consentVersion: "" }, 503],
      ["consent with newline", request(), { ...config, consentVersion: "v1\n" }, 503],
      ["http origin", request(), { ...config, origin: "http://puzzle.example" }, 503],
      ["origin includes path", request(), { ...config, origin: origin + "/other" }, 503],
      ["callback other host", request(), { ...config, callbackUri: "https://evil.example/api/participant/auth/callback" }, 503],
      ["callback wrong path", request(), { ...config, callbackUri: origin + "/evil" }, 503],
      ["callback query", request(), { ...config, callbackUri: callbackUri + "?next=evil" }, 503],
      ["callback fragment", request(), { ...config, callbackUri: callbackUri + "#x" }, 503],
      ["cross origin", request({ origin: "https://evil.example" }), config, 403],
      ["wrong request url", request({ url: "https://evil.example/api/participant/auth/start" }), config, 403],
      ["get", request({ method: "GET" }), config, 405],
    ];
    for (const [name, req, cfg, status] of cases) {
      await t.test(name, async () => {
        const result = await participantOauthStart(req, db, cfg, now);
        assert.equal(result.status, status);
        assert.equal(result.headers.get("cache-control"), "no-store");
        assert.equal(result.headers.get("set-cookie"), null);
      });
    }
    assert.equal(count(sqlite, "auth_attempts"), 0);
    assert.equal(count(sqlite, "participant_oauth_transactions"), 0);
  } finally { sqlite.close(); }
});

test("start uses only trusted configured redirect and returns PKCE bound to cookie", async () => {
  const { sqlite, db } = fixture();
  try {
    const response = await participantOauthStart(request({
      headers: { "cf-connecting-ip": "203.0.113.1" },
    }), db, config, now);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(location.searchParams.get("client_id"), config.clientId);
    assert.equal(location.searchParams.get("redirect_uri"), callbackUri);
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("scope"), "openid email profile");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^__Host-puzzle-participant-oauth=[a-f0-9]{64}; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Lax$/);
    const binding = cookie.split(";")[0].split("=")[1];
    const tx = sqlite.prepare("SELECT * FROM participant_oauth_transactions").get();
    assert.equal(tx.state_hash, sha(location.searchParams.get("state")));
    assert.equal(tx.binding_hash, sha(binding));
    assert.equal(tx.nonce, location.searchParams.get("nonce"));
    assert.equal(tx.return_path, "/participant");
    assert.equal(createHash("sha256").update(tx.code_verifier).digest("base64url"), location.searchParams.get("code_challenge"));
    assert.ok(!location.href.includes(tx.code_verifier));
    assert.equal(count(sqlite, "participant_consents"), 0);
    assert.equal(count(sqlite, "participant_sessions"), 0);
  } finally { sqlite.close(); }
});

test("registration slug is strictly bounded and cannot select an external destination", async () => {
  const { sqlite, db } = fixture();
  try {
    const slug = "a".repeat(32);
    const valid = await participantOauthStart(request({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `slug=${slug}` }), db, config, now);
    assert.equal(valid.status, 303);
    assert.equal(sqlite.prepare("SELECT return_path FROM participant_oauth_transactions").get().return_path, `/participant/register?slug=${slug}`);
    for (const [type, body] of [
      ["application/json", JSON.stringify({ returnPath: "//evil.example" })],
      ["application/x-www-form-urlencoded", `slug=${slug}&next=//evil.example`],
      ["application/x-www-form-urlencoded", `slug=${slug}&slug=${slug}`],
      ["application/x-www-form-urlencoded", "slug=" + "A".repeat(32)],
      ["application/x-www-form-urlencoded", "slug=%61" + "a".repeat(31)],
      ["application/x-www-form-urlencoded", "slug=" + "a".repeat(33)],
    ]) {
      const response = await participantOauthStart(request({ headers: { "Content-Type": type }, body }), db, config, now);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
    }
    assert.equal(count(sqlite, "participant_oauth_transactions"), 1);
  } finally { sqlite.close(); }
});

test("segmented form body cannot exceed its limit even with a false content length", async () => {
  const { sqlite, db } = fixture();
  try {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode("slug=" + "a".repeat(20)));
      controller.enqueue(encoder.encode("a".repeat(13)));
      controller.close();
    } });
    const req = new Request(origin + "/api/participant/auth/start", {
      method: "POST", duplex: "half", body: stream,
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "1" },
    });
    const response = await participantOauthStart(req, db, config, now);
    assert.equal(response.status, 400);
    assert.equal(count(sqlite, "participant_oauth_transactions"), 0);
  } finally { sqlite.close(); }
});

test("cleanup is bounded to own expired transactions and leaves live records untouched", async () => {
  const { sqlite, db } = fixture();
  try {
    const insert = sqlite.prepare("INSERT INTO participant_oauth_transactions VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 105; i++) insert.run("old-" + i, "binding", "nonce", "verifier", "/participant", now - 1);
    insert.run("live", "binding", "nonce", "verifier", "/participant", now + 100);
    sqlite.prepare("INSERT INTO auth_attempts VALUES ('other-auth', 9, ?)").run(now - 100_000);
    const response = await participantOauthStart(request(), db, config, now);
    assert.equal(response.status, 303);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM participant_oauth_transactions WHERE state_hash LIKE 'old-%'").get().n, 5);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM participant_oauth_transactions WHERE state_hash='live'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT attempts FROM auth_attempts WHERE key='other-auth'").get().attempts, 9);
  } finally { sqlite.close(); }
});

test("shared fallback throttles spoofed forwarded headers and edge IP uses a separate bucket", async () => {
  const { sqlite, db } = fixture();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await participantOauthStart(request({ headers: { "x-forwarded-for": "192.0.2." + i } }), db, config, now)).status, 303);
    }
    const countBefore = count(sqlite, "participant_oauth_transactions");
    const blocked = await participantOauthStart(request({ headers: { "x-forwarded-for": "198.51.100.7" } }), db, config, now);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("set-cookie"), null);
    assert.equal(count(sqlite, "participant_oauth_transactions"), countBefore);
    assert.equal((await participantOauthStart(request({ headers: { "cf-connecting-ip": "203.0.113.99" } }), db, config, now)).status, 303);
    const keys = sqlite.prepare("SELECT key FROM auth_attempts").all().map((row) => row.key);
    assert.equal(keys.length, 2);
    assert.ok(keys.every((key) => /^participant-oauth-start:[a-f0-9]{64}$/.test(key)));
    assert.equal((await participantOauthStart(request(), db, config, now + 15 * 60_000)).status, 303);
  } finally { sqlite.close(); }
});

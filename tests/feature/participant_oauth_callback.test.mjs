import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { participantOauthCallback } from "../../app/participant-oauth-callback.ts";
import { beginParticipantOauth, participantOauthBindingCookie } from "../../app/participant-oauth.ts";
import { GET as disabledCallback } from "../../app/api/participant/auth/callback/route.ts";

const crypto = globalThis.crypto ?? webcrypto;
const origin = "https://puzzle.example";
const config = { clientId: "123456-abcdefghijklmnop.apps.googleusercontent.com", clientSecret: "secret-example", origin, callbackUri: origin + "/api/participant/auth/callback", termsVersion: "v1" };
const now = 1_700_000_000_000;
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
);
const jwk = { ...await crypto.subtle.exportKey("jwk", keyPair.publicKey), kid: "google-key-1", use: "sig", alg: "RS256" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function signedToken(nonce, claimOverrides = {}, headerOverrides = {}) {
  const payload = { iss: "https://accounts.google.com", aud: config.clientId, exp: now / 1000 + 300, iat: now / 1000 - 1, nonce, sub: "google-sub", email: "user@example.com", email_verified: true, ...claimOverrides };
  const content = `${encode({ alg: "RS256", kid: "google-key-1", ...headerOverrides })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(content));
  return `${content}.${Buffer.from(signature).toString("base64url")}`;
}
function fixture(published = true) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const migration of readdirSync("drizzle").filter((name) => /^00(?:0[0-9]|10).*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + migration, "utf8"));
  }
  if (published) {
    sqlite.prepare("INSERT INTO participant_terms VALUES (?, ?)").run("v1", "Example terms");
    sqlite.prepare("INSERT INTO participant_terms_current VALUES (1, ?)").run("v1");
  }
  const db = {
    prepare(sql) {
      function statement(args = []) {
        return {
          bind(...values) { return statement(values); },
          async first() { const row = sqlite.prepare(sql).get(...args); return row ? { ...row } : null; },
          async run() { return sqlite.prepare(sql).run(...args); },
        };
      }
      return statement();
    },
  };
  return { sqlite, db };
}
function request(state, cookie, extra = "") {
  return new Request(config.callbackUri + "?state=" + encodeURIComponent(state) + "&code=auth-code" + extra, {
    headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
  });
}
function services(token, overrides = {}) {
  return {
    nowMs: () => now,
    fetcher: async () => new Response(JSON.stringify({ id_token: token }), { status: 200 }),
    keyStore: { async keysFor(kid) { assert.equal(kid, jwk.kid); return { keys: [jwk] }; } },
    ...overrides,
  };
}
function count(sqlite, table) { return sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get().n; }

test("public callback is hard disabled without redirect or cookies", async () => {
  const response = await disabledCallback();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
});

test("bad trusted config and wrong origin refuse before consuming state or contacting Google", async (t) => {
  const configs = [
    ["missing", null],
    ["missing secret", { ...config, clientSecret: "" }],
    ["invalid client", { ...config, clientId: "not-google-client" }],
    ["http origin", { ...config, origin: "http://puzzle.example" }],
    ["callback different host", { ...config, callbackUri: "https://evil.example/api/participant/auth/callback" }],
    ["callback query", { ...config, callbackUri: config.callbackUri + "?redirect=https://evil.example" }],
    ["invalid terms version", { ...config, termsVersion: "v1\n" }],
  ];
  for (const [name, badConfig] of configs) {
    await t.test(name, async () => {
      const { sqlite, db } = fixture();
      try {
        const tx = await beginParticipantOauth(db, "/participant", now);
        let calls = 0;
        const response = await participantOauthCallback(request(tx.state, participantOauthBindingCookie(tx.binding)), db, badConfig,
          services("", { fetcher: async () => { calls++; throw new Error("unexpected"); } }));
        assert.equal(response.status, 503);
        assert.equal(count(sqlite, "participant_oauth_transactions"), 1);
        assert.equal(calls, 0);
      } finally { sqlite.close(); }
    });
  }
  const { sqlite, db } = fixture();
  try {
    const tx = await beginParticipantOauth(db, "/participant", now);
    const wrongOrigin = new Request("https://evil.example/api/participant/auth/callback?state=" + tx.state + "&code=code", {
      headers: { Cookie: participantOauthBindingCookie(tx.binding).split(";")[0] },
    });
    assert.equal((await participantOauthCallback(wrongOrigin, db, config, services(""))).status, 403);
    assert.equal(count(sqlite, "participant_oauth_transactions"), 1);
  } finally { sqlite.close(); }
});

test("successful callback uses fixed token endpoint, issues pending only, and cannot replay", async () => {
  const { sqlite, db } = fixture();
  try {
    const tx = await beginParticipantOauth(db, "/participant", now);
    const stored = sqlite.prepare("SELECT * FROM participant_oauth_transactions").get();
    let seen = 0;
    const fetcher = async (url, init) => {
      seen++;
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.body.get("redirect_uri"), config.callbackUri);
      assert.equal(init.body.get("client_id"), config.clientId);
      assert.equal(init.body.get("client_secret"), config.clientSecret);
      assert.equal(init.body.get("code"), "auth-code");
      assert.equal(init.body.get("code_verifier"), stored.code_verifier);
      return new Response(JSON.stringify({ id_token: await signedToken(tx.nonce) }), { status: 200 });
    };
    const bound = participantOauthBindingCookie(tx.binding);
    const req = request(tx.state, bound, "&redirect_uri=" + encodeURIComponent("https://evil.example") + "&client_secret=attacker");
    const response = await participantOauthCallback(req, db, config, services("", { fetcher }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/participant/consent");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const pending = cookies.find((value) => value.startsWith("__Host-puzzle-participant-pending="));
    assert.match(pending, /^__Host-puzzle-participant-pending=[a-f0-9]{64}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    assert.match(cookies.find((value) => value.startsWith("__Host-puzzle-participant-oauth=")), /Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
    const pendingToken = pending.split(";")[0].split("=")[1];
    const row = sqlite.prepare("SELECT * FROM participant_pending_identities").get();
    assert.equal(row.token_hash, sha(pendingToken));
    assert.equal(row.google_sub, "google-sub");
    assert.equal(row.terms_version, "v1");
    assert.equal(count(sqlite, "participant_sessions"), 0);
    assert.equal(count(sqlite, "participant_consents"), 0);
    assert.equal(count(sqlite, "participants"), 0);
    assert.equal(count(sqlite, "participant_oauth_transactions"), 0);
    assert.equal(seen, 1);
    const repeated = await participantOauthCallback(req, db, config, services("", { fetcher }));
    assert.equal(repeated.status, 400);
    assert.equal(seen, 1);
  } finally { sqlite.close(); }
});

test("registration transaction redirects only to fixed consent path with its slug", async () => {
  const { sqlite, db } = fixture();
  try {
    const slug = "a".repeat(32);
    const tx = await beginParticipantOauth(db, `/participant/register?slug=${slug}`, now);
    const fetcher = async () => new Response(JSON.stringify({ id_token: await signedToken(tx.nonce) }), { status: 200 });
    const response = await participantOauthCallback(request(tx.state, participantOauthBindingCookie(tx.binding)), db, config, services("", { fetcher }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/participant/consent?slug=${slug}`);
    assert.equal(count(sqlite, "participant_sessions"), 0);
  } finally { sqlite.close(); }
});

test("missing or mismatched terms leave transaction unconsumed", async () => {
  for (const published of [false, true]) {
    const { sqlite, db } = fixture(published);
    try {
      const tx = await beginParticipantOauth(db, "/participant", now);
      let calls = 0;
      const opts = services("", { fetcher: async () => { calls++; throw new Error("should not fetch"); } });
      const conf = published ? { ...config, termsVersion: "other" } : config;
      const response = await participantOauthCallback(request(tx.state, participantOauthBindingCookie(tx.binding)), db, conf, opts);
      assert.equal(response.status, 503);
      assert.equal(calls, 0);
      assert.equal(count(sqlite, "participant_oauth_transactions"), 1);
      assert.equal(count(sqlite, "participant_pending_identities"), 0);
    } finally { sqlite.close(); }
  }
});

test("wrong binding, expired state and malformed or duplicate query fail before exchange", async (t) => {
  const cases = [
    ["wrong binding", (tx) => request(tx.state, participantOauthBindingCookie("a".repeat(64))), now],
    ["expired", (tx) => request(tx.state, participantOauthBindingCookie(tx.binding)), now + 300_000],
    ["duplicate state", (tx) => request(tx.state, participantOauthBindingCookie(tx.binding), "&state=" + tx.state), now],
    ["duplicate code", (tx) => request(tx.state, participantOauthBindingCookie(tx.binding), "&code=another"), now],
    ["empty code", (tx) => new Request(config.callbackUri + "?state=" + tx.state + "&code=", { headers: { Cookie: participantOauthBindingCookie(tx.binding).split(";")[0] } }), now],
    ["long code", (tx) => new Request(config.callbackUri + "?state=" + tx.state + "&code=" + "a".repeat(4097), { headers: { Cookie: participantOauthBindingCookie(tx.binding).split(";")[0] } }), now],
    ["error and code", (tx) => request(tx.state, participantOauthBindingCookie(tx.binding), "&error=access_denied"), now],
  ];
  for (const [name, makeRequest, clock] of cases) {
    await t.test(name, async () => {
      const { sqlite, db } = fixture();
      try {
        const tx = await beginParticipantOauth(db, "/participant", now);
        let calls = 0;
        const response = await participantOauthCallback(makeRequest(tx), db, config, services("", {
          nowMs: () => clock, fetcher: async () => { calls++; throw new Error("unexpected"); },
        }));
        assert.equal(response.status, 400);
        assert.equal(calls, 0);
        assert.equal(count(sqlite, "participant_oauth_transactions"), 1);
        assert.equal(response.headers.get("set-cookie"), null);
      } finally { sqlite.close(); }
    });
  }
});

test("bad signature, nonce, email verification, expiry and unknown key fail closed", async (t) => {
  for (const [name, overrides, keyStore] of [
    ["wrong nonce", { nonce: "attacker" }, null],
    ["unverified email", { email_verified: false }, null],
    ["expired token", { exp: now / 1000 }, null],
    ["wrong audience", { aud: "attacker" }, null],
    ["unknown key", {}, { async keysFor() { throw new Error("unknown"); } }],
    ["wrong signing key", {}, { async keysFor() { const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign","verify"]); return { keys: [{ ...await crypto.subtle.exportKey("jwk", other.publicKey), kid: "google-key-1" }] }; } }],
  ]) {
    await t.test(name, async () => {
      const { sqlite, db } = fixture();
      try {
        const tx = await beginParticipantOauth(db, "/participant", now);
        const token = await signedToken(tx.nonce, overrides);
        const response = await participantOauthCallback(request(tx.state, participantOauthBindingCookie(tx.binding)), db, config, services(token, keyStore ? { keyStore } : {}));
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("location"), null);
        assert.equal(count(sqlite, "participant_pending_identities"), 0);
        assert.equal(count(sqlite, "participant_sessions"), 0);
      } finally { sqlite.close(); }
    });
  }
});

test("token endpoint error, redirect, oversize and malicious header fail without leaking secrets", async (t) => {
  for (const [name, mode] of [["error", 500], ["redirect", 302], ["oversize", "large"], ["kid URL injection", "jku"], ["kid newline", "newline"]]) {
    await t.test(name, async () => {
      const { sqlite, db } = fixture();
      try {
        const tx = await beginParticipantOauth(db, "/participant", now);
        const header = mode === "jku" ? { jku: "https://evil.example/jwks" } : mode === "newline" ? { kid: "google-key-1\n" } : {};
        const token = await signedToken(tx.nonce, {}, header);
        const fetcher = async () => mode === "large"
          ? new Response("x".repeat(65_537), { status: 200 })
          : typeof mode === "number"
            ? new Response(null, { status: mode })
            : new Response(JSON.stringify({ id_token: token }), { status: 200 });
        const response = await participantOauthCallback(request(tx.state, participantOauthBindingCookie(tx.binding)), db, config, services(token, { fetcher }));
        assert.equal(response.status, 503);
        const output = await response.text();
        for (const secret of ["auth-code", config.clientSecret, token, tx.state]) assert.ok(!output.includes(secret));
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(count(sqlite, "participant_pending_identities"), 0);
      } finally { sqlite.close(); }
    });
  }
});

test("terms change during token exchange prevents pending creation", async () => {
  const { sqlite, db } = fixture();
  try {
    const tx = await beginParticipantOauth(db, "/participant", now);
    const token = await signedToken(tx.nonce);
    const fetcher = async () => {
      sqlite.prepare("INSERT INTO participant_terms VALUES (?, ?)").run("v2", "Changed terms");
      sqlite.prepare("UPDATE participant_terms_current SET version='v2' WHERE id=1").run();
      return new Response(JSON.stringify({ id_token: token }), { status: 200 });
    };
    const response = await participantOauthCallback(request(tx.state, participantOauthBindingCookie(tx.binding)), db, config, services(token, { fetcher }));
    assert.equal(response.status, 503);
    assert.equal(count(sqlite, "participant_pending_identities"), 0);
    assert.equal(count(sqlite, "participant_sessions"), 0);
  } finally { sqlite.close(); }
});

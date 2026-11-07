import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleKeyStore } from "../../app/google-keys.ts";

const discoveryUrl = "https://accounts.google.com/.well-known/openid-configuration";
const keysUrl = "https://www.googleapis.com/oauth2/v3/certs";
const discovery = { issuer: "https://accounts.google.com", jwks_uri: keysUrl };
const key = (kid) => ({ kid, kty: "RSA", n: "abc", e: "AQAB", use: "sig", alg: "RS256" });
const jsonResponse = (body, cache = "public, max-age=60") =>
  new Response(JSON.stringify(body), { status: 200, headers: { "cache-control": cache } });
const rejects = async (promise) => assert.rejects(promise, { message: "GOOGLE_KEYS_UNAVAILABLE" });

function fixture() {
  let time = 1_000_000;
  let keys = [key("old")];
  let networkFailure = false;
  let calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    if (networkFailure) throw new Error("offline");
    if (url === discoveryUrl) return jsonResponse(discovery);
    if (url === keysUrl) return jsonResponse({ keys });
    throw new Error("unexpected url");
  };
  const store = createGoogleKeyStore({ fetcher, nowMs: () => time });
  return {
    store, calls,
    advance(ms) { time += ms; },
    setKeys(value) { keys = value; },
    setOffline(value) { networkFailure = value; },
  };
}

test("uses only fixed endpoints and caches successful keys", async () => {
  const f = fixture();
  assert.equal((await f.store.keysFor("old")).keys[0].kid, "old");
  await f.store.keysFor("old");
  assert.deepEqual(f.calls, [{ url: discoveryUrl, redirect: "manual" }, { url: keysUrl, redirect: "manual" }]);
  const result = await f.store.keysFor("old");
  result.keys[0].kid = "tampered";
  assert.equal((await f.store.keysFor("old")).keys[0].kid, "old");
});

test("rotates keys with bounded unknown-kid refresh and concurrent sharing", async () => {
  const f = fixture();
  await f.store.keysFor("old");
  f.setKeys([key("new")]);
  await rejects(f.store.keysFor("new"));
  assert.equal(f.calls.length, 2);
  f.advance(30_000);
  const values = await Promise.all(Array.from({ length: 8 }, () => f.store.keysFor("new")));
  assert.ok(values.every((result) => result.keys[0].kid === "new"));
  assert.equal(f.calls.length, 4);
  await rejects(f.store.keysFor("old"));
  assert.equal(f.calls.length, 4);
});

test("expired keys fail closed during outage and retry is rate limited", async () => {
  const f = fixture();
  await f.store.keysFor("old");
  f.advance(60_000);
  f.setOffline(true);
  await rejects(f.store.keysFor("old"));
  assert.equal(f.calls.length, 3);
  await rejects(f.store.keysFor("old"));
  assert.equal(f.calls.length, 3);
  f.setOffline(false);
  f.advance(5_000);
  assert.equal((await f.store.keysFor("old")).keys[0].kid, "old");
});

test("uncached responses retain no key IDs and all subsequent refreshes are globally bounded", async () => {
  let now = 1000, calls = 0;
  const fetcher = async (url) => {
    calls++;
    return jsonResponse(url === discoveryUrl ? discovery : { keys: [key("old")] }, "no-store");
  };
  const store = createGoogleKeyStore({ fetcher, nowMs: () => now });
  await store.keysFor("old");
  await rejects(store.keysFor("unknown"));
  assert.equal(calls, 2);
  await rejects(store.keysFor("old"));
  assert.equal(calls, 2);
  now += 1_000;
  await rejects(store.keysFor("unknown"));
  assert.equal(calls, 4);
  await rejects(store.keysFor("another-unknown"));
  assert.equal(calls, 4);
  await rejects(store.keysFor("old"));
  now += 1_000;
  await store.keysFor("old");
  assert.equal(calls, 6);
});

test("rejects untrusted discovery, redirects, unexpected URL and network errors", async (t) => {
  const cases = [
    ["untrusted issuer", () => jsonResponse({ ...discovery, issuer: "https://evil.example" })],
    ["untrusted host", () => jsonResponse({ ...discovery, jwks_uri: "https://evil.example/oauth2/v3/certs" })],
    ["untrusted path", () => jsonResponse({ ...discovery, jwks_uri: keysUrl + "?redirect=evil" })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })],
    ["server failure", () => new Response("failure", { status: 503 })],
    ["non-JSON", () => new Response("{bad", { status: 200 })],
    ["network error", () => { throw new Error("offline"); }],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const store = createGoogleKeyStore({ fetcher: async () => response(), nowMs: () => 1000 });
      await rejects(store.keysFor("old"));
    });
  }
});

test("rejects malformed and excessive JWKS documents", async (t) => {
  const cases = [
    ["no keys", { keys: [] }],
    ["too many keys", { keys: Array.from({ length: 33 }, (_, i) => key(String(i))) }],
    ["duplicate kid", { keys: [key("old"), key("old")] }],
    ["empty kid", { keys: [key("")] }],
    ["wrong usage", { keys: [{ ...key("old"), use: "enc" }] }],
    ["wrong algorithm", { keys: [{ ...key("old"), alg: "none" }] }],
    ["bad modulus", { keys: [{ ...key("old"), n: "!bad" }] }],
    ["missing key list", {}],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const fetcher = async (url) => jsonResponse(url === discoveryUrl ? discovery : body);
      await rejects(createGoogleKeyStore({ fetcher, nowMs: () => 1000 }).keysFor("old"));
    });
  }
  const fetcher = async (url) => url === discoveryUrl
    ? jsonResponse(discovery)
    : new Response("x".repeat(65_537), { status: 200 });
  await rejects(createGoogleKeyStore({ fetcher, nowMs: () => 1000 }).keysFor("old"));
});

test("cache respects maximum lifetime, age, no-store and absent cache headers", async (t) => {
  for (const [label, control, age, elapsed, expectedCalls] of [
    ["maximum capped", "max-age=999999", null, 3_600_000, 4],
    ["age reduces lifetime", "max-age=60", "40", 20_000, 4],
    ["no-store", "no-store, max-age=60", null, 0, 4],
    ["parameterized no-cache", 'no-cache="private-field", max-age=60', null, 0, 4],
    ["malformed quoted max-age", 'max-age="60', null, 0, 4],
    ["quoted max-age", 'max-age="60"', null, 59_000, 2],
    ["missing max-age", "public", null, 0, 4],
    ["within lifetime", "max-age=60", null, 59_000, 2],
  ]) {
    await t.test(label, async () => {
      let now = 500_000, calls = 0;
      const fetcher = async (url) => {
        calls++;
        if (url === discoveryUrl) return jsonResponse(discovery);
        const headers = { "cache-control": control };
        if (age !== null) headers.age = age;
        return new Response(JSON.stringify({ keys: [key("old")] }), { headers });
      };
      const store = createGoogleKeyStore({ fetcher, nowMs: () => now });
      await store.keysFor("old");
      now += elapsed;
      if (expectedCalls === 4 && elapsed === 0) {
        await rejects(store.keysFor("old"));
        now += 1_000;
      }
      await store.keysFor("old");
      assert.equal(calls, expectedCalls);
    });
  }
});

test("JWKS response age includes request and body time, and stale responses are rejected", async () => {
  for (const [fetchDelay, bodyDelay, age, dateOffset, expected] of [
    [1_000, 1_000, "0", 0, true],
    [2_000, 4_000, "0", 0, false],
    [0, 1_000, "4", 0, false],
    [0, 0, "0", -6_000, false],
  ]) {
    let now = 1_700_000_000_000;
    const started = now;
    const fetcher = async (url) => {
      if (url === discoveryUrl) return jsonResponse(discovery);
      now += fetchDelay;
      const payload = new TextEncoder().encode(JSON.stringify({ keys: [key("old")] }));
      const stream = new ReadableStream({
        pull(controller) {
          now += bodyDelay;
          controller.enqueue(payload);
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "cache-control": "max-age=5", age, date: new Date(started + dateOffset).toUTCString() },
      });
    };
    const store = createGoogleKeyStore({ fetcher, nowMs: () => now });
    if (expected) assert.equal((await store.keysFor("old")).keys[0].kid, "old");
    else await rejects(store.keysFor("old"));
  }
});

test("remaining cache lifetime never exceeds server max-age after delayed body", async () => {
  let now = 1_700_000_000_000, calls = 0;
  const fetcher = async (url) => {
    calls++;
    if (url === discoveryUrl) return jsonResponse(discovery);
    const date = new Date(now).toUTCString();
    const payload = new TextEncoder().encode(JSON.stringify({ keys: [key("old")] }));
    const stream = new ReadableStream({
      pull(controller) {
        now += 2_000;
        controller.enqueue(payload);
        controller.close();
      },
    });
    return new Response(stream, { headers: { "cache-control": "max-age=10", date } });
  };
  const store = createGoogleKeyStore({ fetcher, nowMs: () => now });
  await store.keysFor("old");
  now += 5_000;
  await store.keysFor("old");
  assert.equal(calls, 2);
  now += 1_000;
  await store.keysFor("old");
  assert.equal(calls, 4);
});

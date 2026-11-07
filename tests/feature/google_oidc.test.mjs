import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { verifyGoogleIdToken } from "../../app/google-oidc.ts";

const crypto = globalThis.crypto ?? webcrypto;
const now = 1_700_000_000;
const audience = "test-client.apps.googleusercontent.com";
const nonce = "one-time-test-nonce";
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...await crypto.subtle.exportKey("jwk", keyPair.publicKey), kid: "key-1", alg: "RS256", use: "sig" };
const options = { audience, nonce, nowSeconds: now, jwks: { keys: [publicJwk] } };
const header = { alg: "RS256", kid: "key-1", typ: "JWT" };
const claims = {
  iss: "https://accounts.google.com", aud: audience, exp: now + 3600, iat: now - 30,
  nonce, sub: "google-unique-sub", email: "member@example.com", email_verified: true, name: "Member",
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function sign(claimOverrides = {}, headerOverrides = {}) {
  const content = `${encode({ ...header, ...headerOverrides })}.${encode({ ...claims, ...claimOverrides })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(content));
  return `${content}.${Buffer.from(signature).toString("base64url")}`;
}
async function rejects(token, opts = options) {
  await assert.rejects(verifyGoogleIdToken(token, opts), { message: "INVALID_GOOGLE_ID_TOKEN" });
}

test("accepts signed identity, alternate Google issuer and correct multi-audience azp", async () => {
  assert.deepEqual(await verifyGoogleIdToken(await sign(), options), {
    sub: "google-unique-sub", email: "member@example.com", name: "Member",
  });
  const token = await sign({ iss: "accounts.google.com", aud: [audience, "another-client"], azp: audience });
  assert.equal((await verifyGoogleIdToken(token, options)).sub, "google-unique-sub");
});

test("rejects invalid identity and security claims", async (t) => {
  const cases = [
    ["wrong issuer", { iss: "https://other.example" }],
    ["wrong audience", { aud: "other-client" }],
    ["missing azp", { aud: [audience, "other-client"] }],
    ["wrong azp", { azp: "other-client" }],
    ["malformed audience array", { aud: [audience, 1] }],
    ["expired", { exp: now }],
    ["invalid exp", { exp: "1700000001" }],
    ["future issued-at", { iat: now + 61 }],
    ["issued after expiry", { iat: now + 1000, exp: now + 900 }],
    ["future not-before", { nbf: now + 1 }],
    ["invalid not-before", { nbf: "tomorrow" }],
    ["wrong nonce", { nonce: "wrong" }],
    ["missing nonce", { nonce: undefined }],
    ["empty subject", { sub: "" }],
    ["overlong subject", { sub: "x".repeat(256) }],
    ["unverified email", { email_verified: false }],
    ["missing verified email", { email_verified: undefined }],
    ["missing email", { email: undefined }],
    ["invalid name", { name: 4 }],
  ];
  for (const [name, badClaims] of cases) {
    await t.test(name, async () => rejects(await sign(badClaims)));
  }
});

test("rejects JOSE header, key and signature changes", async (t) => {
  for (const [name, headerOverride] of [
    ["wrong algorithm", { alg: "none" }],
    ["missing key id", { kid: undefined }],
    ["wrong key id", { kid: "other" }],
    ["critical extensions", { crit: ["exp"] }],
    ["unencoded payload", { b64: false }],
    ["wrong type", { typ: "not-jwt" }],
  ]) await t.test(name, async () => rejects(await sign({}, headerOverride)));

  const token = await sign();
  for (const [name, keys] of [
    ["missing key", []],
    ["duplicate kid", [publicJwk, publicJwk]],
    ["wrong use", [{ ...publicJwk, use: "enc" }]],
    ["wrong key type", [{ ...publicJwk, kty: "EC" }]],
    ["wrong key algorithm", [{ ...publicJwk, alg: "RS512" }]],
    ["wrong key operation", [{ ...publicJwk, key_ops: ["sign"] }]],
    ["invalid RSA modulus", [{ ...publicJwk, n: "AQ" }]],
  ]) await t.test(name, async () => rejects(token, { ...options, jwks: { keys } }));

  const parts = token.split(".");
  parts[1] = encode({ ...claims, sub: "attacker" });
  await rejects(parts.join("."));
});

test("rejects malformed tokens and configuration", async () => {
  for (const token of ["", "a.b", "a.b.c.d", "a*.b.c", "x".repeat(16_385), `${encode(header)}.${encode([])}.eA`]) {
    await rejects(token);
  }
  const token = await sign();
  await rejects(token, { ...options, audience: "" });
  await rejects(token, { ...options, nonce: "" });
  await rejects(token, { ...options, nowSeconds: NaN });
  await rejects(token, { ...options, jwks: { keys: [] } });
});

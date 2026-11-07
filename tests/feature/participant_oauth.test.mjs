import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  beginParticipantOauth, consumeParticipantOauth, participantOauthBindingCookie,
  clearParticipantOauthBindingCookie, PARTICIPANT_OAUTH_COOKIE, OAUTH_TRANSACTION_SECONDS,
} from "../../app/participant-oauth.ts";
import {
  createParticipantSession, getParticipantSession, deleteParticipantSession,
  participantSessionCookie, clearParticipantSessionCookie, PARTICIPANT_SESSION_COOKIE, PARTICIPANT_SESSION_SECONDS,
} from "../../app/participant-session.ts";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const migration of readdirSync("drizzle").filter((name) => /^000[0-8].*[.]sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync("drizzle/" + migration, "utf8"));
  }
  sqlite.prepare("INSERT INTO participants VALUES (?,?,?,?,?)")
    .run("p1", "google-id", "user@example.com", "User", "2026-11-07");
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              const row = sqlite.prepare(sql).get(...values);
              return row ? { ...row } : null;
            },
            async run() { return sqlite.prepare(sql).run(...values); },
          };
        },
      };
    },
  };
  return { sqlite, db };
}
const header = (cookie) => cookie.split(";")[0];
const sha256hex = (value) => createHash("sha256").update(value).digest("hex");
const now = 1_700_000_000_000;

test("transaction is browser bound, PKCE S256 and one-time", async () => {
  const { db, sqlite } = fixture();
  try {
    const tx = await beginParticipantOauth(db, "/participant/qr", now);
    const values = [tx.state, tx.binding, tx.nonce];
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.every((value) => /^[a-f0-9]{64}$/.test(value)));
    assert.equal(tx.codeChallengeMethod, "S256");
    const stored = sqlite.prepare("SELECT * FROM participant_oauth_transactions").get();
    assert.equal(stored.state_hash, sha256hex(tx.state));
    assert.equal(stored.binding_hash, sha256hex(tx.binding));
    assert.notEqual(stored.state_hash, tx.state);
    assert.notEqual(stored.binding_hash, tx.binding);
    assert.match(stored.code_verifier, /^[a-f0-9]{64}$/);
    assert.equal(tx.codeChallenge, createHash("sha256").update(stored.code_verifier).digest("base64url"));
    assert.equal(stored.expires_at, now + OAUTH_TRANSACTION_SECONDS * 1_000);

    const bindingCookie = participantOauthBindingCookie(tx.binding);
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=300"]) {
      assert.ok(bindingCookie.includes(attribute));
    }
    assert.ok(bindingCookie.startsWith(PARTICIPANT_OAUTH_COOKIE + "="));
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      consumeParticipantOauth(db, tx.state, header(bindingCookie), now + 1_000)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), { nonce: tx.nonce, codeVerifier: stored.code_verifier, returnPath: "/participant/qr" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM participant_oauth_transactions").get().count, 0);
    assert.equal(await consumeParticipantOauth(db, tx.state, header(bindingCookie), now + 1_000), null);
  } finally { sqlite.close(); }
});

test("wrong binding, invalid state and duplicate cookie cannot consume transaction", async () => {
  const { db, sqlite } = fixture();
  try {
    const tx = await beginParticipantOauth(db, "/participant", now);
    const valid = header(participantOauthBindingCookie(tx.binding));
    const wrong = PARTICIPANT_OAUTH_COOKIE + "=" + "a".repeat(64);
    assert.equal(await consumeParticipantOauth(db, tx.state, wrong, now), null);
    assert.equal(await consumeParticipantOauth(db, "wrong", valid, now), null);
    assert.equal(await consumeParticipantOauth(db, tx.state + "\n", valid, now), null);
    assert.equal(await consumeParticipantOauth(db, tx.state, valid + "; " + valid, now), null);
    assert.throws(() => participantOauthBindingCookie(tx.binding + "\n"), { message: "INVALID_OAUTH_BINDING" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM participant_oauth_transactions").get().count, 1);
    assert.ok(await consumeParticipantOauth(db, tx.state, valid, now));
  } finally { sqlite.close(); }
});

test("expired transaction fails and return path rejects open redirects", async (t) => {
  const { db, sqlite } = fixture();
  try {
    const tx = await beginParticipantOauth(db, "/participant", now);
    assert.equal(await consumeParticipantOauth(db, tx.state, header(participantOauthBindingCookie(tx.binding)), now + OAUTH_TRANSACTION_SECONDS * 1_000), null);
    for (const path of ["//evil.test", "/\\\\evil.test", "/participant/%2f%2fevil", "/participant/../admin", "https://evil.test", "/admin", "/participant?next=https://evil.test", "/participant\n", "/participant\r"]) {
      await t.test(JSON.stringify(path), async () => assert.rejects(beginParticipantOauth(db, path, now), { message: "INVALID_OAUTH_TRANSACTION" }));
    }
    assert.ok(clearParticipantOauthBindingCookie().includes("Max-Age=0"));
  } finally { sqlite.close(); }
});

test("participant session is isolated, expires and logs out", async () => {
  const { db, sqlite } = fixture();
  try {
    const token = await createParticipantSession(db, "p1", now);
    const cookie = participantSessionCookie(token);
    const stored = sqlite.prepare("SELECT * FROM participant_sessions").get();
    assert.equal(stored.token_hash, sha256hex(token));
    assert.notEqual(stored.token_hash, token);
    assert.ok(cookie.startsWith(PARTICIPANT_SESSION_COOKIE + "="));
    assert.throws(() => participantSessionCookie(token + "\n"), { message: "INVALID_PARTICIPANT_COOKIE" });
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${PARTICIPANT_SESSION_SECONDS}`]) {
      assert.ok(cookie.includes(attribute));
    }
    assert.deepEqual(await getParticipantSession(db, "puzzle_admin_session=" + token, now), null);
    assert.deepEqual(await getParticipantSession(db, header(cookie), now), { participantId: "p1" });
    assert.equal(await getParticipantSession(db, header(cookie), now + PARTICIPANT_SESSION_SECONDS * 1_000), null);
    assert.equal(await getParticipantSession(db, header(cookie) + "; " + header(cookie), now), null);
    await deleteParticipantSession(db, header(cookie));
    assert.equal(await getParticipantSession(db, header(cookie), now), null);
    assert.ok(clearParticipantSessionCookie().includes("Max-Age=0"));
    await assert.rejects(createParticipantSession(db, "missing-participant", now));
  } finally { sqlite.close(); }
});

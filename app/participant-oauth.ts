// Node's native TypeScript test runner requires this explicit extension; the
// project bundler resolves it normally without changing shared tsconfig.
// @ts-expect-error TS5097: the repo does not enable allowImportingTsExtensions.
import { randomSecret, readCookie, secretHash } from "./participant-session.ts";

export const PARTICIPANT_OAUTH_COOKIE = "__Host-puzzle-participant-oauth";
export const OAUTH_TRANSACTION_SECONDS = 5 * 60;

function safeReturnPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 256 &&
    !/[\x00-\x20\x7f]/.test(path) &&
    (/^\/participant(?:\/[A-Za-z0-9_-]+)*\/?$/.test(path) ||
      /^\/participant\/register\?slug=[a-f0-9]{32}$/.test(path));
}

function validTime(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 && Number.isSafeInteger(nowMs + OAUTH_TRANSACTION_SECONDS * 1_000);
}

export function participantOauthBindingCookie(binding: string): string {
  if (binding.length !== 64 || !/^[a-f0-9]{64}$/.test(binding)) throw new Error("INVALID_OAUTH_BINDING");
  return `${PARTICIPANT_OAUTH_COOKIE}=${binding}; Path=/; Max-Age=${OAUTH_TRANSACTION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearParticipantOauthBindingCookie(): string {
  return `${PARTICIPANT_OAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function beginParticipantOauth(db: D1Database, returnPath: string, nowMs = Date.now()) {
  if (!safeReturnPath(returnPath) || !validTime(nowMs)) throw new Error("INVALID_OAUTH_TRANSACTION");
  const state = randomSecret();
  const binding = randomSecret();
  const nonce = randomSecret();
  const codeVerifier = randomSecret();
  const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const row = await db.prepare(
    "INSERT INTO participant_oauth_transactions (state_hash,binding_hash,nonce,code_verifier,return_path,expires_at) VALUES (?,?,?,?,?,?) RETURNING state_hash",
  ).bind(await secretHash(state), await secretHash(binding), nonce, codeVerifier, returnPath, nowMs + OAUTH_TRANSACTION_SECONDS * 1_000).first();
  if (!row) throw new Error("OAUTH_TRANSACTION_CREATE_FAILED");
  return { state, binding, nonce, codeChallenge: challenge, codeChallengeMethod: "S256" as const };
}

export async function consumeParticipantOauth(db: D1Database, state: unknown, cookieHeader: string | null, nowMs = Date.now()): Promise<{ nonce: string; codeVerifier: string; returnPath: string } | null> {
  const binding = readCookie(cookieHeader, PARTICIPANT_OAUTH_COOKIE);
  if (typeof state !== "string" || state.length !== 64 || !/^[a-f0-9]{64}$/.test(state) || !binding || !validTime(nowMs)) return null;
  const row = await db.prepare(
    "DELETE FROM participant_oauth_transactions WHERE state_hash=? AND binding_hash=? AND expires_at>? RETURNING nonce,code_verifier AS codeVerifier,return_path AS returnPath",
  ).bind(await secretHash(state), await secretHash(binding), nowMs).first<{ nonce: string; codeVerifier: string; returnPath: string }>();
  if (!row || !safeReturnPath(row.returnPath)) return null;
  return row;
}

// These imports retain .ts extensions for the native Node TypeScript tests.
// @ts-expect-error TS5097: the shared tsconfig does not enable allowImportingTsExtensions.
import { beginParticipantOauth, participantOauthBindingCookie } from "./participant-oauth.ts";
// @ts-expect-error TS5097: the shared tsconfig does not enable allowImportingTsExtensions.
import { secretHash } from "./participant-session.ts";

type StartConfig = {
  clientId: string;
  origin: string;
  callbackUri: string;
  consentVersion: string;
};

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_LIMIT = 10;
const CLEANUP_LIMIT = 100;
const COMMON_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function error(status: number): Response {
  return Response.json({ error: "登入目前無法使用" }, { status, headers: COMMON_HEADERS });
}

function validConfig(config: StartConfig | null): config is StartConfig {
  if (!config || typeof config.clientId !== "string" || config.clientId.length > 200 ||
      !/^[0-9]{1,32}-[a-z0-9]{1,128}\.apps\.googleusercontent\.com$/.test(config.clientId) ||
      typeof config.origin !== "string" || typeof config.callbackUri !== "string" ||
      typeof config.consentVersion !== "string" || config.consentVersion.length > 80 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.consentVersion) ||
      /[\x00-\x20\x7f]/.test(config.clientId + config.origin + config.callbackUri + config.consentVersion)) return false;
  try {
    const origin = new URL(config.origin);
    const callback = new URL(config.callbackUri);
    return origin.protocol === "https:" && origin.origin === config.origin &&
      !origin.username && !origin.password && callback.protocol === "https:" &&
      callback.origin === config.origin && !callback.username && !callback.password &&
      callback.pathname === "/api/participant/auth/callback" && !callback.search && !callback.hash &&
      callback.href === config.callbackUri;
  } catch {
    return false;
  }
}

/**
 * Internal start handler for a future, fully configured integration.
 * The caller supplies trusted server configuration. The consentVersion is a
 * configuration precondition only; invoking this function does not record or
 * imply user consent. Public routing remains disabled until callback,
 * authorization and consent flows are implemented and reviewed.
 */
export async function participantOauthStart(
  request: Request,
  db: D1Database | null,
  config: StartConfig | null,
  nowMs = Date.now(),
): Promise<Response> {
  if (!db || !validConfig(config) || !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(nowMs + 300_000)) return error(503);
  if (request.method !== "POST") return error(405);
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return error(403);
  }
  if (requestOrigin !== config.origin || request.headers.get("Origin") !== config.origin) return error(403);

  try {
    let returnPath = "/participant";
    if (request.body) {
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) return error(400);
      const length = request.headers.get("Content-Length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 37)) return error(400);
      const reader = request.body.getReader();
      let bytes = 0, body = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 37) { await reader.cancel().catch(() => undefined); return error(400); }
          body += new TextDecoder("utf-8", { fatal: true }).decode(part.value);
        }
      } catch { return error(400); } finally { reader.releaseLock(); }
      if (!/^slug=[a-f0-9]{32}$/.test(body)) return error(400);
      returnPath = `/participant/register?${body}`;
    }
    // Cloudflare supplies this header at the edge. Forwarded headers and body
    // values are intentionally ignored; direct/local requests share a bucket.
    const address = request.headers.get("cf-connecting-ip") ?? "";
    const source = address.length <= 45 && /^[0-9a-f:.]+$/i.test(address) ? address.toLowerCase() : "shared";
    const rateKey = "participant-oauth-start:" + await secretHash(source);
    const rate = await db.prepare(
      "INSERT INTO auth_attempts (key,attempts,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING attempts",
    ).bind(rateKey, nowMs, nowMs - RATE_WINDOW_MS, nowMs - RATE_WINDOW_MS).first<{ attempts: number }>();
    if (!rate || rate.attempts > RATE_LIMIT) return error(429);
    await db.prepare(
      "DELETE FROM participant_oauth_transactions WHERE state_hash IN (SELECT state_hash FROM participant_oauth_transactions WHERE expires_at<=? ORDER BY expires_at LIMIT ?)",
    ).bind(nowMs, CLEANUP_LIMIT).run();
    const transaction = await beginParticipantOauth(db, returnPath, nowMs);
    const target = new URL(GOOGLE_AUTHORIZE);
    target.searchParams.set("client_id", config.clientId);
    target.searchParams.set("redirect_uri", config.callbackUri);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", "openid email profile");
    target.searchParams.set("state", transaction.state);
    target.searchParams.set("nonce", transaction.nonce);
    target.searchParams.set("code_challenge", transaction.codeChallenge);
    target.searchParams.set("code_challenge_method", transaction.codeChallengeMethod);
    return new Response(null, {
      status: 303,
      headers: { ...COMMON_HEADERS, Location: target.href, "Set-Cookie": participantOauthBindingCookie(transaction.binding) },
    });
  } catch {
    return error(503);
  }
}

// Explicit extensions are required by Node's native TypeScript test runner.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { consumeParticipantOauth, clearParticipantOauthBindingCookie } from "./participant-oauth.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { getPublishedParticipantTerms, createPendingParticipant, participantPendingCookie } from "./participant-consent.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { verifyGoogleIdToken } from "./google-oidc.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { secretHash } from "./participant-session.ts";

type CallbackConfig = {
  clientId: string;
  clientSecret: string;
  origin: string;
  callbackUri: string;
  termsVersion: string;
};

type CallbackServices = {
  fetcher: typeof fetch;
  keyStore: { keysFor(kid: string): Promise<{ keys: (JsonWebKey & { kid?: string })[] }> };
  nowMs?: () => number;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_TOKEN_BODY_BYTES = 65_536;
const MAX_ID_TOKEN_LENGTH = 16_384;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function failure(status: number): Response {
  return Response.json({ error: "登入目前無法完成" }, { status, headers: HEADERS });
}

function validConfig(config: CallbackConfig | null): config is CallbackConfig {
  if (!config || typeof config.clientId !== "string" || config.clientId.length > 200 ||
      !/^[0-9]{1,32}-[a-z0-9]{1,128}\.apps\.googleusercontent\.com$/.test(config.clientId) ||
      typeof config.clientSecret !== "string" || !config.clientSecret || config.clientSecret.length > 2048 ||
      typeof config.origin !== "string" || typeof config.callbackUri !== "string" ||
      typeof config.termsVersion !== "string" || config.termsVersion.length > 80 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.termsVersion) ||
      /[\x00-\x20\x7f]/.test(config.clientId + config.clientSecret + config.origin + config.callbackUri + config.termsVersion)) return false;
  try {
    const origin = new URL(config.origin);
    const callback = new URL(config.callbackUri);
    return origin.protocol === "https:" && origin.origin === config.origin &&
      !origin.username && !origin.password && callback.protocol === "https:" &&
      callback.origin === config.origin && !callback.username && !callback.password &&
      callback.pathname === "/api/participant/auth/callback" && !callback.search &&
      !callback.hash && callback.href === config.callbackUri;
  } catch {
    return false;
  }
}

function tokenKid(token: string): string {
  if (token.length > MAX_ID_TOKEN_LENGTH) throw new Error("INVALID_TOKEN");
  const parts = token.split(".");
  const segment = parts[0];
  if (parts.length !== 3 || !segment || segment.length > 4_096 ||
      !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) throw new Error("INVALID_TOKEN");
  const decoded = atob(segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "="));
  const canonical = btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (canonical !== segment) throw new Error("INVALID_TOKEN");
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("INVALID_TOKEN");
  const fields = header as Record<string, unknown>;
  if (fields.alg !== "RS256" || typeof fields.kid !== "string" ||
      fields.kid.length < 1 || fields.kid.length > 256 || !/^[\x21-\x7e]+$/.test(fields.kid) ||
      /[\x00-\x20\x7f]/.test(fields.kid) ||
      fields.jku !== undefined || fields.x5u !== undefined) throw new Error("INVALID_TOKEN");
  return fields.kid;
}

async function exchangeCode(fetcher: typeof fetch, code: string, verifier: string, config: CallbackConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, code_verifier: verifier,
    client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.callbackUri,
  });
  const response = await fetcher(TOKEN_URL, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (response.status !== 200 || response.redirected || (response.url && response.url !== TOKEN_URL)) throw new Error("TOKEN_EXCHANGE_FAILED");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_TOKEN_BODY_BYTES)) throw new Error("TOKEN_EXCHANGE_FAILED");
  if (!response.body) throw new Error("TOKEN_EXCHANGE_FAILED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOKEN_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("TOKEN_EXCHANGE_FAILED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TOKEN_EXCHANGE_FAILED");
  const idToken = (value as Record<string, unknown>).id_token;
  if (typeof idToken !== "string" || !idToken || idToken.length > MAX_ID_TOKEN_LENGTH) throw new Error("TOKEN_EXCHANGE_FAILED");
  return idToken;
}

/**
 * Internal handler only. Config, fetch and key store must be supplied by
 * trusted server code; never derive any of them from the request or ID token.
 * Successful verification creates only a pending identity, not a session or
 * an accepted consent. The public route remains disabled.
 */
export async function participantOauthCallback(
  request: Request,
  db: D1Database | null,
  config: CallbackConfig | null,
  services: CallbackServices,
): Promise<Response> {
  if (!db || !validConfig(config) || !services || typeof services.fetcher !== "function" ||
      typeof services.keyStore?.keysFor !== "function") return failure(503);
  if (request.method !== "GET") return failure(405);
  const clock = services.nowMs ?? Date.now;
  try {
    const url = new URL(request.url);
    if (url.origin !== config.origin || url.pathname !== "/api/participant/auth/callback") return failure(403);
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    if (url.searchParams.has("error") || states.length !== 1 || codes.length !== 1 || !/^[a-f0-9]{64}$/.test(states[0]) || states[0].length !== 64 ||
        !codes[0] || codes[0].length > 4_096 || /[\x00-\x20\x7f]/.test(codes[0])) return failure(400);
    const terms = await getPublishedParticipantTerms(db);
    if (!terms || terms.version !== config.termsVersion) return failure(503);
    const transaction = await consumeParticipantOauth(db, states[0], request.headers.get("Cookie"), clock());
    if (!transaction) return failure(400);
    const idToken = await exchangeCode(services.fetcher, codes[0], transaction.codeVerifier, config);
    const kid = tokenKid(idToken);
    const keys = await services.keyStore.keysFor(kid);
    const identity = await verifyGoogleIdToken(idToken, {
      audience: config.clientId, nonce: transaction.nonce, nowSeconds: Math.floor(clock() / 1_000), jwks: keys,
    });
    const currentTerms = await getPublishedParticipantTerms(db);
    if (!currentTerms || currentTerms.version !== config.termsVersion) return failure(503);
    const pending = await createPendingParticipant(db, identity, clock());
    if (!pending) return failure(503);
    if (pending.terms.version !== config.termsVersion) {
      await db.prepare("DELETE FROM participant_pending_identities WHERE token_hash=?").bind(await secretHash(pending.token)).run();
      return failure(503);
    }
    const headers = new Headers({ ...HEADERS, Location: "/participant/consent" });
    headers.append("Set-Cookie", participantPendingCookie(pending.token));
    headers.append("Set-Cookie", clearParticipantOauthBindingCookie());
    return new Response(null, { status: 303, headers });
  } catch {
    return failure(503);
  }
}

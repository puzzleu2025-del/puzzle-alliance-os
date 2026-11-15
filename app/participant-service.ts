// Server-side adapter: configuration is supplied only by the deployment.
// Explicit extensions keep the isolated Node tests usable.
// @ts-expect-error TS5097: native TypeScript tests require the extension.
import { participantRegistrationHttp } from "./participant-registration-http.ts";
// @ts-expect-error TS5097: native TypeScript tests require the extension.
import { participantConsentHttp, participantWithdrawHttp } from "./participant-consent-http.ts";
// @ts-expect-error TS5097: native TypeScript tests require the extension.
import { participantOauthStart } from "./participant-oauth-start.ts";
// @ts-expect-error TS5097: native TypeScript tests require the extension.
import { participantOauthCallback } from "./participant-oauth-callback.ts";
// @ts-expect-error TS5097: native TypeScript tests require the extension.
import { createGoogleKeyStore } from "./google-keys.ts";

type Operation = "registration" | "mine" | "prefill" | "qr-issue" | "qr-revoke" | "consent" | "withdraw" | "auth-start" | "auth-callback" | "remittance";
type Settings = {
  DB?: D1Database;
  PARTICIPANT_ENABLED?: string;
  PARTICIPANT_ORIGIN?: string;
  PARTICIPANT_GOOGLE_CLIENT_ID?: string;
  PARTICIPANT_GOOGLE_CLIENT_SECRET?: string;
  PARTICIPANT_TERMS_VERSION?: string;
  PARTICIPANT_TRUST_CLOUDFLARE_EDGE?: string;
};

const keys = createGoogleKeyStore();
const unavailable = () => Response.json({ error: "目前無法使用，請稍後再試" }, {
  status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" },
});

function config(env: Settings | null) {
  if (!env || env.PARTICIPANT_ENABLED !== "true" || !env.DB || typeof env.DB.prepare !== "function") return null;
  const origin = env.PARTICIPANT_ORIGIN;
  const clientId = env.PARTICIPANT_GOOGLE_CLIENT_ID;
  const clientSecret = env.PARTICIPANT_GOOGLE_CLIENT_SECRET;
  const termsVersion = env.PARTICIPANT_TERMS_VERSION;
  if (typeof origin !== "string" || typeof clientId !== "string" || typeof clientSecret !== "string" ||
      typeof termsVersion !== "string" || !/^[0-9]{1,32}-[a-z0-9]{1,128}\.apps\.googleusercontent\.com$/.test(clientId) ||
      !clientSecret || clientSecret.length > 2048 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(termsVersion) ||
      /[\x00-\x20\x7f]/.test(origin + clientId + clientSecret + termsVersion) ||
      (env.PARTICIPANT_TRUST_CLOUDFLARE_EDGE !== undefined && env.PARTICIPANT_TRUST_CLOUDFLARE_EDGE !== "true" && env.PARTICIPANT_TRUST_CLOUDFLARE_EDGE !== "false")) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) return null;
  } catch { return null; }
  return { db: env.DB, origin, clientId, clientSecret, termsVersion,
    callbackUri: origin + "/api/participant/auth/callback",
    trustedCloudflareEdge: env.PARTICIPANT_TRUST_CLOUDFLARE_EDGE === "true" };
}

export async function invokeParticipantService(request: Request, environment: Settings | null, operation: Operation): Promise<Response> {
  const c = config(environment);
  if (!c) return unavailable();
  if (operation === "auth-start") return participantOauthStart(request, c.db, {
    origin: c.origin, callbackUri: c.callbackUri, clientId: c.clientId, consentVersion: c.termsVersion,
    trustedCloudflareEdge: c.trustedCloudflareEdge,
  });
  if (operation === "auth-callback") return participantOauthCallback(request, c.db, {
    origin: c.origin, callbackUri: c.callbackUri, clientId: c.clientId, clientSecret: c.clientSecret, termsVersion: c.termsVersion,
  }, { fetcher: fetch, keyStore: keys });
  if (operation === "consent") return participantConsentHttp(request, c.db, { origin: c.origin });
  if (operation === "withdraw") return participantWithdrawHttp(request, c.db, { origin: c.origin });
  return participantRegistrationHttp(request, c.db, { origin: c.origin, trustedCloudflareEdge: c.trustedCloudflareEdge }, operation);
}

export async function participantService(request: Request, operation: Operation): Promise<Response> {
  try {
    const runtime = await import("cloudflare:workers");
    return await invokeParticipantService(request, runtime.env as Settings, operation);
  } catch { return unavailable(); }
}

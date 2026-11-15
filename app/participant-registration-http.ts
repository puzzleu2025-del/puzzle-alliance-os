// Explicit extensions support isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { submitParticipantRegistration } from "./participant-registration.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { issueParticipantQr, revokeParticipantQr } from "./participant-qr.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { secretHash } from "./participant-session.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { getParticipantProfilePrefill } from "./participant-profile-prefill.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { listMyRegistrations } from "./participant-my-registrations.ts";

type ServerConfig = {
  origin: string;
  /** Set only when the deployment guarantees Cloudflare overwrites this header. */
  trustedCloudflareEdge?: boolean;
};
type Operation = "registration" | "qr-issue" | "qr-revoke" | "prefill" | "mine";

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 30;
const CLEANUP_LIMIT = 100;

function failure(status: number): Response {
  return Response.json({ error: "目前無法完成操作" }, { status, headers: HEADERS });
}

function validConfig(config: ServerConfig | null): config is ServerConfig {
  if (!config || typeof config.origin !== "string" ||
      (config.trustedCloudflareEdge !== undefined && typeof config.trustedCloudflareEdge !== "boolean") ||
      /[\x00-\x20\x7f]/.test(config.origin)) return false;
  try {
    const origin = new URL(config.origin);
    return origin.protocol === "https:" && origin.origin === config.origin && !origin.username && !origin.password;
  } catch {
    return false;
  }
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new Error("INVALID_BODY");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error("INVALID_BODY");
  if (!request.body) throw new Error("INVALID_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("INVALID_BODY");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function rateAllowed(db: D1Database, request: Request, config: ServerConfig, operation: Operation): Promise<boolean> {
  const address = config.trustedCloudflareEdge === true ? request.headers.get("cf-connecting-ip") ?? "" : "";
  const source = address.length <= 45 && /^[0-9a-f:.]+$/i.test(address) ? address.toLowerCase() : "shared";
  const prefix = `participant-${operation}-http:`;
  const key = prefix + await secretHash(source);
  const cleanup = await db.prepare(
    `DELETE FROM auth_attempts WHERE key IN (SELECT key FROM auth_attempts WHERE key>=? AND key<? AND window_start<=${DB_NOW}-? ORDER BY window_start LIMIT ?)`,
  ).bind(prefix, prefix + "~", WINDOW_MS, CLEANUP_LIMIT).run();
  if (!cleanup.success) throw new Error("RATE_CLEANUP_FAILED");
  const rate = await db.prepare(
    `INSERT INTO auth_attempts (key,attempts,window_start) VALUES (?,1,${DB_NOW}) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=${DB_NOW}-? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=${DB_NOW}-? THEN excluded.window_start ELSE window_start END RETURNING attempts`,
  ).bind(key, WINDOW_MS, WINDOW_MS).first<{ attempts: number }>();
  return !!rate && Number.isSafeInteger(rate.attempts) && rate.attempts > 0 && rate.attempts <= MAX_ATTEMPTS;
}

/**
 * Internal handlers only. Trusted server code supplies config and DB; callers
 * cannot set either through a request. Public routes remain hard-disabled.
 */
export async function participantRegistrationHttp(
  request: Request,
  db: D1Database | null,
  config: ServerConfig | null,
  operation: Operation,
): Promise<Response> {
  if (!db || !validConfig(config)) return failure(503);
  const paths: Record<Operation, string> = {
    registration: "/api/participant/registrations",
    "qr-issue": "/api/participant/qr",
    "qr-revoke": "/api/participant/qr/revoke",
    prefill: "/api/participant/prefill",
    mine: "/api/participant/registrations/mine",
  };
  if (!Object.hasOwn(paths, operation)) return failure(503);
  if (request.method !== "POST") return failure(405);
  try {
    const url = new URL(request.url);
    if (url.origin !== config.origin || url.pathname !== paths[operation] || url.search || url.hash ||
        request.headers.get("Origin") !== config.origin) return failure(403);
    const kind = request.headers.get("X-Participant-Identity");
    if (kind !== "member" && kind !== "participant") return failure(400);
    let body: unknown;
    try { body = await readJson(request, operation === "registration" ? 60_000 : 4_096); }
    catch { return failure(400); }
    if (operation === "registration") {
      if (!(exactObject(body, ["slug", "answers", "consent", "idempotencyKey", "formVersion"]) || exactObject(body, ["slug", "answers", "consent", "idempotencyKey", "formVersion", "feeRevision"])) ||
          typeof body.slug !== "string" || body.slug.length !== 32 || !/^[a-f0-9]{32}$/.test(body.slug)) return failure(400);
    } else if (operation === "prefill") {
      if (!exactObject(body, ["slug"]) || typeof body.slug !== "string" ||
          body.slug.length !== 32 || !/^[a-f0-9]{32}$/.test(body.slug)) return failure(400);
    } else if (operation === "mine") {
      if (!exactObject(body, ["cursor"])) return failure(400);
    } else if (operation === "qr-issue") {
      if (!exactObject(body, ["submissionId"]) || typeof body.submissionId !== "string" ||
          body.submissionId.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(body.submissionId) ||
          /[\x00-\x20\x7f]/.test(body.submissionId)) return failure(400);
    } else {
      if (!exactObject(body, ["token"]) || typeof body.token !== "string" ||
          body.token.length !== 64 || !/^[a-f0-9]{64}$/.test(body.token)) return failure(400);
    }
    if (!await rateAllowed(db, request, config, operation)) return failure(429);
    const cookie = request.headers.get("Cookie");
    if (operation === "mine") {
      const result = await listMyRegistrations(db, kind, cookie, (body as Record<string, unknown>).cursor);
      if (!result.ok) return failure({ invalid: 400, unauthorized: 401, unavailable: 503 }[result.code]);
      return Response.json({ registrations: result.registrations, nextCursor: result.nextCursor }, { headers: HEADERS });
    }
    if (operation === "prefill") {
      const result = await getParticipantProfilePrefill(db, kind, cookie, (body as Record<string, unknown>).slug);
      return result ? Response.json(result, { headers: HEADERS }) : failure(404);
    }
    if (operation === "registration") {
      const data = body as Record<string, unknown>;
      const outcome = await submitParticipantRegistration(db, kind, cookie, data.slug, {
        answers: data.answers, consent: data.consent, idempotencyKey: data.idempotencyKey, formVersion: data.formVersion,
        ...(Object.hasOwn(data, "feeRevision") ? { feeRevision: data.feeRevision } : {}),
      });
      if (!outcome.ok) {
        const status = { invalid: 400, unauthorized: 401, closed: 409, conflict: 409, unavailable: 503 }[outcome.code];
        return failure(status);
      }
      return Response.json({ receiptId: outcome.receiptId }, { status: outcome.replayed ? 200 : 201, headers: HEADERS });
    }
    if (operation === "qr-issue") {
      const token = await issueParticipantQr(db, kind, cookie, (body as Record<string, unknown>).submissionId);
      return token ? Response.json({ token }, { status: 201, headers: HEADERS }) : failure(404);
    }
    const revoked = await revokeParticipantQr(db, kind, cookie, (body as Record<string, unknown>).token);
    return revoked ? Response.json({ ok: true }, { headers: HEADERS }) : failure(404);
  } catch {
    return failure(503);
  }
}

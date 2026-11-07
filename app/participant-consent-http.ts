// Explicit extensions support the isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { PARTICIPANT_PENDING_COOKIE, getPendingParticipantTerms, acceptParticipantConsent, revokeParticipantConsent, clearParticipantPendingCookie } from "./participant-consent.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { readCookie, participantSessionCookie, clearParticipantSessionCookie } from "./participant-session.ts";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const MAX_BODY_BYTES = 4_096;
type ConsentConfig = { origin: string };

function response(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

function validOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string" || /[\x00-\x20\x7f]/.test(origin)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.origin === origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validRequest(request: Request, config: ConsentConfig | null, path: string, requireOrigin: boolean): boolean {
  if (!config || !validOrigin(config.origin)) return false;
  try {
    const url = new URL(request.url);
    return url.origin === config.origin && url.pathname === path && !url.search && !url.hash &&
      (!requireOrigin || request.headers.get("Origin") === config.origin);
  } catch {
    return false;
  }
}

async function readBody(request: Request): Promise<string> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error("INVALID_BODY");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Internal HTTP handlers. The caller supplies a trusted server origin and D1.
 * Public routes remain disabled until the complete login flow is reviewed.
 */
export async function participantConsentHttp(request: Request, db: D1Database | null, config: ConsentConfig | null, nowMs = Date.now()): Promise<Response> {
  if (!db || !config || !validOrigin(config.origin)) return response(503, "目前無法使用，請稍後再試");
  if (request.method !== "GET" && request.method !== "POST") return response(405, "不支援此操作");
  if (!validRequest(request, config, "/api/participant/consent", request.method === "POST")) return response(403, "無法處理此請求");
  try {
    if (request.method === "GET") {
      const terms = await getPendingParticipantTerms(db, request.headers.get("Cookie"), nowMs);
      if (!terms) return response(409, "連結已失效，請重新登入");
      return Response.json({ version: terms.version, content: terms.content }, { headers: HEADERS });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return response(400, "請確認同意選項後再試");
    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(request)); } catch { return response(400, "請確認同意選項後再試"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return response(400, "請確認同意選項後再試");
    const data = parsed as Record<string, unknown>;
    if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "checked") || !Object.hasOwn(data, "version") ||
        data.checked !== true || typeof data.version !== "string" || !data.version || data.version.length > 80) {
      return response(400, "請確認同意選項後再試");
    }
    const pending = readCookie(request.headers.get("Cookie"), PARTICIPANT_PENDING_COOKIE);
    const session = await acceptParticipantConsent(db, pending, data.checked, data.version, nowMs);
    if (!session) return response(409, "同意內容已變更或連結已失效，請重新登入");
    const headers = new Headers(HEADERS);
    headers.append("Set-Cookie", participantSessionCookie(session));
    headers.append("Set-Cookie", clearParticipantPendingCookie());
    return Response.json({ ok: true }, { headers });
  } catch {
    return response(503, "目前無法使用，請稍後再試");
  }
}

export async function participantWithdrawHttp(request: Request, db: D1Database | null, config: ConsentConfig | null, nowMs = Date.now()): Promise<Response> {
  if (!db || !config || !validOrigin(config.origin)) return response(503, "目前無法使用，請稍後再試");
  if (request.method !== "POST") return response(405, "不支援此操作");
  if (!validRequest(request, config, "/api/participant/consent/withdraw", true)) return response(403, "無法處理此請求");
  try {
    if ((await readBody(request)).length !== 0) return response(400, "無法處理此請求");
    const revoked = await revokeParticipantConsent(db, request.headers.get("Cookie"), nowMs);
    if (!revoked) return response(401, "登入已失效，請重新登入");
    const headers = new Headers(HEADERS);
    headers.append("Set-Cookie", clearParticipantSessionCookie());
    headers.append("Set-Cookie", clearParticipantPendingCookie());
    return Response.json({ ok: true, message: "已撤回同意。資料刪除申請請依聯盟公告的方式提出。" }, { headers });
  } catch {
    return response(503, "目前無法使用，請稍後再試");
  }
}

import { env } from "cloudflare:workers";
import { csrfError, currentToken, getAdmin, tokenHash } from "@/app/admin-auth";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const maxBytes = 16_384;

function error(status: number, message: string) {
  return Response.json({ error: message }, { status, headers });
}

async function readBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new Error("INVALID");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error("INVALID");
  if (!request.body) throw new Error("INVALID");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("INVALID"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Initial publication only. Existing terms and the current pointer are never replaced. */
export async function POST(request: Request): Promise<Response> {
  const csrf = csrfError(request);
  if (csrf) return error(403, "請從本站頁面送出操作");
  if (!env.DB) return error(503, "目前無法使用，請稍後再試");
  try {
    const admin = await getAdmin();
    if (!admin) return error(403, "只有系統管理員可以設定條款");
    let body: unknown;
    try { body = await readBody(request); } catch { return error(400, "條款資料格式不正確"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "條款資料格式不正確");
    const data = body as Record<string, unknown>;
    if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "version") || !Object.hasOwn(data, "content") ||
        typeof data.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(data.version) ||
        typeof data.content !== "string" || !data.content.trim() || data.content.length > 10_000 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.content)) return error(400, "條款資料格式不正確");
    const token = await currentToken();
    if (!/^[a-f0-9]{64}$/.test(token)) return error(403, "登入已失效，請重新登入");
    const hash = await tokenHash(token);
    const now = Date.now();
    const validAdmin = "EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND m.status='active' AND m.role='admin')";
    try {
      const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO participant_terms (version,content) SELECT ?,? WHERE ${validAdmin}`).bind(data.version, data.content, hash, admin.userId, now),
        env.DB.prepare(`INSERT INTO participant_terms_current (id,version) SELECT 1,? WHERE ${validAdmin}`).bind(data.version, hash, admin.userId, now),
      ]);
      if (result[0]?.meta?.changes !== 1 || result[1]?.meta?.changes !== 1) return error(403, "登入已失效，請重新登入");
      return Response.json({ ok: true, version: data.version }, { status: 201, headers });
    } catch {
      // D1 batch rolls both INSERTs back on a uniqueness/constraint failure.
      const current = await env.DB.prepare("SELECT id FROM participant_terms_current WHERE id=1").first();
      if (current) return error(409, "條款已設定；如需更換版本，請使用後續的版本管理流程");
      return error(503, "目前無法使用，請稍後再試");
    }
  } catch { return error(503, "目前無法使用，請稍後再試"); }
}

import { env } from "cloudflare:workers";
import { csrfError, currentToken, getMember, tokenHash } from "@/app/admin-auth";
import { buildSiteContent, parseSiteContent, readSiteContent } from "@/app/site-content";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };
const MANAGER_ROLES = ["admin", "manager"];
const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";
// Writes re-check the live session and role in the same statement (same guard as the announcements API).
const managerGuard = `EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>${DB_NOW} AND m.status='active' AND m.role IN ('admin','manager'))`;

async function managerContext() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503, headers: noStore }) };
  const user = await getMember();
  if (!user || !MANAGER_ROLES.includes(user.role)) return { error: Response.json({ error: "只有總召以上可以編輯前台內容" }, { status: 403, headers: noStore }) };
  const token = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(token)) return { error: Response.json({ error: "請先登入" }, { status: 401, headers: noStore }) };
  return { user, tokenHash: await tokenHash(token) };
}

/** Public read (no personal data). With ?scope=manage it answers 403 to anyone who is not a manager, so the editor card can hide itself. */
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("scope") === "manage") {
    const context = await managerContext();
    if (context.error) return context.error;
  }
  const content = env.DB
    ? await readSiteContent(env.DB).catch(() => buildSiteContent(undefined).content)
    : buildSiteContent(undefined).content;
  return Response.json({ content }, { headers: noStore });
}

export async function PUT(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const context = await managerContext(); if (context.error) return context.error;
  const parsed = parseSiteContent(await request.json().catch(() => null));
  if (!("content" in parsed)) {
    return Response.json({ error: "前台內容格式不正確或超過長度限制", fields: parsed.issues.slice(0, 20) }, { status: 400, headers: noStore });
  }
  const now = new Date().toISOString();
  const { user, tokenHash: hash } = context as { user: { userId: string }; tokenHash: string };
  const results = await env.DB!.batch([
    env.DB!.prepare(`INSERT INTO site_content (id,content,updated_at,updated_by) SELECT 1,?,?,? WHERE ${managerGuard} ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(JSON.stringify(parsed.content), now, user.userId, hash, user.userId),
    env.DB!.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,'update_site_content','site_content','1',? WHERE EXISTS (SELECT 1 FROM site_content WHERE id=1 AND updated_at=?) AND ${managerGuard}`)
      .bind(user.userId, now, now, hash, user.userId),
  ]);
  if (results[0]?.meta?.changes !== 1) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  return Response.json({ ok: true }, { headers: noStore });
}

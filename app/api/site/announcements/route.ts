import { env } from "cloudflare:workers";
import { csrfError, currentToken, getMember, tokenHash } from "@/app/admin-auth";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };
const MANAGER_ROLES = ["admin", "manager"];
const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";
// Writes re-check the live session and role in the same statement.
const managerGuard = `EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>${DB_NOW} AND m.status='active' AND m.role IN ('admin','manager'))`;

type Row = { id: string; title: string; body: string; published: number; updatedAt: string };

async function managerContext() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503, headers: noStore }) };
  const user = await getMember();
  if (!user || !MANAGER_ROLES.includes(user.role)) return { error: Response.json({ error: "只有總召以上可以管理消息" }, { status: 403, headers: noStore }) };
  const token = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(token)) return { error: Response.json({ error: "請先登入" }, { status: 401, headers: noStore }) };
  return { user, tokenHash: await tokenHash(token) };
}

function parseFields(value: unknown): { title: string; body: string; published: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (!title || title.length > 120 || !body || body.length > 4000 || typeof data.published !== "boolean") return null;
  return { title, body, published: data.published };
}

export async function GET() {
  const context = await managerContext(); if (context.error) return context.error;
  const rows = await env.DB!.prepare("SELECT id,title,body,published,updated_at AS updatedAt FROM site_announcements ORDER BY updated_at DESC LIMIT 100").all<Row>();
  return Response.json({ announcements: rows.results.map((row) => ({ ...row, published: row.published === 1 })) }, { headers: noStore });
}

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const context = await managerContext(); if (context.error) return context.error;
  const fields = parseFields(await request.json().catch(() => null));
  if (!fields) return Response.json({ error: "消息標題或內容格式不正確" }, { status: 400, headers: noStore });
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const { user, tokenHash: hash } = context as { user: { userId: string }; tokenHash: string };
  const results = await env.DB!.batch([
    env.DB!.prepare(`INSERT INTO site_announcements (id,title,body,published,created_by,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${managerGuard}`)
      .bind(id, fields.title, fields.body, fields.published ? 1 : 0, user.userId, now, now, hash, user.userId),
    env.DB!.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,'create_site_announcement','site_announcement',?,? WHERE ${managerGuard}`)
      .bind(user.userId, id, now, hash, user.userId),
  ]);
  if (results[0]?.meta?.changes !== 1) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  return Response.json({ id }, { status: 201, headers: noStore });
}

export async function PUT(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const context = await managerContext(); if (context.error) return context.error;
  const data = await request.json().catch(() => null) as { id?: unknown } | null;
  const fields = parseFields(data);
  if (!fields || typeof data?.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(data.id)) return Response.json({ error: "消息資料格式不正確" }, { status: 400, headers: noStore });
  const now = new Date().toISOString();
  const { user, tokenHash: hash } = context as { user: { userId: string }; tokenHash: string };
  const results = await env.DB!.batch([
    env.DB!.prepare(`UPDATE site_announcements SET title=?,body=?,published=?,updated_at=? WHERE id=? AND ${managerGuard}`)
      .bind(fields.title, fields.body, fields.published ? 1 : 0, now, data.id, hash, user.userId),
    env.DB!.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,'update_site_announcement','site_announcement',?,? WHERE EXISTS (SELECT 1 FROM site_announcements WHERE id=? AND updated_at=?) AND ${managerGuard}`)
      .bind(user.userId, data.id, now, data.id, now, hash, user.userId),
  ]);
  if (results[0]?.meta?.changes !== 1) return Response.json({ error: "找不到消息或登入已失效" }, { status: 404, headers: noStore });
  return Response.json({ ok: true }, { headers: noStore });
}

export async function DELETE(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const context = await managerContext(); if (context.error) return context.error;
  const data = await request.json().catch(() => null) as { id?: unknown } | null;
  if (typeof data?.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(data.id)) return Response.json({ error: "消息編號格式不正確" }, { status: 400, headers: noStore });
  const now = new Date().toISOString();
  const { user, tokenHash: hash } = context as { user: { userId: string }; tokenHash: string };
  const results = await env.DB!.batch([
    env.DB!.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,'delete_site_announcement','site_announcement',?,? WHERE EXISTS (SELECT 1 FROM site_announcements WHERE id=?) AND ${managerGuard}`)
      .bind(user.userId, data.id, now, data.id, hash, user.userId),
    env.DB!.prepare(`DELETE FROM site_announcements WHERE id=? AND ${managerGuard}`).bind(data.id, hash, user.userId),
  ]);
  if (results[1]?.meta?.changes !== 1) return Response.json({ error: "找不到消息或登入已失效" }, { status: 404, headers: noStore });
  return Response.json({ ok: true }, { headers: noStore });
}

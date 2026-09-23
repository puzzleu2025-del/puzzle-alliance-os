import { env } from "cloudflare:workers";
import { csrfError, rateLimited, tokenHash } from "@/app/admin-auth";

const response = () => Response.json({ ok: true, message: "若帳號存在，重設申請已送出，請聯絡系統管理員確認身分。" }, { headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  if (!env.DB) return Response.json({ error: "資料庫尚未連線" }, { status: 503 });
  let body: { username?: unknown };
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as typeof body; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  if (!username || username.length > 32) return response();
  const source = request.headers.get("cf-connecting-ip") || "direct";
  if (await rateLimited(`forgot:${await tokenHash(`${source}|${username}`)}`)) return response();
  const member = await env.DB.prepare("SELECT user_id FROM members WHERE lower(username)=?").bind(username).first<{user_id:string}>();
  if (!member) return response();
  const existing = await env.DB.prepare("SELECT id FROM password_reset_requests WHERE user_id=? AND status='pending'").bind(member.user_id).first();
  if (!existing) {
    const id = crypto.randomUUID(), now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO password_reset_requests (id,user_id,status,requested_at) VALUES (?,?,'pending',?)").bind(id, member.user_id, now),
      env.DB.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,'request_password_reset','password_reset',?,?)").bind(member.user_id, id, now),
    ]);
  }
  return response();
}

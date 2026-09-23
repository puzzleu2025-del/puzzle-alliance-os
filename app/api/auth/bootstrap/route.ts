import { env } from "cloudflare:workers";
import { csrfError, passwordHash, randomToken } from "@/app/admin-auth";
import { isSiteOwner } from "@/app/setup-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  if (!isSiteOwner(request.headers)) return Response.json({ error: "只有站點擁有者可以啟用管理員帳號" }, { status: 403 });
  if (!env.DB) return Response.json({ error: "資料庫尚未連線" }, { status: 503 });

  let body: { password?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256)
    return Response.json({ error: "請設定至少 12 個字元的密碼" }, { status: 400 });

  const alreadyEnabled = await env.DB.prepare("SELECT 1 FROM admin_credentials c JOIN members m ON m.user_id=c.user_id WHERE m.role='admin' AND m.status='active' LIMIT 1").first();
  if (alreadyEnabled) return Response.json({ error: "管理員帳號已啟用，請直接登入" }, { status: 409 });
  await env.DB.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) SELECT 'admin-kao19950411','kao19950411','','嘉駿','admin','active',? WHERE NOT EXISTS (SELECT 1 FROM members WHERE role='admin' AND status='active')")
    .bind(new Date().toISOString()).run();
  const admin = await env.DB.prepare("SELECT user_id FROM members WHERE role='admin' AND status='active' LIMIT 1").first<{ user_id: string }>();
  if (!admin) return Response.json({ error: "管理員資料尚未建立" }, { status: 503 });
  const salt = randomToken();
  const hash = await passwordHash(body.password, salt);
  const result = await env.DB.prepare("INSERT INTO admin_credentials (user_id,password_hash,salt,updated_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_credentials c JOIN members m ON m.user_id=c.user_id WHERE m.role='admin' AND m.status='active')")
    .bind(admin.user_id, hash, salt, Date.now()).run();
  if (result.meta.changes !== 1) return Response.json({ error: "管理員帳號已啟用，請直接登入" }, { status: 409 });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

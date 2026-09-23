import { env } from "cloudflare:workers";
import { csrfError, passwordHash, randomToken, rateLimited, tokenHash } from "@/app/admin-auth";

const usernamePattern = /^[a-z0-9][a-z0-9._-]{3,31}$/;

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  if (!env.DB) return Response.json({ error: "資料庫尚未連線" }, { status: 503 });
  const initialized = await env.DB.prepare("SELECT 1 FROM admin_credentials c JOIN members m ON m.user_id=c.user_id WHERE m.role='admin' AND m.status='active' LIMIT 1").first();
  if (!initialized) return Response.json({ error: "系統管理員尚未啟用，暫時無法註冊" }, { status: 503 });
  let body: { username?: unknown; password?: unknown; displayName?: unknown; email?: unknown; phone?: unknown; organization?: unknown; position?: unknown };
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as typeof body; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const organization = typeof body.organization === "string" ? body.organization.trim() : "";
  const position = typeof body.position === "string" ? body.position.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!usernamePattern.test(username)) return Response.json({ error: "帳號需為 4–32 位英數字，可使用 . _ -" }, { status: 400 });
  if (!displayName || displayName.length > 100) return Response.json({ error: "請填寫姓名" }, { status: 400 });
  if (email.length > 254 || (email && !/^\S+@\S+\.\S+$/.test(email))) return Response.json({ error: "Email 格式不正確" }, { status: 400 });
  if (!/^[+0-9()\-\s]{8,24}$/.test(phone) || phone.replace(/\D/g, "").length < 7) return Response.json({ error: "請填寫可聯絡的電話" }, { status: 400 });
  if (organization.length > 100 || position.length > 100) return Response.json({ error: "所屬單位或職務過長" }, { status: 400 });
  if (password.length < 6 || password.length > 256) return Response.json({ error: "密碼須為 6–256 個字元" }, { status: 400 });
  const source = request.headers.get("cf-connecting-ip") || "direct";
  if (await rateLimited(`register:${await tokenHash(`${source}|${username}`)}`)) return Response.json({ error: "申請次數過多，請稍後再試" }, { status: 429 });
  const userId = crypto.randomUUID(), now = new Date().toISOString(), salt = randomToken(), hash = await passwordHash(password, salt);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO members (user_id,username,email,display_name,phone,organization,position,role,status,created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)").bind(userId, username, email, displayName, phone, organization, position, "member", now),
      env.DB.prepare("INSERT INTO admin_credentials (user_id,password_hash,salt,updated_at) VALUES (?,?,?,?)").bind(userId, hash, salt, Date.now()),
      env.DB.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,'request_membership','member',?,?)").bind(userId, userId, now),
    ]);
  } catch {
    return Response.json({ error: "這個登入帳號已有人使用" }, { status: 409 });
  }
  return Response.json({ ok: true, message: "申請已送出，請等待系統管理員核可。" }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

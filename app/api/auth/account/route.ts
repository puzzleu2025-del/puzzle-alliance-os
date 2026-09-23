import { env } from "cloudflare:workers";
import { cookie, csrfError, getMember, passwordHash, randomToken, rateLimited, SESSION_SECONDS, tokenHash, verifyPassword } from "@/app/admin-auth";

export async function GET() {
  const user = await getMember();
  if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  const row = await env.DB!.prepare("SELECT user_id FROM admin_credentials WHERE user_id=?").bind(user.userId).first();
  const profile = await env.DB!.prepare("SELECT phone,organization,position FROM members WHERE user_id=?").bind(user.userId).first<{phone:string;organization:string;position:string}>();
  return Response.json({ username: user.username, email: user.email, displayName: user.displayName, phone: profile?.phone || "", organization: profile?.organization || "", position: profile?.position || "", hasPassword: !!row }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const user = await getMember(); if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  let body: { displayName?: unknown; email?: unknown; phone?: unknown; organization?: unknown; position?: unknown };
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as typeof body; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const organization = typeof body.organization === "string" ? body.organization.trim() : "";
  const position = typeof body.position === "string" ? body.position.trim() : "";
  if (!displayName || displayName.length > 100) return Response.json({ error: "請填寫姓名（最多 100 字）" }, { status: 400 });
  if (email.length > 254 || (email && !/^\S+@\S+\.\S+$/.test(email))) return Response.json({ error: "Email 格式不正確" }, { status: 400 });
  if (phone && (!/^[+0-9()\-\s]{8,24}$/.test(phone) || phone.replace(/\D/g, "").length < 7)) return Response.json({ error: "電話格式不正確" }, { status: 400 });
  if (organization.length > 100 || position.length > 100) return Response.json({ error: "所屬單位或職務過長" }, { status: 400 });
  const now = new Date().toISOString();
  await env.DB!.batch([
    env.DB!.prepare("UPDATE members SET display_name=?,email=?,phone=?,organization=?,position=? WHERE user_id=? AND status='active'").bind(displayName, email, phone, organization, position, user.userId),
    env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,'update_profile','member',?,?)").bind(user.userId, user.userId, now),
  ]);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const user = await getMember(); if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  if (await rateLimited(`password:${user.userId}`)) return Response.json({ error: "嘗試過多，請 15 分鐘後再試" }, { status: 429 });
  let body: { currentPassword?: unknown; newPassword?: unknown };
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as typeof body; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (typeof body.newPassword !== "string" || body.newPassword.length < 6 || body.newPassword.length > 256) return Response.json({ error: "新密碼須為 6–256 個字元" }, { status: 400 });
  const old = await env.DB!.prepare("SELECT password_hash,salt FROM admin_credentials WHERE user_id=?").bind(user.userId).first<{password_hash:string;salt:string}>();
  if (!old) return Response.json({ error: "帳號尚未建立密碼，請聯絡系統管理員" }, { status: 409 });
  if (typeof body.currentPassword !== "string" || body.currentPassword.length > 256 || !await verifyPassword(body.currentPassword, old.salt, old.password_hash)) return Response.json({ error: "目前密碼不正確" }, { status: 400 });
  const salt = randomToken(), hash = await passwordHash(body.newPassword, salt), token = randomToken();
  const results = await env.DB!.batch([
    env.DB!.prepare("DELETE FROM admin_sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=? AND password_hash=?)").bind(user.userId, user.userId, old.password_hash),
    env.DB!.prepare("INSERT INTO admin_sessions (token_hash,user_id,expires_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=? AND password_hash=?)").bind(await tokenHash(token), user.userId, Date.now() + SESSION_SECONDS * 1000, user.userId, old.password_hash),
    env.DB!.prepare("UPDATE admin_credentials SET password_hash=?,salt=?,updated_at=? WHERE user_id=? AND password_hash=?").bind(hash, salt, Date.now(), user.userId, old.password_hash),
  ]);
  if (results[2].meta.changes !== 1) return Response.json({ error: "帳號已在另一個視窗更新，請重新登入" }, { status: 409 });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie(token, request), "Cache-Control": "no-store" } });
}

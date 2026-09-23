import { env } from "cloudflare:workers";
import { cookie, csrfError, passwordHash, randomToken, rateLimited, SESSION_SECONDS, tokenHash, verifyPassword } from "@/app/admin-auth";
import { timingSafeEqual } from "node:crypto";

const initialAdminUsername = "kao19950411";
const initialAdminId = "admin-kao19950411";

async function initializeAdmin(username: string, password: string) {
  if (username !== initialAdminUsername || !env.INITIAL_ADMIN_PASSWORD) return;
  const existing = await env.DB!.prepare("SELECT 1 FROM admin_credentials LIMIT 1").first();
  if (existing) return;
  const supplied = Buffer.from(await tokenHash(password), "hex");
  const expected = Buffer.from(await tokenHash(env.INITIAL_ADMIN_PASSWORD), "hex");
  if (!timingSafeEqual(supplied, expected)) return;
  const salt = randomToken(), hash = await passwordHash(password, salt);
  try {
    await env.DB!.batch([
      env.DB!.prepare("INSERT INTO members (user_id,username,email,display_name,role,status,created_at) SELECT ?,?,'','嘉駿','admin','active',? WHERE NOT EXISTS (SELECT 1 FROM members WHERE role='admin' AND status='active')").bind(initialAdminId, initialAdminUsername, new Date().toISOString()),
      env.DB!.prepare("INSERT INTO admin_credentials (user_id,password_hash,salt,updated_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM members WHERE user_id=? AND role='admin' AND status='active') AND NOT EXISTS (SELECT 1 FROM admin_credentials)").bind(initialAdminId, hash, salt, Date.now(), initialAdminId),
    ]);
  } catch {
    // A concurrent first login may have initialized the one allowed admin.
  }
}
export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  if (!env.DB) return Response.json({ error: "正式登入需要 API 與 D1 資料庫部署" }, { status: 503 });
  let body: { username?: unknown; password?: unknown };
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as typeof body; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (typeof body?.username !== "string" || typeof body.password !== "string" || body.username.length > 64 || body.password.length > 256) return Response.json({ error: "帳號或密碼不正確" }, { status: 401 });
  const username = body.username.trim().toLowerCase();
  // Cloudflare replaces this header at its edge. Local requests share the
  // fallback bucket, while one remote address cannot lock out other addresses.
  const source = request.headers.get("cf-connecting-ip") || "direct";
  if (await rateLimited(`login:${await tokenHash(`${source}|${username}`)}`)) return Response.json({ error: "登入嘗試過多，請 15 分鐘後再試" }, { status: 429 });
  await initializeAdmin(username, body.password);
  const row = await env.DB.prepare("SELECT m.user_id,p.password_hash,p.salt FROM members m JOIN admin_credentials p ON p.user_id=m.user_id WHERE lower(m.username)=? AND m.status='active'").bind(username).first<{user_id:string;password_hash:string;salt:string}>();
  const valid = row ? await verifyPassword(body.password,row.salt,row.password_hash) : (await passwordHash(body.password,"unregistered-account-dummy-salt"), false);
  if (!valid || !row) return Response.json({ error: "帳號或密碼不正確，或帳號尚未核可" }, { status: 401 });
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(Date.now()),
    env.DB.prepare("INSERT INTO admin_sessions (token_hash,user_id,expires_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=? AND password_hash=?)").bind(await tokenHash(token),row.user_id,Date.now()+SESSION_SECONDS*1000,row.user_id,row.password_hash),
  ]).then(results => { if (results[1].meta.changes !== 1) throw new Error("Credentials changed during login"); });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie(token,request), "Cache-Control": "no-store" } });
}

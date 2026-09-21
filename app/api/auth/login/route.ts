import { env } from "cloudflare:workers";
import { cookie, csrfError, passwordHash, randomToken, rateLimited, SESSION_SECONDS, tokenHash, verifyPassword } from "@/app/admin-auth";
export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  if (!env.DB) return Response.json({ error: "正式登入需要 API 與 D1 資料庫部署" }, { status: 503 });
  let body: { email?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (typeof body?.email !== "string" || typeof body.password !== "string" || body.email.length > 254 || body.password.length > 256) return Response.json({ error: "電子郵件或密碼不正確" }, { status: 401 });
  const email = body.email.trim().toLowerCase();
  // Cloudflare replaces this header at its edge. Local requests share the
  // fallback bucket, while one remote address cannot lock out other addresses.
  const source = request.headers.get("cf-connecting-ip") || "direct";
  if (await rateLimited(`login:${await tokenHash(`${source}|${email}`)}`)) return Response.json({ error: "登入嘗試過多，請 15 分鐘後再試" }, { status: 429 });
  const row = await env.DB.prepare("SELECT m.user_id,p.password_hash,p.salt FROM members m JOIN admin_credentials p ON p.user_id=m.user_id WHERE lower(m.email)=? AND m.role='admin' AND m.status='active'").bind(email).first<{user_id:string;password_hash:string;salt:string}>();
  const valid = row ? await verifyPassword(body.password,row.salt,row.password_hash) : (await passwordHash(body.password,"unregistered-account-dummy-salt"), false);
  if (!valid || !row) return Response.json({ error: "電子郵件或密碼不正確" }, { status: 401 });
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(Date.now()),
    env.DB.prepare("INSERT INTO admin_sessions (token_hash,user_id,expires_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=? AND password_hash=?)").bind(await tokenHash(token),row.user_id,Date.now()+SESSION_SECONDS*1000,row.user_id,row.password_hash),
  ]).then(results => { if (results[1].meta.changes !== 1) throw new Error("Credentials changed during login"); });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie(token,request), "Cache-Control": "no-store" } });
}

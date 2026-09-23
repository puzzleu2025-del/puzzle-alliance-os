import { env } from "cloudflare:workers";
import { csrfError, getAdmin, passwordHash, randomToken } from "@/app/admin-auth";

const usernamePattern = /^[a-z0-9][a-z0-9._-]{3,31}$/;
const roles = new Set(["coordinator", "leader", "member"]);
const statuses = new Set(["pending", "active", "disabled", "rejected"]);

async function admin() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503 }) };
  const user = await getAdmin();
  if (!user) return { error: Response.json({ error: "只有系統管理員可以管理成員" }, { status: 403 }) };
  return { user };
}

const selectMembers = () => env.DB!.prepare("SELECT m.user_id AS id,m.username,m.email,m.display_name AS name,m.phone,m.organization,m.position,m.role,m.status,m.created_at AS createdAt,CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS resetPending FROM members m LEFT JOIN password_reset_requests r ON r.user_id=m.user_id AND r.status='pending' ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,m.created_at DESC").all();

export async function GET() {
  const auth = await admin(); if (auth.error) return auth.error;
  const result = await selectMembers();
  return Response.json({ members: result.results }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await admin(); if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown>; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const name = typeof body.displayName === "string" ? body.displayName.trim() : typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const organization = typeof body.organization === "string" ? body.organization.trim() : "";
  const position = typeof body.position === "string" ? body.position.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role = typeof body.role === "string" && roles.has(body.role) ? body.role : "member";
  const status = typeof body.status === "string" && statuses.has(body.status) ? body.status : "active";
  if (!usernamePattern.test(username)) return Response.json({ error: "帳號需為 4–32 位英數字，可使用 . _ -" }, { status: 400 });
  if (!name || name.length > 100) return Response.json({ error: "請填寫姓名" }, { status: 400 });
  if (email.length > 254 || (email && !/^\S+@\S+\.\S+$/.test(email))) return Response.json({ error: "Email 格式不正確" }, { status: 400 });
  if (phone && (!/^[+0-9()\-\s]{8,24}$/.test(phone) || phone.replace(/\D/g, "").length < 7)) return Response.json({ error: "電話格式不正確" }, { status: 400 });
  if (organization.length > 100 || position.length > 100) return Response.json({ error: "所屬單位或職務過長" }, { status: 400 });
  if (password.length < 6 || password.length > 256) return Response.json({ error: "初始密碼須為 6–256 個字元" }, { status: 400 });
  const id = crypto.randomUUID(), now = new Date().toISOString(), salt = randomToken(), hash = await passwordHash(password, salt);
  try {
    await env.DB!.batch([
      env.DB!.prepare("INSERT INTO members (user_id,username,email,display_name,phone,organization,position,role,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, username, email, name, phone, organization, position, role, status, now),
      env.DB!.prepare("INSERT INTO admin_credentials (user_id,password_hash,salt,updated_at) VALUES (?,?,?,?)").bind(id, hash, salt, Date.now()),
      env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,'create_member','member',?,?)").bind(auth.user!.userId, id, now),
    ]);
  } catch { return Response.json({ error: "這個登入帳號已有人使用" }, { status: 409 }); }
  const member = await env.DB!.prepare("SELECT user_id AS id,username,email,display_name AS name,phone,organization,position,role,status,created_at AS createdAt FROM members WHERE user_id=?").bind(id).first();
  return Response.json({ member }, { status: 201 });
}

export async function PATCH(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await admin(); if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown>; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  const id = typeof body.id === "string" ? body.id : "";
  const target = await env.DB!.prepare("SELECT user_id,role,status FROM members WHERE user_id=?").bind(id).first<{user_id:string;role:string;status:string}>();
  if (!target) return Response.json({ error: "找不到成員" }, { status: 404 });
  if (id === auth.user!.userId && (body.status && body.status !== "active" || body.role && body.role !== "admin")) return Response.json({ error: "不能停用或降權目前登入的系統管理員" }, { status: 400 });
  const updates: string[] = [], values: unknown[] = [];
  if (typeof body.role === "string") {
    if (!roles.has(body.role) && body.role !== "admin") return Response.json({ error: "角色無效" }, { status: 400 });
    if (body.role === "admin" && target.role !== "admin") return Response.json({ error: "系統目前只保留一位系統管理員" }, { status: 400 });
    if (target.role === "admin" && body.role !== "admin") return Response.json({ error: "不能移除唯一系統管理員" }, { status: 400 });
    updates.push("role=?"); values.push(body.role);
  }
  if (typeof body.status === "string") {
    if (!statuses.has(body.status)) return Response.json({ error: "狀態無效" }, { status: 400 });
    if (target.role === "admin" && body.status !== "active") return Response.json({ error: "不能停用唯一系統管理員" }, { status: 400 });
    updates.push("status=?"); values.push(body.status);
  }
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (body.newPassword !== undefined && (newPassword.length < 6 || newPassword.length > 256)) return Response.json({ error: "新密碼須為 6–256 個字元" }, { status: 400 });
  if (!updates.length && !newPassword) return Response.json({ error: "沒有可更新的欄位" }, { status: 400 });
  const now = new Date().toISOString();
  const statements = [];
  if (updates.length) { values.push(id); statements.push(env.DB!.prepare(`UPDATE members SET ${updates.join(",")} WHERE user_id=?`).bind(...values)); }
  if (newPassword) {
    const salt = randomToken(), hash = await passwordHash(newPassword, salt);
    statements.push(
      env.DB!.prepare("INSERT INTO admin_credentials (user_id,password_hash,salt,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,salt=excluded.salt,updated_at=excluded.updated_at").bind(id, hash, salt, Date.now()),
      env.DB!.prepare("DELETE FROM admin_sessions WHERE user_id=?").bind(id),
      env.DB!.prepare("UPDATE password_reset_requests SET status='resolved',resolved_at=?,resolved_by=? WHERE user_id=? AND status='pending'").bind(now, auth.user!.userId, id),
    );
  }
  statements.push(env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,?,?,?)").bind(auth.user!.userId, newPassword ? "reset_member_password" : "update_member", "member", id, now));
  await env.DB!.batch(statements);
  const member = await env.DB!.prepare("SELECT user_id AS id,username,email,display_name AS name,phone,organization,position,role,status,created_at AS createdAt FROM members WHERE user_id=?").bind(id).first();
  return Response.json({ member });
}

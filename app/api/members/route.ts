import { env } from "cloudflare:workers";
import { csrfError, getMember, passwordHash, randomToken } from "@/app/admin-auth";

const usernamePattern = /^[a-z0-9][a-z0-9._-]{3,31}$/;
const roleRank: Record<string, number> = { admin: 5, manager: 4, coordinator: 3, trainee_coordinator: 2, leader: 1, member: 0 };
const roles = new Set(["manager", "coordinator", "trainee_coordinator", "leader", "member"]);
const statuses = new Set(["pending", "active", "disabled", "rejected"]);
const canManageRole = (actorRole: string, targetRole: string) =>
  typeof roleRank[targetRole] === "number" && roleRank[targetRole] < roleRank[actorRole] &&
  (actorRole !== "coordinator" || targetRole === "leader" || targetRole === "member");

async function approver() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503 }) };
  const user = await getMember();
  if (!user || typeof roleRank[user.role] !== "number" || roleRank[user.role] < roleRank.coordinator) return { error: Response.json({ error: "只有總召以上可以核可成員" }, { status: 403 }) };
  return { user };
}

const selectMembers = () => env.DB!.prepare("SELECT m.user_id AS id,m.username,m.email,m.display_name AS name,m.phone,m.organization,m.position,m.role,m.status,m.created_at AS createdAt,CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS resetPending FROM members m LEFT JOIN password_reset_requests r ON r.user_id=m.user_id AND r.status='pending' ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,m.created_at DESC").all();

type DirectoryUser = { userId: string; role: string; displayName: string };
type DirectoryMember = { id?: string; role?: string; status?: string };

// Only registration identities, never names or email addresses, associate a member with an activity.
// One statement reads grants, active registrations and member rows from the same snapshot.
const coordinatorDirectorySql = `WITH source AS (
    SELECT CASE WHEN json_valid(data) THEN
      CASE WHEN json_type(data, '$.activities') = 'array' THEN json_extract(data, '$.activities') ELSE '[]' END
      ELSE '[]' END AS activities FROM workspace_states WHERE id=1
  ), activity AS (
    SELECT CASE WHEN a.type='object' THEN a.value ELSE '{}' END AS data
    FROM source, json_each(source.activities) a
  ), permitted AS (
  SELECT DISTINCT i.member_id AS memberId
  FROM registration_identities i JOIN registration_forms f ON f.id=i.form_id
  JOIN activity a ON json_extract(a.data, '$.id')=f.activity_id
  WHERE i.status='active' AND i.member_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM registration_submissions x WHERE x.id=i.submission_id AND x.archived_at IS NOT NULL)
    AND json_type(a.data, '$.id')='text' AND length(json_extract(a.data, '$.id')) > 0
    AND (SELECT count(*) FROM activity x WHERE json_extract(x.data, '$.id')=f.activity_id)=1
    AND (json_type(a.data, '$.traineeCoordinatorId') IS NULL OR json_type(a.data, '$.traineeCoordinatorId')='text')
    AND (
      (json_type(a.data, '$.coordinatorIds')='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(a.data, '$.coordinatorIds') g WHERE g.type <> 'text')
        AND NOT EXISTS (SELECT 1 FROM json_each(a.data, '$.coordinatorIds') g GROUP BY g.value HAVING count(*) > 1)
        AND EXISTS (SELECT 1 FROM json_each(a.data, '$.coordinatorIds') g WHERE g.value=?))
      OR (json_type(a.data, '$.coordinatorIds') IS NULL AND json_type(a.data, '$.traineeCoordinatorId') IS NULL
        AND (SELECT count(*) FROM members WHERE status='active' AND display_name=?)=1
        AND EXISTS (SELECT 1 FROM members WHERE status='active' AND display_name=? AND user_id=?)
        AND (trim(CASE WHEN json_type(a.data, '$.owner')='text' THEN json_extract(a.data, '$.owner') ELSE '' END, ?)=?
          OR trim(CASE WHEN json_type(a.data, '$.proxy')='text' THEN json_extract(a.data, '$.proxy') ELSE '' END, ?)=?))
    )
  )
  SELECT m.user_id AS id,m.username,m.email,m.display_name AS name,m.phone,m.organization,m.position,m.role,m.status,m.created_at AS createdAt,
    CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS resetPending
  FROM members m LEFT JOIN password_reset_requests r ON r.user_id=m.user_id AND r.status='pending'
  WHERE m.user_id=? OR (m.status='pending' AND m.role IN ('leader','member'))
    OR m.user_id IN (SELECT memberId FROM permitted)
  ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,m.created_at DESC`;
// ECMAScript String.prototype.trim whitespace and line terminator code points.
const jsTrimCharacters = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const coordinatorDirectoryArgs = (user: DirectoryUser) => [user.userId, user.displayName, user.displayName, user.userId, jsTrimCharacters, user.displayName.trim(), jsTrimCharacters, user.displayName.trim(), user.userId];
async function coordinatorMembers(user: DirectoryUser) {
  const rows = await env.DB!.prepare(coordinatorDirectorySql).bind(...coordinatorDirectoryArgs(user)).all();
  return rows.results;
}

async function visibleMembers(user: DirectoryUser) {
  if (user.role === "coordinator") return coordinatorMembers(user);
  const result = await selectMembers();
  return result.results.filter((row) => {
    const member = row as DirectoryMember;
    return member.id === user.userId || (member.role && canManageRole(user.role, member.role));
  });
}

export async function GET() {
  const auth = await approver(); if (auth.error) return auth.error;
  return Response.json({ members: await visibleMembers(auth.user!) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await approver(); if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown>; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (body.action === "delete_rejected") return removeRejected(String(body.id ?? "").trim(), auth.user!);
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const name = typeof body.displayName === "string" ? body.displayName.trim() : typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const organization = typeof body.organization === "string" ? body.organization.trim() : "";
  const position = typeof body.position === "string" ? body.position.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role = body.role === undefined ? "member" : typeof body.role === "string" ? body.role : "";
  const status = typeof body.status === "string" && statuses.has(body.status) ? body.status : "active";
  if (!roles.has(role) || !canManageRole(auth.user!.role, role)) return Response.json({ error: "只能新增權限低於自己的成員" }, { status: 403 });
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
  if (auth.user!.role === "coordinator") return Response.json({ members: await visibleMembers(auth.user!) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  const member = await env.DB!.prepare("SELECT user_id AS id,username,email,display_name AS name,phone,organization,position,role,status,created_at AS createdAt FROM members WHERE user_id=?").bind(id).first();
  return Response.json({ member }, { status: 201 });
}

export async function PATCH(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await approver(); if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown>; } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  const id = typeof body.id === "string" ? body.id : "";
  const target = await env.DB!.prepare("SELECT user_id,role,status FROM members WHERE user_id=?").bind(id).first<{user_id:string;role:string;status:string}>();
  if (!target) return Response.json({ error: "找不到成員" }, { status: 404 });
  if (id === auth.user!.userId || !canManageRole(auth.user!.role, target.role)) return Response.json({ error: "只能管理權限低於自己的成員" }, { status: 403 });
  // Do not let a hidden account become visible merely by changing its status.
  // The same condition is checked again inside the atomic write batch below.
  const guardPending = auth.user!.role === "coordinator" && body.status === "pending";
  if (guardPending && !(await coordinatorMembers(auth.user!)).some((row) => (row as DirectoryMember).id === id)) {
    return Response.json({ error: "此申請請由管理員協助恢復" }, { status: 403 });
  }
  const updates: string[] = [], values: unknown[] = [];
  if (typeof body.role === "string") {
    if (!roles.has(body.role) || !canManageRole(auth.user!.role, body.role)) return Response.json({ error: "只能指派權限低於自己的角色，系統管理員僅保留一位" }, { status: 403 });
    updates.push("role=?"); values.push(body.role);
  }
  if (typeof body.status === "string") {
    if (!statuses.has(body.status)) return Response.json({ error: "狀態無效" }, { status: 400 });
    updates.push("status=?"); values.push(body.status);
  }
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (body.newPassword !== undefined && (newPassword.length < 6 || newPassword.length > 256)) return Response.json({ error: "新密碼須為 6–256 個字元" }, { status: 400 });
  if (!updates.length && !newPassword) return Response.json({ error: "沒有可更新的欄位" }, { status: 400 });
  const now = new Date().toISOString();
  const statements = [];
  if (guardPending) {
    // D1 batch is transactional: if permission changed, fail before any mutation.
    const guard = `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM (${coordinatorDirectorySql}) visible WHERE visible.id=?) THEN 'null' ELSE 'invalid' END)`;
    statements.push(env.DB!.prepare(guard).bind(...coordinatorDirectoryArgs(auth.user!), id));
  }
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
  try { await env.DB!.batch(statements); } catch (error) {
    if (guardPending) return Response.json({ error: "儲存失敗，請重新整理後再試；如需恢復申請請聯絡管理員。" }, { status: 503 });
    throw error;
  }
  // A valid management operation must not make hidden member details visible in its response.
  if (auth.user!.role === "coordinator") return Response.json({ members: await visibleMembers(auth.user!) }, { headers: { "Cache-Control": "no-store" } });
  const member = await env.DB!.prepare("SELECT user_id AS id,username,email,display_name AS name,phone,organization,position,role,status,created_at AS createdAt FROM members WHERE user_id=?").bind(id).first();
  return Response.json({ member });
}

async function removeRejected(id: string, actor: { userId: string; role: string }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return Response.json({ error: "申請者編號無效" }, { status: 400 });
  const target = await env.DB!.prepare("SELECT user_id,role,status FROM members WHERE user_id=?").bind(id).first<{ user_id: string; role: string; status: string }>();
  if (!target) return Response.json({ error: "找不到申請者" }, { status: 404 });
  if (target.status !== "rejected") return Response.json({ error: "只能刪除已拒絕的申請" }, { status: 409 });
  if (id === actor.userId || !canManageRole(actor.role, target.role)) {
    return Response.json({ error: "只能刪除權限低於自己的已拒絕申請" }, { status: 403 });
  }
  try {
    const result = await env.DB!.batch([
      env.DB!.prepare("DELETE FROM password_reset_requests WHERE user_id=?").bind(id),
      env.DB!.prepare("DELETE FROM admin_sessions WHERE user_id=?").bind(id),
      env.DB!.prepare("DELETE FROM admin_credentials WHERE user_id=?").bind(id),
      env.DB!.prepare("DELETE FROM members WHERE user_id=? AND status='rejected'").bind(id),
    ]);
    if ((result[3].meta.changes ?? 0) !== 1) return Response.json({ error: "申請狀態已變更，請重新載入" }, { status: 409 });
  } catch {
    return Response.json({ error: "刪除申請失敗，請重新整理後再試" }, { status: 500 });
  }
  await env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,'delete_rejected_member','member',?,?)")
    .bind(actor.userId, id, new Date().toISOString()).run();
  return Response.json({ ok: true, id });
}

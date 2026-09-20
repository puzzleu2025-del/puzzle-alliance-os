import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";

export const dynamic = "force-dynamic";
const blank = { activities: [], tasks: [], meetings: [], notices: [] };

async function authorize() {
  const user = await getChatGPTUser();
  if (!user) return { error: Response.json({ error: "請先登入" }, { status: 401 }) };
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503 }) };
  const first = await env.DB.prepare("SELECT user_id FROM members WHERE role = 'admin' AND status = 'active' LIMIT 1").first<{ user_id: string }>();
  if (!first) {
    await env.DB.prepare("INSERT OR IGNORE INTO members (user_id,email,display_name,role,status,created_at) SELECT ?,?,?, 'admin','active',? WHERE NOT EXISTS (SELECT 1 FROM members WHERE role='admin' AND status='active')").bind(user.userId,user.email,user.displayName,new Date().toISOString()).run();
  }
  const member = await env.DB.prepare("SELECT role,status FROM members WHERE user_id = ? LIMIT 1").bind(user.userId).first<{role:string;status:string}>();
  if (!member || member.role !== "admin" || member.status !== "active") return { error: Response.json({ error: "目前只開放系統管理員使用" }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const auth = await authorize(); if (auth.error) return auth.error;
  const row = await env.DB!.prepare("SELECT data,version,updated_at FROM workspace_states WHERE id = 1").first<{data:string;version:number;updated_at:string}>();
  return Response.json({ state: row ? JSON.parse(row.data) : blank, version: row?.version ?? 0, updatedAt: row?.updated_at ?? null, role: "admin" });
}

export async function PUT(request: Request) {
  const auth = await authorize(); if (auth.error) return auth.error;
  let body: { state?: unknown; version?: number; action?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (!validState(body.state) || !Number.isInteger(body.version) || JSON.stringify(body.state).length > 750_000) return Response.json({ error: "資料格式不完整" }, { status: 400 });
  const current = await env.DB!.prepare("SELECT data,version FROM workspace_states WHERE id = 1").first<{data:string;version:number}>();
  const currentVersion = current?.version ?? 0;
  if (body.version !== currentVersion) return Response.json({ state: current ? JSON.parse(current.data) : blank, version: currentVersion }, { status: 409 });
  const nextVersion = currentVersion + 1, now = new Date().toISOString(), serialized = JSON.stringify(body.state);
  const write = !current
    ? await env.DB!.prepare("INSERT OR IGNORE INTO workspace_states (id,data,version,updated_at,updated_by) VALUES (1,?,?,?,?)").bind(serialized,nextVersion,now,auth.user!.userId).run()
    : await env.DB!.prepare("UPDATE workspace_states SET data=?,version=?,updated_at=?,updated_by=? WHERE id=1 AND version=?").bind(serialized,nextVersion,now,auth.user!.userId,currentVersion).run();
  if ((write.meta.changes ?? 0) !== 1) {
    const latest = await env.DB!.prepare("SELECT data,version FROM workspace_states WHERE id=1").first<{data:string;version:number}>();
    return Response.json({ state: latest ? JSON.parse(latest.data) : blank, version: latest?.version ?? 0 }, { status: 409 });
  }
  await env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,?,?,?)").bind(auth.user!.userId,String(body.action || "update_workspace"),"workspace","1",now).run();
  return Response.json({ version: nextVersion, updatedAt: now });
}

function validState(value: unknown): value is {activities:unknown[];tasks:unknown[];meetings:unknown[];notices:unknown[]} {
  if (!value || typeof value !== "object") return false;
  const row=value as Record<string,unknown>;
  if (!["activities","tasks","meetings","notices"].every(k=>Array.isArray(row[k]))) return false;
  const strings = (item: unknown, keys: string[]) => !!item && typeof item === "object" && keys.every(k => typeof (item as Record<string,unknown>)[k] === "string");
  return row.activities.every(x => strings(x,["id","name","date","owner","status","description"]))
    && row.tasks.every(x => strings(x,["id","name","activityId","assignee","due","status","blocker"]))
    && row.meetings.every(x => strings(x,["id","title","activityId","time","status"]))
    && row.notices.every(x => strings(x,["id","title","detail","createdAt"]) && typeof (x as Record<string,unknown>).read === "boolean");
}

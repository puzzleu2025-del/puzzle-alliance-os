import { env } from "cloudflare:workers";
import { csrfError, getMember } from "@/app/admin-auth";

export const dynamic = "force-dynamic";
const blank = { activities: [], tasks: [], meetings: [], notices: [] };
const noStore = { "Cache-Control": "private, no-store" };
const allowedActions = new Set(["create_activity", "create_task", "create_meeting", "complete_task", "reschedule", "confirm_meeting", "update_meeting_attendance", "read_notice", "update_workspace"]);

async function authorize() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503 }) };
  const user = await getMember();
  if (!user) return { error: Response.json({ error: "請先登入已核可帳號" }, { status: 401 }) };
  return { user };
}

export async function GET() {
  const auth = await authorize(); if (auth.error) return auth.error;
  const row = await env.DB!.prepare("SELECT data,version,updated_at FROM workspace_states WHERE id = 1").first<{data:string;version:number;updated_at:string}>();
  const audit = await env.DB!.prepare("SELECT a.id, COALESCE(m.display_name,a.actor_id) AS actor, a.action, a.created_at AS createdAt FROM audit_logs a LEFT JOIN members m ON m.user_id=a.actor_id ORDER BY a.id DESC LIMIT 50").all();
  return Response.json({ state: readState(row?.data), version: row?.version ?? 0, updatedAt: row?.updated_at ?? null, role: auth.user!.role, audit: audit.results }, { headers: noStore });
}

export async function PUT(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await authorize(); if (auth.error) return auth.error;
  // Every approved member works in the same activity, task and meeting space.
  // Registration responses and member credentials use separate protected APIs.
  let body: { state?: unknown; version?: number; action?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (!validState(body.state) || !Number.isInteger(body.version) || JSON.stringify(body.state).length > 750_000) return Response.json({ error: "資料格式不完整" }, { status: 400 });
  const action = body.action ?? "update_workspace";
  if (!allowedActions.has(action)) return Response.json({ error: "操作類型無效" }, { status: 400 });
  const current = await env.DB!.prepare("SELECT data,version FROM workspace_states WHERE id = 1").first<{data:string;version:number}>();
  const currentVersion = current?.version ?? 0;
  if (body.version !== currentVersion) return Response.json({ state: readState(current?.data), version: currentVersion }, { status: 409, headers: noStore });
  const nextVersion = currentVersion + 1, now = new Date().toISOString(), serialized = JSON.stringify(coreState(body.state));
  // D1 batch is a sequential SQL transaction. Check the same CAS condition
  // for the audit before writing state, avoiding connection-local changes().
  // A stale version makes both statements no-ops; any failure rolls both back.
  const audit = !current
    ? env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,?,'workspace','1',? WHERE NOT EXISTS (SELECT 1 FROM workspace_states WHERE id=1)").bind(auth.user!.userId,action,now)
    : env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,?,'workspace','1',? WHERE EXISTS (SELECT 1 FROM workspace_states WHERE id=1 AND version=?)").bind(auth.user!.userId,action,now,currentVersion);
  const stateWrite = !current
    ? env.DB!.prepare("INSERT INTO workspace_states (id,data,version,updated_at,updated_by) SELECT 1,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM workspace_states WHERE id=1)").bind(serialized,nextVersion,now,auth.user!.userId)
    : env.DB!.prepare("UPDATE workspace_states SET data=?,version=?,updated_at=?,updated_by=? WHERE id=1 AND version=?").bind(serialized,nextVersion,now,auth.user!.userId,currentVersion);
  const [, write] = await env.DB!.batch([audit, stateWrite]);
  if ((write.meta.changes ?? 0) !== 1) {
    const latest = await env.DB!.prepare("SELECT data,version FROM workspace_states WHERE id=1").first<{data:string;version:number}>();
    return Response.json({ state: readState(latest?.data), version: latest?.version ?? 0 }, { status: 409, headers: noStore });
  }
  return Response.json({ version: nextVersion, updatedAt: now }, { headers: noStore });
}

function coreState(state: { activities: unknown[]; tasks: unknown[]; meetings: unknown[]; notices: unknown[] }) {
  return { activities: state.activities, tasks: state.tasks, meetings: state.meetings, notices: state.notices };
}

function readState(raw?: string) {
  if (!raw) return blank;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validState(parsed) ? coreState(parsed) : blank;
  } catch { return blank; }
}

function validState(value: unknown): value is {activities:unknown[];tasks:unknown[];meetings:unknown[];notices:unknown[]} {
  if (!value || typeof value !== "object") return false;
  const row=value as Record<string,unknown>;
  if (!Array.isArray(row.activities) || !Array.isArray(row.tasks) || !Array.isArray(row.meetings) || !Array.isArray(row.notices)) return false;
  const object = (item: unknown): item is Record<string,unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const strings = (item: unknown, keys: string[]) => object(item) && keys.every(k => typeof item[k] === "string");
  const optionalStrings = (item: Record<string,unknown>, keys: string[]) => keys.every(k => item[k] === undefined || typeof item[k] === "string");
  const stringList = (item: Record<string,unknown>, key: string) => item[key] === undefined || (Array.isArray(item[key]) && item[key].every(x => typeof x === "string"));
  return row.activities.every(x => strings(x,["id","name","date","owner","status","description"])
      && optionalStrings(x,["startDate","endDate","proxy","location","type","size","currentMilestone"])
      && stringList(x,"teams") && (x.progress === undefined || typeof x.progress === "number")
      && (x.targetAttendance === undefined || (typeof x.targetAttendance === "number" && Number.isFinite(x.targetAttendance) && x.targetAttendance >= 0))
      && (x.budget === undefined || typeof x.budget === "number" || typeof x.budget === "string"))
    && row.tasks.every(x => strings(x,["id","name","activityId","assignee","due","status","blocker"])
      && optionalStrings(x,["proxy","jobRole","nextOwner","startDate","priority","phaseId","acceptanceCriteria"])
      && stringList(x,"flow") && stringList(x,"executionSteps") && stringList(x,"collaborators") && stringList(x,"dependencies")
      && (x.step === undefined || typeof x.step === "number")
      && (x.effortHours === undefined || (typeof x.effortHours === "number" && Number.isFinite(x.effortHours) && x.effortHours >= 0))
      && (x.progressPercent === undefined || (typeof x.progressPercent === "number" && Number.isFinite(x.progressPercent) && x.progressPercent >= 0 && x.progressPercent <= 100)))
    && row.meetings.every(x => strings(x,["id","title","activityId","time","status"])
      && optionalStrings(x,["type","organizer","recorder","endTime","location","meetingLink","agenda"])
      && stringList(x,"attendees")
      && (x.attending === undefined || typeof x.attending === "number")
      && (x.total === undefined || typeof x.total === "number")
      && (x.attendeeResponses === undefined || (Array.isArray(x.attendeeResponses) && x.attendeeResponses.every((person: unknown) => strings(person,["name","response"])))) )
    && row.notices.every(x => strings(x,["id","title","detail","createdAt"]) && typeof x.read === "boolean" && (x.important === undefined || typeof x.important === "boolean"));
}

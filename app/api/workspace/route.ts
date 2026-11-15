import { env } from "cloudflare:workers";
import { csrfError, currentToken, getMember, tokenHash } from "@/app/admin-auth";
import { taskDeadlineError } from "@/app/task-deadlines";

export const dynamic = "force-dynamic";
const blank = { activities: [], tasks: [], meetings: [], notices: [] };
const noStore = { "Cache-Control": "private, no-store" };
// SQLite's floating-point julianday conversion can truncate up to one millisecond.
const databaseNowMs = "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const allowedActions = new Set(["create_activity", "create_task", "create_meeting", "edit_activity", "edit_phase", "submit_activity", "assign_activity_authority", "edit_task", "edit_meeting", "complete_task", "reschedule", "confirm_meeting", "update_meeting_attendance", "read_notice", "update_workspace"]);

async function authorize() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503 }) };
  const user = await getMember();
  if (!user) return { error: Response.json({ error: "請先登入已核可帳號" }, { status: 401 }) };
  const token = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(token)) return { error: Response.json({ error: "請先登入已核可帳號" }, { status: 401 }) };
  return { user, tokenHash: await tokenHash(token) };
}

export async function GET() {
  const auth = await authorize(); if (auth.error) return auth.error;
  const row = await readWorkspace(auth.tokenHash!, auth.user!.userId);
  if (!row?.actor_role) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  const currentUser = { ...auth.user!, role: row.actor_role };
  const audit = await env.DB!.prepare("SELECT a.id, COALESCE(m.display_name,a.actor_id) AS actor, a.action, a.created_at AS createdAt FROM audit_logs a LEFT JOIN members m ON m.user_id=a.actor_id ORDER BY a.id DESC LIMIT 50").all();
  const people = await env.DB!.prepare("SELECT user_id AS id,display_name AS name,username,role FROM members WHERE status='active' ORDER BY display_name,username").all();
  return Response.json({ state: visibleState(workspaceState(row), currentUser), version: row?.version ?? 0, updatedAt: row?.updated_at ?? null, role: currentUser.role, audit: audit.results, memberOptions: people.results }, { headers: noStore });
}

export async function PUT(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await authorize(); if (auth.error) return auth.error;
  // Registration responses and member credentials use separate protected APIs.
  let body: { state?: unknown; version?: number; action?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400 }); }
  if (!validState(body.state) || !Number.isInteger(body.version) || JSON.stringify(body.state).length > 750_000) return Response.json({ error: "資料格式不完整" }, { status: 400 });
  const action = body.action ?? "update_workspace";
  if (!allowedActions.has(action)) return Response.json({ error: "操作類型無效" }, { status: 400 });
  const current = await readWorkspace(auth.tokenHash!, auth.user!.userId);
  if (!current?.actor_role) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  auth.user!.role = current.actor_role;
  const currentVersion = current.version ?? 0;
  const exists = current.data !== null;
  const previousState = workspaceState(current);
  if (body.version !== currentVersion) return Response.json({ state: visibleState(previousState, auth.user!), version: currentVersion }, { status: 409, headers: noStore });
  const nextState = mergeVisibleState(previousState, coreState(body.state), auth.user!);
  if (!nextState) return Response.json({ error: "會議資料已變更或無權修改，請重新載入" }, { status: 403, headers: noStore });
  const oldMeetings = previousState.meetings as MeetingRecord[];
  const newMeetings = nextState.meetings as MeetingRecord[];
  for (let i = 0; i < newMeetings.length; i++) {
    const meeting = newMeetings[i], old = oldMeetings[i];
    if (old && (organizationMeeting(old) !== organizationMeeting(meeting) || (old.meetingScope === "organization" && meeting.meetingScope !== "organization"))) return Response.json({ error: "既有會議不能變更組織類型" }, { status: 403, headers: noStore });
    if (!old && meeting.activityId === "" && meeting.meetingScope !== "organization") return Response.json({ error: "請選擇活動或組織會議" }, { status: 400, headers: noStore });
    if (!organizationMeeting(meeting)) continue;
    // Preserve untouched rows hidden from this user even if historical data is malformed.
    if (old && JSON.stringify(old) === JSON.stringify(meeting)) continue;
    if (meeting.activityId !== "" || !validInvitedIds(meeting.invitedMemberIds)) return Response.json({ error: "組織會議受邀名單無效" }, { status: 400, headers: noStore });
    if (!old) {
      if (!["admin", "manager", "coordinator"].includes(auth.user!.role)) return Response.json({ error: "只有總召以上可以建立組織會議" }, { status: 403, headers: noStore });
      meeting.invitedMemberIds = [...new Set([...meeting.invitedMemberIds, auth.user!.userId])];
    }
    const oldIds = old && Array.isArray(old.invitedMemberIds) ? old.invitedMemberIds : [];
    const added = (meeting.invitedMemberIds as string[]).filter(id => !oldIds.includes(id));
    if (added.length) {
      const active = await env.DB!.prepare(`SELECT user_id AS id FROM members WHERE status='active' AND user_id IN (${added.map(() => "?").join(",")})`).bind(...added).all<{id:string}>();
      if (active.results.length !== added.length) return Response.json({ error: "受邀者須為啟用中的成員" }, { status: 400, headers: noStore });
    }
  }
  if (action === "reschedule" && oldMeetings.some((row, i) => organizationMeeting(row) && JSON.stringify(row) !== JSON.stringify(newMeetings[i]))) {
    const notice = nextState.notices[0] as Record<string, unknown> | undefined;
    if (notice) { notice.title = "排程異動"; notice.detail = "有一項排程已更新。"; }
  }
  const oldActivities = new Map((previousState.activities as ActivityRow[]).map((activity) => [activity.id, activity]));
  const feeChanges = (nextState.activities as ActivityRow[]).flatMap((activity) => {
    const previous = oldActivities.get(activity.id);
    const before = previous?.feeAmount === undefined ? 0 : previous.feeAmount;
    const after = activity.feeAmount === undefined ? 0 : activity.feeAmount;
    return before === after ? [] : [{ id: activity.id as string, before: before as number, after: after as number }];
  });
  if (feeChanges.length && !managerRole(auth.user!.role) && auth.user!.role !== "coordinator")
    return Response.json({ error: "只有管理員或獲授權的總召可設定報名費" }, { status: 403, headers: noStore });
  const matchingNames = !managerRole(auth.user!.role)
    ? await env.DB!.prepare("SELECT user_id FROM members WHERE status='active' AND display_name=?").bind(auth.user!.displayName).all<{ user_id: string }>()
    : null;
  const uniqueSelfName = matchingNames?.results.length === 1 && matchingNames.results[0].user_id === auth.user!.userId;
  const changeError = stateChangeError(previousState, nextState, auth.user!.role, auth.user!.userId, auth.user!.displayName, action, uniqueSelfName);
  if (changeError) return Response.json({ error: changeError }, { status: 403, headers: noStore });
  const deadlineError = changedTaskDeadlineError(previousState, nextState);
  if (deadlineError) return Response.json({ error: deadlineError }, { status: 400, headers: noStore });
  const grantError = await activityGrantError(previousState, nextState);
  if (grantError) return Response.json({ error: grantError }, { status: 400, headers: noStore });
  if (action === "edit_phase") {
    const people = await env.DB!.prepare("SELECT display_name AS name FROM members WHERE status='active'").all<{ name: string }>();
    const activeNames = new Set(people.results.map((person) => person.name));
    const previousActivities = new Map((previousState.activities as Array<{ id: string; phasePlans?: Record<string, { owner?: string; proxy?: string }> }>).map((activity) => [activity.id, activity]));
    for (const activity of nextState.activities as Array<{ id: string; phasePlans?: Record<string, { owner?: string; proxy?: string }> }>) {
      const prior = previousActivities.get(activity.id);
      for (const [phaseId, plan] of Object.entries(activity.phasePlans ?? {})) {
        const oldPlan = prior?.phasePlans?.[phaseId];
        if (["owner", "proxy"].some((field) => {
          const value = plan[field as "owner" | "proxy"];
          return value && value !== oldPlan?.[field as "owner" | "proxy"] && !activeNames.has(value);
        })) return Response.json({ error: "階段主責與代理須選擇已啟用成員" }, { status: 400, headers: noStore });
      }
    }
  }
  if (action === "reschedule") {
    const error = rescheduleError(previousState, nextState, auth.user!.role, auth.user!.userId, auth.user!.displayName, uniqueSelfName);
    if (error) return Response.json({ error }, { status: 403, headers: noStore });
  }
  const nextVersion = currentVersion + 1, now = new Date().toISOString(), nonce = crypto.randomUUID();
  const serialized = JSON.stringify({ ...nextState, meetings: [] });
  // D1 batch is a sequential SQL transaction. Check session expiry at the
  // database statement and tie audit/meeting writes to the winning state nonce.
  const actorGuard = `EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>${databaseNowMs} AND m.user_id=? AND m.status='active' AND m.role=?)`;
  const guardArgs = [auth.tokenHash!, auth.user!.userId, auth.user!.role] as const;
  const stateWrite = !exists
    ? env.DB!.prepare(`INSERT INTO workspace_states (id,data,version,updated_at,updated_by,write_nonce) SELECT 1,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM workspace_states WHERE id=1) AND ${actorGuard}`).bind(serialized,nextVersion,now,auth.user!.userId,nonce,...guardArgs)
    : env.DB!.prepare(`UPDATE workspace_states SET data=?,version=?,updated_at=?,updated_by=?,write_nonce=? WHERE id=1 AND version=? AND ${actorGuard}`).bind(serialized,nextVersion,now,auth.user!.userId,nonce,currentVersion,...guardArgs);
  // Each write has its own nonce: a failed CAS cannot reuse a winner's timestamp.
  const wrote = "EXISTS (SELECT 1 FROM workspace_states WHERE id=1 AND version=? AND write_nonce=?)";
  const audit = env.DB!.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,?,'workspace','1',? WHERE ${wrote}`).bind(auth.user!.userId,action,now,nextVersion,nonce);
  // Update only changed/new rows: invisible historical records retain their exact stored bytes.
  const changedMeetings = newMeetings.flatMap((meeting, i) => {
    const old = oldMeetings[i];
    if (old && JSON.stringify(old) === JSON.stringify(meeting)) return [];
    return [{ id: meeting.id, activityId: organizationMeeting(meeting) ? null : meeting.activityId, position: i, data: meeting }];
  });
  const meetingWrites = changedMeetings.length ? [
    env.DB!.prepare(`INSERT INTO meetings (id,activity_id,position,data) SELECT json_extract(value,'$.id'),json_extract(value,'$.activityId'),json_extract(value,'$.position'),json_extract(value,'$.data') FROM json_each(?) WHERE ${wrote} ON CONFLICT(id) DO UPDATE SET activity_id=excluded.activity_id,position=excluded.position,data=excluded.data`).bind(JSON.stringify(changedMeetings), nextVersion, nonce),
  ] : [];
  const feeWrites = feeChanges.flatMap(({ id, before, after }) => [
    env.DB!.prepare(`INSERT INTO activity_fees (activity_id,amount,revision) SELECT ?,?,1 WHERE ${wrote} ON CONFLICT(activity_id) DO UPDATE SET amount=excluded.amount,revision=activity_fees.revision+1`).bind(id, after, nextVersion, nonce),
    env.DB!.prepare(`UPDATE registration_submissions SET
      fee_recheck_reason=CASE WHEN payment_status='paid' THEN CASE WHEN ?=0 THEN 'refund' ELSE 'price_change' END ELSE fee_recheck_reason END,
      payment_status=CASE WHEN ?=0 AND ?>0 AND payment_status NOT IN ('paid','refunded') THEN 'unpaid' WHEN ?>0 AND ?=0 AND payment_status IN ('unpaid','checking') THEN 'not_required' ELSE payment_status END,
      fee_followup=CASE WHEN ?=0 AND ?>0 AND payment_status NOT IN ('paid','refunded') THEN 1 WHEN ?>0 AND ?=0 AND payment_status IN ('unpaid','checking') THEN 0 ELSE fee_followup END
      WHERE form_id IN (SELECT id FROM registration_forms WHERE activity_id=?)
      AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM registration_identities i WHERE i.submission_id=registration_submissions.id AND i.status='cancelled') AND ${wrote}`)
      .bind(after,before,after,before,after,before,after,before,after,id,nextVersion,nonce),
  ]);
  const [write] = await env.DB!.batch([stateWrite, audit, ...meetingWrites, ...feeWrites]);
  const receipt = () => Response.json({ saved: true, requiresReauthentication: true, version: nextVersion, updatedAt: now }, { headers: noStore });
  let latest: Awaited<ReturnType<typeof readWorkspace>>;
  try { latest = await readWorkspace(auth.tokenHash!, auth.user!.userId); }
  catch (error) {
    // A successful transaction remains committed even if the subsequent read fails.
    if ((write.meta.changes ?? 0) === 1) return receipt();
    throw error;
  }
  if (!latest?.actor_role) {
    // Return a receipt without workspace data so the client clears its private cache.
    if ((write.meta.changes ?? 0) === 1) return receipt();
    return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  }
  const latestUser = { ...auth.user!, role: latest.actor_role };
  if ((write.meta.changes ?? 0) !== 1) {
    if (latest.actor_role !== auth.user!.role) return Response.json({ error: "權限已變更，請重新載入" }, { status: 403, headers: noStore });
    return Response.json({ state: visibleState(workspaceState(latest), latestUser), version: latest.version ?? 0 }, { status: 409, headers: noStore });
  }
  return Response.json({ state: visibleState(workspaceState(latest), latestUser), version: latest.version ?? nextVersion, updatedAt: latest.updated_at ?? now }, { headers: noStore });
}

function coreState(state: { activities: unknown[]; tasks: unknown[]; meetings: unknown[]; notices: unknown[] }) {
  return { activities: state.activities, tasks: state.tasks, meetings: state.meetings, notices: state.notices };
}

// One SQLite statement reads the version and meeting rows from one snapshot.
async function readWorkspace(sessionHash: string, userId: string) {
  // Actor session/role and workspace are evaluated in the same SQLite snapshot.
  return env.DB!.prepare(`SELECT data,version,updated_at,meetings_json,actor_role FROM (SELECT (SELECT data FROM workspace_states WHERE id=1) AS data,(SELECT version FROM workspace_states WHERE id=1) AS version,(SELECT updated_at FROM workspace_states WHERE id=1) AS updated_at,(SELECT json_group_array(json_object('activityId',activity_id,'data',json(data))) FROM (SELECT activity_id,data FROM meetings ORDER BY position)) AS meetings_json,(SELECT m.role FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>${databaseNowMs} AND m.user_id=? AND m.status='active') AS actor_role)`)
    .bind(sessionHash, userId)
    .first<{ data: string | null; version: number | null; updated_at: string | null; meetings_json: string; actor_role: string | null }>();
}

function workspaceState(row: Awaited<ReturnType<typeof readWorkspace>>) {
  if (!row || row.data === null) return blank;
  const rows: unknown = JSON.parse(row.meetings_json);
  if (!Array.isArray(rows)) throw new Error("INVALID_MEETING_DATA");
  const meetings = rows.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_MEETING_DATA");
    const record = entry as { activityId: unknown; data: unknown };
    if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error("INVALID_MEETING_DATA");
    const meeting = record.data as MeetingRecord;
    Object.defineProperty(meeting, physicalActivityId, { value: record.activityId });
    return meeting;
  });
  return { ...readState(row.data), meetings };
}

type WorkspaceUser = NonNullable<Awaited<ReturnType<typeof getMember>>>;
const physicalActivityId = Symbol("physicalActivityId");
type MeetingRecord = Record<string, unknown> & { id: string; [physicalActivityId]?: unknown };
const hasPhysicalActivityId = (meeting: MeetingRecord) => Object.prototype.hasOwnProperty.call(meeting, physicalActivityId);
// A mismatch or private-only metadata without its expected scope is ambiguous:
// fail closed rather than treating a damaged private record as an activity meeting.
const organizationMeeting = (meeting: MeetingRecord) => meeting.meetingScope !== undefined ||
  meeting.invitedMemberIds !== undefined || meeting.activityId === "" ||
  (hasPhysicalActivityId(meeting) && (meeting[physicalActivityId] === null || meeting[physicalActivityId] !== meeting.activityId));
function validInvitedIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.trim().length > 0 && id === id.trim()) && new Set(value).size === value.length;
}
function wellFormedOrganization(meeting: MeetingRecord) {
  return meeting.meetingScope === "organization" && meeting.activityId === "" &&
    (!hasPhysicalActivityId(meeting) || meeting[physicalActivityId] === null) && validInvitedIds(meeting.invitedMemberIds);
}
function maySeeMeeting(meeting: MeetingRecord, user: WorkspaceUser) {
  return !organizationMeeting(meeting) || managerRole(user.role) ||
    (wellFormedOrganization(meeting) && (meeting.invitedMemberIds as string[]).includes(user.userId));
}
// Managers can repair malformed private rows using the normal edit interface. The original
// bytes remain unchanged if this safe presentation is submitted without an actual edit.
function publicMeeting(meeting: MeetingRecord) {
  if (!organizationMeeting(meeting) || wellFormedOrganization(meeting)) return meeting;
  return { ...meeting, meetingScope: "organization", activityId: "", invitedMemberIds: validInvitedIds(meeting.invitedMemberIds) ? meeting.invitedMemberIds : [] };
}
function visibleState(state: ReturnType<typeof coreState>, user: WorkspaceUser) {
  return { ...state, meetings: (state.meetings as MeetingRecord[]).filter((meeting) => maySeeMeeting(meeting, user)).map(publicMeeting) };
}
function mergeVisibleState(previous: ReturnType<typeof coreState>, proposed: ReturnType<typeof coreState>, user: WorkspaceUser) {
  const full = previous.meetings as MeetingRecord[], incoming = proposed.meetings as MeetingRecord[];
  const visible = full.filter((meeting) => maySeeMeeting(meeting, user));
  if (incoming.length < visible.length || visible.some((meeting, i) => meeting.id !== incoming[i]?.id)) return null;
  const known = new Set(full.map((meeting) => meeting.id));
  if (new Set(incoming.map((meeting) => meeting.id)).size !== incoming.length || incoming.slice(visible.length).some((meeting) => known.has(meeting.id))) return null;
  const updated = new Map(incoming.slice(0, visible.length).map((meeting, i) => {
    const old = visible[i];
    return [meeting.id, JSON.stringify(publicMeeting(old)) === JSON.stringify(meeting) ? old : meeting];
  }));
  return { ...proposed, meetings: [...full.map((meeting) => updated.get(meeting.id) ?? meeting), ...incoming.slice(visible.length)] };
}

type ActivityRow = Record<string, unknown>;

function changedTaskDeadlineError(before: ReturnType<typeof coreState>, after: ReturnType<typeof coreState>) {
  const priorTasks = new Map((before.tasks as Array<{ id: string }>).map((task) => [task.id, task as Record<string, unknown>]));
  const priorActivities = new Map((before.activities as Array<{ id: string }>).map((activity) => [activity.id, activity as Record<string, unknown>]));
  const activities = new Map((after.activities as Array<{ id: string }>).map((activity) => [activity.id, activity as Record<string, unknown>]));
  for (const task of after.tasks as Array<{ id: string; activityId: string; due: string; startDate?: string; phaseId?: string }>) {
    const old = priorTasks.get(task.id);
    const activity = activities.get(task.activityId);
    const oldActivity = priorActivities.get(task.activityId);
    const changed = !old || ["due", "startDate", "phaseId", "activityId"].some((key) => old[key] !== task[key as keyof typeof task]);
    const planChanged = task.phaseId && (activity?.date !== oldActivity?.date ||
      (activity?.phasePlans as Record<string, { due?: string }> | undefined)?.[task.phaseId]?.due !== (oldActivity?.phasePlans as Record<string, { due?: string }> | undefined)?.[task.phaseId]?.due);
    if (changed || planChanged) {
      const error = taskDeadlineError(task, activity);
      if (error) return error;
    }
  }
  return "";
}
const managerRole = (role: string) => role === "admin" || role === "manager";
const submitted = (activity?: ActivityRow) => !!activity?.settingsSubmittedAt;
function assignedActivity(activity: ActivityRow | undefined, role: string, userId: string, name: string, uniqueSelfName = false) {
  if (!activity) return false;
  if (role === "trainee_coordinator") return activity.traineeCoordinatorId === userId;
  if (role !== "coordinator") return false;
  const grants = activity.coordinatorIds;
  if (Array.isArray(grants) || typeof activity.traineeCoordinatorId === "string") return Array.isArray(grants) && grants.includes(userId);
  // Old activity rows had no grant fields; their named owner/proxy remains usable.
  return uniqueSelfName && [activity.owner, activity.proxy].some((value) => String(value ?? "").trim() === name.trim());
}

async function activityGrantError(before: ReturnType<typeof coreState>, after: ReturnType<typeof coreState>) {
  const oldById = new Map((before.activities as ActivityRow[]).map((activity) => [activity.id, activity]));
  const people = await env.DB!.prepare("SELECT user_id AS id,role FROM members WHERE status='active'").all<{ id: string; role: string }>();
  const roleById = new Map(people.results.map((person) => [person.id, person.role]));
  const traineeCounts = new Map<string, number>();
  for (const activity of after.activities as ActivityRow[]) {
    const original = oldById.get(activity.id);
    const coordinatorIds = activity.coordinatorIds;
    if (coordinatorIds !== undefined) {
      if (!Array.isArray(coordinatorIds) || coordinatorIds.some((id) => typeof id !== "string") || new Set(coordinatorIds).size !== coordinatorIds.length) return "總召授權名單格式錯誤";
      if (coordinatorIds.some((id) => roleById.get(id) !== "coordinator") && JSON.stringify(coordinatorIds) !== JSON.stringify(original?.coordinatorIds)) return "只能授權已啟用的總召";
    }
    const trainee = activity.traineeCoordinatorId;
    if (trainee) {
      if (typeof trainee !== "string") return "見習總召授權格式錯誤";
      if (roleById.get(trainee) !== "trainee_coordinator" && trainee !== original?.traineeCoordinatorId) return "只能授權已啟用的見習總召";
      traineeCounts.set(trainee, (traineeCounts.get(trainee) ?? 0) + 1);
    }
    if (activity.settingsSubmittedAt !== undefined &&
      (typeof activity.settingsSubmittedAt !== "string" || !Number.isFinite(Date.parse(activity.settingsSubmittedAt)))) return "提交設定時間格式錯誤";
  }
  if ([...traineeCounts.values()].some((count) => count > 1)) return "見習總召只能負責一場活動";
  return "";
}

function stateChangeError(before: ReturnType<typeof coreState>, after: ReturnType<typeof coreState>, role: string, userId: string, name: string, action: string, uniqueSelfName = false) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const isManager = managerRole(role);
  if (action === "assign_activity_authority") {
    if (!isManager) return "只有管理員可以設定活動職權";
    if (!same(before.tasks, after.tasks) || !same(before.meetings, after.meetings) || !same(before.notices, after.notices)) return "活動職權操作不能修改其他資料";
    const previous = before.activities as Record<string, unknown>[];
    const next = after.activities as Record<string, unknown>[];
    if (previous.length !== next.length || previous.some((row, index) => row.id !== next[index]?.id)) return "活動職權操作不能增刪或排列活動";
    for (let index = 0; index < previous.length; index++) {
      const original = previous[index], updated = next[index];
      if (Object.keys({ ...original, ...updated }).some((field) => !["coordinatorIds", "traineeCoordinatorId"].includes(field) && !same(original[field], updated[field]))) return "活動職權操作不能修改活動細項";
    }
    return "";
  }
  const person = (value: unknown) => uniqueSelfName && String(value ?? "").trim() === name.trim();
  const activityById = new Map((before.activities as Record<string, unknown>[]).map((row) => [row.id, row]));
  const ownsActivity = (row?: Record<string, unknown>) => assignedActivity(row, role, userId, name, uniqueSelfName);
  const ownsRelatedActivity = (row: Record<string, unknown>) => ownsActivity(activityById.get(row.activityId));
  const managesMeeting = (row: Record<string, unknown>) => row.meetingScope === "organization" ? role === "coordinator" && validInvitedIds(row.invitedMemberIds) && row.invitedMemberIds.includes(userId) : ownsRelatedActivity(row);
  const changedFields = (oldRow: Record<string, unknown>, newRow: Record<string, unknown>) =>
    Object.keys({ ...oldRow, ...newRow }).filter((field) => !same(oldRow[field], newRow[field]));

  for (const key of ["activities", "tasks", "meetings"] as const) {
    const oldRows = before[key] as Record<string, unknown>[];
    const newRows = after[key] as Record<string, unknown>[];
    const oldById = new Map(oldRows.map((row) => [row.id, row]));
    const newById = new Map(newRows.map((row) => [row.id, row]));
    if (newById.size !== newRows.length || oldById.size !== oldRows.length) return "行程識別碼不能重複";
    if (oldRows.some((row, index) => newRows[index]?.id !== row.id)) return "不能刪除或重新排列既有資料";
    const added = newRows.slice(oldRows.length);
    const createAction = { activities: "create_activity", tasks: "create_task", meetings: "create_meeting" }[key];
    if (added.length && action !== createAction) return "新增資料需使用對應操作";
    if (key === "activities" && added.some((row) => row.coordinatorIds !== undefined || row.traineeCoordinatorId !== undefined)) return "新活動的職權請在成員管理設定";
    if (added.length && !isManager) {
      if (key === "activities") return "新活動及其總召授權須由管理員建立";
      if (added.some((row) => !(key === "meetings" && row.meetingScope === "organization" && role === "coordinator") && (!ownsRelatedActivity(row) || submitted(activityById.get(row.activityId))))) return "只能在獲授權且尚未提交設定的活動新增資料";
    }
    for (const row of oldRows) {
      const updated = newById.get(row.id)!;
      const fields = changedFields(row, updated);
      if (!fields.length) continue;
      if (key === "activities" && fields.some((field) => field === "coordinatorIds" || field === "traineeCoordinatorId")) return "活動職權請在成員管理設定";
      if (action.startsWith("create_")) return "新增操作不能同時修改既有資料";
      if (action === "submit_activity") {
        if (key !== "activities" || fields.length !== 1 || fields[0] !== "settingsSubmittedAt" ||
          submitted(row) || !submitted(updated) || (!isManager && !ownsActivity(row))) return "提交設定只能鎖定自己獲授權的活動";
        continue;
      }
      if (key === "meetings" && action === "update_meeting_attendance") {
        if (fields.some((field) => field !== "attendeeResponses" && field !== "attending")) return "出席回覆不能修改會議其他細項";
        const oldResponses = Array.isArray(row.attendeeResponses) ? row.attendeeResponses as Record<string, unknown>[] : [];
        const names = Array.from(new Set([
          ...(Array.isArray(row.attendees) ? row.attendees.map(String) : []),
          ...oldResponses.map((person) => String(person.name)),
        ].filter(Boolean)));
        const newResponses = Array.isArray(updated.attendeeResponses) ? updated.attendeeResponses as Record<string, unknown>[] : [];
        if (newResponses.length !== names.length || new Set(newResponses.map((person) => person.name)).size !== names.length ||
          names.some((personName) => !newResponses.some((person) => person.name === personName))) return "出席名單不能透過回覆變更";
        for (const current of newResponses) {
          const original = oldResponses.find((person) => person.name === current.name) ?? { name: current.name, response: "待回覆" };
          if (!isManager && (!uniqueSelfName || !person(current.name)) && !same(original, current)) return "只能回覆自己的出席狀態；同名成員請由管理員協助";
          if (changedFields(original, current).some((field) => field !== "response")) return "只能更新出席狀態";
        }
        if (updated.attending !== newResponses.filter((person) => person.response === "出席").length) return "會議出席人數不一致";
        continue;
      }
      if (isManager) continue;
      if (key === "activities") {
        if (!ownsActivity(row) || submitted(row)) return "只有管理員或尚未提交設定的活動總召可以修改活動";
        if (fields.some((field) => ["coordinatorIds", "traineeCoordinatorId", "settingsSubmittedAt"].includes(field))) return "總召授權及設定鎖定只能由管理員變更";
      } else if (key === "tasks") {
        if (fields.includes("activityId")) return "任務所屬活動只能由管理員變更";
        const relatedActivity = activityById.get(row.activityId);
        if (ownsRelatedActivity(row) && !submitted(relatedActivity)) continue;
        if (!person(row.assignee)) return "只能修改自己負責的任務";
        const personalFields = submitted(relatedActivity)
          ? ["status", "progressPercent", "step", "blocker"]
          : ["status", "progressPercent", "step", "blocker", "startDate", "due", "manualStartDate", "manualDue"];
        if (fields.some((field) => !personalFields.includes(field))) return "此身分只能更新自己的任務進度與卡點";
      } else if (fields.includes("activityId")) {
        return "會議所屬活動只能由管理員變更";
      } else if (managesMeeting(row) && !submitted(activityById.get(row.activityId))) {
        continue;
      } else {
        return "只能回覆自己的出席狀態，會議細項由負責人或管理員修改";
      }
    }
  }

  if (action === "reschedule") return ""; // The stricter reschedule check validates its single new notice.
  if (action === "read_notice") {
    if (before.notices.length !== after.notices.length) return "通知讀取不能增刪通知";
    for (let i = 0; i < before.notices.length; i++) {
      const prior = before.notices[i] as Record<string, unknown>, next = after.notices[i] as Record<string, unknown>;
      if (changedFields(prior, next).some((field) => field !== "read") || (prior.read === true && next.read === false)) return "通知讀取只能標記為已讀";
    }
  } else if (!same(before.notices, after.notices)) return "通知內容不能透過此操作變更";
  return "";
}

function rescheduleError(before: ReturnType<typeof coreState>, after: ReturnType<typeof coreState>, role: string, userId: string, name: string, uniqueSelfName: boolean) {
  const canManageAll = managerRole(role);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const activityById = new Map((before.activities as ActivityRow[]).map((row) => [row.id, row]));
  if (after.notices.length !== before.notices.length + 1 || !same(after.notices.slice(1), before.notices)) return "改期只能新增一筆異動通知";
  const collection = (key: "activities" | "tasks" | "meetings", allowed: string[], owner: string) => {
    const oldRows = before[key] as Record<string, unknown>[];
    const newRows = after[key] as Record<string, unknown>[];
    if (oldRows.length !== newRows.length || oldRows.some((row, index) => row.id !== newRows[index]?.id)) return "改期不能增刪或重新排列資料";
    for (let index = 0; index < oldRows.length; index++) {
      const oldRow = oldRows[index], newRow = newRows[index];
      if (same(oldRow, newRow)) continue;
      const activity = key === "activities" ? oldRow : activityById.get(oldRow.activityId);
      if (!canManageAll) {
        if (submitted(activity)) return "活動設定已提交，改期須由管理員處理";
        const assigned = key === "meetings" && oldRow.meetingScope === "organization" ? role === "coordinator" && validInvitedIds(oldRow.invitedMemberIds) && oldRow.invitedMemberIds.includes(userId) : assignedActivity(activity, role, userId, name, uniqueSelfName);
        if (!assigned && (key !== "tasks" || !uniqueSelfName || String(oldRow[owner] ?? "").trim() !== name.trim())) return "只能調整自己的任務或獲授權活動的日期";
      }
      const unchanged = Object.keys({ ...oldRow, ...newRow }).filter((field) => !allowed.includes(field)).every((field) => same(oldRow[field], newRow[field]));
      if (!unchanged) return "改期只能修改日期相關欄位";
    }
    return "";
  };
  return collection("activities", ["date", "startDate", "endDate"], "owner")
    || collection("tasks", ["startDate", "due", "manualStartDate", "manualDue"], "assignee")
    || collection("meetings", ["time", "endTime", "status"], "organizer");
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
      && optionalStrings(x,["startDate","endDate","proxy","location","type","size","currentMilestone","traineeCoordinatorId","settingsSubmittedAt"])
      && stringList(x,"teams") && stringList(x,"coordinatorIds") && (x.progress === undefined || typeof x.progress === "number")
      && (x.phasePlans === undefined || (object(x.phasePlans) && Object.entries(x.phasePlans).every(([phase, plan]) =>
        /^P[1-9]$/.test(phase) && object(plan) && optionalStrings(plan,["startDate","due","notes","owner","proxy"])
        && (plan.progress === undefined || (typeof plan.progress === "number" && Number.isFinite(plan.progress) && plan.progress >= 0 && plan.progress <= 100)))))
      && (x.targetAttendance === undefined || (typeof x.targetAttendance === "number" && Number.isFinite(x.targetAttendance) && x.targetAttendance >= 0))
      && (x.feeAmount === undefined || (typeof x.feeAmount === "number" && Number.isSafeInteger(x.feeAmount) && x.feeAmount >= 0))
      && (x.budget === undefined || typeof x.budget === "number" || typeof x.budget === "string"))
    && row.tasks.every(x => strings(x,["id","name","activityId","assignee","due","status","blocker"])
      && optionalStrings(x,["proxy","jobRole","nextOwner","startDate","priority","phaseId","acceptanceCriteria"])
      && (x.manualStartDate === undefined || typeof x.manualStartDate === "boolean")
      && (x.manualDue === undefined || typeof x.manualDue === "boolean")
      && stringList(x,"flow") && stringList(x,"executionSteps") && stringList(x,"collaborators") && stringList(x,"dependencies")
      && (x.step === undefined || typeof x.step === "number")
      && (x.effortHours === undefined || (typeof x.effortHours === "number" && Number.isFinite(x.effortHours) && x.effortHours >= 0))
      && (x.progressPercent === undefined || (typeof x.progressPercent === "number" && Number.isFinite(x.progressPercent) && x.progressPercent >= 0 && x.progressPercent <= 100)))
    && row.meetings.every(x => strings(x,["id","title","activityId","time","status"])
      && optionalStrings(x,["type","organizer","recorder","endTime","location","meetingLink","agenda","meetingScope"])
      && stringList(x,"invitedMemberIds")
      && stringList(x,"attendees")
      && (x.attending === undefined || typeof x.attending === "number")
      && (x.total === undefined || typeof x.total === "number")
      && (x.attendeeResponses === undefined || (Array.isArray(x.attendeeResponses) && x.attendeeResponses.every((person: unknown) => strings(person,["name","response"])))) )
    && row.notices.every(x => strings(x,["id","title","detail","createdAt"]) && typeof x.read === "boolean" && (x.important === undefined || typeof x.important === "boolean"));
}

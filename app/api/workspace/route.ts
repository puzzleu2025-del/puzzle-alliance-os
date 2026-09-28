import { env } from "cloudflare:workers";
import { csrfError, getMember } from "@/app/admin-auth";
import { taskDeadlineError } from "@/app/task-deadlines";

export const dynamic = "force-dynamic";
const blank = { activities: [], tasks: [], meetings: [], notices: [] };
const noStore = { "Cache-Control": "private, no-store" };
const allowedActions = new Set(["create_activity", "create_task", "create_meeting", "edit_activity", "edit_phase", "submit_activity", "assign_activity_authority", "edit_task", "edit_meeting", "complete_task", "reschedule", "confirm_meeting", "update_meeting_attendance", "read_notice", "update_workspace"]);

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
  const people = await env.DB!.prepare("SELECT user_id AS id,display_name AS name,username,role FROM members WHERE status='active' ORDER BY display_name,username").all();
  return Response.json({ state: readState(row?.data), version: row?.version ?? 0, updatedAt: row?.updated_at ?? null, role: auth.user!.role, audit: audit.results, memberOptions: people.results }, { headers: noStore });
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
  const current = await env.DB!.prepare("SELECT data,version FROM workspace_states WHERE id = 1").first<{data:string;version:number}>();
  const currentVersion = current?.version ?? 0;
  if (body.version !== currentVersion) return Response.json({ state: readState(current?.data), version: currentVersion }, { status: 409, headers: noStore });
  const previousState = readState(current?.data);
  const nextState = coreState(body.state);
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
  const managesMeeting = (row: Record<string, unknown>) => ownsRelatedActivity(row);
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
      if (added.some((row) => !ownsRelatedActivity(row) || submitted(activityById.get(row.activityId)))) return "只能在獲授權且尚未提交設定的活動新增資料";
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
        const assigned = assignedActivity(activity, role, userId, name, uniqueSelfName);
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
      && optionalStrings(x,["type","organizer","recorder","endTime","location","meetingLink","agenda"])
      && stringList(x,"attendees")
      && (x.attending === undefined || typeof x.attending === "number")
      && (x.total === undefined || typeof x.total === "number")
      && (x.attendeeResponses === undefined || (Array.isArray(x.attendeeResponses) && x.attendeeResponses.every((person: unknown) => strings(person,["name","response"])))) )
    && row.notices.every(x => strings(x,["id","title","detail","createdAt"]) && typeof x.read === "boolean" && (x.important === undefined || typeof x.important === "boolean"));
}

"use client";

import {
  FormEvent,
  ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import "./management-panels.css";
import type { RegistrationForm, RegistrationSubmission } from "./registration-types";
import MemberSelect, { MemberMultiSelect, type MemberOption } from "./member-select";

export type Activity = {
  id: string;
  name: string;
  date: string;
  owner: string;
  status: string;
  description: string;
  startDate?: string;
  endDate?: string;
  proxy?: string;
  location?: string;
  teams?: string[];
  progress?: number;
  budget?: number | string;
  type?: string;
  size?: string;
  targetAttendance?: number;
  currentMilestone?: string;
  phasePlans?: Record<string, { startDate?: string; due?: string; progress?: number; notes?: string; owner?: string; proxy?: string }>;
  coordinatorIds?: string[];
  traineeCoordinatorId?: string;
  settingsSubmittedAt?: string;
};

export type Task = {
  id: string;
  name: string;
  activityId: string;
  assignee: string;
  due: string;
  status: string;
  blocker: string;
  proxy?: string;
  jobRole?: string;
  nextOwner?: string;
  startDate?: string;
  manualStartDate?: boolean;
  manualDue?: boolean;
  priority?: string;
  flow?: string[];
  step?: number;
  phaseId?: string;
  executionSteps?: string[];
  acceptanceCriteria?: string;
  collaborators?: string[];
  effortHours?: number;
  progressPercent?: number;
  dependencies?: string[];
};

export type MeetingAttendee = {
  name: string;
  response: "出席" | "不出席" | "待回覆" | "可能出席";
};

export type Meeting = {
  id: string;
  title: string;
  activityId: string;
  time: string;
  status: string;
  type?: string;
  organizer?: string;
  recorder?: string;
  endTime?: string;
  location?: string;
  meetingLink?: string;
  attendees?: string[];
  attendeeResponses?: MeetingAttendee[];
  agenda?: string;
  attending?: number;
  total?: number;
};

export type Notice = {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  read: boolean;
  important?: boolean;
};

export type State = {
  activities: Activity[];
  tasks: Task[];
  meetings: Meeting[];
  notices: Notice[];
  registrationForms?: RegistrationForm[];
  registrationSubmissions?: RegistrationSubmission[];
};

export type ManagementPanelProps = {
  data: State;
  userId?: string;
  userName: string;
  userRole?: string;
  memberOptions?: MemberOption[];
  busy: boolean;
  onSave: (next: State, action: string) => Promise<boolean>;
  onOpenRegistrations?: (activityId: string) => void;
};

export function canConfigureActivity(activity: Activity | undefined, userId: string | undefined, userName: string, role?: string) {
  if (!activity) return false;
  if (role === "admin" || role === "manager") return true;
  if (!["coordinator", "trainee_coordinator"].includes(role ?? "") || activity.settingsSubmittedAt) return false;
  if (activity.coordinatorIds || activity.traineeCoordinatorId) return Boolean(userId && (activity.coordinatorIds?.includes(userId) || activity.traineeCoordinatorId === userId));
  return role === "coordinator" && [activity.owner, activity.proxy].some((name) => name?.trim() === userName.trim());
}

const uid = () => crypto.randomUUID();
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const commaList = (value: string) =>
  value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const DAY = 86_400_000;
const PHASES = [
  { id: "P1", name: "目標、對象、預算與活動日期", start: -8, end: -7, work: ["確認活動目標與預期成果", "盤點對象、預算上限與活動日期"] },
  { id: "P2", name: "活動骨架與宣傳必要資訊", start: -8, end: -7, work: ["擬定活動形式與流程骨架", "整理宣傳文案、報名資訊與負責窗口"] },
  { id: "P3", name: "前期宣傳與報名啟動", start: -7, end: -5, work: ["發布第一波宣傳", "開放報名並確認表單與回覆流程"] },
  { id: "P4", name: "內容、講師與流程細化", start: -6, end: -3, work: ["確認講師與節目內容", "完成流程表及主持、工作分工"] },
  { id: "P5", name: "場地、資源與人力落實", start: -6, end: -2, work: ["確認場地與設備需求", "落實工作人員、物資與預算採購"] },
  { id: "P6", name: "持續宣傳、招募與名單追蹤", start: -5, end: -1, work: ["追蹤報名與對帳狀況", "補足名額並整理通知名單"] },
  { id: "P7", name: "物資、彩排與最終確認", start: -2, end: 0, work: ["核對物資、場地及人員到位", "彩排流程並完成活動前提醒"] },
  { id: "P8", name: "活動執行", start: 0, end: 0, work: ["依流程執行與現場簽到", "記錄突發事項及活動成果"] },
  { id: "P9", name: "檢討、結算與成果結案", start: 1, end: 2, work: ["彙整回饋與檢討改進", "完成支出結算與成果歸檔"] },
] as const;
const WEEK_COLUMNS = Array.from({ length: 11 }, (_, index) => index - 8);

function localDay(value?: string) {
  if (!value) return Number.NaN;
  return new Date(`${value.slice(0, 10)}T00:00:00+08:00`).getTime();
}

function offsetDate(value: string, weeks: number) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

export function phaseSchedule(activityDate: string, phaseId: string) {
  const phase = PHASES.find((row) => row.id === phaseId);
  if (!activityDate || !phase) return null;
  return { startDate: offsetDate(activityDate, phase.start), due: offsetDate(activityDate, phase.end) };
}

export function activityPhaseSchedule(activity: Activity | undefined, phaseId: string) {
  const baseline = phaseSchedule(activity?.date ?? "", phaseId);
  if (!baseline) return null;
  const override = activity?.phasePlans?.[phaseId];
  return { startDate: override?.startDate || baseline.startDate, due: override?.due || baseline.due };
}

function activityPlanningDates(eventDate: string) {
  return { startDate: offsetDate(eventDate, -8), endDate: offsetDate(eventDate, 2) };
}

function phaseLabel(phaseId?: string) {
  const phase = PHASES.find((row) => row.id === phaseId);
  return phase ? `${phase.id} ${phase.name}` : "未分階段";
}

function taskProgress(task: Task) {
  if (task.status === "完成") return 100;
  return Math.max(0, Math.min(100, task.progressPercent ?? 0));
}

function incompleteDependencies(task: Task, tasks: Task[]) {
  return (task.dependencies ?? [])
    .map((id) => tasks.find((row) => row.id === id))
    .filter((row): row is Task => Boolean(row && row.status !== "完成" && row.status !== "不適用"));
}

function activityName(data: State, id: string) {
  return data.activities.find((activity) => activity.id === id)?.name || "未分類";
}

function dateLabel(value?: string) {
  if (!value) return "未設定";
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: value.includes("T") ? "short" : undefined,
    timeZone: "Asia/Taipei",
  }).format(date);
}

function safeMeetingUrl(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function activityProgress(activity: Activity, tasks: Task[]) {
  const rows = tasks.filter((task) => task.activityId === activity.id && task.status !== "不適用");
  return rows.length
    ? Math.round(rows.reduce((sum, task) => sum + taskProgress(task), 0) / rows.length)
    : Math.max(0, Math.min(100, activity.progress ?? 0));
}

function Dialog({
  title,
  close,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`mgmt-dialog${wide ? " mgmt-dialog-wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="mgmt-dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="關閉" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

function FormStatus({ failed }: { failed: boolean }) {
  return failed ? (
    <p className="mgmt-form-error" role="alert">
      儲存失敗，填寫內容已保留。請確認連線後再試一次。
    </p>
  ) : null;
}

function Gantt({ activity, tasks, onEditPhase }: { activity: Activity; tasks: Task[]; onEditPhase?: (phaseId: string) => void }) {
  const rows = tasks.filter((task) => task.activityId === activity.id);
  const eventTime = localDay(activity.date || activity.startDate);
  const todayTime = localDay(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date()));
  const todayWeek = Number.isFinite(eventTime) ? Math.floor((todayTime - eventTime) / (DAY * 7)) : null;
  const currentPhases = PHASES.filter((phase) => {
    const schedule = activityPhaseSchedule(activity, phase.id);
    return schedule && todayTime >= localDay(schedule.startDate) && todayTime <= localDay(schedule.due);
  }).map((phase) => phase.id);
  const weekFromDate = (value: string | undefined, fallback: number) => {
    const time = localDay(value);
    return Number.isFinite(time) && Number.isFinite(eventTime)
      ? Math.max(-8, Math.min(2, Math.round((time - eventTime) / (DAY * 7))))
      : fallback;
  };
  const resolvedPhaseId = (task: Task) => task.phaseId || PHASES.find((phase) => {
    const week = weekFromDate(task.due || task.startDate, 0);
    return week >= phase.start && week <= phase.end;
  })?.id || "P8";
  const relevantPhases = PHASES.filter((phase) => currentPhases.includes(phase.id) || rows.some((task) => resolvedPhaseId(task) === phase.id)).map((phase) => phase.id);
  const focusPhase = [...PHASES]
    .filter((phase) => currentPhases.includes(phase.id))
    .sort((a, b) => b.start - a.start || b.end - a.end)[0]
    ?? PHASES.reduce((closest, phase) => {
      if (todayWeek === null) return closest;
      const distance = todayWeek < phase.start ? phase.start - todayWeek : todayWeek > phase.end ? todayWeek - phase.end : 0;
      const closestDistance = todayWeek < closest.start ? closest.start - todayWeek : todayWeek > closest.end ? todayWeek - closest.end : 0;
      return distance < closestDistance ? phase : closest;
    }, PHASES[0]);
  const focusIndex = PHASES.findIndex((phase) => phase.id === focusPhase.id);
  const mobileStart = Math.max(0, Math.min(PHASES.length - 3, focusIndex - 1));
  const mobilePhases = PHASES.slice(mobileStart, mobileStart + 3);
  const [expanded, setExpanded] = useState<string[]>([focusPhase.id]);
  const toggle = (id: string) => setExpanded((value) => value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  const taskBar = (task: Task, phase: (typeof PHASES)[number]) => {
    const start = weekFromDate(task.startDate, phase.start);
    const end = Math.max(start, weekFromDate(task.due, phase.end));
    return { start, end };
  };
  const phaseProgress = (phaseId: string) => {
    const specified = activity.phasePlans?.[phaseId]?.progress;
    if (specified !== undefined) return specified;
    const related = rows.filter((task) => resolvedPhaseId(task) === phaseId && task.status !== "不適用");
    return related.length ? Math.round(related.reduce((sum, task) => sum + taskProgress(task), 0) / related.length) : 0;
  };
  const centerWeek = Math.max(-7, Math.min(1, todayWeek ?? 0));
  const agendaWeeks = [centerWeek - 1, centerWeek, centerWeek + 1].map((week) => ({
    week,
    start: offsetDate(activity.date, week),
    phases: PHASES.filter((phase) => {
      const schedule = activityPhaseSchedule(activity, phase.id);
      const weekStart = offsetDate(activity.date, week);
      const nextWeek = offsetDate(activity.date, week + 1);
      return schedule && schedule.startDate < nextWeek && schedule.due >= weekStart;
    }),
  }));

  return (
    <div className="mgmt-gantt-wrap">
      <div className="mgmt-gantt-controls">
        <span>{todayWeek !== null && todayWeek >= -8 && todayWeek <= 2 ? `今天在第 ${todayWeek > 0 ? "+" : ""}${todayWeek} 週` : "今天不在主要籌備週期"}</span>
        <div><button type="button" onClick={() => setExpanded(relevantPhases)}>展開相關階段</button><button type="button" onClick={() => setExpanded([])}>全部收合</button></div>
      </div>
      <div className="mgmt-weekly-agenda" aria-label="目前週期前後的每週籌備工作">
        {agendaWeeks.map(({ week, start, phases }) => <section key={week} className={week === todayWeek ? "current" : ""}>
          <h4>第 {week > 0 ? `+${week}` : week} 週 <small>{dateLabel(start)}起</small></h4>
          {phases.length ? phases.map((phase) => <div key={phase.id}><b>{phase.id} {phase.name}</b><small>主責 {activity.phasePlans?.[phase.id]?.owner || "未指派"} · 代理 {activity.phasePlans?.[phase.id]?.proxy || "未指派"}</small><ul>{phase.work.map((work) => <li key={work}>{work}</li>)}</ul></div>) : <p>這週沒有預設籌備階段。</p>}
        </section>)}
      </div>
      <div className="mgmt-gantt-desktop mgmt-gantt-scroll" tabIndex={0} aria-label={`${activity.name} P1 到 P9 任務甘特圖`}>
        <div className="mgmt-gantt">
          <div className="mgmt-gantt-header"><b>階段／任務</b>{WEEK_COLUMNS.map((week) => <span className={week === todayWeek ? "today" : ""} key={week}>{week > 0 ? `+${week}` : week}</span>)}</div>
          {PHASES.map((phase) => {
            const phaseTasks = rows.filter((task) => resolvedPhaseId(task) === phase.id);
            const isExpanded = expanded.includes(phase.id);
            const schedule = activityPhaseSchedule(activity, phase.id)!;
            const phaseStart = weekFromDate(schedule.startDate, phase.start);
            const phaseEnd = Math.max(phaseStart, weekFromDate(schedule.due, phase.end));
            return <div className="mgmt-gantt-phase" key={phase.id}>
              <div className="mgmt-gantt-phase-row">
                <div className="mgmt-gantt-phase-title"><button type="button" aria-expanded={isExpanded} onClick={() => toggle(phase.id)}><span>{isExpanded ? "▾" : "▸"}</span><b>{phase.id}</b><small>{phase.name}</small><em>{phaseProgress(phase.id)}%</em></button>{onEditPhase && <button type="button" aria-label={`編輯 ${phase.id} 階段`} onClick={() => onEditPhase(phase.id)}>調整</button>}</div>
                <div className="mgmt-gantt-weeks">{WEEK_COLUMNS.map((week) => <span className={`${week === todayWeek ? "today " : ""}${week >= phaseStart && week <= phaseEnd ? "active" : ""}`} key={week} />)}</div>
              </div>
              {isExpanded && <div className="mgmt-gantt-plan"><b>每週籌備：{phase.name}</b><span>{dateLabel(schedule.startDate)}－{dateLabel(schedule.due)} · 進度 {phaseProgress(phase.id)}%</span><span>主責 {activity.phasePlans?.[phase.id]?.owner || "未指派"} · 代理 {activity.phasePlans?.[phase.id]?.proxy || "未指派"}</span><ul>{phase.work.map((item) => <li key={item}>{item}</li>)}</ul>{activity.phasePlans?.[phase.id]?.notes && <p>{activity.phasePlans[phase.id].notes}</p>}</div>}
              {isExpanded && phaseTasks.map((task) => {
                const bar = taskBar(task, phase);
                const blocked = incompleteDependencies(task, rows).length > 0;
                return <div className="mgmt-gantt-task-row" key={task.id}>
                  <div><b>{task.name}</b><small>{task.assignee || "未指派"} · {task.status}{blocked ? " · 前置阻塞" : ""}</small></div>
                  <div className="mgmt-gantt-weeks">{WEEK_COLUMNS.map((week) => <span className={week === todayWeek ? "today" : ""} key={week}>{week >= bar.start && week <= bar.end && <i className={`${task.status === "完成" ? "done " : ""}${blocked ? "blocked" : ""}`} title={`${task.name}：${taskProgress(task)}%`} />}</span>)}</div>
                </div>;
              })}
            </div>;
          })}
        </div>
      </div>
      <div className="mgmt-gantt-mobile">
        <p className="mgmt-mobile-phase-hint">手機只顯示目前階段與前後各一階段。</p>
        {mobilePhases.map((phase) => {
          const phaseTasks = rows.filter((task) => resolvedPhaseId(task) === phase.id);
          const isExpanded = expanded.includes(phase.id);
          const schedule = activityPhaseSchedule(activity, phase.id)!;
          return <section key={phase.id} className={currentPhases.includes(phase.id) ? "current" : ""}>
            <button type="button" aria-expanded={isExpanded} onClick={() => toggle(phase.id)}><span><b>{phase.id}</b> {phase.name}</span><small>{dateLabel(schedule.startDate)}－{dateLabel(schedule.due)} · {phaseProgress(phase.id)}%</small></button>
            {isExpanded && <div><article><b>每週籌備：{phase.name}</b><span>{dateLabel(schedule.startDate)}－{dateLabel(schedule.due)}</span><small>階段進度 {phaseProgress(phase.id)}%</small><small>主責 {activity.phasePlans?.[phase.id]?.owner || "未指派"} · 代理 {activity.phasePlans?.[phase.id]?.proxy || "未指派"}</small><ul>{phase.work.map((item) => <li key={item}>{item}</li>)}</ul>{activity.phasePlans?.[phase.id]?.notes && <em>{activity.phasePlans[phase.id].notes}</em>}{onEditPhase && <button type="button" aria-label={`編輯 ${phase.id} 階段`} onClick={() => onEditPhase(phase.id)}>調整階段</button>}</article>{phaseTasks.map((task) => <article key={task.id}><b>{task.name}</b><span>{dateLabel(task.startDate)}－{dateLabel(task.due)}</span><small>{task.assignee || "未指派"} · {task.status} · {taskProgress(task)}%</small>{incompleteDependencies(task, rows).length > 0 && <em>前置阻塞：{incompleteDependencies(task, rows).map((item) => item.name).join("、")}</em>}</article>)}</div>}
          </section>;
        })}
      </div>
    </div>
  );
}

function ActivityFields({ activity, userName, members, disabled, canAssign }: { activity?: Activity; userName: string; members: MemberOption[]; disabled: boolean; canAssign: boolean }) {
  const updateSchedule = (input: HTMLInputElement) => {
    const form = input.form;
    if (!form) return;
    const previous = input.dataset.previousDate || activity?.date || "";
    const oldDates = activityPlanningDates(previous);
    const nextDates = activityPlanningDates(input.value);
    const start = form.elements.namedItem("startDate") as HTMLInputElement;
    const end = form.elements.namedItem("endDate") as HTMLInputElement;
    if (!start.value || start.value === oldDates.startDate) start.value = nextDates.startDate;
    if (!end.value || end.value === oldDates.endDate) end.value = nextDates.endDate;
    input.dataset.previousDate = input.value;
  };
  return <fieldset disabled={disabled} className="mgmt-form-grid">
    <label className="mgmt-span-2">活動名稱<input name="name" required maxLength={200} defaultValue={activity?.name} autoFocus /></label>
    <label className="mgmt-span-2">活動舉辦日（甘特圖第 0 週）<input name="eventDate" type="date" required defaultValue={activity?.date} onChange={(event) => updateSchedule(event.currentTarget)} /><small>選擇活動日後自動反推 P1–P9 籌備週期；可調整下方起訖及各階段日期。</small></label>
    <label>籌備開始<input name="startDate" type="date" defaultValue={activity?.startDate} /></label>
    <label>籌備結束<input name="endDate" type="date" defaultValue={activity?.endDate} /></label>
    <label>狀態<select name="status" defaultValue={activity?.status || "規劃中"}><option>規劃中</option><option>籌備中</option><option>進行中</option><option>已完成</option></select></label>
    <label>完成率（%）<input name="progress" type="number" min="0" max="100" step="1" defaultValue={activity?.progress ?? 0} /></label>
    <label>活動類型<input name="type" maxLength={100} defaultValue={activity?.type} placeholder="例：聯誼、工作坊" /></label>
    <label>活動規模<input name="size" maxLength={100} defaultValue={activity?.size} placeholder="例：中型、50 人" /></label>
    <label>目標人數<input name="targetAttendance" type="number" min="0" step="1" inputMode="numeric" defaultValue={activity?.targetAttendance} /></label>
    <label>活動總召<MemberSelect name="owner" members={members} defaultValue={activity?.owner || userName} required /></label>
    <label>職務代理<MemberSelect name="proxy" members={members} defaultValue={activity?.proxy} /></label>
    {canAssign && <><label>獲授權總召（可多場）<select name="coordinatorIds" multiple size={Math.min(5, Math.max(3, members.length))} defaultValue={activity?.coordinatorIds ?? []}>{(activity?.coordinatorIds ?? []).filter((id) => !members.some((person) => person.id === id && person.role === "coordinator")).map((id) => <option key={id} value={id}>{id}（既有授權）</option>)}{members.filter((person) => person.role === "coordinator").map((person) => <option key={person.id} value={person.id}>{person.name}（@{person.username}）</option>)}</select><small>可按 Ctrl／⌘ 選取多位。</small></label><label>見習總召（只可一場）<select name="traineeCoordinatorId" defaultValue={activity?.traineeCoordinatorId || ""}><option value="">未指派</option>{activity?.traineeCoordinatorId && !members.some((person) => person.id === activity.traineeCoordinatorId && person.role === "trainee_coordinator") && <option value={activity.traineeCoordinatorId}>{activity.traineeCoordinatorId}（既有授權）</option>}{members.filter((person) => person.role === "trainee_coordinator").map((person) => <option key={person.id} value={person.id}>{person.name}（@{person.username}）</option>)}</select></label></>}
    <label>場地<input name="location" maxLength={200} defaultValue={activity?.location} /></label>
    <label className="mgmt-span-2">工作組（逗號分隔）<input name="teams" defaultValue={activity?.teams?.join(", ")} placeholder="企劃, 場務, 公關" maxLength={500} /></label>
    <label>預算<input name="budget" type="number" min="0" step="1" inputMode="numeric" defaultValue={activity?.budget} /></label>
    <label className="mgmt-span-2">本週里程碑<input name="currentMilestone" maxLength={300} defaultValue={activity?.currentMilestone} /></label>
    <label className="mgmt-span-2">活動說明<textarea name="description" maxLength={5000} defaultValue={activity?.description} /></label>
  </fieldset>;
}

export function ActivitiesPanel({ data, userId, userName, userRole, memberOptions = [], busy, onSave, onOpenRegistrations }: ManagementPanelProps) {
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Activity | null>(null);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [editingPhase, setEditingPhase] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  const canManageAll = ["admin", "manager"].includes(userRole ?? "");
  const canEditActivity = (activity: Activity) => canConfigureActivity(activity, userId, userName, userRole);
  const submit = async (event: FormEvent<HTMLFormElement>, original?: Activity) => {
    event.preventDefault();
    if (submitting || busy) return;
    const form = new FormData(event.currentTarget);
    const eventDate = field(form, "eventDate");
    const defaults = activityPlanningDates(eventDate);
    const startDate = field(form, "startDate") || defaults.startDate;
    const endDate = field(form, "endDate") || defaults.endDate;
    if (startDate && endDate < startDate) {
      const input = event.currentTarget.elements.namedItem("endDate") as HTMLInputElement;
      input.setCustomValidity("結束日期不能早於開始日期");
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const item: Activity = {
      ...original,
      id: original?.id || uid(),
      name: field(form, "name"),
      date: eventDate,
      owner: field(form, "owner") || userName,
      status: field(form, "status") || "規劃中",
      description: field(form, "description"),
      startDate,
      endDate,
      proxy: field(form, "proxy"),
      location: field(form, "location"),
      teams: commaList(field(form, "teams")),
      budget: field(form, "budget"),
      type: field(form, "type"),
      size: field(form, "size"),
      targetAttendance: Number(field(form, "targetAttendance")) || undefined,
      currentMilestone: field(form, "currentMilestone"),
      progress: Number(field(form, "progress")) || 0,
      coordinatorIds: canManageAll ? form.getAll("coordinatorIds").map(String) : original?.coordinatorIds,
      traineeCoordinatorId: canManageAll ? field(form, "traineeCoordinatorId") : original?.traineeCoordinatorId,
    };
    const tasks = original && original.date !== item.date ? data.tasks.map((task) => {
      if (task.activityId !== original.id || !task.phaseId) return task;
      const before = activityPhaseSchedule(original, task.phaseId);
      const after = activityPhaseSchedule(item, task.phaseId);
      if (!before || !after) return task;
      return { ...task,
        startDate: !task.manualStartDate && task.startDate === before.startDate ? after.startDate : task.startDate,
        due: !task.manualDue && task.due === before.due ? after.due : task.due,
      };
    }) : data.tasks;
    setSubmitting(true);
    setFailed(false);
    const saved = await onSave(
      { ...data, activities: original ? data.activities.map((row) => row.id === original.id ? item : row) : [...data.activities, item], tasks },
      original ? "edit_activity" : "create_activity",
    );
    setSubmitting(false);
    if (saved) { setCreating(false); setEditing(null); if (original) setDetail(item); }
    else setFailed(true);
  };

  const submitPhase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail || !editingPhase || busy || submitting) return;
    const form = new FormData(event.currentTarget);
    const startDate = field(form, "startDate"), due = field(form, "due");
    if (due < startDate) {
      const input = event.currentTarget.elements.namedItem("due") as HTMLInputElement;
      input.setCustomValidity("階段結束不能早於開始"); input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const updated: Activity = { ...detail, phasePlans: { ...detail.phasePlans, [editingPhase]: { startDate, due, progress: Number(field(form, "progress")), notes: field(form, "notes"), owner: field(form, "owner"), proxy: field(form, "proxy") } } };
    setSubmitting(true); setFailed(false);
    const saved = await onSave({ ...data, activities: data.activities.map((row) => row.id === updated.id ? updated : row) }, "edit_phase");
    setSubmitting(false);
    if (saved) { setDetail(updated); setEditingPhase(null); } else setFailed(true);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>活動管理</h2>
          <p className="muted">把日期、場地、工作組與任務時程集中在同一個活動。</p>
        </div>
        {canManageAll && <button className="primary" onClick={() => { setFailed(false); setCreating(true); }}>
          ＋ 建立活動
        </button>}
      </div>
      {data.activities.length ? (
        <div className="mgmt-activity-grid">
          {data.activities.map((activity) => {
            const progress = activityProgress(activity, data.tasks);
            return (
              <article className="mgmt-activity-card" key={activity.id}>
                <div className="mgmt-card-head">
                  <span className="badge">{activity.status}</span>
                  <span className="mgmt-progress-label">{progress}%</span>
                </div>
                <h3>{activity.name}</h3>
                <p className="muted">舉辦日 {dateLabel(activity.date)}</p>
                <p className="muted">籌備 {dateLabel(activity.startDate || activityPlanningDates(activity.date).startDate)}－{dateLabel(activity.endDate || activityPlanningDates(activity.date).endDate)}</p>
                <dl className="mgmt-compact-list">
                  <div><dt>活動總召</dt><dd>{activity.owner || "未指派"}</dd></div>
                  <div><dt>職務代理</dt><dd>{activity.proxy || "未指派"}</dd></div>
                  <div><dt>場地</dt><dd>{activity.location || "未設定"}</dd></div>
                  <div><dt>工作組</dt><dd>{activity.teams?.join("、") || "未設定"}</dd></div>
                </dl>
                <div className="meter"><i style={{ width: `${progress}%` }} /></div>
                <div className="page-actions">
                  <button className="mgmt-wide-button" onClick={() => setDetail(activity)}>查看活動詳情與甘特圖</button>
                  {onOpenRegistrations && <button className="mgmt-wide-button" onClick={() => onOpenRegistrations(activity.id)}>報名表單</button>}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty">還沒有活動。建立第一個活動後，就能歸檔任務與會議。</div>
      )}

      {creating && (
        <Dialog title="建立活動" close={() => !submitting && !busy && setCreating(false)} wide>
          <form onSubmit={(event) => void submit(event)}>
            <FormStatus failed={failed} />
            <ActivityFields userName={userName} members={memberOptions} disabled={submitting || busy} canAssign={canManageAll} />
            <div className="mgmt-dialog-actions">
              <button type="button" disabled={submitting || busy} onClick={() => setCreating(false)}>取消</button>
              <button className="primary" disabled={submitting || busy} type="submit">{submitting || busy ? "儲存中…" : "建立並同步"}</button>
            </div>
          </form>
        </Dialog>
      )}

      {detail && (
        <Dialog title={detail.name} close={() => setDetail(null)} wide>
          {(() => {
            const tasks = data.tasks.filter((task) => task.activityId === detail.id);
            const applicable = tasks.filter((task) => task.status !== "不適用");
            const overdue = applicable.filter((task) => task.status !== "完成" && Number.isFinite(localDay(task.due)) && localDay(task.due) < localDay(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date()))).length;
            const next = [...applicable].filter((task) => task.status !== "完成").sort((a, b) => localDay(a.due) - localDay(b.due))[0];
            return <>
              <div className="mgmt-activity-hero">
                <div><small>活動日期</small><b>{dateLabel(detail.date)}</b></div>
                <div><small>主責／代理</small><b>{detail.owner || "未指派"}／{detail.proxy || "未指派"}</b></div>
                <div><small>狀態</small><b>{detail.status}</b></div>
                <div className="milestone"><small>本週里程碑</small><b>{detail.currentMilestone || "尚未設定"}</b></div>
              </div>
              <div className="mgmt-activity-summary">
                <div><small>完成率</small><strong>{activityProgress(detail, data.tasks)}%</strong><span>排除不適用任務</span></div>
                <div className={overdue ? "alert" : ""}><small>逾期數</small><strong>{overdue}</strong><span>{overdue ? "需要優先處理" : "目前無逾期"}</span></div>
                <div><small>下一個未完成任務</small><strong>{next?.name || "全部完成"}</strong><span>{next ? `${phaseLabel(next.phaseId)} · ${dateLabel(next.due)}` : "沒有待辦任務"}</span></div>
              </div>
              <div className="mgmt-detail-grid mgmt-activity-meta">
                <div><small>類型／規模</small><b>{[detail.type, detail.size].filter(Boolean).join(" · ") || "未設定"}</b></div>
                <div><small>目標人數</small><b>{detail.targetAttendance ? `${detail.targetAttendance} 人` : "未設定"}</b></div>
                <div><small>場地</small><b>{detail.location || "未設定"}</b></div>
                <div><small>工作組</small><b>{detail.teams?.join("、") || "未設定"}</b></div>
                <div><small>獲授權總召</small><b>{detail.coordinatorIds?.map((id) => memberOptions.find((person) => person.id === id)?.name || "既有成員").join("、") || "未設定"}</b></div>
                <div><small>見習總召</small><b>{memberOptions.find((person) => person.id === detail.traineeCoordinatorId)?.name || (detail.traineeCoordinatorId ? "既有成員" : "未設定")}</b></div>
                <div><small>預算</small><b>{detail.budget ? `NT$ ${Number(detail.budget).toLocaleString("zh-TW")}` : "未設定"}</b></div>
              </div>
            </>;
          })()}
          <p className="mgmt-detail-copy">{detail.description || "尚未加入活動說明。"}</p>
          {detail.settingsSubmittedAt && <p className="muted">設定已提交；後續細項由管理員修改。</p>}
          <div className="mgmt-dialog-actions">{canEditActivity(detail) && <button type="button" onClick={() => { setFailed(false); setEditing(detail); }}>編輯活動</button>}{!canManageAll && canEditActivity(detail) && <button type="button" className="primary" disabled={submitting || busy} onClick={async () => { if (!window.confirm("提交後，活動設定與相關細項須由管理員修改。確定提交？")) return; setSubmitting(true); const updated = { ...detail, settingsSubmittedAt: new Date().toISOString() }; const saved = await onSave({ ...data, activities: data.activities.map((row) => row.id === detail.id ? updated : row) }, "submit_activity"); setSubmitting(false); if (saved) setDetail(updated); }}>提交設定</button>}{canManageAll && detail.settingsSubmittedAt && <button type="button" disabled={submitting || busy} onClick={async () => { if (!window.confirm("重新開放總召設定？")) return; setSubmitting(true); const updated = { ...detail, settingsSubmittedAt: undefined }; const saved = await onSave({ ...data, activities: data.activities.map((row) => row.id === detail.id ? updated : row) }, "edit_activity"); setSubmitting(false); if (saved) setDetail(updated); }}>重新開放設定</button>}</div>
          <section className="mgmt-gantt-section">
            <div><h3>活動籌備甘特圖</h3><p className="muted">P1–P9 依活動舉辦日自動排出每週籌備內容；階段進度及日期可個別調整，不會建立額外任務。</p></div>
            <Gantt activity={detail} tasks={data.tasks} onEditPhase={canEditActivity(detail) ? (phaseId) => { setFailed(false); setEditingPhase(phaseId); } : undefined} />
          </section>
        </Dialog>
      )}
      {editing && <Dialog title={`編輯活動：${editing.name}`} close={() => !submitting && !busy && setEditing(null)} wide><form onSubmit={(event) => void submit(event, editing)}><FormStatus failed={failed} /><ActivityFields activity={editing} userName={userName} members={memberOptions} disabled={submitting || busy} canAssign={canManageAll} /><div className="mgmt-dialog-actions"><button type="button" disabled={submitting || busy} onClick={() => setEditing(null)}>取消</button><button className="primary" type="submit" disabled={submitting || busy}>儲存活動變更</button></div></form></Dialog>}
      {detail && editingPhase && <Dialog title={`編輯 ${editingPhase} 階段`} close={() => !submitting && !busy && setEditingPhase(null)}><form onSubmit={(event) => void submitPhase(event)}><FormStatus failed={failed} /><fieldset disabled={submitting || busy} className="mgmt-form-grid"><label>階段開始<input name="startDate" type="date" required defaultValue={activityPhaseSchedule(detail, editingPhase)?.startDate} /></label><label>階段結束<input name="due" type="date" required defaultValue={activityPhaseSchedule(detail, editingPhase)?.due} /></label><label>階段主責<MemberSelect name="owner" members={memberOptions} defaultValue={detail.phasePlans?.[editingPhase]?.owner} /></label><label>職務代理<MemberSelect name="proxy" members={memberOptions} defaultValue={detail.phasePlans?.[editingPhase]?.proxy} /></label><label>完成率（%）<input name="progress" type="number" min="0" max="100" step="1" required defaultValue={detail.phasePlans?.[editingPhase]?.progress ?? 0} /></label><label className="mgmt-span-2">每週工作重點<textarea name="notes" maxLength={2000} defaultValue={detail.phasePlans?.[editingPhase]?.notes} placeholder="這階段本週要完成什麼" /></label></fieldset><div className="mgmt-dialog-actions"><button type="button" disabled={submitting || busy} onClick={() => setEditingPhase(null)}>取消</button><button className="primary" type="submit" disabled={submitting || busy}>儲存階段進度</button></div></form></Dialog>}
    </>
  );
}

export function TasksPanel({ data, userId, userName, userRole, memberOptions = [], busy, onSave }: ManagementPanelProps) {
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Task | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [activityFilter, setActivityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const owners = unique(data.tasks.map((task) => task.assignee));
  const statuses = unique(data.tasks.map((task) => task.status));
  const filtered = data.tasks.filter(
    (task) =>
      (activityFilter === "all" || task.activityId === activityFilter) &&
      (statusFilter === "all" || task.status === statusFilter) &&
      (ownerFilter === "all" || task.assignee === ownerFilter),
  );
  const configurableActivities = data.activities.filter((activity) => canConfigureActivity(activity, userId, userName, userRole));

  const applyPhaseSchedule = (form: HTMLFormElement) => {
    const activityId = (form.elements.namedItem("activityId") as HTMLSelectElement | null)?.value;
    const phaseId = (form.elements.namedItem("phaseId") as HTMLSelectElement | null)?.value;
    const activity = data.activities.find((row) => row.id === activityId);
    const schedule = activityPhaseSchedule(activity, phaseId ?? "");
    if (!schedule) return;
    const startInput = form.elements.namedItem("startDate") as HTMLInputElement | null;
    const dueInput = form.elements.namedItem("due") as HTMLInputElement | null;
    if (startInput) startInput.value = schedule.startDate;
    if (dueInput) dueInput.value = schedule.due;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || busy) return;
    const form = new FormData(event.currentTarget);
    const assignee = field(form, "assignee") || userName;
    const nextOwner = field(form, "nextOwner");
    const startDate = field(form, "startDate");
    const due = field(form, "due");
    const status = field(form, "status") || "進行中";
    const schedule = activityPhaseSchedule(data.activities.find((row) => row.id === field(form, "activityId")), field(form, "phaseId"));
    if (startDate && due < startDate) {
      const input = event.currentTarget.elements.namedItem("due") as HTMLInputElement;
      input.setCustomValidity("期限不可早於開始日期");
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const item: Task = {
      id: uid(),
      name: field(form, "name"),
      activityId: field(form, "activityId"),
      assignee,
      due,
      status,
      blocker: field(form, "blocker"),
      proxy: field(form, "proxy"),
      jobRole: field(form, "jobRole"),
      nextOwner,
      startDate,
      manualStartDate: Boolean(schedule && startDate !== schedule.startDate),
      manualDue: Boolean(schedule && due !== schedule.due),
      priority: field(form, "priority") || "一般",
      flow: unique(["建立任務", assignee, nextOwner, "完成"]),
      step: 1,
      phaseId: field(form, "phaseId"),
      executionSteps: field(form, "executionSteps").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      acceptanceCriteria: field(form, "acceptanceCriteria"),
      collaborators: unique(form.getAll("collaborators").map(String).filter(Boolean)),
      effortHours: Number(field(form, "effortHours")) || undefined,
      progressPercent: status === "完成" ? 100 : Number(field(form, "progressPercent")) || 0,
      dependencies: form.getAll("dependencies").map(String).filter(Boolean),
    };
    setSubmitting(true);
    setFailed(false);
    const saved = await onSave({ ...data, tasks: [...data.tasks, item] }, "create_task");
    setSubmitting(false);
    if (saved) setCreating(false);
    else setFailed(true);
  };

  const complete = async (task: Task) => {
    if (busy || submitting || task.status === "完成") return;
    setSubmitting(true);
    setFailed(false);
    const saved = await onSave(
      {
        ...data,
        tasks: data.tasks.map((row) =>
          row.id === task.id
            ? { ...row, status: "完成", progressPercent: 100, step: row.flow ? row.flow.length - 1 : row.step }
            : row,
        ),
      },
      "complete_task",
    );
    setSubmitting(false);
    if (saved) setDetail(null);
    else setFailed(true);
  };

  const coordinatorOwnsTask = (task: Task) => canConfigureActivity(data.activities.find((activity) => activity.id === task.activityId), userId, userName, userRole);
  const canEditTask = (task: Task) => ["admin", "manager"].includes(userRole ?? "") ||
    task.assignee.trim() === userName.trim() || coordinatorOwnsTask(task);
  const canEditAllTaskFields = (task: Task) => ["admin", "manager"].includes(userRole ?? "") ||
    coordinatorOwnsTask(task);
  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || busy || submitting) return;
    const form = new FormData(event.currentTarget);
    const full = canEditAllTaskFields(editing);
    const startDate = field(form, "startDate"), due = field(form, "due");
    if (startDate && due < startDate) {
      const input = event.currentTarget.elements.namedItem("due") as HTMLInputElement;
      input.setCustomValidity("期限不可早於開始日期"); input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const status = field(form, "status") || editing.status;
    const assignee = full ? field(form, "assignee") : editing.assignee;
    const nextOwner = full ? field(form, "nextOwner") : editing.nextOwner;
    const item: Task = {
      ...editing,
      ...(full ? {
        name: field(form, "name"), activityId: field(form, "activityId"), phaseId: field(form, "phaseId"),
        assignee, proxy: field(form, "proxy"), collaborators: unique(form.getAll("collaborators").map(String).filter(Boolean)),
        jobRole: field(form, "jobRole"), nextOwner, priority: field(form, "priority"),
        effortHours: Number(field(form, "effortHours")) || undefined,
        dependencies: form.getAll("dependencies").map(String).filter(Boolean),
        executionSteps: field(form, "executionSteps").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        acceptanceCriteria: field(form, "acceptanceCriteria"),
        flow: unique(["建立任務", assignee, nextOwner || "", "完成"]),
      } : {}),
      startDate, due, status, blocker: field(form, "blocker"),
      manualStartDate: editing.manualStartDate || startDate !== editing.startDate,
      manualDue: editing.manualDue || due !== editing.due,
      progressPercent: status === "完成" ? 100 : Number(field(form, "progressPercent")) || 0,
    };
    setSubmitting(true); setFailed(false);
    const saved = await onSave({ ...data, tasks: data.tasks.map((row) => row.id === item.id ? item : row) }, "edit_task");
    setSubmitting(false);
    if (saved) { setDetail(item); setEditing(null); } else setFailed(true);
  };

  const taskSummary = (task: Task) => (
    <>
      <span className={`badge${task.status === "完成" ? " green" : ""}`}>{task.status}</span>
      <h3>{task.name}</h3>
      <p className="muted">{activityName(data, task.activityId)} · 主責 {task.assignee || "未指派"}</p>
      <p>期限 {dateLabel(task.due)} · {task.priority || "一般"}優先</p>
      <small>{phaseLabel(task.phaseId)} · 完成率 {taskProgress(task)}%</small>
      {incompleteDependencies(task, data.tasks).length > 0 && <small className="mgmt-blocker">前置阻塞：{incompleteDependencies(task, data.tasks).map((row) => row.name).join("、")}</small>}
      {task.blocker && <small className="mgmt-blocker">卡點：{task.blocker}</small>}
    </>
  );

  return (
    <>
      <div className="page-heading">
        <div><h2>任務中心</h2><p className="muted">依活動、狀態與主責篩選，清楚保留職務代理與下一手。</p></div>
        {configurableActivities.length > 0 && <button className="primary" onClick={() => { setFailed(false); setCreating(true); }}>＋ 建立任務</button>}
      </div>
      <div className="mgmt-filters" aria-label="任務篩選">
        <label>活動<select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value)}><option value="all">全部活動</option>{data.activities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
        <label>狀態<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部狀態</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
        <label>主責<select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value="all">全部主責</option>{owners.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
      </div>
      {filtered.length ? (
        <>
          <div className="mgmt-table-wrap mgmt-task-table">
            <table>
              <thead><tr><th>任務</th><th>活動／階段</th><th>狀態</th><th>主責／代理</th><th>完成率</th><th>期限</th><th><span className="mgmt-sr-only">操作</span></th></tr></thead>
              <tbody>{filtered.map((task) => { const blocked = incompleteDependencies(task, data.tasks); return <tr key={task.id}><td><b>{task.name}</b>{blocked.length > 0 && <small className="mgmt-table-blocked">前置阻塞：{blocked.map((row) => row.name).join("、")}</small>}{task.blocker && <small>卡點：{task.blocker}</small>}</td><td>{activityName(data, task.activityId)}<small>{phaseLabel(task.phaseId)}</small></td><td><span className={`badge${task.status === "完成" ? " green" : ""}`}>{task.status}</span></td><td>{task.assignee || "未指派"}<small>{task.proxy ? `代理：${task.proxy}` : "無代理"}</small></td><td>{taskProgress(task)}%</td><td>{dateLabel(task.due)}</td><td><button onClick={() => { setFailed(false); setDetail(task); }}>查看</button></td></tr>; })}</tbody>
            </table>
          </div>
          <div className="mgmt-task-cards">{filtered.map((task) => <article className="card" key={task.id}>{taskSummary(task)}<button className="mgmt-wide-button" onClick={() => { setFailed(false); setDetail(task); }}>查看任務詳情</button></article>)}</div>
        </>
      ) : <div className="empty">沒有符合目前篩選條件的任務。</div>}

      {creating && <Dialog title="建立任務" close={() => !submitting && !busy && setCreating(false)} wide><form onSubmit={submit}><FormStatus failed={failed} /><fieldset disabled={submitting || busy} className="mgmt-form-grid">
        <label className="mgmt-span-2">任務名稱<input name="name" required maxLength={200} autoFocus /></label>
        <label>所屬活動<select name="activityId" required onChange={(event) => applyPhaseSchedule(event.currentTarget.form!)}><option value="">請選擇活動</option>{configurableActivities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
        <label>階段<select name="phaseId" required onChange={(event) => applyPhaseSchedule(event.currentTarget.form!)}><option value="">請選擇階段</option>{PHASES.map((phase) => <option value={phase.id} key={phase.id}>{phase.id} {phase.name}（{phase.start}～{phase.end > 0 ? `+${phase.end}` : phase.end} 週）</option>)}</select></label>
        <label>狀態<select name="status" defaultValue="進行中"><option>待處理</option><option>進行中</option><option>等待回覆</option><option>待審核</option><option>完成</option><option>不適用</option></select></label>
        <label>主責<MemberSelect name="assignee" members={memberOptions} defaultValue={userName} required /></label>
        <label>職務代理<MemberSelect name="proxy" members={memberOptions} /></label>
        <label className="mgmt-span-2">協作人員<MemberMultiSelect name="collaborators" members={memberOptions} /><small>可按 Ctrl／⌘ 選取多位。</small></label>
        <label>任務職務<input name="jobRole" maxLength={100} placeholder="例：場務組長" /></label>
        <label>下一手<MemberSelect name="nextOwner" members={memberOptions} /></label>
        <label>開始日期<input name="startDate" type="date" /><small>依活動日與階段自動帶入，可微調。</small></label>
        <label>Deadline<input name="due" type="date" required /><small>儲存後會自動出現在行事曆。</small></label>
        <label>優先級<select name="priority" defaultValue="一般"><option>緊急</option><option>高</option><option>一般</option><option>低</option></select></label>
        <label>完成率（%）<input name="progressPercent" type="number" min="0" max="100" step="1" defaultValue="0" required /></label>
        <label>預估工時<input name="effortHours" type="number" min="0" max="10000" step="0.5" /></label>
        <label className="mgmt-span-2">前置任務<select name="dependencies" multiple size={Math.min(5, Math.max(2, data.tasks.length))}>{data.tasks.map((task) => <option value={task.id} key={task.id}>{activityName(data, task.activityId)}｜{task.name}</option>)}</select><small>可按 Ctrl／⌘ 選取多項；未完成時會顯示阻塞。</small></label>
        <label className="mgmt-span-2">執行步驟（每行一項）<textarea name="executionSteps" maxLength={5000} /></label>
        <label className="mgmt-span-2">完成標準<textarea name="acceptanceCriteria" maxLength={5000} required placeholder="清楚描述什麼結果才算完成" /></label>
        <label className="mgmt-span-2">卡點／備註<textarea name="blocker" maxLength={5000} /></label>
      </fieldset><div className="mgmt-dialog-actions"><button type="button" disabled={submitting || busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={submitting || busy} type="submit">{submitting || busy ? "儲存中…" : "建立並同步"}</button></div></form></Dialog>}

      {detail && <Dialog title={detail.name} close={() => !submitting && setDetail(null)}><FormStatus failed={failed} /><div className="mgmt-detail-grid">
        <div><small>階段</small><b>{phaseLabel(detail.phaseId)}</b></div><div><small>主責</small><b>{detail.assignee || "未指派"}</b></div><div><small>協作人員</small><b>{detail.collaborators?.join("、") || "未設定"}</b></div><div><small>職務代理</small><b>{detail.proxy || "未指派"}</b></div><div><small>完成率</small><b>{taskProgress(detail)}%</b></div><div><small>預估工時</small><b>{detail.effortHours ? `${detail.effortHours} 小時` : "未設定"}</b></div><div><small>開始</small><b>{dateLabel(detail.startDate)}</b></div><div><small>期限</small><b>{dateLabel(detail.due)}</b></div>
      </div>{incompleteDependencies(detail, data.tasks).length > 0 && <section className="mgmt-blocker-box"><small>前置任務未完成</small><p>{incompleteDependencies(detail, data.tasks).map((row) => row.name).join("、")}</p></section>}<section className="mgmt-flow-section"><h3>流轉進度</h3><ol className="mgmt-flow">{(detail.flow?.length ? detail.flow : ["建立任務", detail.assignee || "執行", "完成"]).map((step, index) => <li className={detail.status === "完成" || index <= (detail.step ?? 1) ? "active" : ""} key={`${step}-${index}`}>{step}</li>)}</ol></section>{detail.executionSteps?.length ? <section className="mgmt-task-notes"><h3>執行步驟</h3><ol>{detail.executionSteps.map((step, index) => <li key={`${step}-${index}`}>{step}</li>)}</ol></section> : null}<section className="mgmt-task-notes"><h3>完成標準</h3><p>{detail.acceptanceCriteria || "未設定完成標準。"}</p></section><section className="mgmt-blocker-box"><small>目前卡點</small><p>{detail.blocker || "目前沒有回報卡點。"}</p></section><div className="mgmt-dialog-actions">{canEditTask(detail) && <button type="button" onClick={() => { setFailed(false); setEditing(detail); }}>編輯任務</button>}{detail.status !== "完成" && detail.status !== "不適用" && canEditTask(detail) && <button className="primary" disabled={submitting || busy || incompleteDependencies(detail, data.tasks).length > 0} onClick={() => void complete(detail)}>{incompleteDependencies(detail, data.tasks).length > 0 ? "前置任務未完成" : submitting || busy ? "儲存中…" : "標記完成"}</button>}</div></Dialog>}
      {editing && <Dialog title={`編輯任務：${editing.name}`} close={() => !submitting && !busy && setEditing(null)} wide><form onSubmit={(event) => void saveEdit(event)}><FormStatus failed={failed} /><fieldset disabled={submitting || busy} className="mgmt-form-grid">
        {canEditAllTaskFields(editing) && <>
          <label className="mgmt-span-2">任務名稱<input name="name" required maxLength={200} defaultValue={editing.name} autoFocus /></label>
          <label>所屬活動<select name="activityId" defaultValue={editing.activityId} required onChange={(event) => applyPhaseSchedule(event.currentTarget.form!)}>{configurableActivities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
          <label>階段<select name="phaseId" defaultValue={editing.phaseId} onChange={(event) => applyPhaseSchedule(event.currentTarget.form!)}><option value="">未分階段</option>{PHASES.map((phase) => <option value={phase.id} key={phase.id}>{phase.id} {phase.name}</option>)}</select></label>
          <label>主責<MemberSelect name="assignee" members={memberOptions} defaultValue={editing.assignee} required /></label>
          <label>職務代理<MemberSelect name="proxy" members={memberOptions} defaultValue={editing.proxy} /></label>
          <label className="mgmt-span-2">協作人員<MemberMultiSelect name="collaborators" members={memberOptions} defaultValues={editing.collaborators} /><small>可按 Ctrl／⌘ 選取多位。</small></label>
          <label>任務職務<input name="jobRole" maxLength={100} defaultValue={editing.jobRole} /></label>
          <label>下一手<MemberSelect name="nextOwner" members={memberOptions} defaultValue={editing.nextOwner} /></label>
          <label>優先級<select name="priority" defaultValue={editing.priority || "一般"}><option>緊急</option><option>高</option><option>一般</option><option>低</option></select></label>
          <label>預估工時<input name="effortHours" type="number" min="0" max="10000" step="0.5" defaultValue={editing.effortHours} /></label>
          <label className="mgmt-span-2">前置任務<select name="dependencies" multiple size={Math.min(5, Math.max(2, data.tasks.length))} defaultValue={editing.dependencies ?? []}>{data.tasks.filter((row) => row.id !== editing.id).map((task) => <option value={task.id} key={task.id}>{activityName(data, task.activityId)}｜{task.name}</option>)}</select></label>
          <label className="mgmt-span-2">執行步驟（每行一項）<textarea name="executionSteps" maxLength={5000} defaultValue={editing.executionSteps?.join("\n")} /></label>
          <label className="mgmt-span-2">完成標準<textarea name="acceptanceCriteria" maxLength={5000} defaultValue={editing.acceptanceCriteria} /></label>
        </>}
        <label>狀態<select name="status" defaultValue={editing.status}><option>待處理</option><option>進行中</option><option>等待回覆</option><option>待審核</option><option>完成</option><option>不適用</option></select></label>
        <label>完成率（%）<input name="progressPercent" type="number" min="0" max="100" step="1" required defaultValue={taskProgress(editing)} /></label>
        <label>開始日期<input name="startDate" type="date" defaultValue={editing.startDate} /></label>
        <label>Deadline<input name="due" type="date" required defaultValue={editing.due} /></label>
        <label className="mgmt-span-2">卡點／備註<textarea name="blocker" maxLength={5000} defaultValue={editing.blocker} /></label>
      </fieldset><div className="mgmt-dialog-actions"><button type="button" onClick={() => setEditing(null)} disabled={submitting || busy}>取消</button><button className="primary" type="submit" disabled={submitting || busy}>儲存任務變更</button></div></form></Dialog>}
    </>
  );
}

function attendance(meeting: Meeting) {
  const responses = meetingResponses(meeting);
  const total = meeting.total ?? meeting.attendees?.length ?? responses.length;
  const attending = responses.length
    ? responses.filter((row) => row.response === "出席").length
    : (meeting.attending ?? 0);
  const pending = responses.length
    ? responses.filter((row) => row.response === "待回覆").length
    : Math.max(0, total - attending);
  return { total, attending, pending };
}

function meetingResponses(meeting: Meeting): MeetingAttendee[] {
  return unique([...(meeting.attendees ?? []), ...(meeting.attendeeResponses ?? []).map((person) => person.name)])
    .map((name) => meeting.attendeeResponses?.find((person) => person.name === name) ?? { name, response: "待回覆" });
}

export function MeetingsPanel({ data, userId, userName, userRole, memberOptions = [], busy, onSave }: ManagementPanelProps) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Meeting | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const configurableActivities = data.activities.filter((activity) => canConfigureActivity(activity, userId, userName, userRole));
  const canEditMeeting = (meeting: Meeting) => canConfigureActivity(data.activities.find((activity) => activity.id === meeting.activityId), userId, userName, userRole);
  const canManageAttendance = ["admin", "manager"].includes(userRole ?? "");
  const uniqueSelfName = memberOptions.filter((person) => person.name.trim() === userName.trim()).length === 1;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || busy) return;
    const form = new FormData(event.currentTarget);
    const attendees = unique(form.getAll("attendees").map(String).filter(Boolean));
    const start = field(form, "time");
    const end = field(form, "endTime");
    if (start && end && end <= start) {
      const input = event.currentTarget.elements.namedItem("endTime") as HTMLInputElement;
      input.setCustomValidity("結束時間必須晚於開始時間");
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const item: Meeting = {
      id: uid(),
      title: field(form, "title"),
      activityId: field(form, "activityId"),
      time: start ? `${start}:00+08:00` : "",
      status: "待確認",
      type: field(form, "type"),
      organizer: field(form, "organizer") || userName,
      recorder: field(form, "recorder"),
      endTime: end ? `${end}:00+08:00` : "",
      location: field(form, "location"),
      meetingLink: field(form, "meetingLink"),
      attendees,
      attendeeResponses: attendees.map((name) => ({ name, response: "待回覆" })),
      agenda: field(form, "agenda"),
      attending: 0,
      total: attendees.length,
    };
    setSubmitting(true);
    setFailed(false);
    const saved = await onSave({ ...data, meetings: [...data.meetings, item] }, "create_meeting");
    setSubmitting(false);
    if (saved) setCreating(false);
    else setFailed(true);
  };

  const confirm = async (meeting: Meeting) => {
    if (busy || submitting || !canEditMeeting(meeting)) return;
    setSubmitting(true);
    const saved = await onSave({
      ...data,
      meetings: data.meetings.map((row) => row.id === meeting.id ? {
        ...row,
        status: "已確認",
      } : row),
    }, "confirm_meeting");
    setSubmitting(false);
    if (!saved) setFailed(true);
  };

  const updateResponse = async (meeting: Meeting, attendeeName: string, response: MeetingAttendee["response"]) => {
    if (busy || submitting || (!canManageAttendance && (!uniqueSelfName || attendeeName.trim() !== userName.trim()))) return;
    setSubmitting(true);
    setFailed(false);
    const attendeeResponses = meetingResponses(meeting).map((person) =>
      person.name === attendeeName ? { ...person, response } : person,
    );
    const attending = attendeeResponses.filter((person) => person.response === "出席").length;
    const saved = await onSave({
      ...data,
      meetings: data.meetings.map((row) => row.id === meeting.id
        ? { ...row, attendeeResponses, attending }
        : row),
    }, "update_meeting_attendance");
    setSubmitting(false);
    if (!saved) setFailed(true);
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !canEditMeeting(editing) || submitting || busy) return;
    const form = new FormData(event.currentTarget);
    const start = field(form, "time"), end = field(form, "endTime");
    if (end <= start) {
      const input = event.currentTarget.elements.namedItem("endTime") as HTMLInputElement;
      input.setCustomValidity("結束時間必須晚於開始時間"); input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    const attendees = unique(form.getAll("attendees").map(String).filter(Boolean));
    const attendeeResponses = attendees.map((name) => editing.attendeeResponses?.find((person) => person.name === name) ?? { name, response: "待回覆" as const });
    const item: Meeting = {
      ...editing, title: field(form, "title"), activityId: field(form, "activityId"),
      time: `${start}:00+08:00`, endTime: `${end}:00+08:00`, status: field(form, "status"),
      type: field(form, "type"), organizer: field(form, "organizer"), recorder: field(form, "recorder"),
      location: field(form, "location"), meetingLink: field(form, "meetingLink"), agenda: field(form, "agenda"),
      attendees, attendeeResponses, total: attendees.length, attending: attendeeResponses.filter((person) => person.response === "出席").length,
    };
    setSubmitting(true); setFailed(false);
    const saved = await onSave({ ...data, meetings: data.meetings.map((row) => row.id === item.id ? item : row) }, "edit_meeting");
    setSubmitting(false);
    if (saved) setEditing(null); else setFailed(true);
  };

  return <>
    <div className="page-heading"><div><h2>會議協調</h2><p className="muted">主持、記錄、議程、地點與出席回覆放在同一張會議卡。</p></div>{configurableActivities.length > 0 && <button className="primary" onClick={() => { setFailed(false); setCreating(true); }}>＋ 安排會議</button>}</div>
    {failed && !creating && <FormStatus failed />}
    {data.meetings.length ? <div className="mgmt-meeting-grid">{data.meetings.map((meeting) => { const stats = attendance(meeting); const responseRows = meetingResponses(meeting); const link = safeMeetingUrl(meeting.meetingLink); return <article className="mgmt-meeting-card" key={meeting.id}><div className="mgmt-card-head"><span className={`badge${meeting.status === "已確認" ? " green" : ""}`}>{meeting.status}</span><span>{meeting.type || "工作會議"}</span></div><h3>{meeting.title}</h3><p className="muted">{activityName(data, meeting.activityId)}</p><dl className="mgmt-compact-list"><div><dt>開始</dt><dd>{dateLabel(meeting.time)}</dd></div><div><dt>結束</dt><dd>{dateLabel(meeting.endTime)}</dd></div><div><dt>主持</dt><dd>{meeting.organizer || "未指派"}</dd></div><div><dt>記錄</dt><dd>{meeting.recorder || "未指派"}</dd></div><div><dt>地點</dt><dd>{meeting.location || "未設定"}</dd></div><div><dt>線上連結</dt><dd>{link ? <a href={link} target="_blank" rel="noreferrer">開啟會議連結</a> : "未設定"}</dd></div><div><dt>出席回覆</dt><dd>{stats.attending} 出席／{stats.pending} 待回覆／共 {stats.total}</dd></div></dl>{responseRows.length ? <section className="mgmt-attendance"><small>逐人回覆</small>{responseRows.map((person) => <label key={person.name}><span>{person.name}</span><select aria-label={`${person.name}的出席回覆`} value={person.response} disabled={submitting || busy || (!canManageAttendance && (!uniqueSelfName || person.name.trim() !== userName.trim()))} onChange={(event) => void updateResponse(meeting, person.name, event.target.value as MeetingAttendee["response"])}><option>待回覆</option><option>出席</option><option>可能出席</option><option>不出席</option></select></label>)}</section> : null}<section className="mgmt-agenda"><small>議程</small><p>{meeting.agenda || "尚未加入議程。"}</p></section>{meeting.status !== "已確認" && canEditMeeting(meeting) && <button className="mgmt-wide-button" disabled={submitting || busy} onClick={() => void confirm(meeting)}>{submitting || busy ? "儲存中…" : "確認會議（保留回覆）"}</button>}{canEditMeeting(meeting) && <button className="mgmt-wide-button" onClick={() => { setFailed(false); setEditing(meeting); }}>編輯會議</button>}</article>; })}</div> : <div className="empty">還沒有會議。需要同步決策時再安排即可。</div>}
    {creating && <Dialog title="安排會議" close={() => !submitting && !busy && setCreating(false)} wide><form onSubmit={submit}><FormStatus failed={failed} /><fieldset disabled={submitting || busy} className="mgmt-form-grid">
      <label className="mgmt-span-2">會議名稱<input name="title" required maxLength={200} autoFocus /></label>
      <label>所屬活動<select name="activityId" required><option value="">請選擇活動</option>{configurableActivities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
      <label>會議類型<select name="type" defaultValue="工作會議"><option>工作會議</option><option>決策會議</option><option>檢討會議</option><option>說明會</option><option>其他</option></select></label>
      <label>主持人<MemberSelect name="organizer" members={memberOptions} defaultValue={userName} required /></label>
      <label>記錄人<MemberSelect name="recorder" members={memberOptions} required /></label>
      <label>開始時間<input name="time" type="datetime-local" required /></label>
      <label>結束時間<input name="endTime" type="datetime-local" required /></label>
      <label>地點<input name="location" maxLength={200} /></label>
      <label>線上會議連結<input name="meetingLink" type="url" maxLength={1000} placeholder="https://" /></label>
      <label className="mgmt-span-2">出席者<MemberMultiSelect name="attendees" members={memberOptions} /><small>可按 Ctrl／⌘ 選取多位；成員登入後可回覆自己的出席狀態。</small></label>
      <label className="mgmt-span-2">議程<textarea name="agenda" required maxLength={5000} /></label>
    </fieldset><div className="mgmt-dialog-actions"><button type="button" disabled={submitting || busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={submitting || busy} type="submit">{submitting || busy ? "儲存中…" : "建立並同步"}</button></div></form></Dialog>}
    {editing && <Dialog title={`編輯會議：${editing.title}`} close={() => !submitting && !busy && setEditing(null)} wide><form onSubmit={(event) => void saveEdit(event)}><FormStatus failed={failed} /><fieldset disabled={submitting || busy} className="mgmt-form-grid">
      <label className="mgmt-span-2">會議名稱<input name="title" required maxLength={200} defaultValue={editing.title} autoFocus /></label>
      <label>所屬活動<select name="activityId" required defaultValue={editing.activityId}>{configurableActivities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
      <label>會議類型<select name="type" defaultValue={editing.type || "工作會議"}><option>工作會議</option><option>決策會議</option><option>檢討會議</option><option>說明會</option><option>其他</option></select></label>
      <label>狀態<select name="status" defaultValue={editing.status}><option>待確認</option><option>已確認</option><option>已完成</option><option>已取消</option></select></label>
      <label>主持人<MemberSelect name="organizer" members={memberOptions} defaultValue={editing.organizer} required /></label>
      <label>記錄人<MemberSelect name="recorder" members={memberOptions} defaultValue={editing.recorder} required /></label>
      <label>開始時間<input name="time" type="datetime-local" required defaultValue={editing.time.slice(0, 16)} /></label>
      <label>結束時間<input name="endTime" type="datetime-local" required defaultValue={editing.endTime?.slice(0, 16)} /></label>
      <label>地點<input name="location" maxLength={200} defaultValue={editing.location} /></label>
      <label>線上會議連結<input name="meetingLink" type="url" maxLength={1000} defaultValue={editing.meetingLink} /></label>
      <label className="mgmt-span-2">出席者<MemberMultiSelect name="attendees" members={memberOptions} defaultValues={editing.attendees} /><small>可按 Ctrl／⌘ 選取多位。</small></label>
      <label className="mgmt-span-2">議程<textarea name="agenda" maxLength={5000} defaultValue={editing.agenda} /></label>
    </fieldset><div className="mgmt-dialog-actions"><button type="button" disabled={submitting || busy} onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={submitting || busy} type="submit">儲存會議變更</button></div></form></Dialog>}
  </>;
}

const orgRoles = [
  ["系統管理員", "維護全工作空間、資料、帳號核可、權限與同步。"],
  ["一般管理員", "協助管理成員與活動，可核可總召以下職務。"],
  ["總召", "由管理員授權多場活動；各場提交設定後，後續修改由管理員處理。"],
  ["見習總召", "由管理員授權一場活動；可完成該場設定並提交。"],
  ["幹部／一般成員", "依被核可的帳號登入，查看工作並依角色範圍協作。"],
];
const activityRoles = [
  ["活動總召", "對單一活動的成果、日期、預算與跨組協調負責。"],
  ["職務代理", "總召或主責無法處理時接手，避免責任中斷；不自動取得系統管理權。"],
  ["任務主責", "對指定任務的進度、期限與卡點回報負責；責任限於該任務。"],
];

export function RolesPanel({ data, userName }: ManagementPanelProps) {
  const assignmentRows = useMemo(() => {
    const activityRows = data.activities.map((activity) => ({
      id: `activity-${activity.id}`,
      scope: activity.name,
      role: "活動總召／代理",
      people: `${activity.owner || "未指派"}／${activity.proxy || "未指派"}`,
    }));
    const taskRows = data.tasks.map((task) => ({
      id: `task-${task.id}`,
      scope: task.name,
      role: task.jobRole || "任務主責",
      people: `${task.assignee || "未指派"}${task.proxy ? `（代理 ${task.proxy}）` : ""}`,
    }));
    return [...activityRows, ...taskRows];
  }, [data.activities, data.tasks]);

  return <>
    <div className="page-heading"><div><h2>組織與角色</h2><p className="muted">角色的目的，是讓決策、代理與執行責任在交接時仍然清楚。</p></div></div>
    <section className="mgmt-admin-callout" aria-label="目前登入權限"><div className="role-icon">♙</div><div><p className="eyebrow">目前登入身分</p><h3>{userName}</h3><p>系統帳號角色決定可使用的功能；活動上的總召、代理與主責則描述實際工作責任。</p></div></section>
    <div className="mgmt-role-columns"><section className="panel"><h3>組織角色</h3><p className="muted">決定跨活動治理與系統使用範圍。</p><div className="mgmt-role-list">{orgRoles.map(([name, description]) => <article key={name}><b>{name}</b><p>{description}</p></article>)}</div></section><section className="panel"><h3>活動角色</h3><p className="muted">只界定特定活動或任務的實際責任邊界。</p><div className="mgmt-role-list">{activityRoles.map(([name, description]) => <article key={name}><b>{name}</b><p>{description}</p></article>)}</div></section></div>
    <section className="panel mgmt-assignment-panel"><div className="mgmt-card-head"><div><h3>目前指派概況</h3><p className="muted">直接取自活動與任務資料，不另外建立權限。</p></div><span className="badge">{assignmentRows.length} 筆</span></div>{assignmentRows.length ? <div className="mgmt-table-wrap"><table><thead><tr><th>活動／任務</th><th>責任</th><th>人員</th></tr></thead><tbody>{assignmentRows.map((row) => <tr key={row.id}><td><b>{row.scope}</b></td><td>{row.role}</td><td>{row.people}</td></tr>)}</tbody></table></div> : <p className="mgmt-empty-inline">尚未建立活動或任務指派。</p>}</section>
  </>;
}

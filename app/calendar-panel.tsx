"use client";

import { useMemo, useRef, useState } from "react";
import { activityPhaseSchedule, canConfigureActivity, phaseSchedule, type
  Activity,
  ManagementPanelProps,
  Meeting,
  State,
  Task,
} from "./management-panels";
import "./calendar-panel.css";
import { activityEnded, meetingEnded, taskEnded } from "./record-visibility";
import { taskDeadlineLimit, taskDeadlineError } from "./task-deadlines";
import MemberSelect, { MemberMultiSelect, type MemberOption } from "./member-select";

type EntryKind = "activity" | "task" | "meeting";
type Composer = EntryKind | null;
export type CalendarEntry = { id: string; kind: EntryKind; title: string; date: string; time?: string };
type CalendarPanelProps = ManagementPanelProps & {
  userRole?: string;
  onReschedule?: (entry: CalendarEntry, date: string, time?: string) => Promise<boolean>;
};

const phaseChoices = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];

const kindLabels: Record<EntryKind, string> = {
  activity: "活動",
  task: "任務",
  meeting: "會議",
};

const pad = (value: number) => String(value).padStart(2, "0");
const keyOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const datePart = (value?: string) => value?.slice(0, 10) ?? "";
const field = (form: FormData, name: string) =>
  String(form.get(name) ?? "").trim();
function activityName(data: State, id: string) {
  return data.activities.find((activity) => activity.id === id)?.name || "未分類";
}

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function timeLabel(value?: string) {
  if (!value) return "時間未設定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Taipei",
  }).format(date);
}

function activityOccursOn(activity: Activity, date: string) {
  return datePart(activity.date || activity.startDate) === date;
}

function validateOrder(
  form: HTMLFormElement,
  startName: string,
  endName: string,
  message: string,
  strict = false,
) {
  const values = new FormData(form);
  const start = field(values, startName);
  const end = field(values, endName);
  if (!start || !end || (strict ? end > start : end >= start)) return true;
  const input = form.elements.namedItem(endName) as HTMLInputElement | null;
  input?.setCustomValidity(message);
  input?.reportValidity();
  input?.addEventListener("input", () => input.setCustomValidity(""), { once: true });
  return false;
}

function ActivityForm({
  date,
  userName,
  members,
  disabled,
  onSubmit,
}: {
  date: string;
  userName: string;
  members: MemberOption[];
  disabled: boolean;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <form className="calendar-quick-form" onSubmit={(event) => {
      event.preventDefault();
      if (validateOrder(event.currentTarget, "startDate", "endDate", "籌備結束不能早於開始")) {
        onSubmit(event.currentTarget);
      }
    }}>
      <fieldset disabled={disabled}>
        <label className="calendar-field-wide">活動名稱<input name="name" required maxLength={200} autoFocus /></label>
        <label className="calendar-field-wide">活動舉辦日<input name="eventDate" type="date" required defaultValue={date} onChange={(event) => { const form = event.currentTarget.form!; const start = form.elements.namedItem("startDate") as HTMLInputElement; const end = form.elements.namedItem("endDate") as HTMLInputElement; const previous = event.currentTarget.dataset.previousDate || date; const priorStart = phaseSchedule(previous, "P1")?.startDate; const priorEnd = phaseSchedule(previous, "P9")?.due; if (!start.value || start.value === priorStart) start.value = phaseSchedule(event.currentTarget.value, "P1")?.startDate || ""; if (!end.value || end.value === priorEnd) end.value = phaseSchedule(event.currentTarget.value, "P9")?.due || ""; event.currentTarget.dataset.previousDate = event.currentTarget.value; }} /></label>
        <label>籌備開始<input name="startDate" type="date" required defaultValue={phaseSchedule(date, "P1")?.startDate} /></label>
        <label>籌備結束<input name="endDate" type="date" required defaultValue={phaseSchedule(date, "P9")?.due} /></label>
        <label>活動總召<MemberSelect name="owner" members={members} defaultValue={userName} required /></label>
        <label>狀態<select name="status" defaultValue="規劃中"><option>規劃中</option><option>籌備中</option><option>進行中</option><option>已完成</option></select></label>
        <label className="calendar-field-wide">地點<input name="location" maxLength={200} /></label>
      </fieldset>
      <button className="primary calendar-save" type="submit" disabled={disabled}>{disabled ? "儲存中…" : "建立活動"}</button>
    </form>
  );
}

function TaskForm({
  data,
  date,
  userName,
  members,
  disabled,
  onSubmit,
}: {
  data: State;
  date: string;
  userName: string;
  members: MemberOption[];
  disabled: boolean;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  const applyActivitySchedule = (form: HTMLFormElement) => {
    const values = new FormData(form);
    const activity = data.activities.find((row) => row.id === field(values, "activityId"));
    const schedule = activityPhaseSchedule(activity, field(values, "phaseId"));
    const dueInput = form.elements.namedItem("due") as HTMLInputElement;
    dueInput.max = taskDeadlineLimit(activity, field(values, "phaseId")); dueInput.setCustomValidity("");
    if (!schedule) return;
    (form.elements.namedItem("startDate") as HTMLInputElement).value = schedule.startDate;
    dueInput.value = taskDeadlineLimit(activity, field(values, "phaseId")) || schedule.due;
  };
  return (
    <form className="calendar-quick-form" onSubmit={(event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const phaseInput = event.currentTarget.elements.namedItem("phaseId") as unknown as HTMLSelectElement;
      if (field(values, "activityId") && !field(values, "phaseId")) {
        phaseInput.setCustomValidity("請先選擇活動籌備階段");
        phaseInput.reportValidity();
        return;
      }
      if (validateOrder(event.currentTarget, "startDate", "due", "期限不能早於開始日期")) {
        onSubmit(event.currentTarget);
      }
    }}>
      <fieldset disabled={disabled}>
        <label className="calendar-field-wide">任務名稱<input name="name" required maxLength={200} autoFocus /></label>
        <label>開始日期<input name="startDate" type="date" required defaultValue={date} /></label>
        <label>期限<input name="due" type="date" required defaultValue={date} /></label>
        <label>任務主責<MemberSelect name="assignee" members={members} defaultValue={userName} required /></label>
        <label>優先級<select name="priority" defaultValue="一般"><option>緊急</option><option>高</option><option>一般</option><option>低</option></select></label>
        <label className="calendar-field-wide">所屬活動<select name="activityId" defaultValue="" onChange={(event) => applyActivitySchedule(event.currentTarget.form!)}><option value="">未分類</option>{data.activities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
        <label className="calendar-field-wide">籌備階段<select name="phaseId" defaultValue="" onChange={(event) => { event.currentTarget.setCustomValidity(""); applyActivitySchedule(event.currentTarget.form!); }}><option value="">請選擇階段</option>{phaseChoices.map((phase) => <option key={phase} value={phase}>{phase}</option>)}</select><small>選擇活動與階段後，依活動日倒推日期；可提前調整，不可晚於階段週期限。</small></label>
      </fieldset>
      <button className="primary calendar-save" type="submit" disabled={disabled}>{disabled ? "儲存中…" : "建立任務"}</button>
    </form>
  );
}

function MeetingForm({
  data,
  date,
  userName,
  members,
  disabled,
  onSubmit,
}: {
  data: State;
  date: string;
  userName: string;
  members: MemberOption[];
  disabled: boolean;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <form className="calendar-quick-form" onSubmit={(event) => {
      event.preventDefault();
      if (validateOrder(event.currentTarget, "time", "endTime", "結束時間必須晚於開始時間", true)) {
        onSubmit(event.currentTarget);
      }
    }}>
      <fieldset disabled={disabled}>
        <label className="calendar-field-wide">會議名稱<input name="title" required maxLength={200} autoFocus /></label>
        <label>開始時間<input name="time" type="datetime-local" required defaultValue={`${date}T09:00`} /></label>
        <label>結束時間<input name="endTime" type="datetime-local" required defaultValue={`${date}T10:00`} /></label>
        <label>主持人<MemberSelect name="organizer" members={members} defaultValue={userName} required /></label>
        <label>記錄人<MemberSelect name="recorder" members={members} required /></label>
        <label className="calendar-field-wide">所屬活動<select name="activityId" defaultValue={data.activities[0]?.id ?? ""}><option value="">未分類</option>{data.activities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
        <label className="calendar-field-wide">出席者<MemberMultiSelect name="attendees" members={members} /><small>選擇後，各人可自行回覆出席。</small></label>
      </fieldset>
      <button className="primary calendar-save" type="submit" disabled={disabled}>{disabled ? "儲存中…" : "建立會議"}</button>
    </form>
  );
}

export function CalendarPanel({ data, userId, userName, userRole, memberOptions = [], busy, onSave, onReschedule }: CalendarPanelProps) {
  const now = new Date();
  const today = keyOf(now);
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(today);
  const [composer, setComposer] = useState<Composer>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  const [moving, setMoving] = useState<CalendarEntry | null>(null);
  const [dragging, setDragging] = useState<CalendarEntry | null>(null);
  const [dragOverDate, setDragOverDate] = useState("");
  const [taskView, setTaskView] = useState("self");
  const draggedEntry = useRef<CalendarEntry | null>(null);
  const canSeeAllTasks = ["admin", "manager", "coordinator", "trainee_coordinator"].includes(userRole ?? "");
  const [showHistory, setShowHistory] = useState(false);
  const canManageAll = ["admin", "manager"].includes(userRole ?? "");
  const authorizedActivityIds = new Set(data.activities.filter((activity) =>
    canManageAll || (userRole === "coordinator" && (
      activity.coordinatorIds?.includes(userId ?? "") ||
      (activity.coordinatorIds === undefined && !activity.traineeCoordinatorId && [activity.owner, activity.proxy].some((name) => name?.trim() === userName.trim()))
    )) || (userRole === "trainee_coordinator" && activity.traineeCoordinatorId === userId),
  ).map((activity) => activity.id));
  const scopedActivities = data.activities.filter((activity) => authorizedActivityIds.has(activity.id));
  const scopedTasks = data.tasks.filter((task) => authorizedActivityIds.has(task.activityId));
  const scopedMeetings = data.meetings.filter((meeting) => authorizedActivityIds.has(meeting.activityId));
  const configurableActivities = data.activities.filter((activity) => canConfigureActivity(activity, userId, userName, userRole));
  const configurableData = { ...data, activities: configurableActivities };
  const calendarPeople = useMemo(() => Array.from(new Set([
    ...scopedActivities.flatMap((row) => [row.owner, row.proxy]),
    ...scopedTasks.flatMap((row) => [row.assignee, row.proxy, ...(row.collaborators ?? [])]),
    ...scopedMeetings.flatMap((row) => [row.organizer, row.recorder, ...(row.attendees ?? []), ...(row.attendeeResponses ?? []).map((person) => person.name)]),
  ].map((person) => person?.trim() ?? "").filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-TW")), [scopedActivities, scopedTasks, scopedMeetings]);
  const selectedPerson = canSeeAllTasks && taskView !== "self" && taskView !== "all" ? taskView : userName.trim();
  const showAll = canSeeAllTasks && taskView === "all";
  const visibleActivities = data.activities.filter((activity) => ((canManageAll && showHistory) || !activityEnded(activity)) && (taskView === "self" || canManageAll || authorizedActivityIds.has(activity.id)) && (showAll || [activity.owner, activity.proxy].some((name) => name?.trim() === selectedPerson)));
  const visibleTasks = data.tasks.filter((task) => ((canManageAll && showHistory) || !taskEnded(task, data.activities)) && (taskView === "self" || canManageAll || authorizedActivityIds.has(task.activityId)) && (showAll || [task.assignee, task.proxy, ...(task.collaborators ?? [])].some((name) => name?.trim() === selectedPerson)));
  const visibleMeetings = data.meetings.filter((meeting) => ((canManageAll && showHistory) || !meetingEnded(meeting)) && (taskView === "self" || canManageAll || authorizedActivityIds.has(meeting.activityId)) && (showAll || [meeting.organizer, meeting.recorder, ...(meeting.attendees ?? []), ...(meeting.attendeeResponses ?? []).map((person) => person.name)].some((name) => name?.trim() === selectedPerson)));
  const canMoveEntry = (entry: CalendarEntry) => {
    if (!onReschedule) return false;
    if (canManageAll) return true;
    if (entry.kind === "activity") {
      const activity = data.activities.find((row) => row.id === entry.id);
      return canConfigureActivity(activity, userId, userName, userRole);
    }
    if (entry.kind === "task") {
      const task = data.tasks.find((row) => row.id === entry.id);
      return Boolean(task && canConfigureActivity(data.activities.find((activity) => activity.id === task.activityId), userId, userName, userRole));
    }
    const meeting = data.meetings.find((row) => row.id === entry.id);
    return Boolean(meeting && canConfigureActivity(data.activities.find((activity) => activity.id === meeting.activityId), userId, userName, userRole));
  };

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const visibleCount = mondayOffset + new Date(year, month + 1, 0).getDate() > 35 ? 42 : 35;
    return Array.from({ length: visibleCount }, (_, index) => {
      const date = new Date(year, month, index - mondayOffset + 1, 12);
      return { date: keyOf(date), day: date.getDate(), inMonth: date.getMonth() === month };
    });
  }, [cursor]);

  const entriesFor = (date: string) => ({
    activities: visibleActivities.filter((activity) => activityOccursOn(activity, date)),
    tasks: visibleTasks.filter((task) => datePart(task.due || task.startDate) === date),
    meetings: visibleMeetings.filter((meeting) => datePart(meeting.time) === date),
  });
  const selected = entriesFor(selectedDate);
  const saving = busy || submitting;
  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const chooseDate = (date: string) => {
    setSelectedDate(date);
    setComposer(null);
    setFeedback("");
    setFailed(false);
    setMoving(null);
    const chosen = new Date(`${date}T12:00:00`);
    if (chosen.getFullYear() !== year || chosen.getMonth() !== month) {
      setCursor(new Date(chosen.getFullYear(), chosen.getMonth(), 1));
    }
  };

  const save = async (kind: EntryKind, formElement: HTMLFormElement) => {
    if (saving) return;
    const form = new FormData(formElement);
    let next: State;
    let action: "create_activity" | "create_task" | "create_meeting";
    if (kind === "activity") {
      const startDate = field(form, "startDate");
      const endDate = field(form, "endDate");
      const item: Activity = {
        id: crypto.randomUUID(),
        name: field(form, "name"),
        date: field(form, "eventDate"),
        owner: field(form, "owner") || userName,
        status: field(form, "status") || "規劃中",
        description: "",
        startDate,
        endDate,
        location: field(form, "location"),
      };
      next = { ...data, activities: [...data.activities, item] };
      action = "create_activity";
    } else if (kind === "task") {
      const assignee = field(form, "assignee") || userName;
      const activity = data.activities.find((row) => row.id === field(form, "activityId"));
      const schedule = activityPhaseSchedule(activity, field(form, "phaseId"));
      const item: Task = {
        id: crypto.randomUUID(),
        name: field(form, "name"),
        activityId: field(form, "activityId"),
        assignee,
        due: field(form, "due"),
        status: "待處理",
        blocker: "",
        startDate: field(form, "startDate"),
        manualStartDate: Boolean(schedule && field(form, "startDate") !== schedule.startDate),
        manualDue: Boolean(schedule && field(form, "due") !== schedule.due),
        priority: field(form, "priority") || "一般",
        phaseId: field(form, "phaseId") || undefined,
        flow: ["建立任務", assignee, "完成"],
        step: 1,
      };
      const deadlineError = taskDeadlineError(item, activity);
      if (deadlineError) { setFailed(true); setFeedback(deadlineError); return; }
      next = { ...data, tasks: [...data.tasks, item] };
      action = "create_task";
    } else {
      const start = field(form, "time");
      const end = field(form, "endTime");
      const item: Meeting = {
        id: crypto.randomUUID(),
        title: field(form, "title"),
        activityId: field(form, "activityId"),
        time: `${start}:00+08:00`,
        endTime: `${end}:00+08:00`,
        status: "待確認",
        type: "工作會議",
        organizer: field(form, "organizer") || userName,
        recorder: field(form, "recorder"),
        attendees: form.getAll("attendees").map(String).filter(Boolean),
        attendeeResponses: form.getAll("attendees").map(String).filter(Boolean).map((name) => ({ name, response: "待回覆" as const })),
        agenda: "",
        attending: 0,
        total: form.getAll("attendees").length,
      };
      next = { ...data, meetings: [...data.meetings, item] };
      action = "create_meeting";
    }
    if (!window.confirm(`確認建立${kindLabels[kind]}「${kind === "meeting" ? field(form, "title") : field(form, "name")}」？`)) return;
    setSubmitting(true);
    setFailed(false);
    setFeedback("");
    try {
      const saved = await onSave(next, action);
      if (saved) {
        setComposer(null);
        setFeedback(`${kindLabels[kind]}已建立在 ${selectedDate}`);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const reschedule = async (entry: CalendarEntry, target: string, time?: string) => {
    if (!onReschedule || !canMoveEntry(entry) || saving || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return;
    if (target === entry.date && (!time || time === entry.time)) return;
    if (entry.kind === "task") {
      const task = data.tasks.find((row) => row.id === entry.id);
      if (task) { const deadlineError = taskDeadlineError({ ...task, startDate: undefined, due: target }, data.activities.find((activity) => activity.id === task.activityId)); if (deadlineError) { setFailed(true); setFeedback(deadlineError); return; } }
    }
    if (!window.confirm(`確認將${kindLabels[entry.kind]}「${entry.title}」從 ${entry.date} 改到 ${target}${time ? ` ${time}` : ""}？${entry.kind === "activity" ? " 符合原自動排程的關聯任務將跟著調整；手動修改過的日期會保留。" : ""}`)) {
      setDragging(null);
      setDragOverDate("");
      draggedEntry.current = null;
      return;
    }
    setSubmitting(true);
    setFailed(false);
    setFeedback("");
    try {
      const saved = await onReschedule(entry, target, time);
      if (saved) {
        const targetDate = new Date(`${target}T12:00:00`);
        setSelectedDate(target);
        setCursor(new Date(targetDate.getFullYear(), targetDate.getMonth(), 1));
        setFeedback(`「${entry.title}」已移到 ${target}`);
        setComposer(null);
        setMoving(null);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
      setDragging(null);
      setDragOverDate("");
      draggedEntry.current = null;
    }
  };

  const move = async (formElement: HTMLFormElement) => {
    if (!moving) return;
    const form = new FormData(formElement);
    const target = field(form, "moveDate");
    const time = moving.kind === "meeting" ? field(form, "moveTime") : undefined;
    await reschedule(moving, target, time);
  };

  return (
    <section className="calendar-panel" aria-labelledby="calendar-panel-title">
      <div className="page-heading calendar-page-heading">
        <div>
          <h2 id="calendar-panel-title">行事曆</h2>
          <p className="muted">點選日期即可查看當日內容，並直接建立活動、任務或會議。</p>
        </div>
        {canManageAll && <button className="primary" type="button" onClick={() => { chooseDate(today); setComposer("activity"); }}>＋ 今天新增</button>}
      </div>
      {canManageAll && <label className="mgmt-history-toggle"><input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} />顯示已結束／完成項目</label>}
      {canSeeAllTasks && <label className="calendar-task-view">行事曆視角 <select value={taskView} onChange={(event) => setTaskView(event.target.value)}><option value="self">我的行程</option><option value="all">全局行程</option>{calendarPeople.filter((person) => person !== userName.trim()).map((person) => <option value={person} key={person}>{person}的行程</option>)}</select></label>}

      <div className="calendar-layout">
        <section className="calendar-month-card" aria-label={`${year} 年 ${month + 1} 月`}>
          <div className="calendar-toolbar">
            <button type="button" aria-label="上一個月" onClick={() => setCursor(new Date(year, month - 1, 1))}>←</button>
            <div><strong>{year} 年 {month + 1} 月</strong><small>選一天下一步</small></div>
            <div className="calendar-toolbar-actions">
              <button type="button" onClick={() => { setCursor(new Date(now.getFullYear(), now.getMonth(), 1)); chooseDate(today); }}>今天</button>
              <button type="button" aria-label="下一個月" onClick={() => setCursor(new Date(year, month + 1, 1))}>→</button>
            </div>
          </div>
          <p className="calendar-drag-help">桌機可拖曳項目到新日期；手機可點項目或右欄「改期」調整。</p>
          <p className="calendar-scroll-hint">點選日期，在下方查看完整行程。</p>
          <div className="calendar-grid-scroll" tabIndex={0}>
            <div className="calendar-grid">
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => <div className="calendar-weekday" key={day}>週{day}</div>)}
              {cells.map((cell) => {
                const entries = entriesFor(cell.date);
                const total = entries.activities.length + entries.tasks.length + entries.meetings.length;
                const calendarEntries: CalendarEntry[] = [
                  ...entries.activities.map((activity) => ({ id: activity.id, kind: "activity" as const, title: activity.name, date: datePart(activity.date || activity.startDate) })),
                  ...entries.tasks.map((task) => ({ id: task.id, kind: "task" as const, title: task.name, date: datePart(task.due || task.startDate) })),
                  ...entries.meetings.map((meeting) => ({ id: meeting.id, kind: "meeting" as const, title: meeting.title, date: datePart(meeting.time), time: meeting.time.slice(11, 16) })),
                ];
                const visibleEntries = calendarEntries.slice(0, 3);
                return (
                  <div
                    className={`calendar-day${cell.inMonth ? "" : " is-outside"}${cell.date === today ? " is-today" : ""}${cell.date === selectedDate ? " is-selected" : ""}${dragOverDate === cell.date ? " is-drag-over" : ""}`}
                    key={cell.date}
                    aria-label={`${cell.date}${total ? `，${total} 個項目` : "，沒有項目"}`}
                    onDragOver={(event) => {
                      if (!onReschedule || saving || !draggedEntry.current) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragOverDate(cell.date);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOverDate("");
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const entry = draggedEntry.current;
                      setDragOverDate("");
                      if (entry) void reschedule(entry, cell.date, entry.kind === "meeting" ? entry.time : undefined);
                    }}
                  >
                    <button type="button" className="calendar-day-select" aria-pressed={cell.date === selectedDate} onClick={() => chooseDate(cell.date)}>
                      <span className="calendar-day-number">{cell.day}</span>
                      <span className="calendar-counts" aria-hidden="true">
                        {entries.activities.length > 0 && <span className="is-activity">活 {entries.activities.length}</span>}
                        {entries.tasks.length > 0 && <span className="is-task">任 {entries.tasks.length}</span>}
                        {entries.meetings.length > 0 && <span className="is-meeting">會 {entries.meetings.length}</span>}
                        {!total && <span className="calendar-no-count">—</span>}
                      </span>
                    </button>
                    {visibleEntries.length > 0 && <div className="calendar-day-items">
                      {visibleEntries.map((entry) => <button
                        type="button"
                        className={`calendar-drag-item is-${entry.kind}${dragging?.kind === entry.kind && dragging.id === entry.id ? " is-dragging" : ""}`}
                        key={`${entry.kind}-${entry.id}`}
                        draggable={canMoveEntry(entry) && !saving}
                        title={`${kindLabels[entry.kind]}：${entry.title}。可拖曳改期，或點擊開啟日期調整。`}
                        onClick={() => {
                          setSelectedDate(cell.date);
                          setComposer(null);
                          setFailed(false);
                          setFeedback("");
                          setMoving(canMoveEntry(entry) ? entry : null);
                        }}
                        onDragStart={(event) => {
                          draggedEntry.current = entry;
                          setDragging(entry);
                          setMoving(null);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", `${entry.kind}:${entry.id}`);
                        }}
                        onDragEnd={() => {
                          draggedEntry.current = null;
                          setDragging(null);
                          setDragOverDate("");
                        }}
                      ><span aria-hidden="true">{entry.kind === "activity" ? "活" : entry.kind === "task" ? "任" : "會"}</span>{entry.title}</button>)}
                      {calendarEntries.length > visibleEntries.length && <button type="button" className="calendar-more-items" onClick={() => chooseDate(cell.date)}>另有 {calendarEntries.length - visibleEntries.length} 項</button>}
                    </div>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="calendar-legend" aria-label="行事曆圖例"><span className="is-activity">活動</span><span className="is-task">任務期限</span><span className="is-meeting">會議</span></div>
        </section>

        <aside className="calendar-day-panel" aria-label={`${selectedDate} 當日內容`}>
          <div className="calendar-day-panel-head">
            <div><small>{selectedDate}</small><h3>{dateLabel(selectedDate)}</h3></div>
            <span>{selected.activities.length + selected.tasks.length + selected.meetings.length} 項</span>
          </div>

          <div className="calendar-create-actions" aria-label="新增項目">
            {(["activity", "task", "meeting"] as EntryKind[]).map((kind) => (
              (kind === "activity" ? canManageAll : configurableActivities.length > 0) && <button className={composer === kind ? "active" : ""} type="button" key={kind} onClick={() => { setComposer(composer === kind ? null : kind); setFailed(false); setFeedback(""); }}>＋ {kindLabels[kind]}</button>
            ))}
          </div>

          {feedback && <p className="calendar-feedback success" role="status">{feedback}</p>}
          {failed && <p className="calendar-feedback error" role="alert">儲存失敗，內容已保留，請稍後再試。</p>}

          {composer && <div className="calendar-composer" key={`${composer}-${selectedDate}`}>
            <div className="calendar-composer-head"><strong>新增{kindLabels[composer]}</strong><button type="button" aria-label="關閉新增表單" onClick={() => setComposer(null)}>×</button></div>
            {composer === "activity" && <ActivityForm date={selectedDate} userName={userName} members={memberOptions} disabled={saving} onSubmit={(form) => void save("activity", form)} />}
            {composer === "task" && <TaskForm data={configurableData} date={selectedDate} userName={userName} members={memberOptions} disabled={saving} onSubmit={(form) => void save("task", form)} />}
            {composer === "meeting" && <MeetingForm data={configurableData} date={selectedDate} userName={userName} members={memberOptions} disabled={saving} onSubmit={(form) => void save("meeting", form)} />}
          </div>}

          {moving && <div className="calendar-composer" key={`move-${moving.kind}-${moving.id}`}>
            <div className="calendar-composer-head"><strong>調整「{moving.title}」日期</strong><button type="button" aria-label="關閉改期表單" onClick={() => setMoving(null)}>×</button></div>
            <form className="calendar-quick-form" onSubmit={(event) => { event.preventDefault(); void move(event.currentTarget); }}>
              <fieldset disabled={saving}>
                <label className="calendar-field-wide">新日期<input name="moveDate" type="date" required max={moving.kind === "task" ? (() => { const task = data.tasks.find((row) => row.id === moving.id); return taskDeadlineLimit(data.activities.find((activity) => activity.id === task?.activityId), task?.phaseId); })() : undefined} defaultValue={moving.date} /></label>
                {moving.kind === "meeting" && <label className="calendar-field-wide">時間<input name="moveTime" type="time" required defaultValue={moving.time || "09:00"} /></label>}
              </fieldset>
              <button className="primary calendar-save" type="submit" disabled={saving}>{saving ? "儲存中…" : "儲存日期"}</button>
            </form>
          </div>}

          <div className="calendar-day-entries">
            {selected.activities.map((activity) => <article className="calendar-entry is-activity" key={`activity-${activity.id}`}><span>活動</span><div><strong>{activity.name}</strong><small>總召 {activity.owner || "未指派"} · {activity.status}</small></div>{canMoveEntry({ id: activity.id, kind: "activity", title: activity.name, date: datePart(activity.date || activity.startDate) }) && <button type="button" onClick={() => { setComposer(null); setMoving({ id: activity.id, kind: "activity", title: activity.name, date: datePart(activity.date || activity.startDate) }); }}>改期</button>}</article>)}
            {selected.tasks.map((task) => <article className="calendar-entry is-task" key={`task-${task.id}`}><span>任務</span><div><strong>{task.name}</strong><small>{activityName(data, task.activityId)} · 主責 {task.assignee || "未指派"}</small></div>{canMoveEntry({ id: task.id, kind: "task", title: task.name, date: datePart(task.due) }) && <button type="button" onClick={() => { setComposer(null); setMoving({ id: task.id, kind: "task", title: task.name, date: datePart(task.due) }); }}>改期</button>}</article>)}
            {selected.meetings.map((meeting) => <article className="calendar-entry is-meeting" key={`meeting-${meeting.id}`}><span>會議</span><div><strong>{meeting.title}</strong><small>{timeLabel(meeting.time)} · 主持 {meeting.organizer || "未指派"}</small></div>{canMoveEntry({ id: meeting.id, kind: "meeting", title: meeting.title, date: datePart(meeting.time) }) && <button type="button" onClick={() => { setComposer(null); setMoving({ id: meeting.id, kind: "meeting", title: meeting.title, date: datePart(meeting.time), time: meeting.time.slice(11, 16) }); }}>改期</button>}</article>)}
            {!selected.activities.length && !selected.tasks.length && !selected.meetings.length && !composer && <div className="calendar-empty"><strong>這一天還沒有安排</strong><p>可直接新增活動、任務或會議，日期會自動帶入。</p></div>}
          </div>
        </aside>
      </div>
    </section>
  );
}

export default CalendarPanel;

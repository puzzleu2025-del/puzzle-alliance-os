"use client";

import { useMemo, useRef, useState } from "react";
import type {
  Activity,
  ManagementPanelProps,
  Meeting,
  State,
  Task,
} from "./management-panels";
import "./calendar-panel.css";

type EntryKind = "activity" | "task" | "meeting";
type Composer = EntryKind | null;
export type CalendarEntry = { id: string; kind: EntryKind; title: string; date: string; time?: string };
type CalendarPanelProps = ManagementPanelProps & {
  onReschedule?: (entry: CalendarEntry, date: string, time?: string) => Promise<boolean>;
};

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
  const start = datePart(activity.startDate || activity.date);
  const end = datePart(activity.endDate || activity.date || start);
  if (!start && !end) return false;
  const lower = start || end;
  const upper = end || start;
  return date >= lower && date <= upper;
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
  disabled,
  onSubmit,
}: {
  date: string;
  userName: string;
  disabled: boolean;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <form className="calendar-quick-form" onSubmit={(event) => {
      event.preventDefault();
      if (validateOrder(event.currentTarget, "startDate", "endDate", "結束日期不能早於開始日期")) {
        onSubmit(event.currentTarget);
      }
    }}>
      <fieldset disabled={disabled}>
        <label className="calendar-field-wide">活動名稱<input name="name" required maxLength={200} autoFocus /></label>
        <label>開始日期<input name="startDate" type="date" required defaultValue={date} /></label>
        <label>結束日期<input name="endDate" type="date" required defaultValue={date} /></label>
        <label>活動總召<input name="owner" required maxLength={100} defaultValue={userName} /></label>
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
  disabled,
  onSubmit,
}: {
  data: State;
  date: string;
  userName: string;
  disabled: boolean;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <form className="calendar-quick-form" onSubmit={(event) => {
      event.preventDefault();
      if (validateOrder(event.currentTarget, "startDate", "due", "期限不能早於開始日期")) {
        onSubmit(event.currentTarget);
      }
    }}>
      <fieldset disabled={disabled}>
        <label className="calendar-field-wide">任務名稱<input name="name" required maxLength={200} autoFocus /></label>
        <label>開始日期<input name="startDate" type="date" required defaultValue={date} /></label>
        <label>期限<input name="due" type="date" required defaultValue={date} /></label>
        <label>任務主責<input name="assignee" required maxLength={100} defaultValue={userName} /></label>
        <label>優先級<select name="priority" defaultValue="一般"><option>緊急</option><option>高</option><option>一般</option><option>低</option></select></label>
        <label className="calendar-field-wide">所屬活動<select name="activityId" defaultValue={data.activities[0]?.id ?? ""}><option value="">未分類</option>{data.activities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
      </fieldset>
      <button className="primary calendar-save" type="submit" disabled={disabled}>{disabled ? "儲存中…" : "建立任務"}</button>
    </form>
  );
}

function MeetingForm({
  data,
  date,
  userName,
  disabled,
  onSubmit,
}: {
  data: State;
  date: string;
  userName: string;
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
        <label>主持人<input name="organizer" required maxLength={100} defaultValue={userName} /></label>
        <label>記錄人<input name="recorder" required maxLength={100} /></label>
        <label className="calendar-field-wide">所屬活動<select name="activityId" defaultValue={data.activities[0]?.id ?? ""}><option value="">未分類</option>{data.activities.map((activity) => <option value={activity.id} key={activity.id}>{activity.name}</option>)}</select></label>
      </fieldset>
      <button className="primary calendar-save" type="submit" disabled={disabled}>{disabled ? "儲存中…" : "建立會議"}</button>
    </form>
  );
}

export function CalendarPanel({ data, userName, busy, onSave, onReschedule }: CalendarPanelProps) {
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
  const draggedEntry = useRef<CalendarEntry | null>(null);

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
    activities: data.activities.filter((activity) => activityOccursOn(activity, date)),
    tasks: data.tasks.filter((task) => datePart(task.due || task.startDate) === date),
    meetings: data.meetings.filter((meeting) => datePart(meeting.time) === date),
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
        date: startDate,
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
      const item: Task = {
        id: crypto.randomUUID(),
        name: field(form, "name"),
        activityId: field(form, "activityId"),
        assignee,
        due: field(form, "due"),
        status: "待處理",
        blocker: "",
        startDate: field(form, "startDate"),
        priority: field(form, "priority") || "一般",
        flow: ["建立任務", assignee, "完成"],
        step: 1,
      };
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
        attendees: [],
        attendeeResponses: [],
        agenda: "",
        attending: 0,
        total: 0,
      };
      next = { ...data, meetings: [...data.meetings, item] };
      action = "create_meeting";
    }
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
    if (!onReschedule || saving || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return;
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
        <button className="primary" type="button" onClick={() => { chooseDate(today); setComposer("activity"); }}>＋ 今天新增</button>
      </div>

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
          <p className="calendar-scroll-hint">手機可左右滑動月曆。</p>
          <div className="calendar-grid-scroll" tabIndex={0}>
            <div className="calendar-grid">
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => <div className="calendar-weekday" key={day}>週{day}</div>)}
              {cells.map((cell) => {
                const entries = entriesFor(cell.date);
                const total = entries.activities.length + entries.tasks.length + entries.meetings.length;
                const calendarEntries: CalendarEntry[] = [
                  ...entries.activities.map((activity) => ({ id: activity.id, kind: "activity" as const, title: activity.name, date: datePart(activity.startDate || activity.date) })),
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
                        draggable={Boolean(onReschedule) && !saving}
                        title={`${kindLabels[entry.kind]}：${entry.title}。可拖曳改期，或點擊開啟日期調整。`}
                        onClick={() => {
                          setSelectedDate(cell.date);
                          setComposer(null);
                          setFailed(false);
                          setFeedback("");
                          setMoving(entry);
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
              <button className={composer === kind ? "active" : ""} type="button" key={kind} onClick={() => { setComposer(composer === kind ? null : kind); setFailed(false); setFeedback(""); }}>＋ {kindLabels[kind]}</button>
            ))}
          </div>

          {feedback && <p className="calendar-feedback success" role="status">{feedback}</p>}
          {failed && <p className="calendar-feedback error" role="alert">儲存失敗，內容已保留，請稍後再試。</p>}

          {composer && <div className="calendar-composer" key={`${composer}-${selectedDate}`}>
            <div className="calendar-composer-head"><strong>新增{kindLabels[composer]}</strong><button type="button" aria-label="關閉新增表單" onClick={() => setComposer(null)}>×</button></div>
            {composer === "activity" && <ActivityForm date={selectedDate} userName={userName} disabled={saving} onSubmit={(form) => void save("activity", form)} />}
            {composer === "task" && <TaskForm data={data} date={selectedDate} userName={userName} disabled={saving} onSubmit={(form) => void save("task", form)} />}
            {composer === "meeting" && <MeetingForm data={data} date={selectedDate} userName={userName} disabled={saving} onSubmit={(form) => void save("meeting", form)} />}
          </div>}

          {moving && <div className="calendar-composer" key={`move-${moving.kind}-${moving.id}`}>
            <div className="calendar-composer-head"><strong>調整「{moving.title}」日期</strong><button type="button" aria-label="關閉改期表單" onClick={() => setMoving(null)}>×</button></div>
            <form className="calendar-quick-form" onSubmit={(event) => { event.preventDefault(); void move(event.currentTarget); }}>
              <fieldset disabled={saving}>
                <label className="calendar-field-wide">新日期<input name="moveDate" type="date" required defaultValue={moving.date} /></label>
                {moving.kind === "meeting" && <label className="calendar-field-wide">時間<input name="moveTime" type="time" required defaultValue={moving.time || "09:00"} /></label>}
              </fieldset>
              <button className="primary calendar-save" type="submit" disabled={saving}>{saving ? "儲存中…" : "儲存日期"}</button>
            </form>
          </div>}

          <div className="calendar-day-entries">
            {selected.activities.map((activity) => <article className="calendar-entry is-activity" key={`activity-${activity.id}`}><span>活動</span><div><strong>{activity.name}</strong><small>總召 {activity.owner || "未指派"} · {activity.status}</small></div>{onReschedule && <button type="button" onClick={() => { setComposer(null); setMoving({ id: activity.id, kind: "activity", title: activity.name, date: datePart(activity.startDate || activity.date) }); }}>改期</button>}</article>)}
            {selected.tasks.map((task) => <article className="calendar-entry is-task" key={`task-${task.id}`}><span>任務</span><div><strong>{task.name}</strong><small>{activityName(data, task.activityId)} · 主責 {task.assignee || "未指派"}</small></div>{onReschedule && <button type="button" onClick={() => { setComposer(null); setMoving({ id: task.id, kind: "task", title: task.name, date: datePart(task.due) }); }}>改期</button>}</article>)}
            {selected.meetings.map((meeting) => <article className="calendar-entry is-meeting" key={`meeting-${meeting.id}`}><span>會議</span><div><strong>{meeting.title}</strong><small>{timeLabel(meeting.time)} · 主持 {meeting.organizer || "未指派"}</small></div>{onReschedule && <button type="button" onClick={() => { setComposer(null); setMoving({ id: meeting.id, kind: "meeting", title: meeting.title, date: datePart(meeting.time), time: meeting.time.slice(11, 16) }); }}>改期</button>}</article>)}
            {!selected.activities.length && !selected.tasks.length && !selected.meetings.length && !composer && <div className="calendar-empty"><strong>這一天還沒有安排</strong><p>可直接新增活動、任務或會議，日期會自動帶入。</p></div>}
          </div>
        </aside>
      </div>
    </section>
  );
}

export default CalendarPanel;

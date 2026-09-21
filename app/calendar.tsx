"use client";

import { useRef, useState } from "react";
import "./calendar.css";

export type CalendarEvent = { id: string; kind: "activity" | "task" | "meeting"; title: string; date: string; time?: string };
type Props = { events: CalendarEvent[]; onReschedule: (event: CalendarEvent, date: string, time?: string) => Promise<boolean> };
const labels = { activity: "活動", task: "任務", meeting: "會議" };
const pad = (n: number) => String(n).padStart(2, "0");
const monthLabel = (date: Date) => `${date.getFullYear()} / ${pad(date.getMonth() + 1)}`;

export default function Calendar({ events, onReschedule }: Props) {
  const [cursor, setCursor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [over, setOver] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const moving = useRef(false);
  const dragged = useRef<CalendarEvent | null>(null);
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const prefix = `${year}-${pad(month + 1)}`;
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const total = new Date(year, month + 1, 0).getDate();
  const previous = new Date(year, month - 1, 1), next = new Date(year, month + 1, 1);
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  async function save(event: CalendarEvent, target: string, time?: string) {
    if (moving.current || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return;
    moving.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (await onReschedule(event, target, time)) {
        setMessage(`「${event.title}」已移到 ${target}`);
        dialog.current?.close();
        setSelected(null);
      } else {
        setMessage("日期未儲存，請重試。");
      }
    } catch {
      setMessage("日期未儲存，請稍後重試。");
    } finally {
      moving.current = false;
      setBusy(false);
    }
  }

  function open(event: CalendarEvent) {
    setSelected(event);
    setDate(event.date.slice(0, 10));
    setMessage("");
    dialog.current?.showModal();
  }

  return <section className="demo-calendar" aria-label="行事曆">
    <div className="hero-row"><div><h2>行事曆</h2><p className="sub">活動、任務、會議都可在同一張月曆查看；有權限者可直接拖曳到其他日期。</p></div></div>
    <div className="card">
      <div className="section-head">
        <div className="inline-actions">
          <button type="button" onClick={() => setCursor(previous)} aria-label="上一個月">← {monthLabel(previous)}</button>
          <button type="button" onClick={() => setCursor(new Date(now.getFullYear(), now.getMonth(), 1))}>本月</button>
          <button type="button" onClick={() => setCursor(next)} aria-label="下一個月">{monthLabel(next)} →</button>
        </div>
        <h3 aria-live="polite">{year} 年 {month + 1} 月</h3>
      </div>
      <div className="notice">桌機：直接拖曳活動／任務／會議到新日期。手機或不方便拖曳時：點一下項目，可直接選擇新日期。</div>
      <p className="cal-status" role="status">{message}</p>
      <div className="calendar">
        {["一", "二", "三", "四", "五", "六", "日"].map(day => <div className="cal-head" key={day}>週{day}</div>)}
        {Array.from({ length: offset }, (_, i) => <div className="cal-day cal-blank" aria-hidden="true" key={`blank-${i}`} />)}
        {Array.from({ length: total }, (_, i) => {
          const key = `${prefix}-${pad(i + 1)}`;
          return <div key={key} className={`cal-day drop-day${over === key ? " drag-over" : ""}${today === key ? " cal-today" : ""}`} aria-label={key}
            onDragOver={e => { if (!busy && dragged.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(key); } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(""); }}
            onDrop={e => { e.preventDefault(); setOver(""); const event = dragged.current; dragged.current = null; if (event) void save(event, key); }}>
            <div className="cal-num">{i + 1}</div>
            {events.filter(event => event.date.slice(0, 10) === key).map(event => <button type="button" className="cal-event" key={`${event.kind}-${event.id}`} draggable={!busy} disabled={busy}
              title={`${labels[event.kind]} · ${event.title}；點擊或拖曳以調整日期`}
              aria-label={`${labels[event.kind]}：${event.title}，${key}，調整日期`}
              onClick={() => open(event)}
              onDragStart={e => { dragged.current = event; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", `${event.kind}:${event.id}`); }}
              onDragEnd={() => { dragged.current = null; setOver(""); }}>
              <strong>{labels[event.kind]}</strong> · {event.title}
            </button>)}
          </div>;
        })}
      </div>
    </div>
    <dialog ref={dialog} className="cal-dialog" aria-labelledby="cal-dialog-title" onCancel={e => { if (busy) e.preventDefault(); }} onClose={() => setSelected(null)}>
      <form onSubmit={e => {
        e.preventDefault();
        const values = new FormData(e.currentTarget);
        const actualDate = String(values.get("date") || "");
        const actualTime = selected?.kind === "meeting" ? String(values.get("time") || "20:00") : undefined;
        if (selected) void save(selected, actualDate, actualTime);
      }}>
        <h2 id="cal-dialog-title">{selected?.title || "調整日期"}</h2>
        <p className="sub">{selected && labels[selected.kind]}排程</p>
        <label htmlFor="cal-reschedule-date">日期</label>
        <input id="cal-reschedule-date" name="date" type="date" required value={date} disabled={busy} onChange={e => setDate(e.target.value)} />
        {selected?.kind === "meeting" && <>
          <label htmlFor="cal-reschedule-time">時間</label>
          <input key={selected.id} id="cal-reschedule-time" name="time" type="time" required defaultValue={selected.time || "20:00"} disabled={busy} />
        </>}
        <p role="status" className="cal-status">{message}</p>
        <div className="inline-actions"><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "儲存中…" : "儲存日期"}</button></div>
      </form>
    </dialog>
  </section>;
}

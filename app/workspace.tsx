"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { CalendarPanel, type CalendarEntry } from "./calendar-panel";
import SettingsPanel, { Audit } from "./settings-panel";
import { ActivitiesPanel, MeetingsPanel, RolesPanel, TasksPanel, phaseSchedule, type Meeting, type Notice, type State, type Task } from "./management-panels";
import RegistrationPanel from "./registration-panel";
import RegistrationPublic from "./registration-public";
import MembersPanel, { type MemberRole } from "./members-panel";

type User = { id: string; email: string; name: string; role?: string };
export type { State } from "./management-panels";
type Page = "dashboard" | "activities" | "tasks" | "registrations" | "calendar" | "meetings" | "roles" | "members" | "notifications" | "settings";

const emptyState: State = { activities: [], tasks: [], meetings: [], notices: [], registrationForms: [], registrationSubmissions: [] };
const previewRegistrationKey = "puzzle-alliance-preview-registrations-v1";
const nav: Array<[Page, string, string]> = [
  ["dashboard", "營運總覽", "⌂"], ["activities", "活動管理", "◇"], ["tasks", "任務中心", "✓"],
  ["registrations", "報名表單", "▤"], ["calendar", "行事曆", "□"], ["meetings", "會議協調", "◉"], ["roles", "組織與角色", "♙"],
  ["members", "成員管理", "♧"], ["notifications", "通知中心", "•"], ["settings", "系統設定", "⚙"],
];
const pageTitles = Object.fromEntries(nav.map(([id, label]) => [id, label])) as Record<Page, string>;
const uid = () => crypto.randomUUID();

export default function Workspace({ user, preview = false, initialState = emptyState, onLogout }: { user: User; preview?: boolean; initialState?: State; onLogout?: () => void }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [data, setData] = useState<State>(initialState);
  const [version, setVersion] = useState(0);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [sync, setSync] = useState(preview ? "本機資料" : "載入中");
  const [ready, setReady] = useState(preview);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const generation = useRef(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState("");
  const [publicFormId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("register") ?? "");
  const [registrationActivityId, setRegistrationActivityId] = useState("");
  const visibleNav = nav.filter(([id]) => (id !== "members" || ["admin", "manager", "coordinator"].includes(user.role ?? "")) && (id !== "registrations" || ["admin", "manager", "coordinator"].includes(user.role ?? "")));

  useEffect(() => {
    if (!preview) return;
    const applyStored = (raw: string | null) => {
      if (!raw) return;
      try {
        const stored = JSON.parse(raw) as Partial<State>;
        // localStorage is the preview's external persistence source.
        setData((current) => ({
          activities: Array.isArray(stored.activities) ? stored.activities : current.activities,
          tasks: Array.isArray(stored.tasks) ? stored.tasks : current.tasks,
          meetings: Array.isArray(stored.meetings) ? stored.meetings : current.meetings,
          notices: Array.isArray(stored.notices) ? stored.notices : current.notices,
          registrationForms: Array.isArray(stored.registrationForms) ? stored.registrationForms : current.registrationForms,
          registrationSubmissions: Array.isArray(stored.registrationSubmissions) ? stored.registrationSubmissions : current.registrationSubmissions,
        }));
      } catch {}
    };
    applyStored(window.localStorage.getItem(previewRegistrationKey));
    const onStorage = (event: StorageEvent) => { if (event.key === previewRegistrationKey) applyStored(event.newValue); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [preview]);

  const load = useCallback(async () => {
    if (preview || saving.current) return;
    const requestGeneration = ++generation.current;
    try {
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "這個帳號尚未取得使用權限" : "無法載入工作空間");
      const body = await res.json() as {state:State;version:number;audit:Audit[]};
      if (requestGeneration !== generation.current) return;
      setData(body.state ?? emptyState); setVersion(body.version ?? 0); setAudit(body.audit ?? []); setSync("已同步");
      setError(""); setReady(true);
    } catch (e) { if (requestGeneration !== generation.current) return; setError(e instanceof Error ? e.message : "載入失敗"); setSync("同步失敗"); }
  }, [preview]);

  useEffect(() => {
    if (preview) return;
    // Initial server synchronization is the external system this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, preview]);
  useEffect(() => {
    const onFocus = () => void load(); window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 45000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(timer); };
  }, [load]);

  const save = useCallback(async (next: State, action: string) => {
    if (saving.current || !ready) return false;
    const record = () => setAudit(rows => [{id:uid(), actor:user.name, action, createdAt:new Date().toISOString()},...rows].slice(0,50));
    if (preview) {
      setData(next);
      window.localStorage.setItem(previewRegistrationKey, JSON.stringify(next));
      setVersion(v => v + 1); record(); setSync("本機預覽已儲存"); return true;
    }
    saving.current = true; generation.current++; setBusy(true); setSync("儲存中"); setError("");
    try {
      const res = await fetch("/api/workspace", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: next, version, action }) });
      const body = await res.json() as {state:State;version:number;error?:string};
      if (res.status === 409) { setData(body.state); setVersion(body.version); throw new Error("資料已由其他裝置更新，已載入最新版本，請再操作一次"); }
      if (!res.ok) throw new Error(body.error || "儲存失敗");
      setData(next); setVersion(body.version); record(); setSync("已同步"); return true;
    } catch (e) { setError(e instanceof Error ? e.message : "儲存失敗"); setSync("同步失敗"); return false; }
    finally { saving.current = false; setBusy(false); }
  }, [preview, ready, version, user.name]);

  useEffect(() => {
    const ctx = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: unknown) => unknown } }).modelContext;
    if (!ctx?.registerTool) return;
    const control = new AbortController();
    void Promise.resolve(ctx.registerTool({ name: "list_open_tasks", title: "列出未完成任務", description: "列出拼圖聯盟工作空間內所有未完成任務。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => data.tasks.filter(t => t.status !== "完成") }, { signal: control.signal })).catch(() => {});
    return () => control.abort();
  }, [data.tasks]);

  const openTasks = data.tasks.filter(t => t.status !== "完成");
  const upcoming = [...data.meetings].filter(m => new Date(m.time) >= new Date()).sort((a,b) => a.time.localeCompare(b.time));
  const activityName = (id: string) => data.activities.find(a => a.id === id)?.name || "未分類";
  const reschedule = async (event: CalendarEntry, date:string, time?:string) => {
    const meeting=event.kind==="meeting"?data.meetings.find(m=>m.id===event.id):undefined;
    if(date===event.date&&(!time||time===meeting?.time.slice(11,16)))return true;
    const oldDay = Date.parse(`${event.date}T00:00:00Z`);
    const newDay = Date.parse(`${date}T00:00:00Z`);
    const deltaDays = Number.isFinite(oldDay) && Number.isFinite(newDay) ? Math.round((newDay-oldDay)/86_400_000) : 0;
    const shiftDate = (value?: string) => {
      if (!value || !deltaDays) return value;
      const shifted = new Date(`${value.slice(0,10)}T00:00:00Z`);
      shifted.setUTCDate(shifted.getUTCDate()+deltaDays);
      return shifted.toISOString().slice(0,10);
    };
    const shiftMeeting = (row: Meeting) => {
      const nextStart = `${date}T${time || row.time.slice(11,16) || "09:00"}:00+08:00`;
      const oldStart = Date.parse(row.time);
      const oldEnd = Date.parse(row.endTime || "");
      const duration = Number.isFinite(oldStart) && Number.isFinite(oldEnd) && oldEnd > oldStart ? oldEnd-oldStart : 60*60_000;
      const localEnd = new Date(Date.parse(nextStart)+duration+8*60*60_000).toISOString().slice(0,19);
      return { ...row, time: nextStart, endTime: `${localEnd}+08:00`, status: "待確認" };
    };
    const change:Notice={...notice(`排程異動：${event.title}`),detail:`${event.date}${meeting?" "+meeting.time.slice(11,16):""} → ${date}${meeting?" "+(time||meeting.time.slice(11,16)):""}；請確認相關準備與出席安排。`,important:true};
    const activity = event.kind === "activity" ? data.activities.find((row) => row.id === event.id) : undefined;
    const shiftedActivityDate = activity ? shiftDate(activity.date) ?? activity.date : "";
    return save({...data,activities:data.activities.map(a=>event.kind==="activity"&&a.id===event.id?{...a,date:shiftedActivityDate,startDate:shiftDate(a.startDate),endDate:shiftDate(a.endDate)}:a),tasks:data.tasks.map(t=>{
      if (event.kind === "task" && t.id === event.id) return {...t,startDate:shiftDate(t.startDate),due:date};
      if (!activity || t.activityId !== activity.id || !t.phaseId) return t;
      const before = phaseSchedule(activity.date, t.phaseId);
      const after = phaseSchedule(shiftedActivityDate, t.phaseId);
      if (!before || !after) return t;
      return {...t,startDate:t.startDate === before.startDate ? after.startDate : t.startDate,due:t.due === before.due ? after.due : t.due};
    }),meetings:data.meetings.map(m=>event.kind==="meeting"&&m.id===event.id?shiftMeeting(m):m),notices:[change,...data.notices]},"reschedule");
  };

  if (preview && publicFormId) {
    const form = (data.registrationForms ?? []).find((row) => row.id === publicFormId);
    const activity = form ? data.activities.find((row) => row.id === form.activityId) : undefined;
    if (!form) return <main className="signin-page"><section className="signin-card"><h1>找不到這份報名表</h1><p className="muted">連結可能有誤，或表單尚未建立。</p><a className="button wide" href="./">返回預覽</a></section></main>;
    return <RegistrationPublic form={form} activityName={activity?.name ?? "活動報名"} onSubmit={async (submission) => save({ ...data, registrationSubmissions: [...(data.registrationSubmissions ?? []), submission] }, "create_registration_submission")} />;
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="logo"><b>▦ 拼圖聯盟</b><small>ALLIANCE OS</small></div><nav aria-label="主要導覽">{visibleNav.map(([id,label,icon]) => <button key={id} aria-current={page===id?"page":undefined} className={page===id?"active":""} onClick={() => setPage(id)}><span className="icon" aria-hidden="true">{icon}</span><span className="nav-label-text">{label}</span></button>)}</nav><div className="account"><b>{user.name}</b><span>{ready ? roleName(user.role) : "驗證權限中"}</span></div></aside>
    <main className="main"><header className="topbar"><div><h1>{pageTitles[page]}</h1><p>{page === "dashboard" ? "掌握今天最需要推進的事" : "拼圖聯盟工作空間"}</p></div><div aria-live="polite" className={`sync ${sync.includes("失敗") ? "bad" : ""}`}><i aria-hidden="true" />{sync}</div></header>
      <nav className="mobile-nav" aria-label="手機導覽">{visibleNav.filter(([id])=>["dashboard","activities","tasks","meetings"].includes(id)).map(([id,label,icon]) => <button key={id} aria-current={page===id?"page":undefined} className={page===id?"active":""} onClick={() => setPage(id)}><span className="icon" aria-hidden="true">{icon}</span><span className="nav-label-text">{label.replace("營運","").replace("管理","").replace("中心","").replace("協調","")}</span></button>)}<button aria-label="更多功能" aria-haspopup="dialog" aria-expanded={moreOpen} className={!["dashboard","activities","tasks","meetings"].includes(page)?"active":""} onClick={()=>setMoreOpen(true)}><span className="icon" aria-hidden="true">⋯</span><span>更多</span></button></nav>
      <div className="content">{error && <div className="alert" role="alert">{error}<button onClick={() => void load()}>重新載入</button></div>}
        {preview && <div className="preview-banner" role="note">GitHub Pages 互動版 · 帳號、成員與報名資料保存在這個瀏覽器；正式跨裝置同步與自動寄信需要後端服務。</div>}
        {!ready ? (error ? <div className="empty">目前無法開啟工作空間，請重新載入或確認登入帳號。</div> : <Loading />) : <>
          {page === "dashboard" && <Dashboard data={data} openTasks={openTasks} upcoming={upcoming} activityName={activityName} onNewTask={() => setPage("tasks")} />}
          {page === "activities" && <ActivitiesPanel data={data} userName={user.name} busy={busy} onSave={save} onOpenRegistrations={(activityId) => { setRegistrationActivityId(activityId); setPage("registrations"); }} />}
          {page === "tasks" && <TasksPanel data={data} userName={user.name} busy={busy} onSave={save} />}
          {page === "registrations" && <RegistrationPanel data={data} userName={user.name} busy={busy} onSave={save} preview={preview} initialActivityId={registrationActivityId || undefined} />}
          {page === "calendar" && <CalendarPanel data={data} userName={user.name} userRole={user.role} busy={busy} onSave={save} onReschedule={reschedule} />}
          {page === "meetings" && <MeetingsPanel data={data} userName={user.name} busy={busy} onSave={save} />}
          {page === "roles" && <RolesPanel data={data} userName={user.name} busy={busy} onSave={save} />}
          {page === "members" && <MembersPanel currentUser={{ ...user, role: (user.role ?? "member") as MemberRole }} preview={preview} />}
          {page === "notifications" && <Notifications data={data} navigate={setPage} acknowledge={id=>void save({...data,notices:data.notices.map(n=>n.id===id?{...n,read:true}:n)},"read_notice")} />}
          {page === "settings" && <SettingsPanel version={version} preview={preview} sync={sync} audit={audit} refresh={()=>void load()} onLogout={onLogout} />}
        </>}
      </div>
    </main>
    {moreOpen && <DialogShell title="更多功能" className="more-menu" close={()=>setMoreOpen(false)}><nav>{visibleNav.filter(([id])=>!["dashboard","activities","tasks","meetings"].includes(id)).map(([id,label,icon])=><button key={id} onClick={()=>{setPage(id);setMoreOpen(false);}}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav></DialogShell>}
  </div>;
}

function notice(title: string): Notice { return { id: uid(), title, detail: "由系統管理員操作", createdAt: new Date().toISOString(), read: false }; }
function Notifications({data,navigate,acknowledge}:{data:State;navigate:(page:Page)=>void;acknowledge:(id:string)=>void}) {
  const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei"}).format(new Date());
  const rows=data.tasks.filter(t=>t.status!=="完成").flatMap(t=>{
    const reasons=[t.due&&t.due<today?`已逾期，期限 ${t.due}`:"",t.blocker?`卡關：${t.blocker}`:"",/待|審核/.test(t.status)?`目前${t.status}`:""].filter(Boolean);
    return reasons.length?[{id:`task-${t.id}`,title:t.name,detail:`${reasons.join("；")} · 主責 ${t.assignee}${t.proxy?`／代理 ${t.proxy}`:""}`,risk:true,page:"tasks" as Page}]:[];
  });
  const meetings=data.meetings.filter(m=>m.status!=="已確認").map(m=>({id:`meeting-${m.id}`,title:`會議待確認：${m.title}`,detail:formatDateTime(m.time),risk:false,page:"meetings" as Page}));
  const changes=data.notices.filter(n=>n.important&&!n.read);
  return <><div className="page-heading"><div><h2>通知中心</h2><p className="muted">只顯示需要處理、可能延誤、待審核與重要變更。</p></div></div><section className="card notification-list">{[...rows,...meetings].map(n=><article className={`notification-item ${n.risk?"risk":"warn"}`} key={n.id}><div><h3>{n.title}</h3><p>{n.detail}</p></div><button onClick={()=>navigate(n.page)}>前往處理</button></article>)}{changes.map(n=><article className="notification-item info" key={n.id}><div><h3>{n.title}</h3><p>{n.detail}</p><small>{formatDateTime(n.createdAt)}</small></div><button onClick={()=>acknowledge(n.id)}>我已確認</button></article>)}{!rows.length&&!meetings.length&&!changes.length&&<p>目前沒有需要處理的通知。</p>}</section></>;
}
function formatDateTime(value: string) { if (!value) return "未設定"; return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: value.includes("T") ? "short" : undefined, timeZone: "Asia/Taipei" }).format(new Date(value.includes("T") ? value : `${value}T00:00:00+08:00`)); }
function roleName(role?: string) { return ({admin:"系統管理員",manager:"一般管理員",coordinator:"總召",leader:"幹部／組長",member:"一般成員"} as Record<string,string>)[role || ""] || "已核可成員"; }
function Loading() { return <div className="loading"><i/><i/><i/></div>; }
function Dashboard({data,openTasks,upcoming,activityName,onNewTask}:{data:State;openTasks:Task[];upcoming:Meeting[];activityName:(id:string)=>string;onNewTask:()=>void}) { const risks = openTasks.filter(t => t.due && new Date(t.due) < new Date()); return <><div className="hero"><div><p className="eyebrow">WORKSPACE OVERVIEW</p><h2>一起，把事情推進。</h2><p className="muted">掌握活動進度，讓每一次交接都有方向。</p></div><button className="primary" onClick={onNewTask}>＋ 建立任務</button></div><div className="stats">{[["進行中的活動",data.activities.length],["待處理任務",openTasks.length],["已逾期",risks.length],["近期會議",upcoming.length]].map(([l,v]) => <section className="stat" key={l}><span>{l}</span><strong>{v}</strong></section>)}</div><div className="split"><section className="panel"><div className="panel-head"><h3>待處理任務</h3><button onClick={onNewTask}>新增</button></div>{openTasks.length ? openTasks.slice(0,5).map(t => <div className="row" key={t.id}><div><b>{t.name}</b><small>{activityName(t.activityId)}</small></div><span>{t.due || "未設期限"}</span></div>) : <p className="empty-inline">目前沒有待處理任務</p>}</section><section className="panel"><h3>近期會議</h3>{upcoming.length ? upcoming.slice(0,5).map(m => <div className="row" key={m.id}><div><b>{m.title}</b><small>{activityName(m.activityId)}</small></div><span>{formatDateTime(m.time)}</span></div>) : <p className="empty-inline">目前沒有已安排會議</p>}</section></div></>; }
function DialogShell({ title, close, className = "", children }: {title: string; close:()=>void; className?:string; children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=ref.current;
    const previous=document.activeElement as HTMLElement | null;
    const overflow=document.body.style.overflow;
    dialog?.showModal(); document.body.style.overflow="hidden";
    return ()=>{dialog?.close();document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={e=>{e.preventDefault();close();}}><div className="modal-head"><h2>{title}</h2><button type="button" aria-label="關閉" onClick={close}>×</button></div>{children}</dialog>;
}

"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type User = { id: string; email: string; name: string };
type Activity = { id: string; name: string; date: string; owner: string; status: string; description: string };
type Task = { id: string; name: string; activityId: string; assignee: string; due: string; status: string; blocker: string };
type Meeting = { id: string; title: string; activityId: string; time: string; status: string };
type Notice = { id: string; title: string; detail: string; createdAt: string; read: boolean };
type State = { activities: Activity[]; tasks: Task[]; meetings: Meeting[]; notices: Notice[] };
type Page = "dashboard" | "activities" | "tasks" | "calendar" | "meetings" | "roles" | "members" | "notifications" | "settings";

const emptyState: State = { activities: [], tasks: [], meetings: [], notices: [] };
const nav: Array<[Page, string, string]> = [
  ["dashboard", "營運總覽", "⌂"], ["activities", "活動管理", "◇"], ["tasks", "任務中心", "✓"],
  ["calendar", "行事曆", "□"], ["meetings", "會議協調", "◉"], ["roles", "組織與角色", "♙"],
  ["members", "成員管理", "♧"], ["notifications", "通知中心", "•"], ["settings", "系統設定", "⚙"],
];
const pageTitles = Object.fromEntries(nav.map(([id, label]) => [id, label])) as Record<Page, string>;
const uid = () => crypto.randomUUID();

export default function Workspace({ user }: { user: User }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [data, setData] = useState<State>(emptyState);
  const [version, setVersion] = useState(0);
  const [sync, setSync] = useState("載入中");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"activity" | "task" | "meeting" | null>(null);

  const load = useCallback(async () => {
    try {
      setSync("同步中"); setError("");
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "這個帳號尚未取得使用權限" : "無法載入工作空間");
      const body = await res.json();
      setData(body.state ?? emptyState); setVersion(body.version ?? 0); setSync("已同步");
    } catch (e) { setError(e instanceof Error ? e.message : "載入失敗"); setSync("同步失敗"); }
  }, []);

  useEffect(() => {
    // Initial server synchronization is the external system this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    const onFocus = () => void load(); window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 45000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(timer); };
  }, [load]);

  const save = useCallback(async (next: State, action: string) => {
    const before = data; setData(next); setSync("儲存中"); setError("");
    try {
      const res = await fetch("/api/workspace", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: next, version, action }) });
      const body = await res.json();
      if (res.status === 409) { setData(body.state); setVersion(body.version); throw new Error("資料已由其他裝置更新，已載入最新版本，請再操作一次"); }
      if (!res.ok) throw new Error(body.error || "儲存失敗");
      setVersion(body.version); setSync("已同步");
    } catch (e) { if (!(e instanceof Error && e.message.startsWith("資料已"))) setData(before); setError(e instanceof Error ? e.message : "儲存失敗"); setSync("同步失敗"); }
  }, [data, version]);

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
  const addActivity = (form: FormData) => {
    const item: Activity = { id: uid(), name: String(form.get("name")), date: String(form.get("date")), owner: user.name, status: "規劃中", description: String(form.get("description") || "") };
    void save({ ...data, activities: [...data.activities, item], notices: [notice(`已建立活動「${item.name}」`), ...data.notices] }, "create_activity"); setDialog(null);
  };
  const addTask = (form: FormData) => {
    const item: Task = { id: uid(), name: String(form.get("name")), activityId: String(form.get("activityId") || ""), assignee: user.name, due: String(form.get("due")), status: "進行中", blocker: "" };
    void save({ ...data, tasks: [...data.tasks, item], notices: [notice(`已建立任務「${item.name}」`), ...data.notices] }, "create_task"); setDialog(null);
  };
  const addMeeting = (form: FormData) => {
    const item: Meeting = { id: uid(), title: String(form.get("title")), activityId: String(form.get("activityId") || ""), time: String(form.get("time")), status: "待確認" };
    void save({ ...data, meetings: [...data.meetings, item], notices: [notice(`已安排會議「${item.title}」`), ...data.notices] }, "create_meeting"); setDialog(null);
  };
  const completeTask = (id: string) => void save({ ...data, tasks: data.tasks.map(t => t.id === id ? { ...t, status: "完成" } : t), notices: [notice("任務已完成"), ...data.notices] }, "complete_task");

  return <div className="app-shell">
    <aside className="sidebar"><div className="logo"><b>▦ 拼圖聯盟</b><small>ALLIANCE OS</small></div><nav aria-label="主要導覽">{nav.map(([id,label,icon]) => <button key={id} className={page===id?"active":""} onClick={() => setPage(id)}><span>{icon}</span>{label}</button>)}</nav><div className="account"><b>{user.name}</b><span>系統管理員</span><span className="truncate">{user.email}</span></div></aside>
    <main className="main"><header className="topbar"><div><h1>{pageTitles[page]}</h1><p>{page === "dashboard" ? "掌握今天最需要推進的事" : "拼圖聯盟工作空間"}</p></div><div className={`sync ${sync.includes("失敗") ? "bad" : ""}`}><i />{sync}</div></header>
      <div className="mobile-nav" aria-label="手機導覽">{nav.map(([id,label]) => <button key={id} className={page===id?"active":""} onClick={() => setPage(id)}>{label}</button>)}</div>
      <div className="content">{error && <div className="alert" role="alert">{error}<button onClick={() => void load()}>重新載入</button></div>}
        {sync === "載入中" ? <Loading /> : <>
          {page === "dashboard" && <Dashboard data={data} openTasks={openTasks} upcoming={upcoming} activityName={activityName} onNewTask={() => setDialog("task")} />}
          {page === "activities" && <Collection title="活動管理" subtitle="建立活動並集中追蹤進度與負責人" action="建立活動" onAction={() => setDialog("activity")} empty="還沒有活動。建立第一個活動，任務與會議就能開始歸檔。">{data.activities.map(a => <article className="card" key={a.id}><span className="badge">{a.status}</span><h3>{a.name}</h3><p className="muted">{a.date} · 負責人 {a.owner}</p><p>{a.description || "尚未加入說明"}</p><div className="meter"><i style={{width: `${progress(a.id, data.tasks)}%`}} /></div><small>{progress(a.id, data.tasks)}% 任務完成</small></article>)}</Collection>}
          {page === "tasks" && <Collection title="任務中心" subtitle="承辦、期限與下一步集中在同一處" action="建立任務" onAction={() => setDialog("task")} empty="目前沒有任務。建立任務後即可跨裝置追蹤。">{data.tasks.map(t => <article className="card task" key={t.id}><div><span className={`badge ${t.status === "完成" ? "green" : ""}`}>{t.status}</span><h3>{t.name}</h3><p className="muted">{activityName(t.activityId)} · {t.assignee}</p><p>期限 {t.due || "未設定"}</p></div>{t.status !== "完成" && <button onClick={() => completeTask(t.id)}>標記完成</button>}</article>)}</Collection>}
          {page === "calendar" && <Calendar data={data} />}
          {page === "meetings" && <Collection title="會議協調" subtitle="確認時間後會自動出現在行事曆" action="安排會議" onAction={() => setDialog("meeting")} empty="還沒有會議。需要同步時再安排即可。">{data.meetings.map(m => <article className="card" key={m.id}><span className="badge">{m.status}</span><h3>{m.title}</h3><p className="muted">{activityName(m.activityId)}</p><p>{formatDateTime(m.time)}</p></article>)}</Collection>}
          {page === "roles" && <Roles />}
          {page === "members" && <Members user={user} />}
          {page === "notifications" && <Collection title="通知中心" subtitle="需要處理的變更集中在這裡" empty="目前沒有通知。">{data.notices.map(n => <article className="card" key={n.id}><h3>{n.title}</h3><p>{n.detail}</p><small>{formatDateTime(n.createdAt)}</small></article>)}</Collection>}
          {page === "settings" && <Settings user={user} version={version} />}
        </>}
      </div>
    </main>
    {dialog && <Modal type={dialog} activities={data.activities} close={() => setDialog(null)} submit={dialog === "activity" ? addActivity : dialog === "task" ? addTask : addMeeting} />}
  </div>;
}

function notice(title: string): Notice { return { id: uid(), title, detail: "由系統管理員操作", createdAt: new Date().toISOString(), read: false }; }
function progress(activityId: string, tasks: Task[]) { const rows = tasks.filter(t => t.activityId === activityId); return rows.length ? Math.round(rows.filter(t => t.status === "完成").length / rows.length * 100) : 0; }
function formatDateTime(value: string) { if (!value) return "未設定"; return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: value.includes("T") ? "short" : undefined, timeZone: "Asia/Taipei" }).format(new Date(value.includes("T") ? value : `${value}T00:00:00+08:00`)); }
function Loading() { return <div className="loading"><i/><i/><i/></div>; }
function Collection({title, subtitle, action, onAction, empty, children}:{title:string;subtitle:string;action?:string;onAction?:()=>void;empty:string;children:React.ReactNode}) { const has = Array.isArray(children) ? children.length > 0 : Boolean(children); return <><div className="page-heading"><div><h2>{title}</h2><p className="muted">{subtitle}</p></div>{action && <button className="primary" onClick={onAction}>＋ {action}</button>}</div>{has ? <div className="card-grid">{children}</div> : <div className="empty"><b>{empty}</b></div>}</>; }
function Dashboard({data,openTasks,upcoming,activityName,onNewTask}:{data:State;openTasks:Task[];upcoming:Meeting[];activityName:(id:string)=>string;onNewTask:()=>void}) { const risks = openTasks.filter(t => t.due && new Date(t.due) < new Date()); return <><div className="hero"><div><p className="eyebrow">WORKSPACE OVERVIEW</p><h2>一起，把事情推進。</h2><p className="muted">掌握活動進度，讓每一次交接都有方向。</p></div><button className="primary" onClick={onNewTask}>＋ 建立任務</button></div><div className="stats">{[["進行中的活動",data.activities.length],["待處理任務",openTasks.length],["已逾期",risks.length],["近期會議",upcoming.length]].map(([l,v]) => <section className="stat" key={l}><span>{l}</span><strong>{v}</strong></section>)}</div><div className="split"><section className="panel"><div className="panel-head"><h3>待處理任務</h3><button onClick={onNewTask}>新增</button></div>{openTasks.length ? openTasks.slice(0,5).map(t => <div className="row" key={t.id}><div><b>{t.name}</b><small>{activityName(t.activityId)}</small></div><span>{t.due || "未設期限"}</span></div>) : <p className="empty-inline">目前沒有待處理任務</p>}</section><section className="panel"><h3>近期會議</h3>{upcoming.length ? upcoming.slice(0,5).map(m => <div className="row" key={m.id}><div><b>{m.title}</b><small>{activityName(m.activityId)}</small></div><span>{formatDateTime(m.time)}</span></div>) : <p className="empty-inline">目前沒有已安排會議</p>}</section></div></>; }
function Calendar({data}:{data:State}) { const events = [...data.activities.map(a => ({id:a.id,date:a.date,title:a.name,type:"活動"})),...data.tasks.filter(t=>t.due).map(t=>({id:t.id,date:t.due,title:t.name,type:"任務"})),...data.meetings.map(m=>({id:m.id,date:m.time.slice(0,10),title:m.title,type:"會議"}))].sort((a,b)=>a.date.localeCompare(b.date)); return <Collection title="行事曆" subtitle="活動、任務期限與會議排程" empty="還沒有任何排程。">{events.map(e => <article className="card calendar-item" key={`${e.type}-${e.id}`}><time>{e.date}</time><div><span className="badge">{e.type}</span><h3>{e.title}</h3></div></article>)}</Collection>; }
function Roles() { return <Collection title="組織與角色" subtitle="第一版只啟用系統管理員" empty=""><article className="card role-card"><span className="role-icon">♙</span><div><h3>系統管理員</h3><p>可管理活動、任務、會議、成員、通知與系統設定。</p></div></article></Collection>; }
function Members({user}:{user:User}) { return <Collection title="成員管理" subtitle="目前只有一個啟用中的系統管理員" empty=""><article className="card member-card"><div className="avatar">{user.name.slice(0,1).toUpperCase()}</div><div><h3>{user.name}</h3><p className="muted">{user.email}</p></div><span className="badge green">系統管理員</span></article></Collection>; }
function Settings({user,version}:{user:User;version:number}) { return <><div className="page-heading"><div><h2>系統設定</h2><p className="muted">安全與跨裝置資料狀態</p></div></div><div className="card-grid"><article className="card"><h3>登入方式</h3><p>ChatGPT 安全登入</p><small>{user.email}</small></article><article className="card"><h3>中央同步</h3><p>所有裝置共用同一份資料</p><small>資料版本 {version}</small></article><article className="card"><h3>時區</h3><p>Asia / Taipei</p><small>日期與時間以台北時間顯示</small></article></div></>; }
function Modal({type,activities,close,submit}:{type:"activity"|"task"|"meeting";activities:Activity[];close:()=>void;submit:(form:FormData)=>void}) { const labels={activity:"建立活動",task:"建立任務",meeting:"安排會議"}; const onSubmit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();submit(new FormData(e.currentTarget));}; return <div className="modal-backdrop" onMouseDown={e=>{if(e.currentTarget===e.target)close();}}><form className="modal" onSubmit={onSubmit}><div className="modal-head"><h2>{labels[type]}</h2><button type="button" aria-label="關閉" onClick={close}>×</button></div><label>{type==="activity"?"活動名稱":type==="task"?"任務名稱":"會議名稱"}<input name={type==="meeting"?"title":"name"} required autoFocus /></label>{type!=="activity"&&<label>所屬活動<select name="activityId"><option value="">未分類</option>{activities.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label>}{type==="activity"&&<><label>活動日期<input type="date" name="date" required /></label><label>說明<textarea name="description" /></label></>}{type==="task"&&<label>期限<input type="date" name="due" /></label>}{type==="meeting"&&<label>時間<input type="datetime-local" name="time" required /></label>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" type="submit">儲存並同步</button></div></form></div>; }

"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./members-panel.css";
import { previewPasswordHash } from "../preview/preview-password";

export type MemberRole = "admin" | "manager" | "coordinator" | "leader" | "member";
export type MemberStatus = "pending" | "active" | "disabled" | "rejected";

export type Member = {
  id: string;
  username: string;
  email?: string;
  phone?: string;
  organization?: string;
  position?: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  createdAt: string;
  updatedAt?: string;
  resetPending?: boolean;
  /** Preview only: consumed by preview-auth and never rendered by this component. */
  password?: string;
};

type Props = {
  preview: boolean;
  currentUser: { id: string; email: string; name: string; role?: string };
  initialMembers?: Member[];
};

const PREVIEW_KEY = "puzzle-union-preview-members-v1";
const roles: Array<[MemberRole, string, string]> = [
  ["admin", "系統管理員", "管理所有成員、活動與系統設定"],
  ["manager", "一般管理員", "管理低階成員與日常行政工作"],
  ["coordinator", "總召", "統籌活動、任務與跨組協作"],
  ["leader", "幹部／組長", "管理被指派的工作與組內協作"],
  ["member", "一般成員", "參與活動並更新自己的任務"],
];
const roleRank: Record<MemberRole, number> = { admin: 4, manager: 3, coordinator: 2, leader: 1, member: 0 };
const roleLabel = (role: MemberRole) => roles.find(([value]) => value === role)?.[1] ?? role;
const statusLabels: Record<MemberStatus, string> = {
  pending: "待核可",
  active: "啟用中",
  disabled: "已停用",
  rejected: "已拒絕",
};

function normalizeMember(value: unknown, keepPreviewPassword = false): Member | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? row.userId ?? row.user_id ?? "");
  const email = String(row.email ?? "").trim();
  const phone = String(row.phone ?? "").trim();
  const organization = String(row.organization ?? "").trim();
  const position = String(row.position ?? "").trim();
  const username = String(row.username ?? (email ? email.split("@")[0] : "")).trim();
  const name = String(row.name ?? row.displayName ?? row.display_name ?? "").trim();
  const role = String(row.role) as MemberRole;
  const status = String(row.status) as MemberStatus;
  if (!id || !username || !name || !["admin", "manager", "coordinator", "leader", "member"].includes(role)
    || !["pending", "active", "disabled", "rejected"].includes(status)) return null;
  return {
    id,
    username,
    name,
    email: email || undefined,
    phone: phone || undefined,
    organization: organization || undefined,
    position: position || undefined,
    role,
    status,
    createdAt: String(row.createdAt ?? row.created_at ?? new Date(0).toISOString()),
    updatedAt: row.updatedAt || row.updated_at ? String(row.updatedAt ?? row.updated_at) : undefined,
    resetPending: row.resetPending === true || row.resetPending === 1 || row.reset_pending === true || row.reset_pending === 1,
    password: keepPreviewPassword && typeof row.password === "string" ? row.password : undefined,
  };
}

function seed(currentUser: Props["currentUser"], initialMembers?: Member[]) {
  if (initialMembers?.length) return initialMembers;
  return [{
    id: currentUser.id,
    username: currentUser.email.split("@")[0] || currentUser.id,
    email: currentUser.email || undefined,
    name: currentUser.name || "嘉駿",
    role: currentUser.role && typeof roleRank[currentUser.role as MemberRole] === "number" ? currentUser.role as MemberRole : "member",
    status: "active" as const,
    createdAt: new Date().toISOString(),
  }];
}

function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
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
  return <dialog ref={ref} className="members-dialog" aria-labelledby="members-dialog-title" onCancel={(event) => { event.preventDefault(); close(); }}><div className="members-dialog-head"><h2 id="members-dialog-title">{title}</h2><button type="button" aria-label="關閉" onClick={close}>×</button></div>{children}</dialog>;
}

export default function MembersPanel({ preview, currentUser, initialMembers }: Props) {
  const actorRank = typeof roleRank[currentUser.role as MemberRole] === "number" ? roleRank[currentUser.role as MemberRole] : preview ? roleRank.admin : roleRank.member;
  const canApprove = actorRank >= roleRank.coordinator;
  const lowerRoles = canApprove ? roles.filter(([role]) => roleRank[role] < actorRank) : [];
  const [members, setMembers] = useState<Member[]>(() => {
    if (preview && typeof window !== "undefined") {
      try {
        const saved = JSON.parse(window.localStorage.getItem(PREVIEW_KEY) ?? "null") as unknown;
        if (Array.isArray(saved)) {
          const rows = saved.map((member) => normalizeMember(member, true)).filter((member): member is Member => Boolean(member));
          if (rows.length === saved.length) return rows;
        }
      } catch {
        // Ignore invalid disposable preview data.
      }
    }
    return seed(currentUser, initialMembers);
  });
  const [loading, setLoading] = useState(!preview && !initialMembers);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [filter, setFilter] = useState<MemberStatus | "all">("all");
  const [resetTarget, setResetTarget] = useState<Member | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");

  useEffect(() => {
    if (!preview) return;
    window.localStorage.setItem(PREVIEW_KEY, JSON.stringify(members));
  }, [members, preview]);

  const load = useCallback(async () => {
    if (preview) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/members", { cache: "no-store" });
      const body = await response.json() as Member[] | { members?: Member[]; error?: string };
      if (!response.ok) throw new Error(!Array.isArray(body) ? body.error || "無法載入成員" : "無法載入成員");
      const rows = Array.isArray(body) ? body : body.members ?? [];
      setMembers(rows.map((member) => normalizeMember(member)).filter((member): member is Member => Boolean(member)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法載入成員");
    } finally {
      setLoading(false);
    }
  }, [preview]);

  useEffect(() => {
    if (preview || initialMembers) return;
    // Fetching the server-owned member directory is the external system synchronized by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [preview, initialMembers, load]);

  const manageable = useMemo(() => canApprove ? members.filter((member) => roleRank[member.role] < actorRank) : [], [members, actorRank, canApprove]);
  const directory = members.filter((member) => member.id === currentUser.id || canApprove && roleRank[member.role] < actorRank);
  const pending = useMemo(() => manageable.filter((member) => member.status === "pending"), [manageable]);
  const resetRequests = useMemo(() => manageable.filter((member) => member.resetPending), [manageable]);
  const visible = filter === "all" ? directory : directory.filter((member) => member.status === filter);

  const applyResponse = async (response: Response, fallback: Member) => {
    const body = await response.json() as Member | { member?: Member; members?: Member[]; error?: string };
    if (!response.ok) {
      const message = "error" in body && typeof body.error === "string" ? body.error : "操作失敗";
      throw new Error(message);
    }
    if ("members" in body && Array.isArray(body.members)) setMembers(body.members.map((member) => normalizeMember(member)).filter((member): member is Member => Boolean(member)));
    else {
      const member = ("member" in body ? normalizeMember(body.member) : normalizeMember(body)) ?? fallback;
      setMembers((rows) => rows.some((row) => row.id === member.id)
        ? rows.map((row) => row.id === member.id ? member : row)
        : [...rows, member]);
    }
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createBusy) return;
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const phone = String(form.get("phone") ?? "").trim();
    const organization = String(form.get("organization") ?? "").trim();
    const position = String(form.get("position") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const role = String(form.get("role") ?? "member") as MemberRole;
    const status = String(form.get("status") ?? "active") as MemberStatus;
    if (!canApprove || typeof roleRank[role] !== "number" || roleRank[role] >= actorRank) { setError("只有總召以上能新增權限低於自己的成員。"); return; }
    if (members.some((member) => member.username.toLowerCase() === username.toLowerCase())) {
      setError("這個登入帳號已存在於成員名單。");
      return;
    }
    if (email && members.some((member) => member.email?.toLowerCase() === email)) {
      setError("這個 Email 已存在於成員名單。");
      return;
    }
    const member: Member = { id: crypto.randomUUID(), username, name, email: email || undefined, phone: phone || undefined, organization: organization || undefined, position: position || undefined, role, status, createdAt: new Date().toISOString() };
    setCreateBusy(true);
    setError("");
    try {
      if (preview) { const passwordHash = await previewPasswordHash(password); setMembers((rows) => [...rows, { ...member, password: passwordHash }]); }
      else await applyResponse(await fetch("/api/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, displayName: name, email: email || undefined, phone, organization, position, password, role, status }) }), member);
      setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法新增成員");
    } finally {
      setCreateBusy(false);
    }
  };

  const patch = async (member: Member, change: Partial<Pick<Member, "role" | "status">>) => {
    if (busyId) return;
    if (!canApprove || member.id === currentUser.id || roleRank[member.role] >= actorRank || (change.role && roleRank[change.role] >= actorRank)) {
      setError("只有總召以上能核可與管理權限低於自己的成員。");
      return;
    }
    const next = { ...member, ...change, updatedAt: new Date().toISOString() };
    setBusyId(member.id);
    setError("");
    try {
      if (preview) setMembers((rows) => rows.map((row) => row.id === member.id ? next : row));
      else await applyResponse(await fetch("/api/members", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: member.id, ...change }) }), next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法更新成員");
    } finally {
      setBusyId("");
    }
  };

  const resetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetTarget || resetBusy) return;
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("confirmPassword") ?? "");
    if (newPassword.length < 6) { setResetError("新密碼至少需要 6 個字元。"); return; }
    if (newPassword !== confirmation) { setResetError("兩次輸入的密碼不一致。"); return; }
    const next: Member = { ...resetTarget, resetPending: false, updatedAt: new Date().toISOString() };
    setResetBusy(true);
    setResetError("");
    try {
      if (preview) {
        const passwordHash = await previewPasswordHash(newPassword);
        setMembers((rows) => rows.map((row) => row.id === resetTarget.id ? { ...next, password: passwordHash } : row));
      } else {
        await applyResponse(await fetch("/api/members", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: resetTarget.id, newPassword }) }), next);
        setMembers((rows) => rows.map((row) => row.id === resetTarget.id ? { ...row, resetPending: false } : row));
      }
      setResetTarget(null);
    } catch (reason) {
      setResetError(reason instanceof Error ? reason.message : "無法重設密碼");
    } finally {
      setResetBusy(false);
    }
  };

  if (!canApprove) return <section className="members-panel" aria-labelledby="members-title"><h2 id="members-title">成員管理</h2><p>只有總召以上可以核可成員。</p></section>;

  return <section className="members-panel" aria-labelledby="members-title">
    <div className="page-heading"><div><h2 id="members-title">成員管理</h2><p className="muted">核可權限低於自己的加入申請，並管理成員角色。</p></div>{lowerRoles.length > 0 && <button className="primary" onClick={() => { setError(""); setCreating(true); }}>＋ 新增成員</button>}</div>
    {preview && <div className="members-preview-note" role="note">互動預覽 · 變更只保存在這個瀏覽器，不會建立正式帳號。</div>}
    {error && <div className="members-error" role="alert">{error}<button type="button" onClick={() => setError("")}>關閉</button></div>}

    <div className="members-stats">{[["待核可", pending.length], ["待重設密碼", resetRequests.length], ["啟用中", members.filter((member) => member.status === "active").length], ["已停用", members.filter((member) => member.status === "disabled").length]].map(([label, value]) => <div key={label} className={label === "待重設密碼" && Number(value) > 0 ? "attention" : ""}><small>{label}</small><strong>{value}</strong></div>)}</div>

    <section className="members-pending" aria-labelledby="pending-title"><div className="members-section-head"><div><h3 id="pending-title">待核可申請</h3><p className="muted">確認身分與所需角色後再啟用。</p></div><span className="badge">{pending.length} 筆</span></div>{pending.length ? <div className="members-pending-list">{pending.map((member) => <article key={member.id}><div className="members-identity"><span className="members-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><b>{member.name}</b><small>@{member.username}</small>{member.email && <span>{member.email}</span>}{member.phone && <span>電話：{member.phone}</span>}{member.organization && <span>單位：{member.organization}</span>}{member.position && <span>職務：{member.position}</span>}<span>申請角色：{roleLabel(member.role)}</span></div></div><div className="members-actions"><select aria-label={`調整 ${member.name} 的角色`} value={member.role} disabled={busyId === member.id} onChange={(event) => void patch(member, { role: event.target.value as MemberRole })}>{lowerRoles.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button className="primary" disabled={Boolean(busyId)} onClick={() => void patch(member, { status: "active" })}>核可</button><button className="danger" disabled={Boolean(busyId)} onClick={() => void patch(member, { status: "rejected" })}>拒絕</button></div></article>)}</div> : <p className="members-empty">目前沒有等待核可的申請。</p>}</section>

    {resetRequests.length > 0 && <section className="members-reset-requests" aria-labelledby="reset-title"><div className="members-section-head"><div><h3 id="reset-title">待重設密碼</h3><p>這些成員已提出忘記密碼申請；完成身分確認後再設定新密碼。</p></div><span className="members-reset-count">{resetRequests.length} 筆待處理</span></div><div className="members-pending-list">{resetRequests.map((member) => <article key={member.id}><div className="members-identity"><span className="members-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><b>{member.name}</b><small>@{member.username}</small>{member.email && <span>{member.email}</span>}{member.phone && <span>電話：{member.phone}</span>}{member.organization && <span>單位：{member.organization}</span>}{member.position && <span>職務：{member.position}</span>}</div></div><button className="primary" onClick={() => { setResetError(""); setResetTarget(member); }}>設定新密碼</button></article>)}</div></section>}

    <section className="members-directory" aria-labelledby="directory-title"><div className="members-section-head"><div><h3 id="directory-title">成員清單</h3><p className="muted">角色只決定工作空間內的操作範圍。</p></div><label>狀態<select value={filter} onChange={(event) => setFilter(event.target.value as MemberStatus | "all")}><option value="all">全部</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>{loading ? <p className="members-empty" aria-live="polite">載入成員中…</p> : visible.length ? <div className="members-table-wrap"><table><thead><tr><th>成員</th><th>角色</th><th>狀態</th><th>加入時間</th><th>操作</th></tr></thead><tbody>{visible.map((member) => { const isCurrent = member.id === currentUser.id; return <tr key={member.id}><td><div className="members-identity"><span className="members-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><b>{member.name}{isCurrent ? "（你）" : ""}</b><small>@{member.username}</small>{member.email && <span>{member.email}</span>}{member.phone && <span>電話：{member.phone}</span>}{member.organization && <span>單位：{member.organization}</span>}{member.position && <span>職務：{member.position}</span>}{member.resetPending && <span className="members-reset-badge">待重設密碼</span>}</div></div></td><td><select aria-label={`調整 ${member.name} 的角色`} value={member.role} disabled={busyId === member.id || isCurrent || roleRank[member.role] >= actorRank} onChange={(event) => void patch(member, { role: event.target.value as MemberRole })}>{(isCurrent ? roles.filter(([value]) => value === member.role) : lowerRoles).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></td><td><span className={`members-status ${member.status}`}>{statusLabels[member.status]}</span></td><td>{new Date(member.createdAt).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}</td><td>{member.status === "active" && !isCurrent ? <button disabled={Boolean(busyId)} onClick={() => void patch(member, { status: "disabled" })}>停用</button> : member.status === "disabled" ? <button disabled={Boolean(busyId)} onClick={() => void patch(member, { status: "active" })}>重新啟用</button> : member.status === "rejected" ? <button disabled={Boolean(busyId)} onClick={() => void patch(member, { status: "pending" })}>恢復申請</button> : null}</td></tr>; })}</tbody></table></div> : <p className="members-empty">沒有符合篩選條件的成員。</p>}</section>

    {creating && <Dialog title="新增成員" close={() => !createBusy && setCreating(false)}><form onSubmit={create}><fieldset disabled={createBusy}><label>登入帳號<input name="username" required minLength={4} maxLength={32} pattern={"[A-Za-z0-9._\\-]+"} autoComplete="username" autoFocus /><small>4–32 位，可使用英文字母、數字、句點、底線與連字號。</small></label><label>姓名<input name="name" required maxLength={100} autoComplete="name" /></label><label>Email（選填）<input name="email" type="email" maxLength={254} autoComplete="email" /></label><label>聯絡電話（選填）<input name="phone" type="tel" maxLength={24} autoComplete="tel" /></label><label>所屬單位（選填）<input name="organization" maxLength={100} /></label><label>職務／身分（選填）<input name="position" maxLength={100} /></label><label>初始密碼<input name="password" type="password" required minLength={6} maxLength={256} autoComplete="new-password" /><small>至少 6 個字元；儲存後不會在介面中顯示。</small></label><label>角色<select name="role" defaultValue="member">{lowerRoles.map(([value, label, description]) => <option value={value} key={value}>{label}｜{description}</option>)}</select></label><label>加入方式<select name="status" defaultValue="active"><option value="active">直接啟用</option><option value="pending">加入待核可清單</option></select></label></fieldset><p className="members-password-note">密碼只在新增時送交驗證服務；成員清單不會顯示或回填密碼。</p><div className="members-dialog-actions"><button type="button" disabled={createBusy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={createBusy}>{createBusy ? "儲存中…" : "新增成員"}</button></div></form></Dialog>}
    {resetTarget && <Dialog title={`重設 ${resetTarget.name} 的密碼`} close={() => !resetBusy && setResetTarget(null)}><form onSubmit={resetPassword}><fieldset disabled={resetBusy}><p className="members-reset-identity">登入帳號：<b>@{resetTarget.username}</b></p><label>新密碼<input name="newPassword" type="password" required minLength={6} maxLength={256} autoComplete="new-password" autoFocus /><small>至少 6 個字元。</small></label><label>確認新密碼<input name="confirmPassword" type="password" required minLength={6} maxLength={256} autoComplete="new-password" /></label></fieldset>{resetError && <p className="members-dialog-error" role="alert">{resetError}</p>}<p className="members-password-note">儲存後不會在介面中顯示密碼，忘記密碼標記會自動清除。</p><div className="members-dialog-actions"><button type="button" disabled={resetBusy} onClick={() => setResetTarget(null)}>取消</button><button className="primary" disabled={resetBusy}>{resetBusy ? "重設中…" : "確認重設"}</button></div></form></Dialog>}
  </section>;
}

"use client";

import { useEffect, useRef, useState } from "react";
import ParticipantQrView from "../../participant-qr-view";

type Identity = "member" | "participant";
type Cursor = { submittedAt: string; submissionId: string };
type Entry = { submissionId: string; title: string; submittedAt: string; feeAmount: number; remittanceLast5: string };

export default function MyClient() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  return <main className="signin-page"><section className="signin-card"><h1>我的報名</h1>
    <p>請選擇要查看的登入身分。</p>
    <button type="button" aria-pressed={identity === "member"} onClick={() => setIdentity("member")}>會員</button>{" "}
    <button type="button" aria-pressed={identity === "participant"} onClick={() => setIdentity("participant")}>參與者</button>
    {identity && <List key={identity} identity={identity} />}
  </section></main>;
}

// Paid registrations need the last five digits once; later changes are made by staff only.
function RemittanceField({ submissionId, feeAmount, remittanceLast5, identity, onSaved }: {
  submissionId: string; feeAmount: number; remittanceLast5: string; identity: Identity; onSaved: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (feeAmount <= 0) return null;
  if (remittanceLast5) return <p>匯款末五碼：{remittanceLast5}（如需修改，請洽工作人員）</p>;

  async function save() {
    if (busy) return;
    if (!/^[0-9]{5}$/.test(value)) { setError("請輸入 5 位數字的匯款末五碼。"); return; }
    if (!window.confirm("送出後無法自行修改，如需修改請洽工作人員。確定送出？")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/participant/registrations/remittance", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Participant-Identity": identity },
        body: JSON.stringify({ submissionId, remittanceLast5: value }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "登入已失效，請重新登入所選身分。" : response.status === 409 ? "此報名已有匯款末五碼，如需修改請洽工作人員。" : "目前無法送出，請稍後重試。");
      onSaved(value);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "目前無法送出，請稍後重試。");
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <p>本報名為收費活動，請填寫匯款末五碼（必填）。送出後僅能由工作人員修改。</p>
    <label>匯款末五碼 <input inputMode="numeric" autoComplete="off" maxLength={5} value={value} disabled={busy} onChange={event => { setValue(event.target.value.replace(/\D/g, "").slice(0, 5)); setError(""); }} /></label>{" "}
    <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "送出中…" : "送出末五碼"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

function List({ identity }: { identity: Identity }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [qrId, setQrId] = useState("");
  const alive = useRef(false);
  const pending = useRef(false);
  const withdrawing = useRef(false);
  const controller = useRef<AbortController | null>(null);

  async function load(next: Cursor | null) {
    if (pending.current) return;
    pending.current = true;
    const current = new AbortController();
    controller.current = current;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/participant/registrations/mine", {
        method: "POST", cache: "no-store", signal: current.signal,
        headers: { "Content-Type": "application/json", "X-Participant-Identity": identity },
        body: JSON.stringify({ cursor: next }),
      });
      if (!response.ok) {
        if (response.status === 401 && alive.current) { setRows([]); setCursor(null); setLoaded(false); }
        throw new Error(response.status === 401 ? "登入已失效，請重新登入所選身分。" : "目前無法載入，請稍後重試。");
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !Array.isArray((data as { registrations?: unknown }).registrations)) throw new Error();
      const result = data as { registrations: Entry[]; nextCursor: Cursor | null };
      if (!result.registrations.every(row => row && typeof row.submissionId === "string" && typeof row.title === "string" && typeof row.submittedAt === "string" && typeof row.feeAmount === "number" && typeof row.remittanceLast5 === "string") ||
          (result.nextCursor !== null && (!result.nextCursor || typeof result.nextCursor.submissionId !== "string" || typeof result.nextCursor.submittedAt !== "string"))) throw new Error();
      if (alive.current && !current.signal.aborted) {
        setRows(previous => next ? [...previous, ...result.registrations] : result.registrations);
        setCursor(result.nextCursor); setLoaded(true);
      }
    } catch (reason) {
      if (alive.current && !current.signal.aborted) setError(reason instanceof Error && reason.message ? reason.message : "目前無法載入，請稍後重試。");
    } finally {
      if (alive.current && !current.signal.aborted) { pending.current = false; setBusy(false); }
    }
  }

  useEffect(() => {
    alive.current = true;
    void load(null);
    return () => { alive.current = false; controller.current?.abort(); pending.current = false; };
  }, [identity]);

  async function withdraw() {
    if (withdrawing.current) return;
    withdrawing.current = true;
    setWithdrawBusy(true); setWithdrawError("");
    try {
      const response = await fetch("/api/participant/consent/withdraw", { method: "POST", cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401 && alive.current) { controller.current?.abort(); setRows([]); setCursor(null); setLoaded(false); }
        throw new Error(response.status === 401 ? "登入已失效，請重新登入後再試。" : "目前無法撤回，請稍後再試。");
      }
      if (alive.current) {
        controller.current?.abort();
        setRows([]); setCursor(null); setLoaded(false); setError(""); setQrId(""); setWithdrawn(true);
      }
    } catch (reason) {
      if (alive.current) setWithdrawError(reason instanceof Error ? reason.message : "目前無法撤回，請稍後再試。");
    } finally {
      withdrawing.current = false;
      if (alive.current) setWithdrawBusy(false);
    }
  }

  return <section aria-label="報名清單">
    {withdrawn ? <p role="status">已撤回同意。如需再次使用參與者服務，請重新登入並完成同意。資料刪除申請請依聯盟公告的方式提出。</p> : <>
    {busy && <p role="status">載入中…</p>}
    {error && <><p role="alert">{error}</p><button type="button" disabled={busy} onClick={() => void load(loaded ? cursor : null)}>重試</button></>}
    {loaded && rows.length === 0 && <p>目前沒有報名紀錄。</p>}
    {rows.length > 0 && <ul>{rows.map(row => <li key={row.submissionId}><strong>{row.title}</strong><br /><time>{row.submittedAt}</time><br /><RemittanceField submissionId={row.submissionId} feeAmount={row.feeAmount} remittanceLast5={row.remittanceLast5} identity={identity} onSaved={value => setRows(previous => previous.map(item => item.submissionId === row.submissionId ? { ...item, remittanceLast5: value } : item))} /><button type="button" onClick={() => setQrId(row.submissionId)}>顯示 QR</button>{qrId === row.submissionId && <ParticipantQrView submissionId={row.submissionId} identity={identity} />}</li>)}</ul>}
    {loaded && cursor && !error && <button type="button" disabled={busy} onClick={() => void load(cursor)}>載入更多</button>}
    {identity === "participant" && <div>
      {!withdrawOpen ? <button type="button" onClick={() => setWithdrawOpen(true)}>撤回加入名單同意</button> : <>
        <p>撤回後將登出參與者帳號。資料刪除申請請依聯盟公告的方式提出。</p>
        <button type="button" disabled={withdrawBusy} onClick={() => void withdraw()}>{withdrawBusy ? "處理中…" : "確認撤回同意"}</button>{" "}
        <button type="button" disabled={withdrawBusy} onClick={() => { setWithdrawOpen(false); setWithdrawError(""); }}>取消</button>
        {withdrawError && <p role="alert">{withdrawError}</p>}
      </>}
    </div>}
    </>}
  </section>;
}

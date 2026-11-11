"use client";

import { useEffect, useRef, useState } from "react";

type Identity = "member" | "participant";
type Cursor = { submittedAt: string; submissionId: string };
type Entry = { submissionId: string; title: string; submittedAt: string };

export default function MyClient() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  return <main className="signin-page"><section className="signin-card"><h1>我的報名</h1>
    <p>請選擇要查看的登入身分。</p>
    <button type="button" aria-pressed={identity === "member"} onClick={() => setIdentity("member")}>會員</button>{" "}
    <button type="button" aria-pressed={identity === "participant"} onClick={() => setIdentity("participant")}>參與者</button>
    {identity && <List key={identity} identity={identity} />}
  </section></main>;
}

function List({ identity }: { identity: Identity }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const pending = useRef(false);
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
      if (!result.registrations.every(row => row && typeof row.submissionId === "string" && typeof row.title === "string" && typeof row.submittedAt === "string") ||
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

  return <section aria-label="報名清單">
    {busy && <p role="status">載入中…</p>}
    {error && <><p role="alert">{error}</p><button type="button" disabled={busy} onClick={() => void load(loaded ? cursor : null)}>重試</button></>}
    {loaded && rows.length === 0 && <p>目前沒有報名紀錄。</p>}
    {rows.length > 0 && <ul>{rows.map(row => <li key={row.submissionId}><strong>{row.title}</strong><br /><time>{row.submittedAt}</time></li>)}</ul>}
    {loaded && cursor && !error && <button type="button" disabled={busy} onClick={() => void load(cursor)}>載入更多</button>}
  </section>;
}

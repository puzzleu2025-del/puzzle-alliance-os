"use client";

import { FormEvent, useEffect, useState } from "react";

type Terms = { version: string; content: string };

export default function ConsentClient() {
  const [terms, setTerms] = useState<Terms | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/participant/consent", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data: unknown = await response.json();
        if (!response.ok || !data || typeof data !== "object" ||
            typeof (data as Terms).version !== "string" || typeof (data as Terms).content !== "string") {
          throw new Error("目前無法取得同意內容，請重新登入或稍後再試。");
        }
        setTerms(data as Terms);
      })
      .catch(() => { if (!controller.signal.aborted) setError("目前無法取得同意內容，請重新登入或稍後再試。"); });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!terms || !checked || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/participant/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: terms.version, checked: true }),
      });
      if (!response.ok) throw new Error();
      setComplete(true);
    } catch {
      setError("無法完成同意，內容可能已更新。請重新登入後再試。");
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-form">
    <h1>聯盟名單同意事項</h1>
    {complete ? <p className="auth-success" role="status">已完成同意。</p> : <>
      {terms && <form onSubmit={submit}>
        <p>條款版本：{terms.version}</p>
        <div style={{ whiteSpace: "pre-wrap" }}>{terms.content}</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            style={{ width: 20, height: 20, minHeight: 20, flex: "0 0 20px", padding: 0, margin: 0 }}
          />
          <span>我已閱讀並同意以上內容</span>
        </label>
        <button className="primary wide" disabled={!checked || busy}>{busy ? "處理中…" : "確認同意"}</button>
      </form>}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </>}
  </main>;
}

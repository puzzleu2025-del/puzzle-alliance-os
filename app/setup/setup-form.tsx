"use client";

import { FormEvent, useState } from "react";

export default function SetupForm() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (password !== String(values.get("confirm") ?? "")) { setMessage("兩次密碼不一致"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "啟用失敗");
      form.reset(); setDone(true); setMessage("管理員帳號已啟用。請返回首頁登入。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "啟用失敗"); }
    finally { setBusy(false); }
  }
  if (done) return <p role="status">{message}</p>;
  return <form className="auth-form" onSubmit={submit}>
    <p>首次啟用時設定管理員密碼。完成後此入口即關閉。</p>
    <label>新密碼<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required /></label>
    <label>確認新密碼<input name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={256} required /></label>
    {message && <p role="alert" className="auth-error">{message}</p>}
    <button className="primary wide" disabled={busy}>{busy ? "設定中…" : "啟用帳號"}</button>
  </form>;
}

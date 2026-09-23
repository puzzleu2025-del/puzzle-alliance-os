"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "login" | "register" | "forgot";

export default function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    if (mode === "register" && password !== String(data.get("confirmPassword") ?? "")) {
      setError("兩次密碼不一致");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : mode === "register" ? "/api/auth/register" : "/api/auth/forgot-password";
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: data.get("username"), password, displayName: data.get("displayName"), email: data.get("email") }) });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "操作失敗");
      if (mode === "login") { router.replace("/"); router.refresh(); return; }
      form.reset();
      setMessage(result.message || (mode === "register" ? "申請已送出，請等待系統管理員核可。" : "申請已送出。"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "無法連線，請稍後再試"); }
    finally { setBusy(false); }
  };

  const switchMode = (next: Mode) => { setMode(next); setError(""); setMessage(""); };
  return <>
    <div className="auth-tabs" role="tablist" aria-label="帳號操作">
      <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => switchMode("login")}>登入</button>
      <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => switchMode("register")}>註冊帳號</button>
    </div>
    <form className="auth-form" onSubmit={submit}>
      <h2>{mode === "login" ? "登入工作空間" : mode === "register" ? "申請加入" : "忘記密碼"}</h2>
      {mode === "register" && <><label htmlFor="register-name">姓名</label><input id="register-name" name="displayName" autoComplete="name" required maxLength={100}/></>}
      <label htmlFor="login-username">登入帳號</label>
      <input id="login-username" name="username" autoComplete="username" required minLength={4} maxLength={32} pattern="[A-Za-z0-9._-]+" />
      {mode === "register" && <><label htmlFor="register-email">Email（選填）</label><input id="register-email" name="email" type="email" autoComplete="email" maxLength={254}/></>}
      {mode !== "forgot" && <><label htmlFor="login-password">密碼</label><input id="login-password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={6} maxLength={256}/></>}
      {mode === "register" && <><label htmlFor="register-confirm">再次輸入密碼</label><input id="register-confirm" name="confirmPassword" type="password" autoComplete="new-password" required minLength={6} maxLength={256}/></>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {message && <p className="auth-success" role="status">{message}</p>}
      <button className="primary wide" disabled={busy}>{busy ? "處理中…" : mode === "login" ? "登入" : mode === "register" ? "送出申請" : "送出重設申請"}</button>
    </form>
    {mode === "login" ? <button className="auth-link" type="button" onClick={() => switchMode("forgot")}>忘記密碼？</button> : <button className="auth-link" type="button" onClick={() => switchMode("login")}>返回登入</button>}
    {mode === "forgot" && <p className="fineprint">重設申請會交由系統管理員核對，不會寄出自動郵件。</p>}
  </>;
}

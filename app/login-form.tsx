"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export default function LoginForm(){
  const router=useRouter();
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  return <><form style={{display:"grid",gap:12,marginTop:22}} onSubmit={async e=>{
    e.preventDefault();if(busy)return;const data=new FormData(e.currentTarget);setBusy(true);setError("");
    try{const response=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:data.get("email"),password:data.get("password")})});const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error||"登入失敗");router.replace("/");router.refresh();}catch(error){setError(error instanceof Error?error.message:"無法連線，請稍後再試");setBusy(false);}
  }}><label htmlFor="login-email">管理員電子郵件</label><input id="login-email" name="email" type="email" autoComplete="username" required maxLength={254} style={{minHeight:44,minWidth:0}}/><label htmlFor="login-password">密碼</label><input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={256} style={{minHeight:44,minWidth:0}}/><p role="alert">{error}</p><button className="primary wide" disabled={busy}>{busy?"登入中…":"登入"}</button></form><a className="button wide" href="/signin-with-chatgpt?return_to=%2F" target="_top">首次啟用：以 ChatGPT 驗證身分</a><p className="fineprint">首位經 ChatGPT 驗證的使用者成為唯一系統管理員，再到系統設定建立密碼。已有管理員時，其他帳號無法啟用。</p><p className="fineprint">GitHub Pages 僅為靜態預覽；正式帳密登入需要部署 API 與 D1 資料庫。</p></>;
}

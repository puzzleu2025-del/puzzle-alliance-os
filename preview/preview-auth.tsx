import { FormEvent, useState } from "react";
import Workspace, { State } from "../app/workspace";
import type { Member } from "../app/members-panel";
import { previewPasswordHash, previewPasswordMatches } from "./preview-password";

const MEMBER_KEY = "puzzle-union-preview-members-v1";
const SESSION_KEY = "puzzle-union-preview-session-v1";
const initialAdmin: Member = { id: "preview-admin", username: "kao19950411", name: "嘉駿", role: "admin", status: "active", createdAt: "2026-09-23T00:00:00+08:00", password: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92" };

type Mode = "login" | "register" | "forgot";

function readMembers() {
  try { const value=JSON.parse(localStorage.getItem(MEMBER_KEY)||"[]") as Member[]; return Array.isArray(value)?value:[]; } catch { return []; }
}

function ensureAdmin() {
  const rows=readMembers();
  if(!rows.some(row=>row.username.toLowerCase()===initialAdmin.username)){
    const legacy=rows.findIndex(row=>row.id==="preview"&&row.role==="admin");
    if(legacy>=0)rows[legacy]={...rows[legacy],...initialAdmin};else rows.unshift(initialAdmin);
    localStorage.setItem(MEMBER_KEY,JSON.stringify(rows));
  }
}

export default function PreviewAuth({initialState}:{initialState:State}) {
  const [username,setUsername]=useState(()=>{ensureAdmin();return sessionStorage.getItem(SESSION_KEY)||"";});
  const publicForm=Boolean(new URLSearchParams(window.location.search).get("register"));
  if(publicForm)return <Workspace preview user={{id:"public",name:"報名者",email:"",role:"member"}} initialState={initialState}/>;
  const member=readMembers().find(row=>row.username===username&&row.status==="active");
  if(member)return <Workspace preview user={{id:member.id,name:member.name,email:member.email||"",role:member.role}} initialState={initialState} onLogout={()=>{sessionStorage.removeItem(SESSION_KEY);setUsername("");}}/>;
  return <PreviewLogin onLogin={(value)=>{sessionStorage.setItem(SESSION_KEY,value);setUsername(value);}}/>;
}

function PreviewLogin({onLogin}:{onLogin:(username:string)=>void}) {
  const [mode,setMode]=useState<Mode>("login"),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
  const switchMode=(next:Mode)=>{setMode(next);setMessage("");setError("");};
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(busy)return;setBusy(true);setMessage("");setError("");
    const form=event.currentTarget,data=new FormData(form),username=String(data.get("username")||"").trim().toLowerCase(),password=String(data.get("password")||"");
    const rows=readMembers();
    try{
      if(mode==="login"){
        const member=rows.find(row=>row.username.toLowerCase()===username);
        if(!member||!await previewPasswordMatches(member.password,password)||member.status!=="active")throw new Error("帳號或密碼不正確，或帳號尚未核可");
        onLogin(member.username);return;
      }
      if(mode==="register"){
        if(!/^[a-z0-9][a-z0-9._-]{3,31}$/.test(username))throw new Error("帳號需為 4–32 位英數字，可使用 . _ -");
        if(rows.some(row=>row.username.toLowerCase()===username))throw new Error("這個登入帳號已有人使用");
        if(password.length<6)throw new Error("密碼至少需要 6 個字元");
        if(password!==String(data.get("confirmPassword")||""))throw new Error("兩次密碼不一致");
        rows.push({id:crypto.randomUUID(),username,name:String(data.get("displayName")||"").trim(),email:String(data.get("email")||"").trim()||undefined,role:"member",status:"pending",createdAt:new Date().toISOString(),password:await previewPasswordHash(password)});
        localStorage.setItem(MEMBER_KEY,JSON.stringify(rows));form.reset();setMessage("申請已送出，請等待系統管理員核可。");return;
      }
      const index=rows.findIndex(row=>row.username.toLowerCase()===username);
      if(index>=0){rows[index]={...rows[index],updatedAt:new Date().toISOString(),resetPending:true} as Member;localStorage.setItem(MEMBER_KEY,JSON.stringify(rows));}
      form.reset();setMessage("若帳號存在，重設申請已送出，請聯絡系統管理員確認身分。");
    }catch(reason){setError(reason instanceof Error?reason.message:"操作失敗");}finally{setBusy(false);}
  };
  return <main className="signin-page"><section className="signin-card"><div className="brand-mark" aria-hidden="true">▦</div><p className="eyebrow">PUZZLE ALLIANCE OS</p><h1>拼圖聯盟工作空間</h1><p className="muted">活動、任務、會議與團隊協作，都在同一個地方。</p>
    <div className="auth-tabs" role="tablist" aria-label="帳號操作"><button type="button" role="tab" aria-selected={mode==="login"} onClick={()=>switchMode("login")}>登入</button><button type="button" role="tab" aria-selected={mode==="register"} onClick={()=>switchMode("register")}>註冊帳號</button></div>
    <form className="auth-form" onSubmit={submit}><h2>{mode==="login"?"登入工作空間":mode==="register"?"申請加入":"忘記密碼"}</h2>
      {mode==="register"&&<><label>姓名<input name="displayName" required maxLength={100}/></label></>}
      <label>登入帳號<input name="username" required minLength={4} maxLength={32} pattern="[A-Za-z0-9._-]+" autoComplete="username"/></label>
      {mode==="register"&&<label>Email（選填）<input name="email" type="email" maxLength={254}/></label>}
      {mode!=="forgot"&&<label>密碼<input name="password" type="password" required minLength={6} maxLength={256} autoComplete={mode==="login"?"current-password":"new-password"}/></label>}
      {mode==="register"&&<label>再次輸入密碼<input name="confirmPassword" type="password" required minLength={6} maxLength={256}/></label>}
      {error&&<p className="auth-error" role="alert">{error}</p>}{message&&<p className="auth-success" role="status">{message}</p>}
      <button className="primary wide" disabled={busy}>{busy?"處理中…":mode==="login"?"登入":mode==="register"?"送出申請":"送出重設申請"}</button>
    </form>
    {mode==="login"?<button className="auth-link" type="button" onClick={()=>switchMode("forgot")}>忘記密碼？</button>:<button className="auth-link" type="button" onClick={()=>switchMode("login")}>返回登入</button>}
    <p className="fineprint">GitHub Pages 互動版的帳號與資料只保存在這個瀏覽器。</p>
  </section></main>;
}

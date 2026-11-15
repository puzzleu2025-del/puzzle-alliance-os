"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { previewPasswordHash, previewPasswordMatches } from "../preview/preview-password";

export type Audit = { id: string | number; actor: string; action: string; createdAt: string };
const actions: Record<string,string> = {create_activity:"建立活動",create_task:"建立任務",create_meeting:"安排會議",complete_task:"完成任務",reschedule:"調整排程",confirm_meeting:"確認會議",update_meeting_attendance:"更新出席回覆",read_notice:"確認重要通知",create_registration_form:"建立報名表",update_registration_form:"更新報名表",create_registration_submission:"提交報名資料",update_registration_reconciliation:"更新報名對帳",export_registration_responses:"匯出報名名單",create_member:"新增成員",update_member:"更新成員",update_profile:"更新個人資料",reset_member_password:"重設成員密碼"};

export default function SettingsPanel({preview,version,sync,audit,refresh,onLogout}:{preview:boolean;version:number;sync:string;audit:Audit[];refresh:()=>void;onLogout?:()=>void}) {
  const [matrix,setMatrix]=useState(false);
  return <><div className="page-heading"><div><h2>系統設定</h2><p className="muted">帳號安全、同步機制、角色權限與稽核紀錄</p></div></div><div className="settings-grid">
    <AccountCard preview={preview} onLogout={onLogout}/>
    <RetentionCard preview={preview}/>
    <AnnouncementsCard preview={preview}/>
    <article className="card"><h3>同步機制</h3><p>{preview?"GitHub Pages 互動版會把資料保存在這個瀏覽器。":"共用資料庫每 45 秒或返回視窗時更新。"}</p><p>{sync} · 資料版本 {version}</p>{!preview&&<button onClick={refresh}>立即同步</button>}</article>
    <article className="card"><h3>角色與權限設定</h3><p>成員角色由系統管理員在「成員管理」調整。</p><button aria-expanded={matrix} onClick={()=>setMatrix(!matrix)}>{matrix?"收合權限矩陣":"查看權限矩陣"}</button></article>
    <article className="card"><h3>稽核紀錄</h3><p>查看誰在什麼時間執行了哪些操作。</p><small>{preview?"以下只記錄目前瀏覽器的操作。":"顯示最近 50 筆已儲存操作。"}</small><div className="audit-list">{audit.length?audit.map(a=><div className="row" key={a.id}><div><b>{actions[a.action]||a.action}</b><small>{a.actor}</small><small>{new Date(a.createdAt).toLocaleString("zh-TW",{timeZone:"Asia/Taipei"})}</small></div></div>):<p>尚無操作紀錄</p>}</div></article>
  </div>{matrix&&<section className="card permission-matrix"><h3>角色權限矩陣</h3><div className="table-scroll"><table><thead><tr>{["角色","活動／任務","會議","報名個資","成員","系統設定"].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{[
    ["系統管理員","完整管理","完整管理","查看／匯出","新增／核可／停用","完整"],
    ["總召","查看／協作","建立／確認","查看／匯出","查看","個人資料／密碼"],
    ["幹部／組長","查看指派工作","查看／回覆","無","查看","個人資料／密碼"],
    ["一般成員","查看與更新自己工作","查看／回覆","無","無","個人資料／密碼"]
  ].map(row=><tr key={row[0]}>{row.map((x,i)=><td key={i}>{x}</td>)}</tr>)}</tbody></table></div></section>}</>;
}

function AccountCard({preview,onLogout}:{preview:boolean;onLogout?:()=>void}) {
  const router=useRouter();
  const [account,setAccount]=useState<{username:string;displayName:string;email:string;phone:string;organization:string;position:string;hasPassword:boolean}|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{
    if(preview){
      const username=window.sessionStorage.getItem("puzzle-union-preview-session-v1")||"";
      // Preview sessionStorage is the external account source for this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAccount({username,displayName:"",email:"",phone:"",organization:"",position:"",hasPassword:true});
      return;
    }
    let alive=true;
    fetch("/api/auth/account",{cache:"no-store"}).then(async response=>{const data=await response.json() as {username:string;displayName:string;email:string;phone:string;organization:string;position:string;hasPassword:boolean;error?:string};if(!response.ok)throw new Error(data.error||"無法讀取帳號");if(alive)setAccount(data);}).catch(error=>{if(alive)setMessage(error instanceof Error?error.message:"無法讀取帳號");});
    return ()=>{alive=false;};
  },[preview]);

  const saveProfile = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if(busy)return;
    const form=new FormData(event.currentTarget);
    const profile={displayName:String(form.get("displayName")||"").trim(),email:String(form.get("email")||"").trim(),phone:String(form.get("phone")||"").trim(),organization:String(form.get("organization")||"").trim(),position:String(form.get("position")||"").trim()};
    setBusy(true);setMessage("");
    try{
      if(preview){
        const key="puzzle-union-preview-members-v1",username=window.sessionStorage.getItem("puzzle-union-preview-session-v1");
        const rows=JSON.parse(window.localStorage.getItem(key)||"[]") as Array<Record<string,unknown>>;
        const index=rows.findIndex(row=>row.username===username);
        if(index<0)throw new Error("找不到目前帳號");
        rows[index]={...rows[index],name:profile.displayName,email:profile.email,phone:profile.phone,organization:profile.organization,position:profile.position};
        window.localStorage.setItem(key,JSON.stringify(rows));
      }else{
        const response=await fetch("/api/auth/account",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(profile)});
        const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error||"個人資料未儲存");
      }
      setAccount(current=>current?{...current,...profile}:current);setMessage("個人資料已更新。");router.refresh();
    }catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  const changePassword = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if(busy)return;
    const form=event.currentTarget,data=new FormData(form),current=String(data.get("currentPassword")||""),next=String(data.get("newPassword")||"");
    if(next!==data.get("confirmPassword")){setMessage("兩次新密碼不一致");return;}
    setBusy(true);setMessage("");
    try{
      if(preview){
        const key="puzzle-union-preview-members-v1",username=window.sessionStorage.getItem("puzzle-union-preview-session-v1");
        const rows=JSON.parse(window.localStorage.getItem(key)||"[]") as Array<Record<string,unknown>>;
        const index=rows.findIndex(row=>row.username===username);
        if(index<0||!await previewPasswordMatches(String(rows[index].password||""),current))throw new Error("目前密碼不正確");
        rows[index]={...rows[index],password:await previewPasswordHash(next),updatedAt:new Date().toISOString()};
        window.localStorage.setItem(key,JSON.stringify(rows));
      }else{
        const response=await fetch("/api/auth/account",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:current,newPassword:next})});
        const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error||"密碼未儲存");
      }
      form.reset();setMessage("密碼已更新。");
    }catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  return <article className="card"><h3>我的帳號</h3><p>{account?.displayName||"目前登入帳號"}</p><small>{account?.username?`登入帳號：${account.username}`:"正在讀取帳號…"}</small>
    {account&&<form className="account-form" onSubmit={saveProfile}><b>編輯個人資料</b><label htmlFor="account-name">姓名</label><input id="account-name" name="displayName" defaultValue={account.displayName} required maxLength={100}/><label htmlFor="account-phone">聯絡電話</label><input id="account-phone" name="phone" type="tel" defaultValue={account.phone} maxLength={24}/><label htmlFor="account-email">Email</label><input id="account-email" name="email" type="email" defaultValue={account.email} maxLength={254}/><label htmlFor="account-organization">所屬單位</label><input id="account-organization" name="organization" defaultValue={account.organization} maxLength={100}/><label htmlFor="account-position">職務／身分</label><input id="account-position" name="position" defaultValue={account.position} maxLength={100}/><button className="primary" disabled={busy}>{busy?"儲存中…":"儲存個人資料"}</button></form>}
    {account&&<form className="account-form" onSubmit={changePassword}><b>變更密碼</b><label htmlFor="account-current">目前密碼</label><input id="account-current" name="currentPassword" type="password" autoComplete="current-password" required maxLength={256}/><label htmlFor="account-new">新密碼（至少 6 個字元）</label><input id="account-new" name="newPassword" type="password" autoComplete="new-password" required minLength={6} maxLength={256}/><label htmlFor="account-confirm">再次輸入新密碼</label><input id="account-confirm" name="confirmPassword" type="password" autoComplete="new-password" required minLength={6} maxLength={256}/><button className="primary" disabled={busy}>{busy?"儲存中…":"儲存密碼"}</button></form>}
    <p role="status">{message}</p><button disabled={busy} onClick={async()=>{setBusy(true);if(preview){onLogout?.();return;}try{const response=await fetch("/api/auth/logout",{method:"POST"});if(!response.ok)throw new Error("登出失敗，請重試");router.replace("/");router.refresh();}catch(error){setMessage(error instanceof Error?error.message:"登出失敗");setBusy(false);}}}>登出此裝置</button>
  </article>;
}

type RetentionStatus = {retentionYears:number;minYears:number;maxYears:number;cutoff:string;dueCount:number;archivedCount:number;heldWithoutActivity:number};

// Visible only to system administrators; the API answers 403 for everyone else and the card stays hidden.
function RetentionCard({preview}:{preview:boolean}) {
  const [status,setStatus]=useState<RetentionStatus|null>(null);
  const [years,setYears]=useState("");
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const load=async()=>{
    const response=await fetch("/api/retention",{cache:"no-store"});
    if(!response.ok){setStatus(null);return;}
    const data=await response.json() as RetentionStatus;
    setStatus(data);setYears(String(data.retentionYears));
  };
  useEffect(()=>{
    if(preview)return;
    let alive=true;
    fetch("/api/retention",{cache:"no-store"}).then(async response=>{
      if(!alive||!response.ok)return;
      const data=await response.json() as RetentionStatus;
      if(alive){setStatus(data);setYears(String(data.retentionYears));}
    }).catch(()=>undefined);
    return()=>{alive=false;};
  },[preview]);
  if(preview||!status)return null;

  const saveYears=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(busy)return;
    const value=Number(years);
    if(!Number.isInteger(value)||value<status.minYears||value>status.maxYears){setMessage(`保存年限須為 ${status.minYears} 至 ${status.maxYears} 年`);return;}
    setBusy(true);setMessage("");
    try{
      const response=await fetch("/api/retention",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({retentionYears:value})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw new Error(result.error||"保存年限未儲存");
      await load();setMessage("保存年限已更新。");
    }catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  const archiveDue=async()=>{
    if(busy||status.dueCount===0)return;
    if(!window.confirm(`將封存 ${status.dueCount} 筆最後參加活動日期早於 ${status.cutoff} 的報名資料。封存後只有系統管理員可見，確定執行？`))return;
    setBusy(true);setMessage("");
    try{
      const response=await fetch("/api/retention",{method:"POST",headers:{"Content-Type":"application/json"}});
      const result=await response.json() as {error?:string;archived?:number};
      if(!response.ok)throw new Error(result.error||"封存未完成");
      await load();setMessage(`已封存 ${result.archived??0} 筆報名資料。`);
    }catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  return <article className="card"><h3>資料保存與封存</h3>
    <p>參與者報名資料自最後參加活動日期起保存；屆滿後先移入封存，封存資料僅系統管理員可見，不列入一般名單與匯出。</p>
    <small>目前保存年限：{status.retentionYears} 年；截止日 {status.cutoff} 以前的活動紀錄列為到期。</small>
    <p>待封存 {status.dueCount} 筆 · 已封存 {status.archivedCount} 筆 · 無活動日期待確認 {status.heldWithoutActivity} 筆</p>
    <form className="account-form" onSubmit={saveYears}><label htmlFor="retention-years">保存年限（{status.minYears}–{status.maxYears} 年）</label><input id="retention-years" type="number" min={status.minYears} max={status.maxYears} step={1} value={years} onChange={(event)=>setYears(event.target.value)} required/><button disabled={busy} type="submit">儲存年限</button></form>
    <button disabled={busy||status.dueCount===0} type="button" onClick={()=>void archiveDue()}>檢查並封存到期資料</button>
    <p role="status">{message}</p>
  </article>;
}

type SiteAnnouncement = {id:string;title:string;body:string;published:boolean;updatedAt:string};

// 消息 editor for managers. The public site shows only published items; the API returns 403 to everyone else.
function AnnouncementsCard({preview}:{preview:boolean}) {
  const [items,setItems]=useState<SiteAnnouncement[]|null>(null);
  const [title,setTitle]=useState(""),[body,setBody]=useState(""),[publish,setPublish]=useState(false);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const load=async()=>{
    const response=await fetch("/api/site/announcements",{cache:"no-store"});
    if(!response.ok){setItems(null);return;}
    const data=await response.json() as {announcements:SiteAnnouncement[]};
    setItems(data.announcements);
  };
  useEffect(()=>{
    if(preview)return;
    let alive=true;
    fetch("/api/site/announcements",{cache:"no-store"}).then(async response=>{
      if(!alive||!response.ok)return;
      const data=await response.json() as {announcements:SiteAnnouncement[]};
      if(alive)setItems(data.announcements);
    }).catch(()=>undefined);
    return()=>{alive=false;};
  },[preview]);
  if(preview||items===null)return null;

  const send=async(method:string,payload:Record<string,unknown>)=>{
    const response=await fetch("/api/site/announcements",{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const result=await response.json().catch(()=>({})) as {error?:string};
    if(!response.ok)throw new Error(result.error||"消息未儲存");
    await load();
  };

  const create=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(busy)return;
    setBusy(true);setMessage("");
    try{await send("POST",{title:title.trim(),body:body.trim(),published:publish});setTitle("");setBody("");setPublish(false);setMessage("消息已儲存。");}
    catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  const togglePublish=async(item:SiteAnnouncement)=>{
    if(busy)return;setBusy(true);setMessage("");
    try{await send("PUT",{id:item.id,title:item.title,body:item.body,published:!item.published});}
    catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  const remove=async(item:SiteAnnouncement)=>{
    if(busy||!window.confirm(`確定刪除消息「${item.title}」？刪除後無法復原。`))return;
    setBusy(true);setMessage("");
    try{await send("DELETE",{id:item.id});setMessage("消息已刪除。");}
    catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
  };

  return <article className="card"><h3>前台消息</h3>
    <p>發布後會出現在對外網站的消息區。未發布的消息只有後台可見。</p>
    <form className="account-form" onSubmit={create}>
      <label htmlFor="announcement-title">標題</label>
      <input id="announcement-title" value={title} maxLength={120} onChange={(event)=>setTitle(event.target.value)} required/>
      <label htmlFor="announcement-body">內容</label>
      <textarea id="announcement-body" value={body} maxLength={4000} rows={4} onChange={(event)=>setBody(event.target.value)} required/>
      <label><input type="checkbox" checked={publish} onChange={(event)=>setPublish(event.target.checked)}/> 立即發布到前台</label>
      <button disabled={busy} type="submit">新增消息</button>
    </form>
    {items.length===0?<p className="muted">尚無消息。</p>:<ul className="audit-list">{items.map(item=><li key={item.id}><b>{item.title}</b> <small>{item.published?"已發布":"未發布"}</small><div><button disabled={busy} type="button" onClick={()=>void togglePublish(item)}>{item.published?"取消發布":"發布"}</button> <button disabled={busy} type="button" onClick={()=>void remove(item)}>刪除</button></div></li>)}</ul>}
    <p role="status">{message}</p>
  </article>;
}

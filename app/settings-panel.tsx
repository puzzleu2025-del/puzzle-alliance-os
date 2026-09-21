"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
export type Audit = { id: string | number; actor: string; action: string; createdAt: string };
const actions: Record<string,string> = {create_activity:"建立活動",create_task:"建立任務",create_meeting:"安排會議",complete_task:"完成任務",reschedule:"調整排程",confirm_meeting:"確認會議",update_meeting_attendance:"更新出席回覆",read_notice:"確認重要通知"};
export default function SettingsPanel({preview,version,sync,audit,refresh}:{preview:boolean;version:number;sync:string;audit:Audit[];refresh:()=>void}) {
  const [matrix,setMatrix]=useState(false);
  return <><div className="page-heading"><div><h2>系統設定</h2><p className="muted">登入與安全、同步機制、角色權限與稽核紀錄</p></div></div><div className="settings-grid">
    <AdminAccount preview={preview}/>
    <article className="card"><h3>同步機制</h3><p>{preview?"本頁暫存；重新整理會回復範例，不會跨裝置同步。":"共用資料庫，每 45 秒或返回視窗時更新。"}</p><p>{sync} · 資料版本 {version}</p>{!preview&&<button onClick={refresh}>立即同步</button>}</article>
    <article className="card"><h3>角色與權限設定</h3><p>在管理端查看活動、任務、會議、成員與系統設定的管理範圍。</p><button aria-expanded={matrix} onClick={()=>setMatrix(!matrix)}>{matrix?"收合權限矩陣":"查看權限矩陣"}</button></article>
    <article className="card"><h3>稽核紀錄</h3><p>查看誰在什麼時間執行了哪些操作。</p><small>{preview?"以下只記錄本次預覽操作。":"顯示最近 50 筆已儲存操作。"}</small><div className="audit-list">{audit.length?audit.map(a=><div className="row" key={a.id}><div><b>{actions[a.action]||a.action}</b><small>{a.actor}</small><small>{new Date(a.createdAt).toLocaleString("zh-TW",{timeZone:"Asia/Taipei"})}</small></div></div>):<p>尚無操作紀錄</p>}</div></article>
  </div>{matrix&&<section className="card permission-matrix"><h3>角色權限矩陣（管理端）</h3><p>依 DEMO 保留角色設計。目前只啟用系統管理員，其餘角色尚未開放，無法在此修改。</p><div className="table-scroll"><table><thead><tr>{["角色","活動管理","任務管理","會議","成員","系統設定"].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{[
    ["系統管理員","全部","全部","全部","全部","全部"],
    ["一般管理員（未啟用）","建立／編輯","建立／指派／編輯","建立／確認","一般管理","部分"],
    ["總召（未啟用）","跨活動查看／建立","跨活動查看／介入","建立／確認","查看","無"],
    ["活動總召（未啟用）","指定活動全部","指定活動全部","指定活動","活動成員","無"],
    ["組長（未啟用）","查看","組內建立／指派","查看","組內查看","無"],
    ["組員（未啟用）","查看授權活動","更新自己任務","查看／回覆","無","無"]
  ].map(row=><tr key={row[0]}>{row.map((x,i)=><td key={i}>{x}</td>)}</tr>)}</tbody></table></div></section>}</>;
}

function AdminAccount({preview}:{preview:boolean}) {
  const router=useRouter();
  const [account,setAccount]=useState<{hasPassword:boolean;canInitialize:boolean}|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{
    if(preview)return;
    let alive=true;
    fetch("/api/auth/account",{cache:"no-store"}).then(async response=>{const data=await response.json() as {hasPassword:boolean;canInitialize:boolean;error?:string};if(!response.ok)throw new Error(data.error||"無法讀取帳號");if(alive)setAccount(data);}).catch(error=>{if(alive)setMessage(error instanceof Error?error.message:"無法讀取帳號");});
    return ()=>{alive=false;};
  },[preview]);
  return <article className="card"><h3>系統管理員帳號</h3><p>嘉駿</p><small>目前僅開放一位系統管理員。正式帳密登入需要 API 與 D1 部署。</small>
    {preview?<p>帳號待後端啟用；靜態預覽沒有建立密碼或登入工作階段。</p>:<>
      {account&&<form style={{display:"grid",gap:8,marginTop:16}} onSubmit={async e=>{
        e.preventDefault();if(busy)return;const form=e.currentTarget,data=new FormData(form);
        if(data.get("newPassword")!==data.get("confirmPassword")){setMessage("兩次新密碼不一致");return;}
        setBusy(true);setMessage("");
        try{const response=await fetch("/api/auth/account",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:data.get("currentPassword"),newPassword:data.get("newPassword")})});const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error||"密碼未儲存");setAccount({...account,hasPassword:true});form.reset();setMessage("密碼已更新，其他帳密登入工作階段已登出。");}catch(error){setMessage(error instanceof Error?error.message:"無法連線");}finally{setBusy(false);}
      }}><b>{account.hasPassword?"變更密碼":"初次設定密碼"}</b>
        {account.hasPassword&&<><label htmlFor="admin-current-password">目前密碼</label><input id="admin-current-password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={256}/></>}
        {!account.hasPassword&&!account.canInitialize?<p>請先以 ChatGPT 驗證既有管理員身分，再設定密碼。</p>:<><label htmlFor="admin-new-password">新密碼（至少 12 個字元）</label><input id="admin-new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256}/><label htmlFor="admin-confirm-password">再次輸入新密碼</label><input id="admin-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256}/><button className="primary" disabled={busy}>{busy?"儲存中…":"儲存密碼"}</button></>}
      </form>}
      <p role="status">{message}</p><small>帳密工作階段有效 12 小時。登出會清除本裝置工作階段，並結束 ChatGPT 網站登入；改密碼不會撤銷由 ChatGPT 管理的身分驗證。</small>
      <button style={{marginTop:12}} disabled={busy} onClick={async()=>{setBusy(true);try{const response=await fetch("/api/auth/logout",{method:"POST"});if(!response.ok)throw new Error("登出失敗，請重試");router.replace("/signout-with-chatgpt?return_to=%2F");router.refresh();}catch(error){setMessage(error instanceof Error?error.message:"登出失敗");setBusy(false);}}}>登出此裝置</button>
    </>}
  </article>;
}

import { env } from "cloudflare:workers";
import { cookie, csrfError, getAdmin, passwordHash, randomToken, rateLimited, SESSION_SECONDS, tokenHash, verifyPassword } from "@/app/admin-auth";
export async function GET() {
  const user = await getAdmin();
  if (!user) return Response.json({error:"請先登入管理員帳號"},{status:401});
  const row = await env.DB!.prepare("SELECT user_id FROM admin_credentials WHERE user_id=?").bind(user.userId).first();
  return Response.json({email:user.email,hasPassword:!!row,canInitialize:user.via==="chatgpt"},{headers:{"Cache-Control":"no-store"}});
}
export async function POST(request: Request) {
  const csrf=csrfError(request);if(csrf)return csrf;
  const user=await getAdmin();if(!user)return Response.json({error:"請先登入管理員帳號"},{status:401});
  if(await rateLimited(`password:${user.userId}`))return Response.json({error:"嘗試過多，請 15 分鐘後再試"},{status:429});
  let body:{currentPassword?:unknown;newPassword?:unknown};
  try{body=await request.json();}catch{return Response.json({error:"資料格式錯誤"},{status:400});}
  if(typeof body?.newPassword!=="string"||body.newPassword.length<12||body.newPassword.length>256)return Response.json({error:"新密碼須為 12–256 個字元"},{status:400});
  const old=await env.DB!.prepare("SELECT password_hash,salt FROM admin_credentials WHERE user_id=?").bind(user.userId).first<{password_hash:string;salt:string}>();
  if(old){
    if(typeof body.currentPassword!=="string"||body.currentPassword.length>256||!await verifyPassword(body.currentPassword,old.salt,old.password_hash))return Response.json({error:"目前密碼不正確"},{status:400});
  }else if(user.via!=="chatgpt")return Response.json({error:"首次設定須先以 ChatGPT 驗證管理員身分"},{status:403});
  const salt=randomToken(),hash=await passwordHash(body.newPassword,salt),token=randomToken(),hashedToken=await tokenHash(token);
  // CAS guards every statement, so simultaneous password changes cannot mint stale sessions.
  const guard = old ? "EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=? AND password_hash=?)" : "NOT EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=?)";
  const params = old ? [user.userId,old.password_hash] : [user.userId];
  const results=await env.DB!.batch([
    env.DB!.prepare(`DELETE FROM admin_sessions WHERE user_id=? AND ${guard}`).bind(user.userId,...params),
    env.DB!.prepare(`INSERT INTO admin_sessions (token_hash,user_id,expires_at) SELECT ?,?,? WHERE ${guard}`).bind(hashedToken,user.userId,Date.now()+SESSION_SECONDS*1000,...params),
    old ? env.DB!.prepare("UPDATE admin_credentials SET password_hash=?,salt=?,updated_at=? WHERE user_id=? AND password_hash=?").bind(hash,salt,Date.now(),user.userId,old.password_hash) : env.DB!.prepare("INSERT INTO admin_credentials (user_id,password_hash,salt,updated_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_credentials WHERE user_id=?)").bind(user.userId,hash,salt,Date.now(),user.userId),
  ]);
  if(results[2].meta.changes!==1)return Response.json({error:"帳號已在另一個視窗更新，請重新登入"},{status:409});
  return Response.json({ok:true},{headers:{"Set-Cookie":cookie(token,request),"Cache-Control":"no-store"}});
}

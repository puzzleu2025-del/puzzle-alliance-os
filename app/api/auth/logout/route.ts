import { env } from "cloudflare:workers";
import { cookie, csrfError, currentToken, tokenHash } from "@/app/admin-auth";
export async function POST(request:Request){
  const csrf=csrfError(request);if(csrf)return csrf;
  const token=await currentToken();
  if(token&&env.DB)await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await tokenHash(token)).run();
  return Response.json({ok:true},{headers:{"Set-Cookie":cookie("",request,0),"Cache-Control":"no-store"}});
}

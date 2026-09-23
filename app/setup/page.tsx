import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import Link from "next/link";
import { isSiteOwner } from "@/app/setup-auth";
import SetupForm from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const owner = isSiteOwner(await headers());
  const admin = owner && env.DB ? await env.DB.prepare("SELECT m.user_id, c.user_id AS credential_id FROM members m LEFT JOIN admin_credentials c ON c.user_id=m.user_id WHERE m.role='admin' AND m.status='active' LIMIT 1").first<{user_id:string;credential_id:string|null}>() : null;
  return <main className="signin-page"><section className="signin-card">
    <div className="brand-mark" aria-hidden="true">▦</div>
    <p className="eyebrow">PUZZLE ALLIANCE OS</p>
    <h1>啟用系統管理員</h1>
    {!owner ? <p role="alert">請以站點擁有者身分開啟此頁。</p>
      : !env.DB ? <p role="alert">資料庫尚未就緒，請稍後重試。</p>
      : admin?.credential_id ? <p>管理員帳號已啟用。請返回首頁登入。</p>
      : <SetupForm />}
    <p><Link href="/">返回登入頁</Link></p>
  </section></main>;
}

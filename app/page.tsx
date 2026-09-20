import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import Workspace from "./workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) {
    return (
      <main className="signin-page">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">▦</div>
          <p className="eyebrow">PUZZLE ALLIANCE OS</p>
          <h1>拼圖聯盟工作空間</h1>
          <p className="muted">活動、任務、會議與團隊協作，都在同一個地方。</p>
          <a className="button primary wide" href={chatGPTSignInPath("/")} target="_top">以 ChatGPT 帳號登入</a>
          <p className="fineprint">第一位登入者會成為唯一的系統管理員。</p>
        </section>
      </main>
    );
  }
  return <Workspace user={{ id: user.userId, email: user.email, name: user.displayName }} />;
}

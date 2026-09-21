import { getAdmin } from "./admin-auth";
import LoginForm from "./login-form";
import Workspace from "./workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getAdmin();
  if (!user) {
    return (
      <main className="signin-page">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">▦</div>
          <p className="eyebrow">PUZZLE ALLIANCE OS</p>
          <h1>拼圖聯盟工作空間</h1>
          <p className="muted">活動、任務、會議與團隊協作，都在同一個地方。</p>
          <LoginForm />
        </section>
      </main>
    );
  }
  return <Workspace user={{ id: user.userId, email: user.email, name: user.displayName }} />;
}

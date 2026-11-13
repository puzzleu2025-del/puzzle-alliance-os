export default function ParticipantPage() {
  return <main className="signin-page"><section className="signin-card">
    <h1>參與者服務</h1>
    <form method="post" action="/api/participant/auth/start">
      <button type="submit">使用 Google 登入</button>
    </form>
    <p><a href="/participant/my">查看我的報名與 QR</a></p>
  </section></main>;
}

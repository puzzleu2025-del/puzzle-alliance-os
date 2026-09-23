export async function POST() {
  return Response.json({ error: "請直接從登入頁登入管理員帳號" }, { status: 410, headers: { "Cache-Control": "no-store" } });
}

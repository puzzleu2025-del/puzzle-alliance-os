export const dynamic = "force-dynamic";

// Public callback is disabled until the complete consent flow is ready.
export async function GET(): Promise<Response> {
  return Response.json({ error: "登入目前無法使用" }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

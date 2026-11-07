export const dynamic = "force-dynamic";

// The callback and current-consent flow are not yet available.
export async function POST(): Promise<Response> {
  return Response.json({ error: "登入目前無法使用" }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  return Response.json({ error: "目前無法使用，請稍後再試" }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" },
  });
}

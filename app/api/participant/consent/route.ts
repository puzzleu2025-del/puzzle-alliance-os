export const dynamic = "force-dynamic";

async function disabled(): Promise<Response> {
  return Response.json({ error: "目前無法使用，請稍後再試" }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export const GET = disabled;
export const POST = disabled;

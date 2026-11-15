import { env } from "cloudflare:workers";
import { currentToken, tokenHash } from "@/app/admin-auth";
import { watchWorkspace, workspaceWatchIntervalMs, type WatchSnapshot } from "@/app/workspace-watch";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };

// Reads the caller's session and role plus the workspace version in one statement.
async function readSnapshot(sessionHash: string): Promise<WatchSnapshot> {
  const row = await env.DB!.prepare("SELECT m.role AS role,(SELECT version FROM workspace_states WHERE id=1) AS version FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND m.status='active'")
    .bind(sessionHash, Date.now())
    .first<{ role: string; version: number | null }>();
  return row ? { role: row.role, version: row.version ?? 0 } : null;
}

export async function GET(request: Request) {
  if (!env.DB) return Response.json({ error: "資料庫尚未連線" }, { status: 503, headers: noStore });
  const token = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(token)) return Response.json({ error: "請先登入已核可帳號" }, { status: 401, headers: noStore });
  const hash = await tokenHash(token);
  // The baseline is read before headers are sent, so the client's load after `open` cannot miss a later write.
  const baseline = await readSnapshot(hash);
  if (!baseline) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  const stream = watchWorkspace(() => readSnapshot(hash), { baseline, intervalMs: workspaceWatchIntervalMs, signal: request.signal });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

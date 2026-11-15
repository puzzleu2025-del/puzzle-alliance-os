// Server-sent change signal for the workspace. It carries no workspace data:
// clients reload through GET /api/workspace, which enforces session and role again.
export type WatchSnapshot = { role: string; version: number } | null;

export const workspaceWatchIntervalMs = 5000;

function signature(snapshot: WatchSnapshot) {
  return snapshot ? `${snapshot.role}\u0000${snapshot.version}` : "";
}

export function watchWorkspace(
  read: () => Promise<WatchSnapshot>,
  { baseline, intervalMs, signal }: { baseline: WatchSnapshot; intervalMs: number; signal?: AbortSignal },
) {
  const encoder = new TextEncoder();
  let last = signature(baseline);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const send = (event: string, data: object) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    try { controller.close(); } catch {}
  };
  const tick = async () => {
    if (stopped) return;
    try {
      const snapshot = await read();
      if (stopped) return;
      // Session expiry, deactivation or sign-out ends the stream; the client locks its private data.
      if (!snapshot) { send("revoked", {}); stop(); return; }
      const next = signature(snapshot);
      if (next !== last) { last = next; send("changed", { version: snapshot.version }); }
      timer = setTimeout(tick, intervalMs);
    } catch {
      // The client treats a dropped stream as unsafe, locks private data, and reconnects.
      stop();
    }
  };
  signal?.addEventListener("abort", stop);
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal?.aborted) stop(); else timer = setTimeout(tick, intervalMs);
    },
    cancel() { stop(); },
  });
}

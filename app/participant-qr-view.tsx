"use client";

import { useEffect, useState } from "react";
import { participantQrModules } from "./participant-qr-image";

export default function ParticipantQrView({ submissionId, identity }: { submissionId: string; identity: "member" | "participant" }) {
  const [modules, setModules] = useState<boolean[][] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setModules(null); setError("");
    fetch("/api/participant/qr", { method: "POST", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Participant-Identity": identity },
      body: JSON.stringify({ submissionId }) })
      .then(async response => {
        if (!response.ok) throw new Error();
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || !("token" in data)) throw new Error();
        const next = participantQrModules(data.token);
        if (!controller.signal.aborted) setModules(next);
      })
      .catch(() => { if (!controller.signal.aborted) setError("目前無法顯示 QR，請稍後重試或聯絡工作人員。"); });
    return () => controller.abort();
  }, [submissionId, identity, attempt]);

  if (error) return <div><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重試顯示 QR</button></div>;
  if (!modules) return <p role="status">正在準備 QR…</p>;
  const size = modules.length + 8;
  return <svg role="img" aria-label="個人簽到 QR 碼" viewBox={`0 0 ${size} ${size}`} width="246" height="246" shapeRendering="crispEdges" style={{ maxWidth: "100%", height: "auto" }}>
    <rect width={size} height={size} fill="#fff" />
    {modules.map((row, y) => row.map((dark, x) => dark && <rect key={`${x}-${y}`} x={x + 4} y={y + 4} width="1" height="1" fill="#000" />))}
  </svg>;
}

"use client";

import { useEffect, useState } from "react";
import type { State } from "../app/workspace";
import PreviewAuth from "./preview-auth";

const liveUrl = "https://puzzle-alliance-os.gaoj3152.chatgpt.site/";
const legacyKey = "puzzle-alliance-preview-registrations-v1";

export default function SharedEntry({ initialState }: { initialState: State }) {
  const [hasOldData] = useState(() => {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) return false;
      const data = JSON.parse(raw) as Partial<State>;
      return [data.activities, data.tasks, data.meetings, data.notices, data.registrationForms, data.registrationSubmissions]
        .some((rows) => Array.isArray(rows) && rows.length > 0);
    } catch { return true; }
  });
  const [showOld, setShowOld] = useState(false);
  const oldRegistrationLink = new URLSearchParams(window.location.search).has("register");

  useEffect(() => {
    if (!hasOldData && !oldRegistrationLink) window.location.replace(liveUrl);
  }, [hasOldData, oldRegistrationLink]);

  const exportOld = () => {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return;
    const blob = new Blob([raw], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href; anchor.download = `puzzle-alliance-old-data-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  if (showOld) return <PreviewAuth initialState={initialState} />;
  return <main className="signin-page"><section className="signin-card">
    <div className="brand-mark" aria-hidden="true">▦</div>
    <p className="eyebrow">PUZZLE ALLIANCE OS</p>
    <h1>前往共用工作空間</h1>
    <p className="muted">新版使用共用資料庫。登入後，活動、任務與會議會在不同裝置讀取同一份資料。</p>
    {oldRegistrationLink && <p role="alert">這是舊版報名連結，資料無法跨裝置同步。請向主辦方索取新版報名連結。</p>}
    {hasOldData && <><p role="note">這個瀏覽器有舊版資料，請先匯出備份；舊資料不會自動出現在共用版。</p>
      <button type="button" className="secondary wide" onClick={exportOld}>匯出這台裝置的舊資料</button>
      <button type="button" className="auth-link" onClick={() => setShowOld(true)}>開啟舊版資料</button></>}
    <a className="button primary wide" href={liveUrl}>開啟共用版</a>
  </section></main>;
}

"use client";

import { useEffect, useRef, useState } from "react";
import RegistrationPublic from "@/app/registration-public";
import type { RegistrationForm, RegistrationSubmission } from "@/app/registration-types";

type Identity = "member" | "participant";
type Loaded = { form: RegistrationForm; activityName: string; version: number; values: Record<string, string> };

export default function RegistrationClient({ slug }: { slug: string }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  if (!/^[a-f0-9]{32}$/.test(slug)) return <main className="signin-page"><p role="alert">報名連結無效。</p></main>;
  if (!identity) return <main className="signin-page"><section className="signin-card"><h1>選擇報名身分</h1><p>請選擇已登入的帳號身分。</p><button type="button" onClick={() => setIdentity("member")}>會員</button><button type="button" onClick={() => setIdentity("participant")}>參與者</button></section></main>;
  return <RegistrationFlow key={`${slug}:${identity}`} slug={slug} identity={identity} onBack={() => setIdentity(null)} />;
}

function RegistrationFlow({ slug, identity, onBack }: { slug: string; identity: Identity; onBack: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [completed, setCompleted] = useState(false);
  const retry = useRef<string | null>(null);
  const done = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [formResponse, prefillResponse] = await Promise.all([
          fetch(`/api/public/registrations/${encodeURIComponent(slug)}`, { cache: "no-store", signal: controller.signal }),
          fetch("/api/participant/prefill", { method: "POST", headers: { "Content-Type": "application/json", "X-Participant-Identity": identity }, body: JSON.stringify({ slug }), cache: "no-store", signal: controller.signal }),
        ]);
        if (!formResponse.ok || !prefillResponse.ok) throw new Error("目前無法載入報名資料，請確認已使用所選身分登入並稍後再試。");
        const publicData = await formResponse.json() as { form?: RegistrationForm; activity?: { name?: string }; formVersion?: number };
        const prefill = await prefillResponse.json() as { formVersion?: number; values?: Record<string, string> };
        if (!publicData.form || typeof publicData.activity?.name !== "string" || !Number.isSafeInteger(publicData.formVersion) || !prefill.values || typeof prefill.values !== "object" || Array.isArray(prefill.values)) throw new Error("報名資料無法使用，請稍後再試。");
        if (publicData.formVersion !== prefill.formVersion) throw new Error("報名表已更新，請重新整理後再填寫。");
        if (!controller.signal.aborted) setLoaded({ form: publicData.form, activityName: publicData.activity.name, version: publicData.formVersion!, values: prefill.values });
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "目前無法載入報名資料，請稍後再試。");
      }
    }
    void load();
    return () => controller.abort();
  }, [slug, identity]);

  async function send(body: string, wasUncertain: boolean): Promise<boolean> {
    if (done.current || pending.current) return false;
    pending.current = true;
    setRetrying(true);
    setError("");
    try {
      const response = await fetch("/api/participant/registrations", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Participant-Identity": identity },
        body,
      });
      if (!response.ok) {
        if (wasUncertain || response.status >= 500) {
          setUncertain(true);
          setError(response.status === 409 ? "原報名結果仍無法確認，請保留此頁，勿重新整理或關閉；請聯絡活動工作人員查詢。" : "無法確認原報名結果，請保留此頁，勿重新整理或關閉；請重試原內容，若仍無法確認請聯絡活動工作人員。");
        } else {
          retry.current = null;
          setError(response.status === 409 ? "報名狀態或表單可能已變更，請聯絡活動工作人員確認是否已報名，再重新整理。" : response.status === 401 ? "登入已失效，請重新登入。" : "目前無法送出，請檢查資料後再試。");
        }
        return false;
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || typeof (data as { receiptId?: unknown }).receiptId !== "string" || !(data as { receiptId: string }).receiptId) throw new Error();
      done.current = true;
      setCompleted(true);
      return true;
    } catch {
      setUncertain(true);
      setError("無法確認原報名結果，請保留此頁，勿重新整理或關閉；請重試原內容，若仍無法確認請聯絡活動工作人員。");
      return false;
    } finally { pending.current = false; setRetrying(false); }
  }

  async function submit(submission: RegistrationSubmission): Promise<boolean> {
    if (!loaded || uncertain || done.current || pending.current) return false;
    const body = JSON.stringify({ slug, answers: submission.answers, consent: submission.consent, idempotencyKey: crypto.randomUUID(), formVersion: loaded.version });
    retry.current = body;
    return send(body, false);
  }

  if (!loaded) return <main className="signin-page"><section className="signin-card">{error ? <><p role="alert">{error}</p><button type="button" onClick={onBack}>返回選擇身分</button></> : <p>正在載入報名資料…</p>}</section></main>;
  if (completed) return <main className="signin-page"><section className="signin-card"><p role="status">報名已送出</p><h1>{loaded.form.title}</h1><p>{loaded.form.confirmationMessage || "我們已收到你的資料，後續資訊將由活動團隊通知。"}</p></section></main>;
  return <>{error && <p role="alert">{error}</p>}{uncertain && <button type="button" disabled={retrying} onClick={() => { if (retry.current) void send(retry.current, true); }}>{retrying ? "確認中…" : "重試原報名內容"}</button>}<fieldset disabled={uncertain} style={{ border: 0, padding: 0, margin: 0 }}><RegistrationPublic form={loaded.form} activityName={loaded.activityName} initialValues={loaded.values} onSubmit={submit} /></fieldset></>;
}

"use client";

import { useEffect, useState } from "react";
import RegistrationPublic from "@/app/registration-public";
import type { RegistrationForm, RegistrationSubmission } from "@/app/registration-types";

export default function RegistrationClient({ slug }: { slug: string }) {
  const [payload, setPayload] = useState<{form:RegistrationForm;activity:{name:string};feeAmount:number;feeRevision:number} | null>(null);
  const [error, setError] = useState("");
  const [submitError, setSubmitError] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(`/api/public/registrations/${encodeURIComponent(slug)}`, { cache:"no-store" }).then(async (response) => {
      const body = await response.json() as {form?:RegistrationForm;activity?:{name:string};feeAmount?:number;feeRevision?:number;error?:string};
      if (!response.ok || !body.form || !body.activity || !Number.isSafeInteger(body.feeAmount) || !Number.isSafeInteger(body.feeRevision)) throw new Error(body.error || "找不到報名表");
      if (alive) setPayload({ form:body.form, activity:body.activity, feeAmount:body.feeAmount!, feeRevision:body.feeRevision! });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "無法載入報名表"); });
    return () => { alive = false; };
  }, [slug]);
  if (error) return <main className="signin-page"><section className="signin-card"><h1>目前無法報名</h1><p className="muted">{error}</p></section></main>;
  if (!payload) return <main className="signin-page"><section className="signin-card"><p>正在載入報名表…</p></section></main>;
  return <>{submitError && <p role="alert">{submitError}</p>}<RegistrationPublic form={payload.form} activityName={payload.activity.name} feeAmount={payload.feeAmount} onSubmit={async (submission:RegistrationSubmission) => {
    const response = await fetch(`/api/public/registrations/${encodeURIComponent(slug)}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({answers:submission.answers,consent:submission.consent,idempotencyKey:submission.id,feeRevision:payload.feeRevision,website:""}) });
    if (response.status === 409) setSubmitError("報名費或表單已變更，請重新載入並確認。");
    return response.ok;
  }} /></>;
}

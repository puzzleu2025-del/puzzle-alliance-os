"use client";

import { useEffect, useState } from "react";
import RegistrationPublic from "@/app/registration-public";
import type { RegistrationForm, RegistrationSubmission } from "@/app/registration-types";

export default function RegistrationClient({ slug }: { slug: string }) {
  const [payload, setPayload] = useState<{form:RegistrationForm;activity:{name:string}} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(`/api/public/registrations/${encodeURIComponent(slug)}`, { cache:"no-store" }).then(async (response) => {
      const body = await response.json() as {form?:RegistrationForm;activity?:{name:string};error?:string};
      if (!response.ok || !body.form || !body.activity) throw new Error(body.error || "找不到報名表");
      if (alive) setPayload({ form:body.form, activity:body.activity });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "無法載入報名表"); });
    return () => { alive = false; };
  }, [slug]);
  if (error) return <main className="signin-page"><section className="signin-card"><h1>目前無法報名</h1><p className="muted">{error}</p></section></main>;
  if (!payload) return <main className="signin-page"><section className="signin-card"><p>正在載入報名表…</p></section></main>;
  return <RegistrationPublic form={payload.form} activityName={payload.activity.name} onSubmit={async (submission:RegistrationSubmission) => {
    const response = await fetch(`/api/public/registrations/${encodeURIComponent(slug)}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({answers:submission.answers,consent:submission.consent,idempotencyKey:submission.id,website:""}) });
    return response.ok;
  }} />;
}

"use client";

import { FormEvent, useId, useState } from "react";
import {
  RegistrationAnswer,
  RegistrationField,
  RegistrationForm,
  RegistrationSubmission,
  validateRegistrationSubmission,
} from "./registration-types";

export type RegistrationPublicProps = {
  form: RegistrationForm;
  activityName: string;
  onSubmit: (submission: RegistrationSubmission) => Promise<boolean>;
};

const shellStyle = { maxWidth: 720, margin: "0 auto", padding: "24px 16px" } as const;
const cardStyle = { background: "#fff", border: "1px solid #e4e8f0", borderRadius: 18, padding: 24 } as const;
const gridStyle = { display: "grid", gap: 18, marginTop: 24 } as const;
const labelStyle = { display: "grid", gap: 7, fontWeight: 700 } as const;
const controlStyle = { width: "100%", minHeight: 46, padding: "10px 12px", border: "1px solid #d8dde7", borderRadius: 10, font: "inherit" } as const;
const helpStyle = { color: "#70798b", fontSize: ".84rem", fontWeight: 400 } as const;
const errorStyle = { color: "#a32f2f", fontSize: ".84rem", fontWeight: 600 } as const;

function initialAnswers(form: RegistrationForm) {
  return Object.fromEntries(
    form.fields.map((field) => [
      field.id,
      field.type === "multiple_choice" || (field.type === "checkbox" && field.options?.length)
        ? []
        : field.type === "checkbox"
          ? false
          : "",
    ]),
  ) as Record<string, RegistrationAnswer>;
}

function FieldControl({
  field,
  value,
  error,
  disabled,
  setValue,
}: {
  field: RegistrationField;
  value: RegistrationAnswer;
  error?: string;
  disabled: boolean;
  setValue: (value: RegistrationAnswer) => void;
}) {
  const generatedId = useId();
  const id = `registration-${field.id}-${generatedId}`;
  const describedBy = [field.helpText ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const shared = { id, name: field.id, disabled, required: field.required, "aria-invalid": Boolean(error), "aria-describedby": describedBy };
  let control;
  if (field.type === "long_text" || field.type === "textarea") {
    control = <textarea {...shared} value={String(value ?? "")} placeholder={field.placeholder} maxLength={field.maxLength ?? 10_000} rows={5} style={{ ...controlStyle, resize: "vertical" }} onChange={(event) => setValue(event.target.value)} />;
  } else if (field.type === "select") {
    control = <select {...shared} value={String(value ?? "")} style={controlStyle} onChange={(event) => setValue(event.target.value)}><option value="">請選擇</option>{field.options?.map((option) => <option value={option} key={option}>{option}</option>)}</select>;
  } else if (["single_choice", "radio"].includes(field.type)) {
    control = <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy} style={{ display: "grid", gap: 8 }}>{field.options?.map((option) => <label key={option} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}><input type="radio" name={field.id} disabled={disabled} checked={value === option} onChange={() => setValue(option)} />{option}</label>)}</div>;
  } else if (field.type === "multiple_choice" || (field.type === "checkbox" && Boolean(field.options?.length))) {
    const selected = Array.isArray(value) ? value : [];
    control = <div style={{ display: "grid", gap: 8 }}>{field.options?.map((option) => <label key={option} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}><input type="checkbox" disabled={disabled} checked={selected.includes(option)} onChange={(event) => setValue(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))} />{option}</label>)}</div>;
  } else if (field.type === "checkbox") {
    control = <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}><input {...shared} type="checkbox" checked={value === true} onChange={(event) => setValue(event.target.checked)} />我已閱讀並同意</label>;
  } else {
    const type = field.type === "email" ? "email" : field.type === "phone" || field.type === "tel" ? "tel" : field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
    control = <input {...shared} type={type} value={value === null ? "" : String(value ?? "")} placeholder={field.placeholder} min={field.min} max={field.max} maxLength={type === "number" ? undefined : field.maxLength ?? 10_000} style={controlStyle} onChange={(event) => setValue(event.target.value)} />;
  }
  const grouped = ["single_choice", "radio", "multiple_choice", "checkbox"].includes(field.type);
  const heading = <span id={`${id}-label`}>{field.label}{field.required && <span aria-hidden="true" style={{ color: "#b42318" }}> *</span>}</span>;
  const content = <>{heading}{field.helpText && <small id={`${id}-help`} style={helpStyle}>{field.helpText}</small>}{control}{error && <span id={`${id}-error`} role="alert" style={errorStyle}>{error}</span>}</>;
  return grouped ? <div style={labelStyle}>{content}</div> : <label style={labelStyle} htmlFor={id}>{content}</label>;
}

export default function RegistrationPublic({ form, activityName, onSubmit }: RegistrationPublicProps) {
  const [answers, setAnswers] = useState<Record<string, RegistrationAnswer>>(() => initialAnswers(form));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [complete, setComplete] = useState(false);
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || form.status !== "open") return;
    const validation = validateRegistrationSubmission(form, answers);
    setErrors(validation.fieldErrors);
    setConsentError(!consent);
    if (!validation.ok || !consent) {
      const first = form.fields.find((field) => validation.fieldErrors[field.id]);
      if (first) document.querySelector<HTMLElement>(`[name="${CSS.escape(first.id)}"]`)?.focus();
      else document.querySelector<HTMLElement>("#registration-privacy-consent")?.focus();
      return;
    }
    setBusy(true);
    setFailed(false);
    let saved = false;
    try {
      saved = await onSubmit({
        id: crypto.randomUUID(),
        formId: form.id,
        activityId: form.activityId,
        answers: validation.answers,
        consent: true,
        status: "submitted",
        submittedAt: new Date().toISOString(),
      });
    } catch {
      saved = false;
    }
    setBusy(false);
    if (saved) {
      setComplete(true);
      setAnswers(initialAnswers(form));
      setErrors({});
      setConsent(false);
      setConsentError(false);
    } else {
      setFailed(true);
    }
  };

  if (complete) {
    return <main style={shellStyle}><section style={cardStyle} aria-live="polite"><p style={{ color: "#5b6ee1", fontWeight: 800 }}>報名已送出</p><h1 style={{ margin: "8px 0" }}>{form.title}</h1><p>{form.confirmationMessage || "我們已收到你的資料，後續資訊將由活動團隊通知。"}</p></section></main>;
  }

  const unavailable = form.status !== "open";
  return <main style={shellStyle}><section style={cardStyle}><header><p style={{ color: "#5b6ee1", fontWeight: 800, letterSpacing: ".08em", margin: 0 }}>{activityName}</p><h1 style={{ margin: "6px 0 8px" }}>{form.title}</h1>{form.description && <p style={{ color: "#596275", whiteSpace: "pre-wrap" }}>{form.description}</p>}</header>{unavailable ? <p role="status" style={{ marginTop: 24, padding: 14, background: "#f5f7fb", borderRadius: 10 }}>{form.status === "closed" ? "此表單已停止收件。" : "此表單尚未開放。"}</p> : <form onSubmit={submit} noValidate><div style={gridStyle}>{form.fields.map((field) => <FieldControl key={field.id} field={field} value={answers[field.id]} error={errors[field.id]} disabled={busy} setValue={(value) => { setAnswers((current) => ({ ...current, [field.id]: value })); setErrors((current) => { const next = { ...current }; delete next[field.id]; return next; }); }} />)}</div><section style={{ marginTop: 22, padding: 14, background: "#f5f7fb", borderRadius: 10 }}><b>個人資料與隱私告知</b><p style={{ color: "#596275", whiteSpace: "pre-wrap" }}>{form.privacyNotice || "你提供的資料只用於本次活動報名、聯絡與行政作業。"}</p><label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><input id="registration-privacy-consent" type="checkbox" checked={consent} disabled={busy} aria-invalid={consentError} aria-describedby={consentError ? "registration-consent-error" : undefined} onChange={(event) => { setConsent(event.target.checked); setConsentError(false); }} />我已閱讀並同意上述告知</label>{consentError && <span id="registration-consent-error" role="alert" style={errorStyle}>必須同意隱私告知才能送出</span>}</section>{failed && <p role="alert" style={{ marginTop: 18, color: "#a32f2f" }}>送出失敗，填寫內容已保留，請稍後再試。</p>}<button type="submit" disabled={busy} style={{ width: "100%", minHeight: 48, marginTop: 24, border: 0, borderRadius: 11, background: "#5b6ee1", color: "#fff", font: "inherit", fontWeight: 800, cursor: busy ? "wait" : "pointer" }}>{busy ? "送出中…" : form.submitLabel || "送出報名"}</button></form>}</section></main>;
}

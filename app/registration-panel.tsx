"use client";

import { FormEvent, useEffect, useState } from "react";
import type { ManagementPanelProps, State } from "./management-panels";
import type { RegistrationField, RegistrationFieldType, RegistrationForm, RegistrationPaymentStatus, RegistrationSubmission } from "./registration-types";
import { downloadRegistrationXlsx } from "./export-registrations";
import { registrationReminderSchedule, reminderMessage, reminderRecipients, type ReminderKind } from "./registration-reminders";
import RegistrationBuilder from "./registration-builder";
import "./registration-panel.css";

const uid = () => crypto.randomUUID();
const initialFields = (): RegistrationField[] => [
  { id: uid(), label: "姓名", type: "short_text", required: true, sensitive: true },
  { id: uid(), label: "電子郵件", type: "email", required: true, sensitive: true, options: [] },
  { id: uid(), label: "聯絡電話", type: "phone", required: false, sensitive: true },
];
const optionType = (type: RegistrationFieldType) => ["single_choice", "multiple_choice", "select", "radio"].includes(type);
const mask = (value: string) => value ? `${value.slice(0, 1)}${"•".repeat(Math.min(8, Math.max(3, value.length - 1)))}` : "—";
const paymentLabels: Record<RegistrationPaymentStatus, string> = { unpaid:"未對帳", checking:"待確認", paid:"已對帳", refunded:"已退款", not_required:"無需付款" };

export default function RegistrationPanel({ data, busy, onSave, preview, initialActivityId }: ManagementPanelProps & { preview: boolean; initialActivityId?: string }) {
  const [activityId, setActivityId] = useState(initialActivityId ?? data.activities[0]?.id ?? "");
  const [remoteForms, setRemoteForms] = useState<RegistrationForm[]>([]);
  const [remoteSubmissions, setRemoteSubmissions] = useState<RegistrationSubmission[]>([]);
  const [loading, setLoading] = useState(!preview && Boolean(initialActivityId ?? data.activities[0]?.id));
  const forms = preview ? (data.registrationForms ?? []) : remoteForms;
  const submissions = preview ? (data.registrationSubmissions ?? []) : remoteSubmissions;
  const activity = data.activities.find((row) => row.id === activityId);
  const activityForms = forms.filter((form) => form.activityId === activityId);
  const [selectedId, setSelectedId] = useState("");
  const selected = activityForms.find((form) => form.id === selectedId) ?? activityForms[0];
  const selectedSubmissions = selected ? submissions.filter((row) => row.formId === selected.id) : [];
  const [editor, setEditor] = useState<RegistrationForm | null>(null);
  const [fields, setFields] = useState<RegistrationField[]>([]);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [reconciliationBusy, setReconciliationBusy] = useState("");
  const reminderSchedule = activity ? registrationReminderSchedule(activity.date) : { five_days:"", one_day:"" };
  const reminderRows = selected ? reminderRecipients(selected, selectedSubmissions) : [];

  useEffect(() => {
    if (preview || !activityId) return;
    let alive = true;
    fetch(`/api/registration-forms?activityId=${encodeURIComponent(activityId)}`, { cache:"no-store" }).then(async (response) => {
      const body = await response.json() as {forms?:RegistrationForm[];submissions?:NonNullable<State["registrationSubmissions"]>;error?:string};
      if (!response.ok) throw new Error(body.error || "無法載入報名表");
      if (alive) { setRemoteForms(body.forms ?? []); setRemoteSubmissions(body.submissions ?? []); setSelectedId(""); setFeedback(""); }
    }).catch((reason) => { if (alive) setFeedback(reason instanceof Error ? reason.message : "無法載入報名表"); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activityId, preview]);

  const publicUrl = (() => {
    if (!selected || typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    url.search = ""; url.hash = "";
    if (preview) url.searchParams.set("register", selected.id);
    else url.pathname = `/r/${selected.slug ?? ""}`;
    return url.toString();
  })();

  const openEditor = (form?: RegistrationForm) => {
    const now = new Date().toISOString();
    const next = form ? structuredClone(form) : {
      id: uid(), activityId, title: `${activity?.name ?? "活動"}報名表`, description: "",
      status: "draft" as const, fields: initialFields(), privacyNotice: "填寫資料僅供本活動報名、聯繫與執行使用，由總召以上權限人員管理。",
      createdAt: now, updatedAt: now,
    };
    setEditor(next); setFields(next.fields); setFeedback("");
  };

  const saveForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving || busy) return;
    if (!fields.length || fields.some((row) => !row.label.trim() || (optionType(row.type) && !(row.options ?? []).length))) {
      setFeedback("每個問題都需要標題；選擇題至少要有一個選項。"); return;
    }
    const formData = new FormData(event.currentTarget);
    const nextForm: RegistrationForm = {
      ...editor,
      activityId,
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      privacyNotice: String(formData.get("privacyNotice") ?? "").trim(),
      status: String(formData.get("status") ?? "draft") as RegistrationForm["status"],
      fields: fields.map((row) => ({ ...row, label: row.label.trim(), options: (row.options ?? []).map((value) => value.trim()).filter(Boolean) })),
      updatedAt: new Date().toISOString(),
    };
    const exists = forms.some((row) => row.id === nextForm.id);
    setSaving(true); setFeedback("");
    let saved = false;
    let failureMessage = "";
    let savedForm = nextForm;
    if (preview) {
      const next: State = { ...data, registrationForms: exists ? forms.map((row) => row.id === nextForm.id ? nextForm : row) : [...forms, nextForm], registrationSubmissions: submissions };
      saved = await onSave(next, exists ? "update_registration_form" : "create_registration_form");
    } else {
      try {
        const response = await fetch("/api/registration-forms", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({form:nextForm}) });
        const body = await response.json() as {form?:RegistrationForm;error?:string};
        if (!response.ok || !body.form) throw new Error(body.error || "報名表尚未儲存");
        saved = true; savedForm = body.form;
        setRemoteForms([body.form]);
      } catch (reason) { failureMessage = reason instanceof Error ? reason.message : "報名表尚未儲存"; }
    }
    setSaving(false);
    if (saved) { setSelectedId(savedForm.id); setEditor(null); setFeedback("報名表已儲存。"); }
    else setFeedback(failureMessage || "報名表尚未儲存，請重試。");
  };

  const exportResponses = async () => {
    if (!selected || !activity) return;
    if (!preview) {
      try {
        const response = await fetch("/api/registration-forms", { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ formId:selected.id }) });
        const body = await response.json() as {error?:string};
        if (!response.ok) throw new Error(body.error || "無法記錄匯出操作");
      } catch (reason) {
        setFeedback(reason instanceof Error ? reason.message : "無法記錄匯出操作");
        return;
      }
    }
    downloadRegistrationXlsx(selected, selectedSubmissions, activity.name);
    setFeedback(`已匯出 ${selectedSubmissions.length} 筆報名資料。`);
  };

  const updateReconciliation = async (submission: RegistrationSubmission, patch: {paymentStatus?:RegistrationPaymentStatus;paymentNote?:string}) => {
    if (!selected || reconciliationBusy) return;
    const nextSubmission = { ...submission, ...patch };
    setReconciliationBusy(submission.id);
    if (preview) {
      const nextRows = submissions.map((row) => row.id === submission.id ? nextSubmission : row);
      const saved = await onSave({ ...data, registrationForms: forms, registrationSubmissions: nextRows }, "update_registration_reconciliation");
      if (!saved) setFeedback("對帳註記尚未儲存，請重試。");
    } else {
      try {
        const response = await fetch("/api/registration-forms", { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ formId:selected.id, submissionId:submission.id, paymentStatus:nextSubmission.paymentStatus ?? "unpaid", paymentNote:nextSubmission.paymentNote ?? "" }) });
        const body = await response.json() as {error?:string};
        if (!response.ok) throw new Error(body.error || "對帳註記尚未儲存");
        setRemoteSubmissions((rows) => rows.map((row) => row.id === submission.id ? nextSubmission : row));
      } catch (reason) { setFeedback(reason instanceof Error ? reason.message : "對帳註記尚未儲存"); }
    }
    setReconciliationBusy("");
  };

  const prepareReminder = async (kind: ReminderKind) => {
    if (!selected || !activity || !reminderRows.length) return;
    const subject = `${activity.name}｜活動前${kind === "five_days" ? "5 天" : "1 天"}提醒`;
    const messages = reminderRows.map(({ submission, email }) => `${email}\n${reminderMessage(kind, activity.name, activity.date, selected, submission)}`).join("\n\n");
    try { await navigator.clipboard.writeText(`主旨：${subject}\n\n${messages}`); setFeedback(`已複製 ${reminderRows.length} 位參加者的通知內容。`); }
    catch { setFeedback("無法自動複製，請確認瀏覽器的剪貼簿權限。"); }
  };

  const copyLink = async () => {
    if (!publicUrl) return;
    try { await navigator.clipboard.writeText(publicUrl); setFeedback("公開報名連結已複製。"); }
    catch { setFeedback(`請複製此連結：${publicUrl}`); }
  };

  return <section className="registration-center" aria-labelledby="registration-title">
    <div className="page-heading"><div><h2 id="registration-title">活動報名中心</h2><p className="muted">每個活動使用自己的表單與名單；個資只提供總召以上權限查看。</p></div><button className="primary" disabled={!activityId || activityForms.length > 0} onClick={() => openEditor()}>＋ 建立報名表</button></div>
    {preview && <div className="registration-note">公開版會把表單與測試填答保留在這台裝置。跨裝置收件與自動寄信需正式後端服務。</div>}
    <div className="registration-toolbar"><label>選擇活動<select value={activityId} onChange={(event) => { setActivityId(event.target.value); setSelectedId(""); setReveal(false); if (!preview && event.target.value) setLoading(true); }}><option value="">請選擇活動</option>{data.activities.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><span className="badge">個資權限：總召以上</span></div>
    {loading ? <div className="empty">正在載入報名表…</div> : !activity ? <div className="empty">請先建立或選擇一場活動。</div> : <div className="registration-layout">
      <aside className="registration-form-list"><div className="registration-section-head"><div><h3>{activity.name}</h3><small>{activityForms.length} 份表單</small></div></div>{activityForms.map((form) => <button className={selected?.id === form.id ? "active" : ""} key={form.id} onClick={() => { setSelectedId(form.id); setReveal(false); setFeedback(""); }}><span><b>{form.title}</b><small>{form.status === "open" ? "開放報名" : form.status === "closed" ? "已截止" : "草稿"}</small></span><strong>{submissions.filter((row) => row.formId === form.id).length}</strong></button>)}{!activityForms.length && <p className="muted">這場活動還沒有報名表。</p>}</aside>
      <div className="registration-main">{selected ? <>
        <div className="registration-card-head"><div><span className={`badge ${selected.status === "open" ? "green" : ""}`}>{selected.status === "open" ? "開放報名" : selected.status === "closed" ? "已截止" : "草稿"}</span><h3>{selected.title}</h3><p className="muted">{selected.description || "尚未加入表單說明"}</p></div><div className="page-actions"><button onClick={() => openEditor(selected)}>編輯問題</button><button disabled={selected.status !== "open"} onClick={copyLink}>複製報名連結</button><a className="button" aria-disabled={selected.status !== "open"} href={selected.status === "open" ? publicUrl : undefined} target="_blank" rel="noreferrer">預覽填寫</a></div></div>
        <p className="registration-privacy">🔒 {selected.privacyNotice}</p>
        <div className="registration-metrics"><div><small>問題</small><strong>{selected.fields.length}</strong></div><div><small>報名筆數</small><strong>{selectedSubmissions.length}</strong></div><div><small>個資欄位</small><strong>{selected.fields.filter((row) => row.sensitive).length}</strong></div></div>
        <section className="registration-reminders" aria-label="活動提醒"><div><h3>參加者提醒</h3><p>依活動日期自動排定前 5 天與前 1 天提醒，共 {reminderRows.length} 位有電子郵件。</p></div><div className="registration-reminder-grid"><article><small>活動前 5 天</small><strong>{reminderSchedule.five_days || "未設定活動日"}</strong><button disabled={!reminderRows.length || !reminderSchedule.five_days} onClick={() => void prepareReminder("five_days")}>準備通知內容</button></article><article><small>活動前 1 天</small><strong>{reminderSchedule.one_day || "未設定活動日"}</strong><button disabled={!reminderRows.length || !reminderSchedule.one_day} onClick={() => void prepareReminder("one_day")}>準備通知內容</button></article></div></section>
        <div className="registration-submission-head"><div><h3>報名名單</h3><small>預設遮蔽個資；顯示與匯出僅限總召以上。已有填答後會鎖定問題結構，保留歷史資料欄位。</small></div><div className="page-actions"><button disabled={!selectedSubmissions.length} onClick={() => setReveal(!reveal)}>{reveal ? "遮蔽個資" : "顯示個資"}</button><button onClick={() => void exportResponses()}>匯出 Excel</button></div></div>
        {selectedSubmissions.length ? <div className="registration-table-scroll"><table><thead><tr><th>提交時間</th><th>對帳</th><th>對帳註記</th>{selected.fields.map((field) => <th key={field.id}>{field.label}{field.sensitive ? " 🔒" : ""}</th>)}</tr></thead><tbody>{selectedSubmissions.map((submission) => <tr key={submission.id}><td>{new Date(submission.submittedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</td><td><select className="registration-payment-select" disabled={reconciliationBusy === submission.id} value={submission.paymentStatus ?? "unpaid"} onChange={(event) => void updateReconciliation(submission, { paymentStatus:event.target.value as RegistrationPaymentStatus })}>{Object.entries(paymentLabels).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></td><td><input className="registration-payment-note" aria-label={`${submission.id} 對帳註記`} disabled={reconciliationBusy === submission.id} defaultValue={submission.paymentNote ?? ""} placeholder="匯款末五碼／備註" maxLength={1000} onBlur={(event) => { if (event.target.value !== (submission.paymentNote ?? "")) void updateReconciliation(submission, { paymentNote:event.target.value }); }} /></td>{selected.fields.map((field) => { const raw = submission.answers[field.id]; const value = Array.isArray(raw) ? raw.join("、") : String(raw ?? ""); return <td key={field.id}>{field.sensitive && !reveal ? mask(value) : value || "—"}</td>; })}</tr>)}</tbody></table></div> : <div className="empty">尚無報名資料。表單開放後，可複製專屬連結給參加者。</div>}
      </> : <div className="empty">建立第一份表單後，可設定問題、分享連結與匯出名單。</div>}</div>
    </div>}
    {feedback && <p className="registration-feedback" role="status">{feedback}</p>}
    {editor && <dialog open className="modal registration-editor" aria-labelledby="registration-editor-title"><form onSubmit={saveForm}><div className="modal-head"><h2 id="registration-editor-title">{forms.some((row) => row.id === editor.id) ? "編輯報名表" : "建立報名表"}</h2><button type="button" aria-label="關閉" onClick={() => setEditor(null)}>×</button></div><fieldset disabled={saving || busy}>
      <label>表單名稱<input name="title" required maxLength={200} defaultValue={editor.title} /></label><label>狀態<select name="status" defaultValue={editor.status}><option value="draft">草稿</option><option value="open">開放報名</option><option value="closed">已截止</option></select></label><label>表單說明<textarea name="description" maxLength={3000} defaultValue={editor.description} /></label><label>個資告知<textarea name="privacyNotice" required maxLength={2000} defaultValue={editor.privacyNotice} /></label>
      <div className="registration-question-head"><div><h3>自訂問題</h3><small>每題可選回答方式並直接確認填寫畫面。</small></div><button type="button" disabled={selectedSubmissions.length > 0} onClick={() => setFields((rows) => [...rows, { id: uid(), label: "", type: "short_text", required: false, sensitive: false }])}>＋ 新增問題</button></div>
      <RegistrationBuilder fields={fields} setFields={setFields} locked={selectedSubmissions.length > 0} busy={saving || busy} />
    </fieldset><div className="mgmt-dialog-actions"><button type="button" disabled={saving || busy} onClick={() => setEditor(null)}>取消</button><button className="primary" disabled={saving || busy}>{saving || busy ? "儲存中…" : "儲存報名表"}</button></div></form></dialog>}
  </section>;
}

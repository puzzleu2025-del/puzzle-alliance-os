import { env } from "cloudflare:workers";
import { csrfError, currentToken, getMember, randomToken, tokenHash } from "@/app/admin-auth";
import { normalizeRegistrationForm, normalizeRegistrationText, normalizeRemittanceLast5, registrationPresentationError, registrationAnswerStructure, REGISTRATION_REQUEST_LIMIT, type RegistrationForm, type RegistrationPaymentStatus, type RegistrationSubmission } from "@/app/registration-types";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };

async function authorize() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503, headers: noStore }) };
  const user = await getMember();
  if (!user) return { error: Response.json({ error: "請先登入已核可帳號" }, { status: 401, headers: noStore }) };
  if (!["admin", "manager", "coordinator", "trainee_coordinator"].includes(user.role)) return { error: Response.json({ error: "只有獲授權的活動總召可以管理報名表" }, { status: 403, headers: noStore }) };
  return { user };
}

type ActivityAccess = { id: string; owner?: string; proxy?: string; coordinatorIds?: string[]; traineeCoordinatorId?: string; settingsSubmittedAt?: string };
type AccessUser = { role: string; userId: string; displayName: string };

async function activityAccess(activityId: string, user: AccessUser) {
  const workspace = await env.DB!.prepare("SELECT data,version FROM workspace_states WHERE id=1").first<{ data: string; version: number }>();
  let activity: ActivityAccess | undefined;
  try { activity = (JSON.parse(workspace?.data ?? "{}") as { activities?: ActivityAccess[] }).activities?.find((row) => row.id === activityId); } catch {}
  if (!activity) return { error: Response.json({ error: "找不到所屬活動" }, { status: 404, headers: noStore }) };
  const isManager = user.role === "admin" || user.role === "manager";
  const legacyNameGrant = user.role === "coordinator" && !Array.isArray(activity.coordinatorIds) && typeof activity.traineeCoordinatorId !== "string";
  const matchingNames = legacyNameGrant
    ? await env.DB!.prepare("SELECT user_id FROM members WHERE status='active' AND display_name=?").bind(user.displayName).all<{ user_id: string }>()
    : null;
  const uniqueSelfName = matchingNames?.results.length === 1 && matchingNames.results[0].user_id === user.userId;
  const assigned = user.role === "trainee_coordinator"
    ? activity.traineeCoordinatorId === user.userId
    : user.role === "coordinator" && (Array.isArray(activity.coordinatorIds) || typeof activity.traineeCoordinatorId === "string"
      ? activity.coordinatorIds?.includes(user.userId) === true
      : uniqueSelfName && [activity.owner, activity.proxy].some((name) => name?.trim() === user.displayName.trim()));
  if (!isManager && !assigned) return { error: Response.json({ error: "沒有這場活動的授權" }, { status: 403, headers: noStore }) };
  return { activity, isManager, workspaceVersion: workspace?.version ?? 0 };
}

function writeAccess(access: Awaited<ReturnType<typeof activityAccess>>) {
  if (access.error) return access.error;
  if (!access.isManager && access.activity?.settingsSubmittedAt) return Response.json({ error: "活動設定已提交，只有管理員可以修改報名表" }, { status: 403, headers: noStore });
  return null;
}

type FormRow = { id:string; activityId:string; slug:string; schemaJson:string; version:number };

function rowToForm(row: FormRow): RegistrationForm | null {
  const form = normalizeRegistrationForm(JSON.parse(row.schemaJson));
  return form ? { ...form, id: row.id, activityId: row.activityId, slug: row.slug, version: row.version } : null;
}

export async function GET(request: Request) {
  const auth = await authorize(); if (auth.error) return auth.error;
  const activityId = new URL(request.url).searchParams.get("activityId")?.trim() ?? "";
  if (!activityId || activityId.length > 100) return Response.json({ error: "活動編號無效" }, { status: 400, headers: noStore });
  const access = await activityAccess(activityId, auth.user!); if (access.error) return access.error;
  const fee = await env.DB!.prepare("SELECT amount,revision FROM activity_fees WHERE activity_id=?").bind(activityId).first<{amount:number;revision:number}>();
  const result = await env.DB!.prepare("SELECT id,activity_id AS activityId,slug,schema_json AS schemaJson,version FROM registration_forms WHERE activity_id=? ORDER BY created_at").bind(activityId).all<FormRow>();
  const forms = result.results.flatMap((row) => { try { const form = rowToForm(row); return form ? [form] : []; } catch { return []; } });
  const ids = forms.map((form) => form.id);
  let submissions: RegistrationSubmission[] = [];
  const canSeeResponses = auth.user!.role !== "trainee_coordinator";
  if (ids.length && canSeeResponses) {
    const rows = await env.DB!.prepare("SELECT id,form_id AS formId,answers_json AS answersJson,consent,archived_at AS archivedAt,payment_status AS paymentStatus,payment_note AS paymentNote,remittance_last5 AS remittanceLast5,fee_followup AS feeFollowup,fee_recheck_reason AS feeRecheckReason,reminder_5d_sent_at AS reminderFiveDaysSentAt,reminder_1d_sent_at AS reminderOneDaySentAt,submitted_at AS submittedAt FROM registration_submissions WHERE form_id=? AND (archived_at IS NULL OR ?=1) ORDER BY submitted_at DESC").bind(ids[0], auth.user!.role === "admin" ? 1 : 0).all<{id:string;formId:string;answersJson:string;consent:number;archivedAt:string|null;paymentStatus:RegistrationPaymentStatus;paymentNote:string;remittanceLast5:string;feeFollowup:number;feeRecheckReason:"price_change"|"refund"|"";reminderFiveDaysSentAt:string|null;reminderOneDaySentAt:string|null;submittedAt:string}>();
    submissions = rows.results.flatMap((row) => { try { return [{ id: row.id, formId: row.formId, activityId, answers: JSON.parse(row.answersJson), consent: row.consent === 1, status: "submitted" as const, paymentStatus: row.paymentStatus, paymentNote: row.paymentNote || undefined, remittanceLast5: row.remittanceLast5 || undefined, feeFollowup: row.feeFollowup === 1, feeRecheckReason: row.feeRecheckReason, reminderFiveDaysSentAt: row.reminderFiveDaysSentAt || undefined, reminderOneDaySentAt: row.reminderOneDaySentAt || undefined, submittedAt: row.submittedAt, archivedAt: row.archivedAt || undefined }]; } catch { return []; } });
  }
  return Response.json({ forms, submissions, feeAmount: fee?.amount ?? 0, feeRevision: fee?.revision ?? 0, permission: canSeeResponses ? "admin" : "form_editor" }, { headers: noStore });
}

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await authorize(); if (auth.error) return auth.error;
  let raw: unknown;
  try { const text = await request.text(); if (new TextEncoder().encode(text).byteLength > REGISTRATION_REQUEST_LIMIT) return Response.json({ error: "表單資料過大，請縮小圖片或減少說明內容" }, { status: 413, headers: noStore }); raw = JSON.parse(text); } catch { return Response.json({ error: "表單資料格式錯誤" }, { status: 400, headers: noStore }); }
  const presentationError = registrationPresentationError((raw as { form?: unknown })?.form);
  if (presentationError) return Response.json({ error: presentationError }, { status: 400, headers: noStore });
  const form = normalizeRegistrationForm((raw as { form?: unknown })?.form);
  if (!form || !form.fields.length) return Response.json({ error: "至少需要一個有效問題" }, { status: 400, headers: noStore });
  const access = await activityAccess(form.activityId, auth.user!);
  const permissionError = writeAccess(access); if (permissionError) return permissionError;
  const existing = await env.DB!.prepare("SELECT id,slug,version,created_at AS createdAt,schema_json AS schemaJson FROM registration_forms WHERE activity_id=?").bind(form.activityId).first<{id:string;slug:string;version:number;createdAt:string;schemaJson:string}>();
  if (existing && existing.id !== form.id) return Response.json({ error: "每場活動目前只能建立一份主要報名表" }, { status: 409, headers: noStore });
  const currentForm = existing ? rowToForm({ id: existing.id, activityId: form.activityId, slug: existing.slug, version: existing.version, schemaJson: existing.schemaJson }) : null;
  const activeMembers = await env.DB!.prepare("SELECT display_name AS name FROM members WHERE status='active'").all<{ name: string }>();
  const activeNames = new Set(activeMembers.results.map((member) => member.name));
  if (!form.owner || (!activeNames.has(form.owner) && form.owner !== currentForm?.owner) ||
    (form.proxy && !activeNames.has(form.proxy) && form.proxy !== currentForm?.proxy)) {
    return Response.json({ error: "負責人與代理人須從已啟用成員選擇" }, { status: 400, headers: noStore });
  }
  if (existing) {
    const responseCount = await env.DB!.prepare("SELECT COUNT(*) AS count FROM registration_submissions WHERE form_id=?").bind(existing.id).first<{count:number}>();
    let schemaChanged = true;
    try { schemaChanged = JSON.stringify(registrationAnswerStructure(rowToForm({ id:existing.id, activityId:form.activityId, slug:existing.slug, version:existing.version, schemaJson:existing.schemaJson })?.fields ?? [])) !== JSON.stringify(registrationAnswerStructure(form.fields)); } catch {}
    if ((responseCount?.count ?? 0) > 0 && schemaChanged) return Response.json({ error: "已有報名資料，問題結構已鎖定；仍可調整說明、狀態與個資告知" }, { status: 409, headers: noStore });
  }
  const now = new Date().toISOString();
  const next: RegistrationForm = { ...form, id: existing?.id ?? form.id, slug: existing?.slug ?? randomToken().slice(0, 32), version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
  const serialized = JSON.stringify(next);
  if (existing) {
    await env.DB!.batch([
      env.DB!.prepare("UPDATE registration_forms SET title=?,description=?,status=?,schema_json=?,privacy_notice=?,version=?,updated_at=? WHERE id=?").bind(next.title,next.description,next.status,serialized,next.privacyNotice,next.version,now,next.id),
      env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,'registration_form',?,?)").bind(auth.user!.userId,"update_registration_form",next.id,now),
    ]);
  } else {
    await env.DB!.batch([
      env.DB!.prepare("INSERT INTO registration_forms (id,activity_id,slug,title,description,status,schema_json,privacy_notice,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(next.id,next.activityId,next.slug,next.title,next.description,next.status,serialized,next.privacyNotice,next.version,auth.user!.userId,now,now),
      env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,'registration_form',?,?)").bind(auth.user!.userId,"create_registration_form",next.id,now),
    ]);
  }
  return Response.json({ form: next }, { headers: noStore });
}

export async function PUT(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await authorize(); if (auth.error) return auth.error;
  let formId = "";
  try { formId = String((await request.json() as {formId?:unknown}).formId ?? "").trim(); } catch {}
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(formId)) return Response.json({ error: "報名表編號無效" }, { status: 400, headers: noStore });
  const exists = await env.DB!.prepare("SELECT id,activity_id AS activityId FROM registration_forms WHERE id=?").bind(formId).first<{id:string;activityId:string}>();
  if (!exists) return Response.json({ error: "找不到報名表" }, { status: 404, headers: noStore });
  if (auth.user!.role === "trainee_coordinator") return Response.json({ error: "報名個資匯出僅限總召以上" }, { status: 403, headers: noStore });
  const access = await activityAccess(exists.activityId, auth.user!); if (access.error) return access.error;
  await env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,'registration_form',?,?)").bind(auth.user!.userId,"export_registration_responses",formId,new Date().toISOString()).run();
  return Response.json({ ok: true }, { headers: noStore });
}

export async function PATCH(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const auth = await authorize(); if (auth.error) return auth.error;
  let body: {action?:unknown;formId?:unknown;submissionId?:unknown;paymentStatus?:unknown;paymentNote?:unknown;feeRevision?:unknown;resolveRecheck?:unknown;remittanceLast5?:unknown};
  try { body = await request.json(); } catch { return Response.json({ error: "對帳資料格式錯誤" }, { status: 400, headers: noStore }); }
  const formId = String(body.formId ?? "").trim(), submissionId = String(body.submissionId ?? "").trim();
  const paymentStatus = String(body.paymentStatus ?? "") as RegistrationPaymentStatus;
  if (body.action === "remittance") {
    // Staff backfill of the remittance last five digits; reconciliation rules do not apply to this field.
    const remittanceLast5 = normalizeRemittanceLast5(body.remittanceLast5);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(formId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(submissionId) || remittanceLast5 === null) return Response.json({ error: "匯款末五碼須為 5 位數字" }, { status: 400, headers: noStore });
    if (auth.user!.role === "trainee_coordinator") return Response.json({ error: "報名對帳僅限總召以上" }, { status: 403, headers: noStore });
    const remittanceForm = await env.DB!.prepare("SELECT activity_id AS activityId FROM registration_forms WHERE id=?").bind(formId).first<{ activityId: string }>();
    if (!remittanceForm) return Response.json({ error: "找不到報名表" }, { status: 404, headers: noStore });
    const remittanceAccess = await activityAccess(remittanceForm.activityId, auth.user!);
    const remittancePermissionError = writeAccess(remittanceAccess); if (remittancePermissionError) return remittancePermissionError;
    const remittanceToken = await currentToken();
    if (!/^[a-f0-9]{64}$/.test(remittanceToken)) return Response.json({ error: "登入已失效" }, { status: 401, headers: noStore });
    const remittanceNonce = crypto.randomUUID(), remittanceNow = new Date().toISOString();
    const remittanceResult = await env.DB!.batch([
      env.DB!.prepare(`UPDATE registration_submissions SET remittance_last5=?,reconciliation_nonce=? WHERE id=? AND form_id=? AND (archived_at IS NULL OR ?=1)
        AND EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND m.status='active' AND m.user_id=? AND m.role=?)`)
        .bind(remittanceLast5, remittanceNonce, submissionId, formId, auth.user!.role === "admin" ? 1 : 0, await tokenHash(remittanceToken), Date.now(), auth.user!.userId, auth.user!.role),
      env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,?,'registration_submission',?,? WHERE EXISTS (SELECT 1 FROM registration_submissions WHERE id=? AND form_id=? AND reconciliation_nonce=?)")
        .bind(auth.user!.userId, "update_registration_remittance", submissionId, remittanceNow, submissionId, formId, remittanceNonce),
    ]);
    if (remittanceResult[0].meta.changes !== 1) return Response.json({ error: "權限或登入狀態已變更，請重新載入" }, { status: 409, headers: noStore });
    return Response.json({ ok: true, remittanceLast5 }, { headers: noStore });
  }
  const allowed: RegistrationPaymentStatus[] = ["unpaid", "checking", "paid", "refunded", "not_required"];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(formId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(submissionId) || !allowed.includes(paymentStatus)) return Response.json({ error: "對帳資料無效" }, { status: 400, headers: noStore });
  const paymentNote = normalizeRegistrationText(body.paymentNote, 1_000);
  if (auth.user!.role === "trainee_coordinator") return Response.json({ error: "報名對帳僅限總召以上" }, { status: 403, headers: noStore });
  const form = await env.DB!.prepare("SELECT activity_id AS activityId FROM registration_forms WHERE id=?").bind(formId).first<{ activityId: string }>();
  if (!form) return Response.json({ error: "找不到報名表" }, { status: 404, headers: noStore });
  const access = await activityAccess(form.activityId, auth.user!);
  const permissionError = writeAccess(access); if (permissionError) return permissionError;
  const feeRevision = body.feeRevision === undefined ? 0 : body.feeRevision;
  if (!Number.isSafeInteger(feeRevision) || (feeRevision as number) < 0 || (body.resolveRecheck !== undefined && typeof body.resolveRecheck !== "boolean")) return Response.json({ error: "費用版本無效，請重新載入" }, { status: 400, headers: noStore });
  if (body.resolveRecheck === true && !access.isManager) return Response.json({ error: "重新核對由管理員處理" }, { status: 403, headers: noStore });
  const sessionToken = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(sessionToken)) return Response.json({ error: "登入已失效" }, { status: 401, headers: noStore });
  const sessionHash = await tokenHash(sessionToken), nonce = crypto.randomUUID(), now = new Date().toISOString();
  const result = await env.DB!.batch([
    env.DB!.prepare(`UPDATE registration_submissions SET payment_status=?,payment_note=?,
      fee_recheck_reason=CASE WHEN ?=1 THEN '' ELSE fee_recheck_reason END,
      fee_followup=CASE WHEN ? IN ('paid','refunded','not_required') THEN 0 ELSE fee_followup END,reconciliation_nonce=?
      WHERE id=? AND form_id=? AND (archived_at IS NULL OR ?=1) AND (fee_recheck_reason='' OR ?=1)
      AND (fee_recheck_reason<>'refund' OR ?='refunded')
      AND COALESCE((SELECT revision FROM activity_fees WHERE activity_id=?),0)=?
      AND EXISTS (SELECT 1 FROM workspace_states WHERE id=1 AND version=?)
      AND EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND m.status='active' AND m.user_id=? AND m.role=?)`)
      .bind(paymentStatus,paymentNote,body.resolveRecheck === true ? 1 : 0,paymentStatus,nonce,submissionId,formId,auth.user!.role === "admin" ? 1 : 0,body.resolveRecheck === true ? 1 : 0,paymentStatus,form.activityId,feeRevision,access.workspaceVersion,sessionHash,Date.now(),auth.user!.userId,auth.user!.role),
    env.DB!.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,?,'registration_submission',?,? WHERE EXISTS (SELECT 1 FROM registration_submissions WHERE id=? AND form_id=? AND reconciliation_nonce=?)")
      .bind(auth.user!.userId,"update_registration_reconciliation",submissionId,now,submissionId,formId,nonce),
  ]);
  if (result[0].meta.changes !== 1) return Response.json({ error: "費用、權限或對帳狀態已變更，請重新載入；需重新核對者請由管理員處理" }, { status: 409, headers: noStore });
  return Response.json({ ok: true, paymentStatus, paymentNote }, { headers: noStore });
}

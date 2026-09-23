import { env } from "cloudflare:workers";
import { csrfError, rateLimited, tokenHash } from "@/app/admin-auth";
import { normalizeRegistrationForm, normalizeRegistrationId, validateRegistrationSubmission } from "@/app/registration-types";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };
type FormRow = { id:string; activityId:string; schemaJson:string; version:number };

async function load(slug: string) {
  if (!env.DB || !/^[a-f0-9]{32}$/.test(slug)) return null;
  const row = await env.DB.prepare("SELECT id,activity_id AS activityId,schema_json AS schemaJson,version FROM registration_forms WHERE slug=?").bind(slug).first<FormRow>();
  if (!row) return null;
  try { const form = normalizeRegistrationForm(JSON.parse(row.schemaJson)); return form ? { row, form } : null; } catch { return null; }
}

function publicActivity(data: string | undefined, activityId: string) {
  try {
    const row = (JSON.parse(data ?? "{}") as {activities?:Array<{id:string;name:string;date:string;location?:string}>}).activities?.find((item) => item.id === activityId);
    return row ? { name: row.name, date: row.date, location: row.location ?? "" } : null;
  } catch { return null; }
}

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const loaded = await load(slug);
  if (!loaded || loaded.form.status !== "open") return Response.json({ error: "表單尚未開放或不存在" }, { status: 404, headers: noStore });
  const workspace = await env.DB!.prepare("SELECT data FROM workspace_states WHERE id=1").first<{data:string}>();
  const activity = publicActivity(workspace?.data, loaded.row.activityId);
  if (!activity) return Response.json({ error: "活動不存在" }, { status: 404, headers: noStore });
  const { form } = loaded;
  return Response.json({ activity, form: { id:form.id,activityId:form.activityId,title:form.title,description:form.description,status:form.status,fields:form.fields,submitLabel:form.submitLabel,confirmationMessage:form.confirmationMessage,createdAt:form.createdAt,updatedAt:form.updatedAt,privacyNotice:form.privacyNotice } }, { headers: noStore });
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const { slug } = await context.params;
  const loaded = await load(slug);
  if (!loaded || loaded.form.status !== "open") return Response.json({ error: "表單已截止或不存在" }, { status: 404, headers: noStore });
  let body: {answers?:unknown;consent?:boolean;idempotencyKey?:unknown;website?:unknown};
  try { const text = await request.text(); if (text.length > 60_000) throw new Error(); body = JSON.parse(text); } catch { return Response.json({ error: "填寫資料格式錯誤" }, { status: 400, headers: noStore }); }
  if (body.website) return Response.json({ ok: true }, { headers: noStore });
  if (body.consent !== true) return Response.json({ error: "必須同意個資告知" }, { status: 400, headers: noStore });
  const validation = validateRegistrationSubmission(loaded.form, body.answers);
  if (!validation.ok) return Response.json({ error: "部分欄位需要修正", fieldErrors: validation.fieldErrors }, { status: 400, headers: noStore });
  const idempotencyKey = normalizeRegistrationId(body.idempotencyKey);
  if (!idempotencyKey) return Response.json({ error: "缺少送出識別碼" }, { status: 400, headers: noStore });
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const sourceHash = await tokenHash(`registration:${loaded.row.id}:${ip}`);
  if (await rateLimited(`registration:${sourceHash}`)) return Response.json({ error: "送出次數過多，請稍後再試" }, { status: 429, headers: noStore });
  const idempotencyHash = await tokenHash(`${loaded.row.id}:${idempotencyKey}`);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  try {
    await env.DB!.prepare("INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at) VALUES (?,?,?,?,?,1,?,?,?)").bind(id,loaded.row.id,loaded.row.version,JSON.stringify(loaded.form.fields),JSON.stringify(validation.answers),idempotencyHash,sourceHash,now).run();
  } catch {
    const prior = await env.DB!.prepare("SELECT id FROM registration_submissions WHERE form_id=? AND idempotency_hash=?").bind(loaded.row.id,idempotencyHash).first<{id:string}>();
    if (prior) return Response.json({ ok:true, receiptId:prior.id, confirmationMessage:loaded.form.confirmationMessage }, { headers: noStore });
    return Response.json({ error: "目前無法完成報名，請稍後重試" }, { status: 503, headers: noStore });
  }
  return Response.json({ ok:true, receiptId:id, confirmationMessage:loaded.form.confirmationMessage }, { status: 201, headers: noStore });
}

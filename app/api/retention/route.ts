import { env } from "cloudflare:workers";
import { csrfError, currentToken, getAdmin, tokenHash } from "@/app/admin-auth";
import { ADMIN_GUARD, archiveRegistrations, planRetention, RETENTION_MAX_YEARS, RETENTION_MIN_YEARS, validRetentionYears } from "@/app/retention";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };

// Every retention operation is system-administrator only; managers and coordinators never see archive state.
async function adminContext() {
  if (!env.DB) return { error: Response.json({ error: "資料庫尚未連線" }, { status: 503, headers: noStore }) };
  const admin = await getAdmin();
  if (!admin) return { error: Response.json({ error: "只有系統管理員可以管理資料保存與封存" }, { status: 403, headers: noStore }) };
  const token = await currentToken();
  if (!/^[a-f0-9]{64}$/.test(token)) return { error: Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore }) };
  return { admin, tokenHash: await tokenHash(token) };
}

export async function GET() {
  const context = await adminContext(); if (context.error) return context.error;
  const plan = await planRetention(env.DB!, new Date());
  const archived = await env.DB!.prepare("SELECT COUNT(*) AS n FROM registration_submissions WHERE archived_at IS NOT NULL").first<{ n: number }>();
  return Response.json({
    retentionYears: plan.retentionYears, minYears: RETENTION_MIN_YEARS, maxYears: RETENTION_MAX_YEARS, cutoff: plan.cutoff,
    dueCount: plan.dueSubmissionIds.length, archivedCount: archived?.n ?? 0, heldWithoutActivity: plan.heldWithoutActivity,
  }, { headers: noStore });
}

export async function PUT(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const context = await adminContext(); if (context.error) return context.error;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "資料格式錯誤" }, { status: 400, headers: noStore }); }
  const years = body && typeof body === "object" ? (body as { retentionYears?: unknown }).retentionYears : undefined;
  if (!validRetentionYears(years)) return Response.json({ error: `保存年限須為 ${RETENTION_MIN_YEARS} 至 ${RETENTION_MAX_YEARS} 年` }, { status: 400, headers: noStore });
  const stamp = new Date().toISOString();
  const { admin, tokenHash: hash } = context as { admin: { userId: string }; tokenHash: string };
  const results = await env.DB!.batch([
    env.DB!.prepare(`UPDATE data_retention_settings SET retention_years=?,updated_at=?,updated_by=? WHERE id=1 AND ${ADMIN_GUARD}`).bind(years, stamp, admin.userId, hash, admin.userId),
    env.DB!.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,'update_retention_years','retention','1',? WHERE ${ADMIN_GUARD}`).bind(admin.userId, stamp, hash, admin.userId),
  ]);
  if (results[0]?.meta?.changes !== 1) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  return Response.json({ retentionYears: years }, { headers: noStore });
}

export async function POST(request: Request) {
  const csrf = csrfError(request); if (csrf) return csrf;
  const context = await adminContext(); if (context.error) return context.error;
  const plan = await planRetention(env.DB!, new Date());
  const { admin, tokenHash: hash } = context as { admin: { userId: string }; tokenHash: string };
  const result = await archiveRegistrations(env.DB!, plan.dueSubmissionIds, new Date(), { tokenHash: hash, userId: admin.userId });
  if (plan.dueSubmissionIds.length && result.archived === 0) return Response.json({ error: "登入已失效，請重新登入" }, { status: 401, headers: noStore });
  return Response.json({ archived: result.archived, heldWithoutActivity: plan.heldWithoutActivity }, { headers: noStore });
}

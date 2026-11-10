// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { PARTICIPANT_SESSION_COOKIE, readCookie, secretHash } from "./participant-session.ts";

type Cursor = { submittedAt: string; submissionId: string };
type Registration = { submissionId: string; title: string; submittedAt: string };
type Result = { ok: true; registrations: Registration[]; nextCursor: Cursor | null } |
  { ok: false; code: "invalid" | "unauthorized" | "unavailable" };
type Row = { submissionId: string | null; title: string | null; submittedAt: string | null };

const PAGE_SIZE = 50;
const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";

function validCursor(value: unknown): value is Cursor | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && typeof item.submittedAt === "string" &&
    item.submittedAt.length > 0 && item.submittedAt.length <= 64 && !/[\x00-\x1f\x7f]/.test(item.submittedAt) &&
    typeof item.submissionId === "string" && item.submissionId.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.submissionId);
}

/** Internal only: the caller must protect the eventual HTTP entry point. */
export async function listMyRegistrations(
  db: D1Database, kind: unknown, cookieHeader: string | null, cursor: unknown = null,
): Promise<Result> {
  if ((kind !== "member" && kind !== "participant") || !validCursor(cursor)) return { ok: false, code: "invalid" };
  const token = readCookie(cookieHeader, kind === "member" ? "puzzle_admin_session" : PARTICIPANT_SESSION_COOKIE);
  if (!token) return { ok: false, code: "unauthorized" };
  try {
    const auth = kind === "member"
      ? `SELECT m.user_id AS id FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.expires_at>${DB_NOW}`
      : `SELECT ps.participant_id AS id FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.expires_at>${DB_NOW}`;
    const ownerColumn = kind === "member" ? "member_id" : "participant_id";
    const result = await db.prepare(
      `WITH owner AS (${auth}), page AS (
        SELECT s.id AS submissionId,f.title AS title,s.submitted_at AS submittedAt
        FROM owner JOIN registration_identities i ON i.${ownerColumn}=owner.id AND i.status='active'
        JOIN registration_submissions s ON s.id=i.submission_id AND s.form_id=i.form_id
        JOIN registration_forms f ON f.id=i.form_id
        WHERE (? IS NULL OR s.submitted_at<? OR (s.submitted_at=? AND s.id<?))
        ORDER BY s.submitted_at DESC,s.id DESC LIMIT ?
      ) SELECT page.submissionId,page.title,page.submittedAt FROM owner LEFT JOIN page ON 1=1
        ORDER BY page.submittedAt DESC,page.submissionId DESC`,
    ).bind(await secretHash(token), cursor?.submittedAt ?? null, cursor?.submittedAt ?? null,
      cursor?.submittedAt ?? null, cursor?.submissionId ?? null, PAGE_SIZE + 1).all<Row>();
    if (!result.success || !result.results) return { ok: false, code: "unavailable" };
    if (!result.results.length) return { ok: false, code: "unauthorized" };
    const rows = result.results.filter((row): row is { submissionId: string; title: string; submittedAt: string } =>
      typeof row.submissionId === "string" && typeof row.title === "string" && typeof row.submittedAt === "string");
    const registrations = rows.slice(0, PAGE_SIZE);
    const last = registrations.at(-1);
    return { ok: true, registrations, nextCursor: rows.length > PAGE_SIZE && last ? { submittedAt: last.submittedAt, submissionId: last.submissionId } : null };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

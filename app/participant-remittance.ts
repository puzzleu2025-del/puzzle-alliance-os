// Explicit extensions support the isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { DB_NOW, MEMBER_AUTH, MEMBER_COOKIE, PARTICIPANT_AUTH } from "./participant-registration.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { PARTICIPANT_SESSION_COOKIE, readCookie, secretHash } from "./participant-session.ts";

export type RemittanceOutcome =
  | { ok: true }
  | { ok: false; code: "invalid" | "unauthorized" | "not_found" | "not_required" | "already_set" | "unavailable" };

/**
 * A registrant (member or participant) may fill the last five digits of their
 * own paid registration exactly once. Any later change is made by staff.
 */
export async function fillOwnRemittance(
  db: D1Database,
  kind: unknown,
  cookieHeader: string | null,
  submissionId: unknown,
  remittanceLast5: unknown,
): Promise<RemittanceOutcome> {
  if ((kind !== "member" && kind !== "participant") ||
      typeof submissionId !== "string" || submissionId.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(submissionId) ||
      typeof remittanceLast5 !== "string" || !/^[0-9]{5}$/.test(remittanceLast5)) {
    return { ok: false, code: "invalid" };
  }
  const token = readCookie(cookieHeader, kind === "member" ? MEMBER_COOKIE : PARTICIPANT_SESSION_COOKIE);
  if (!token) return { ok: false, code: "unauthorized" };
  try {
    const tokenHash = await secretHash(token);
    const ownerQuery = kind === "member"
      ? `SELECT m.user_id AS id FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.expires_at>${DB_NOW}`
      : `SELECT ps.participant_id AS id FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.expires_at>${DB_NOW}`;
    const owner = await db.prepare(ownerQuery).bind(tokenHash).first<{ id: string }>();
    if (!owner) return { ok: false, code: "unauthorized" };
    const ownerColumn = kind === "member" ? "member_id" : "participant_id";
    const auth = kind === "member" ? MEMBER_AUTH : PARTICIPANT_AUTH;
    const row = await db.prepare(
      `SELECT s.remittance_last5 AS remittanceLast5,COALESCE((SELECT amount FROM activity_fees WHERE activity_id=(SELECT activity_id FROM registration_forms WHERE id=s.form_id)),0) AS feeAmount
       FROM registration_submissions s JOIN registration_identities i ON i.submission_id=s.id AND i.form_id=s.form_id
       WHERE s.id=? AND i.status='active' AND i.${ownerColumn}=?`,
    ).bind(submissionId, owner.id).first<{ remittanceLast5: string; feeAmount: number }>();
    if (!row) return { ok: false, code: "not_found" };
    if (!(row.feeAmount > 0)) return { ok: false, code: "not_required" };
    if (row.remittanceLast5 !== "") return { ok: false, code: "already_set" };
    const write = await db.prepare(
      `UPDATE registration_submissions SET remittance_last5=? WHERE id=? AND remittance_last5=''
       AND EXISTS (SELECT 1 FROM registration_identities i WHERE i.submission_id=registration_submissions.id AND i.form_id=registration_submissions.form_id AND i.status='active' AND i.${ownerColumn}=?)
       AND ${auth}`,
    ).bind(remittanceLast5, submissionId, owner.id, tokenHash, owner.id).run();
    if (write.meta.changes !== 1) {
      const stillAuthorized = await db.prepare(`SELECT 1 AS ok WHERE ${auth}`).bind(tokenHash, owner.id).first();
      return { ok: false, code: stillAuthorized ? "already_set" : "unauthorized" };
    }
    // Staff audit trail; participants have no member name, so their actor is generic.
    await db.prepare("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,'registration_submission',?,?)")
      .bind(kind === "member" ? owner.id : "participant", "fill_registration_remittance", submissionId, new Date().toISOString()).run();
    return { ok: true };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

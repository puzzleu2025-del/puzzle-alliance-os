// Explicit extensions support the isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { PARTICIPANT_SESSION_COOKIE, readCookie, randomSecret, secretHash } from "./participant-session.ts";

const MEMBER_COOKIE = "puzzle_admin_session";
// Round up to avoid accepting an expiry during SQLite's fractional-ms rounding.
const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";
const MEMBER_AUTH = `EXISTS (SELECT 1 FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.user_id=i.member_id AND a.expires_at>${DB_NOW})`;
const PARTICIPANT_AUTH = `EXISTS (SELECT 1 FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.participant_id=i.participant_id AND ps.expires_at>${DB_NOW})`;

function selectedSession(kind: unknown, cookieHeader: string | null): { token: string; auth: string } | null {
  if (kind !== "member" && kind !== "participant") return null;
  const token = readCookie(cookieHeader, kind === "member" ? MEMBER_COOKIE : PARTICIPANT_SESSION_COOKIE);
  if (!token) return null;
  return { token, auth: kind === "member" ? MEMBER_AUTH : PARTICIPANT_AUTH };
}

/**
 * Internal-only issuer. Every display creates a new random code; older codes
 * remain valid unless explicitly revoked or the registration stops being active.
 * The caller must enforce same-origin/CSRF and rate limits before invoking it.
 */
export async function issueParticipantQr(
  db: D1Database,
  kind: unknown,
  cookieHeader: string | null,
  submissionId: unknown,
): Promise<string | null> {
  const session = selectedSession(kind, cookieHeader);
  if (!session || typeof submissionId !== "string" || submissionId.length > 100 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(submissionId) || /[\x00-\x20\x7f]/.test(submissionId)) return null;
  const value = randomSecret();
  const row = await db.prepare(
    `INSERT INTO registration_qr_tokens (token_hash,submission_id,issued_at,revoked_at) SELECT ?,i.submission_id,${DB_NOW},NULL FROM registration_identities i WHERE i.submission_id=? AND i.status='active' AND NOT EXISTS (SELECT 1 FROM registration_submissions x WHERE x.id=i.submission_id AND x.archived_at IS NOT NULL) AND ${session.auth} RETURNING token_hash`,
  ).bind(await secretHash(value), submissionId, await secretHash(session.token)).first();
  return row ? value : null;
}

/**
 * Revokes just the presented code and requires its active registration owner
 * to have a current session. A later display may issue a new code.
 */
export async function revokeParticipantQr(
  db: D1Database,
  kind: unknown,
  cookieHeader: string | null,
  qrToken: unknown,
): Promise<boolean> {
  const session = selectedSession(kind, cookieHeader);
  if (!session || typeof qrToken !== "string" || qrToken.length !== 64 || !/^[a-f0-9]{64}$/.test(qrToken)) return false;
  const row = await db.prepare(
    `UPDATE registration_qr_tokens SET revoked_at=${DB_NOW} WHERE token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM registration_identities i WHERE i.submission_id=registration_qr_tokens.submission_id AND i.status='active' AND ${session.auth}) RETURNING token_hash`,
  ).bind(await secretHash(qrToken), await secretHash(session.token)).first();
  return row !== null;
}

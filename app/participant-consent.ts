// @ts-expect-error TS5097: native Node TypeScript tests require an explicit extension.
import { PARTICIPANT_SESSION_COOKIE, PARTICIPANT_SESSION_SECONDS, randomSecret, readCookie, secretHash } from "./participant-session.ts";

export const PARTICIPANT_PENDING_COOKIE = "__Host-puzzle-participant-pending";
export const PARTICIPANT_PENDING_SECONDS = 10 * 60;

type VerifiedGoogleIdentity = { sub: string; email: string; name?: string };
type PublishedTerms = { version: string; content: string };

function validTime(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 &&
    Number.isSafeInteger(nowMs + PARTICIPANT_SESSION_SECONDS * 1_000);
}

function validIdentity(identity: VerifiedGoogleIdentity): boolean {
  return !!identity && typeof identity.sub === "string" &&
    identity.sub.length >= 1 && identity.sub.length <= 255 && /^[\x21-\x7e]+$/.test(identity.sub) &&
    typeof identity.email === "string" && identity.email.trim().length > 0 && identity.email.length <= 320 &&
    (identity.name === undefined || (typeof identity.name === "string" && identity.name.length <= 255));
}

export async function getPublishedParticipantTerms(db: D1Database): Promise<PublishedTerms | null> {
  return await db.prepare(
    "SELECT t.version,t.content FROM participant_terms_current c JOIN participant_terms t ON t.version=c.version WHERE c.id=1",
  ).first<PublishedTerms>();
}

export function participantPendingCookie(token: string): string {
  if (token.length !== 64 || !/^[a-f0-9]{64}$/.test(token)) throw new Error("INVALID_PENDING_COOKIE");
  return `${PARTICIPANT_PENDING_COOKIE}=${token}; Path=/; Max-Age=${PARTICIPANT_PENDING_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearParticipantPendingCookie(): string {
  return `${PARTICIPANT_PENDING_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function getPendingParticipantTerms(db: D1Database, cookieHeader: string | null, nowMs = Date.now()): Promise<PublishedTerms | null> {
  const token = readCookie(cookieHeader, PARTICIPANT_PENDING_COOKIE);
  if (!token || !validTime(nowMs)) return null;
  return await db.prepare(
    "SELECT t.version,t.content FROM participant_pending_identities i JOIN participant_terms_current c ON c.id=1 AND c.version=i.terms_version JOIN participant_terms t ON t.version=c.version WHERE i.token_hash=? AND i.claim IS NULL AND i.expires_at>?",
  ).bind(await secretHash(token), nowMs).first<PublishedTerms>();
}

/**
 * Internal-only: the caller must have just verified the Google ID token, its
 * nonce and the one-time OAuth transaction before passing this identity.
 * This function is not an authentication endpoint and does not record consent.
 */
export async function createPendingParticipant(db: D1Database, identity: VerifiedGoogleIdentity, nowMs = Date.now()) {
  if (!validIdentity(identity) || !validTime(nowMs)) throw new Error("INVALID_PENDING_IDENTITY");
  const terms = await getPublishedParticipantTerms(db);
  if (!terms) return null;
  const token = randomSecret();
  const row = await db.prepare(
    "INSERT INTO participant_pending_identities (token_hash,google_sub,email,display_name,terms_version,expires_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM participant_terms_current WHERE id=1 AND version=?) RETURNING terms_version",
  ).bind(await secretHash(token), identity.sub, identity.email, identity.name ?? "", terms.version, nowMs + PARTICIPANT_PENDING_SECONDS * 1_000, terms.version).first();
  if (!row) return null;
  return { token, terms };
}

/**
 * A claimed pending identity and all dependent writes share one D1 batch. The
 * final guard intentionally raises a constraint error if a claim exists but
 * the history or session write did not occur, rolling back the entire batch.
 */
export async function acceptParticipantConsent(db: D1Database, pendingToken: unknown, checked: unknown, expectedVersion: unknown, nowMs = Date.now()): Promise<string | null> {
  if (checked !== true || typeof pendingToken !== "string" || pendingToken.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(pendingToken) || typeof expectedVersion !== "string" ||
      !expectedVersion || expectedVersion.length > 80 || !validTime(nowMs)) return null;

  const claim = randomSecret();
  const participantId = crypto.randomUUID();
  const consentId = crypto.randomUUID();
  const session = randomSecret();
  const pendingHash = await secretHash(pendingToken);
  const sessionHash = await secretHash(session);
  const timestamp = new Date(nowMs).toISOString();
  const results = await db.batch([
    db.prepare("UPDATE participant_pending_identities SET claim=? WHERE token_hash=? AND claim IS NULL AND expires_at>? AND terms_version=? AND terms_version=(SELECT version FROM participant_terms_current WHERE id=1)")
      .bind(claim, pendingHash, nowMs, expectedVersion),
    db.prepare("INSERT INTO participants (id,google_sub,email,display_name,created_at) SELECT ?,google_sub,email,display_name,? FROM participant_pending_identities WHERE claim=? ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,display_name=excluded.display_name")
      .bind(participantId, timestamp, claim),
    db.prepare("INSERT INTO participant_consents (id,participant_id,version,accepted_at) SELECT ?,p.id,i.terms_version,? FROM participant_pending_identities i JOIN participants p ON p.google_sub=i.google_sub WHERE i.claim=?")
      .bind(consentId, timestamp, claim),
    db.prepare("INSERT INTO participant_consent_state (participant_id,status,epoch,terms_version) SELECT p.id,'active',1,i.terms_version FROM participant_pending_identities i JOIN participants p ON p.google_sub=i.google_sub WHERE i.claim=? ON CONFLICT(participant_id) DO UPDATE SET status='active',epoch=participant_consent_state.epoch+1,terms_version=excluded.terms_version")
      .bind(claim),
    db.prepare("INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) SELECT ?,s.participant_id,?,s.epoch FROM participant_pending_identities i JOIN participants p ON p.google_sub=i.google_sub JOIN participant_consent_state s ON s.participant_id=p.id AND s.status='active' AND s.terms_version=i.terms_version JOIN participant_terms_current t ON t.id=1 AND t.version=i.terms_version WHERE i.claim=?")
      .bind(sessionHash, nowMs + PARTICIPANT_SESSION_SECONDS * 1_000, claim),
    db.prepare("UPDATE participant_pending_identities SET email=NULL WHERE claim=? AND (NOT EXISTS (SELECT 1 FROM participant_consents WHERE id=?) OR NOT EXISTS (SELECT 1 FROM participant_sessions WHERE token_hash=?))")
      .bind(claim, consentId, sessionHash),
    db.prepare("DELETE FROM participant_pending_identities WHERE claim=?").bind(claim),
    db.prepare("UPDATE participant_pending_identities SET email=NULL WHERE claim=?").bind(claim),
  ]);
  return results[4]?.meta?.changes === 1 ? session : null;
}

/**
 * The caller must perform CSRF protection. This SQL authenticates and revokes
 * against the same current, unexpired session in one atomic statement.
 */
export async function revokeParticipantConsent(db: D1Database, cookieHeader: string | null, nowMs = Date.now()): Promise<boolean> {
  const token = readCookie(cookieHeader, PARTICIPANT_SESSION_COOKIE);
  if (!token || !validTime(nowMs)) return false;
  const row = await db.prepare(
    "UPDATE participant_consent_state SET status='revoked',epoch=epoch+1 WHERE status='active' AND EXISTS (SELECT 1 FROM participant_sessions s JOIN participant_terms_current t ON t.id=1 AND t.version=participant_consent_state.terms_version WHERE s.participant_id=participant_consent_state.participant_id AND s.token_hash=? AND s.expires_at>? AND s.consent_epoch=participant_consent_state.epoch) RETURNING participant_id",
  ).bind(await secretHash(token), nowMs).first();
  return row !== null;
}

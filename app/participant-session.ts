export const PARTICIPANT_SESSION_COOKIE = "__Host-puzzle-participant";
export const PARTICIPANT_SESSION_SECONDS = 12 * 60 * 60;

export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function secretHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header || header.length > 16_384) return null;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(name + "="));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return value.length === 64 && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function cookie(name: string, token: string, maxAge: number): string {
  if ((maxAge > 0 && (token.length !== 64 || !/^[a-f0-9]{64}$/.test(token))) || !Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new Error("INVALID_PARTICIPANT_COOKIE");
  }
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function participantSessionCookie(token: string): string {
  return cookie(PARTICIPANT_SESSION_COOKIE, token, PARTICIPANT_SESSION_SECONDS);
}

export function clearParticipantSessionCookie(): string {
  return cookie(PARTICIPANT_SESSION_COOKIE, "", 0);
}

function validTime(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 && Number.isSafeInteger(nowMs + PARTICIPANT_SESSION_SECONDS * 1_000);
}

/**
 * The caller must authenticate and authorize the participant. This function
 * independently requires an active consent state for currently published terms.
 */
export async function createParticipantSession(db: D1Database, participantId: string, nowMs = Date.now()): Promise<string> {
  if (typeof participantId !== "string" || !participantId || participantId.length > 255 || !validTime(nowMs)) throw new Error("INVALID_PARTICIPANT_SESSION");
  const token = randomSecret();
  const row = await db.prepare(
    "INSERT INTO participant_sessions (token_hash,participant_id,expires_at,consent_epoch) SELECT ?,s.participant_id,?,s.epoch FROM participant_consent_state s JOIN participant_terms_current t ON t.id=1 AND t.version=s.terms_version WHERE s.participant_id=? AND s.status='active' RETURNING participant_id",
  ).bind(await secretHash(token), nowMs + PARTICIPANT_SESSION_SECONDS * 1_000, participantId).first();
  if (!row) throw new Error("PARTICIPANT_SESSION_CREATE_FAILED");
  return token;
}

export async function getParticipantSession(db: D1Database, cookieHeader: string | null, nowMs = Date.now()): Promise<{ participantId: string } | null> {
  const token = readCookie(cookieHeader, PARTICIPANT_SESSION_COOKIE);
  if (!token || !validTime(nowMs)) return null;
  return await db.prepare(
    "SELECT ps.participant_id AS participantId FROM participant_sessions ps JOIN participant_consent_state s ON s.participant_id=ps.participant_id AND s.status='active' AND s.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=s.terms_version WHERE ps.token_hash=? AND ps.expires_at>?",
  ).bind(await secretHash(token), nowMs).first<{ participantId: string }>();
}

export async function deleteParticipantSession(db: D1Database, cookieHeader: string | null): Promise<void> {
  const token = readCookie(cookieHeader, PARTICIPANT_SESSION_COOKIE);
  if (!token) return;
  await db.prepare("DELETE FROM participant_sessions WHERE token_hash=?").bind(await secretHash(token)).run();
}

// Explicit extensions support the isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { PARTICIPANT_SESSION_COOKIE, readCookie, secretHash } from "./participant-session.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { normalizeRegistrationForm, normalizeRemittanceLast5, remittanceMissing, validateRegistrationSubmission } from "./registration-types.ts";

type PrincipalKind = "member" | "participant";
type Outcome =
  | { ok: true; receiptId: string; replayed: boolean }
  | { ok: false; code: "invalid" | "unauthorized" | "closed" | "conflict" | "unavailable" };
type FormRow = { id: string; status: string; version: number; schemaJson: string };
type Previous = { id: string; status: string; formVersion: number; schemaJson: string; answersJson: string };

export const MEMBER_COOKIE = "puzzle_admin_session";
// Round up to avoid accepting an expiry during SQLite's fractional-ms rounding.
export const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";
export const MEMBER_AUTH = `EXISTS (SELECT 1 FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.user_id=? AND a.expires_at>${DB_NOW})`;
export const PARTICIPANT_AUTH = `EXISTS (SELECT 1 FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.participant_id=? AND ps.expires_at>${DB_NOW})`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validBody(value: unknown): value is { answers: Record<string, unknown>; consent: true; idempotencyKey: string; formVersion: number; feeRevision?: number; remittanceLast5?: string } {
  if (!isRecord(value) || ![4, 5, 6].includes(Object.keys(value).length) ||
      !["answers", "consent", "idempotencyKey", "formVersion"].every((key) => Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !["answers", "consent", "idempotencyKey", "formVersion", "feeRevision", "remittanceLast5"].includes(key)) ||
      !isRecord(value.answers) || value.consent !== true ||
      typeof value.idempotencyKey !== "string" || value.idempotencyKey.length > 100 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.idempotencyKey) ||
      /[\x00-\x20\x7f]/.test(value.idempotencyKey) ||
      !Number.isSafeInteger(value.formVersion) || (value.formVersion as number) < 1 ||
      (value.feeRevision !== undefined && (!Number.isSafeInteger(value.feeRevision) || (value.feeRevision as number) < 0)) ||
      (value.remittanceLast5 !== undefined && typeof value.remittanceLast5 !== "string")) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 60_000;
  } catch {
    return false;
  }
}

/**
 * Internal core only. The future HTTP caller must enforce same-origin/CSRF,
 * bound the request stream and rate-limit before calling. No identity is
 * accepted from the body; kind explicitly selects one authenticated cookie.
 */
export async function submitParticipantRegistration(
  db: D1Database,
  kind: unknown,
  cookieHeader: string | null,
  slug: unknown,
  body: unknown,
): Promise<Outcome> {
  if ((kind !== "member" && kind !== "participant") ||
      typeof slug !== "string" || slug.length !== 32 || !/^[a-f0-9]{32}$/.test(slug) || !validBody(body)) {
    return { ok: false, code: "invalid" };
  }
  const selectedKind: PrincipalKind = kind;
  const submission = body;
  const token = readCookie(cookieHeader, kind === "member" ? MEMBER_COOKIE : PARTICIPANT_SESSION_COOKIE);
  if (!token) return { ok: false, code: "unauthorized" };
  try {
    const tokenHash = await secretHash(token);
    const ownerQuery = kind === "member"
      ? `SELECT m.user_id AS id FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.expires_at>${DB_NOW}`
      : `SELECT ps.participant_id AS id FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.expires_at>${DB_NOW}`;
    const owner = await db.prepare(ownerQuery).bind(tokenHash).first<{ id: string }>();
    if (!owner) return { ok: false, code: "unauthorized" };
    const formRow = await db.prepare("SELECT id,status,version,schema_json AS schemaJson FROM registration_forms WHERE slug=?")
      .bind(slug).first<FormRow>();
    if (!formRow) return { ok: false, code: "closed" };
    const form = normalizeRegistrationForm(JSON.parse(formRow.schemaJson));
    if (!form) return { ok: false, code: "unavailable" };
    const auth = kind === "member" ? MEMBER_AUTH : PARTICIPANT_AUTH;
    const ownerColumn = kind === "member" ? "member_id" : "participant_id";
    const idempotencyHash = await secretHash(JSON.stringify(["unified-registration-v1", formRow.id, selectedKind, owner.id, submission.idempotencyKey]));
    const sourceHash = await secretHash(JSON.stringify(["unified-registration-source-v1", formRow.id, selectedKind, owner.id]));

    async function prior(): Promise<Previous | null> {
      return await db.prepare(
        `SELECT s.id,i.status,s.form_version AS formVersion,s.schema_json AS schemaJson,s.answers_json AS answersJson FROM registration_submissions s JOIN registration_identities i ON i.submission_id=s.id AND i.form_id=s.form_id WHERE s.form_id=? AND s.idempotency_hash=? AND i.${ownerColumn}=? AND ${auth}`,
      ).bind(formRow!.id, idempotencyHash, owner!.id, tokenHash, owner!.id).first<Previous>();
    }
    function priorResult(previous: Previous): Outcome {
      if (previous.status !== "active" || previous.formVersion !== submission.formVersion) return { ok: false, code: "conflict" };
      try {
        const fields: unknown = JSON.parse(previous.schemaJson);
        if (!Array.isArray(fields)) return { ok: false, code: "unavailable" };
        const validation = validateRegistrationSubmission({ ...form!, fields }, submission.answers);
        if (!validation.ok || JSON.stringify(validation.answers) !== previous.answersJson) return { ok: false, code: "conflict" };
        return { ok: true, receiptId: previous.id, replayed: true };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    }

    const existing = await prior();
    if (existing) return priorResult(existing);
    if (formRow.status !== "open" || form.status !== "open" || formRow.version !== submission.formVersion) {
      return { ok: false, code: "closed" };
    }
    const validation = validateRegistrationSubmission(form, submission.answers);
    if (!validation.ok) return { ok: false, code: "invalid" };
    const remittanceLast5 = normalizeRemittanceLast5(submission.remittanceLast5);
    if (remittanceLast5 === null) return { ok: false, code: "invalid" };
    const fee = await db.prepare("SELECT COALESCE((SELECT amount FROM activity_fees WHERE activity_id=(SELECT activity_id FROM registration_forms WHERE id=?)),0) AS amount")
      .bind(formRow.id).first<{ amount: number }>();
    if (remittanceMissing(fee?.amount ?? 0, remittanceLast5)) return { ok: false, code: "invalid" };

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const ownerMember = kind === "member" ? owner.id : null;
    const ownerParticipant = kind === "participant" ? owner.id : null;
    try {
      const result = await db.batch([
        db.prepare(
          `INSERT INTO registration_submissions (id,form_id,form_version,schema_json,answers_json,consent,idempotency_hash,source_hash,submitted_at,payment_status,remittance_last5) SELECT ?,f.id,f.version,?,?,1,?,?,?,CASE WHEN COALESCE((SELECT amount FROM activity_fees WHERE activity_id=f.activity_id),0)=0 THEN 'not_required' ELSE 'unpaid' END,? FROM registration_forms f WHERE f.id=? AND f.status='open' AND f.version=? AND f.schema_json=? AND COALESCE((SELECT revision FROM activity_fees WHERE activity_id=f.activity_id),0)=? AND ${auth} AND NOT EXISTS (SELECT 1 FROM registration_identities i WHERE i.form_id=f.id AND i.status='active' AND i.${ownerColumn}=?) ON CONFLICT(form_id,idempotency_hash) DO NOTHING`,
        ).bind(id, JSON.stringify(form.fields), JSON.stringify(validation.answers), idempotencyHash, sourceHash, timestamp, remittanceLast5,
          formRow.id, formRow.version, formRow.schemaJson, submission.feeRevision ?? 0, tokenHash, owner.id, owner.id),
        db.prepare(
          `INSERT INTO registration_identities (submission_id,form_id,member_id,participant_id) SELECT s.id,s.form_id,?,? FROM registration_submissions s WHERE s.id=? AND s.form_id=? AND ${auth}`,
        ).bind(ownerMember, ownerParticipant, id, formRow.id, tokenHash, owner.id),
        db.prepare(
          `UPDATE registration_submissions SET consent=NULL WHERE id=? AND NOT EXISTS (SELECT 1 FROM registration_identities WHERE submission_id=? AND form_id=? AND ${ownerColumn}=? AND status='active')`,
        ).bind(id, id, formRow.id, owner.id),
      ]);
      if (result[0]?.meta?.changes === 1 && result[1]?.meta?.changes === 1) {
        return { ok: true, receiptId: id, replayed: false };
      }
    } catch {
      // On a conflicting retry, the original result is returned only through
      // the owner-scoped query below, which rechecks the live session.
    }
    const previous = await prior();
    if (previous) return priorResult(previous);
    const stillAuthorized = await db.prepare(`SELECT 1 AS ok WHERE ${auth}`).bind(tokenHash, owner.id).first();
    if (!stillAuthorized) return { ok: false, code: "unauthorized" };
    const currentForm = await db.prepare("SELECT status,version,schema_json AS schemaJson FROM registration_forms WHERE id=?")
      .bind(formRow.id).first<{ status: string; version: number; schemaJson: string }>();
    if (!currentForm || currentForm.status !== "open" || currentForm.version !== formRow.version ||
        currentForm.schemaJson !== formRow.schemaJson) return { ok: false, code: "closed" };
    const feeRevision = await db.prepare("SELECT COALESCE((SELECT revision FROM activity_fees WHERE activity_id=(SELECT activity_id FROM registration_forms WHERE id=?)),0) AS revision").bind(formRow.id).first<{revision:number}>();
    if (!feeRevision || feeRevision.revision !== (submission.feeRevision ?? 0)) return { ok: false, code: "conflict" };
    const active = await db.prepare(`SELECT 1 AS ok FROM registration_identities WHERE form_id=? AND ${ownerColumn}=? AND status='active'`)
      .bind(formRow.id, owner.id).first();
    return { ok: false, code: active ? "conflict" : "unavailable" };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

// Explicit extensions support isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { PARTICIPANT_SESSION_COOKIE, readCookie, secretHash } from "./participant-session.ts";
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { isRegistrationProfileMappingCompatible, normalizeRegistrationForm, validateRegistrationSubmission, type RegistrationField, type RegistrationForm, type RegistrationProfileKey } from "./registration-types.ts";

type Kind = "member" | "participant";
type FormRow = { id: string; version: number; schemaJson: string };
type ProfileRow = { id: string } & Partial<Record<RegistrationProfileKey, string>>;
type HistoricalRow = { submissionId: string; submittedAt: string; fieldType: string; answer: unknown };

const MEMBER_COOKIE = "puzzle_admin_session";
const DB_NOW = "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1)";
const MEMBER_AUTH = `EXISTS (SELECT 1 FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.expires_at>${DB_NOW})`;
const PARTICIPANT_AUTH = `EXISTS (SELECT 1 FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.expires_at>${DB_NOW})`;
const MEMBER_COLUMNS: Record<RegistrationProfileKey, string> = {
  displayName: "m.display_name", email: "m.email", phone: "m.phone",
  organization: "m.organization", position: "m.position",
};
const PARTICIPANT_COLUMNS: Partial<Record<RegistrationProfileKey, string>> = {
  displayName: "p.display_name", email: "p.email",
};

function addValue(values: Record<string, string>, form: RegistrationForm, field: RegistrationField, input: unknown) {
  if (typeof input !== "string" || !input.trim() || input.length > 1_000) return;
  const validation = validateRegistrationSubmission({ ...form, fields: [{ ...field, required: false }] }, { [field.id]: input });
  const value = validation.ok ? validation.answers[field.id] : null;
  if (typeof value === "string" && value) values[field.id] = value;
}

/**
 * Internal read-only core. The future caller must enforce same-origin, bounded
 * requests and rate limits. The chosen identity is resolved only from its
 * selected cookie; no email lookup or historical field-label guessing occurs.
 */
export async function getParticipantProfilePrefill(
  db: D1Database,
  kind: unknown,
  cookieHeader: string | null,
  slug: unknown,
): Promise<{ formVersion: number; values: Record<string, string> } | null> {
  if ((kind !== "member" && kind !== "participant") || typeof slug !== "string" ||
      slug.length !== 32 || !/^[a-f0-9]{32}$/.test(slug)) return null;
  const selectedKind: Kind = kind;
  const token = readCookie(cookieHeader, kind === "member" ? MEMBER_COOKIE : PARTICIPANT_SESSION_COOKIE);
  if (!token) return null;
  try {
    const tokenHash = await secretHash(token);
    const auth = selectedKind === "member" ? MEMBER_AUTH : PARTICIPANT_AUTH;
    const target = await db.prepare(
      `SELECT f.id,f.version,f.schema_json AS schemaJson FROM registration_forms f WHERE f.slug=? AND f.status='open' AND length(CAST(f.schema_json AS BLOB))<=2000000 AND ${auth}`,
    ).bind(slug, tokenHash).first<FormRow>();
    if (!target || !Number.isSafeInteger(target.version) || target.version < 1) return null;
    const form = normalizeRegistrationForm(JSON.parse(target.schemaJson));
    if (!form || form.status !== "open") return null;
    const mapped = form.fields.filter((field: RegistrationField) => field.profileKey !== undefined);
    const values: Record<string, string> = Object.create(null);
    const columns = selectedKind === "member" ? MEMBER_COLUMNS : PARTICIPANT_COLUMNS;
    const desired = mapped.filter((field: RegistrationField) => field.profileKey && columns[field.profileKey]);
    const projection = desired.map((field: RegistrationField) => {
      const column = columns[field.profileKey!];
      return `CASE WHEN length(${column})<=1000 THEN ${column} ELSE NULL END AS "${field.profileKey}"`;
    }).join(",");
    const sameForm = "f.id=? AND f.status='open' AND f.version=? AND f.schema_json=?";

    let owner: ProfileRow | null;
    if (selectedKind === "member") {
      owner = await db.prepare(
        `SELECT m.user_id AS id${projection ? "," + projection : ""} FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' JOIN registration_forms f ON ${sameForm} WHERE a.token_hash=? AND a.expires_at>${DB_NOW}`,
      ).bind(target.id, target.version, target.schemaJson, tokenHash).first<ProfileRow>();
    } else {
      owner = await db.prepare(
        `SELECT p.id AS id${projection ? "," + projection : ""} FROM participant_sessions ps JOIN participants p ON p.id=ps.participant_id JOIN participant_consent_state cs ON cs.participant_id=p.id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version JOIN registration_forms f ON ${sameForm} WHERE ps.token_hash=? AND ps.expires_at>${DB_NOW}`,
      ).bind(target.id, target.version, target.schemaJson, tokenHash).first<ProfileRow>();
    }
    if (!owner) return null;
    for (const field of desired) addValue(values, form, field, owner[field.profileKey!]);

    if (selectedKind === "participant") {
      const historicalFields = mapped.filter((field: RegistrationField) =>
        field.profileKey === "phone" || field.profileKey === "organization" || field.profileKey === "position");
      const fieldId = "json_extract(fields.fieldJson,'$.id')";
      const answerPath = `('$."' || ${fieldId} || '"')`;
      for (const field of historicalFields) {
        let cursorTime: string | null = null;
        let cursorId: string | null = null;
        for (let page = 0; page < 20; page++) {
          const rows: D1Result<HistoricalRow> = await db.prepare(
          `WITH recent AS (
            SELECT s.id,s.submitted_at,s.schema_json,s.answers_json
            FROM registration_identities i
            JOIN registration_submissions s ON s.id=i.submission_id AND s.form_id=i.form_id AND s.archived_at IS NULL
            JOIN participant_sessions ps ON ps.participant_id=i.participant_id
            JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch
            JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version
            JOIN registration_forms f ON ${sameForm}
            WHERE i.participant_id=? AND i.status='active' AND ps.token_hash=? AND ps.expires_at>${DB_NOW}
              AND length(CAST(s.schema_json AS BLOB))<=2000000 AND length(CAST(s.answers_json AS BLOB))<=60000
              AND (? IS NULL OR s.submitted_at<? OR (s.submitted_at=? AND s.id<?))
          ), fields AS (
            SELECT r.id,r.submitted_at,
              CASE WHEN j.type='object' THEN j.value ELSE '{}' END AS fieldJson,
              CASE WHEN json_valid(r.answers_json) THEN r.answers_json ELSE '{}' END AS answersJson
            FROM recent r, json_each(CASE WHEN json_valid(r.schema_json)
              THEN CASE WHEN json_type(r.schema_json)='array' THEN r.schema_json ELSE '[]' END
              ELSE '[]' END) j
            WHERE CAST(j.key AS INTEGER)<100
          ), candidates AS (
          SELECT fields.id AS submissionId,fields.submitted_at AS submittedAt,
            COUNT(*) AS count,MAX(CASE WHEN typeof(json_extract(fields.fieldJson,'$.type'))='text'
            AND length(json_extract(fields.fieldJson,'$.type'))<=32 THEN json_extract(fields.fieldJson,'$.type') ELSE NULL END) AS fieldType,
            MAX(json_type(fields.fieldJson,'$.sensitive')) AS sensitiveType,
            MAX(CASE WHEN typeof(${fieldId})='text' AND length(${fieldId}) BETWEEN 1 AND 100
              AND substr(${fieldId},1,1) GLOB '[A-Za-z0-9]'
              AND ${fieldId} NOT GLOB '*[^A-Za-z0-9_-]*'
              AND json_type(fields.answersJson,${answerPath})='text'
              AND length(json_extract(fields.answersJson,${answerPath}))<=1000
              THEN json_extract(fields.answersJson,${answerPath}) ELSE NULL END) AS answer
          FROM fields WHERE json_extract(fields.fieldJson,'$.profileKey')=?
          GROUP BY fields.id,fields.submitted_at
          )
          SELECT submissionId,submittedAt,fieldType,answer FROM candidates
          WHERE count=1 AND sensitiveType='true' AND answer IS NOT NULL AND length(trim(answer))>0
            AND (fieldType IN ('short_text','text') OR (?='phone' AND fieldType IN ('phone','tel')))
          ORDER BY submittedAt DESC,submissionId DESC LIMIT 50`,
          ).bind(target.id, target.version, target.schemaJson, owner.id, tokenHash,
            cursorTime, cursorTime, cursorTime, cursorId, field.profileKey, field.profileKey).all<HistoricalRow>();
          if (!rows.success || !Array.isArray(rows.results)) return null;
          for (const row of rows.results) {
            if (!isRegistrationProfileMappingCompatible(row.fieldType, field.profileKey)) continue;
            addValue(values, form, field, row.answer);
            if (Object.hasOwn(values, field.id)) break;
          }
          if (Object.hasOwn(values, field.id) || rows.results.length < 50) break;
          const last: HistoricalRow = rows.results[rows.results.length - 1];
          if (typeof last.submittedAt !== "string" || typeof last.submissionId !== "string") return null;
          if (page === 19) return null;
          cursorTime = last.submittedAt;
          cursorId = last.submissionId;
        }
      }
    }
    const ownerAuth = selectedKind === "member"
      ? `EXISTS (SELECT 1 FROM admin_sessions a JOIN members m ON m.user_id=a.user_id AND m.status='active' WHERE a.token_hash=? AND a.user_id=? AND a.expires_at>${DB_NOW})`
      : `EXISTS (SELECT 1 FROM participant_sessions ps JOIN participant_consent_state cs ON cs.participant_id=ps.participant_id AND cs.status='active' AND cs.epoch=ps.consent_epoch JOIN participant_terms_current t ON t.id=1 AND t.version=cs.terms_version WHERE ps.token_hash=? AND ps.participant_id=? AND ps.expires_at>${DB_NOW})`;
    const current = await db.prepare(
      `SELECT 1 AS ok FROM registration_forms f WHERE ${sameForm} AND ${ownerAuth}`,
    ).bind(target.id, target.version, target.schemaJson, tokenHash, owner.id).first();
    return current ? { formVersion: target.version, values } : null;
  } catch {
    return null;
  }
}

// Explicit extensions support the isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { DB_NOW } from "./participant-registration.ts";

/**
 * Retention counts from the participant's last activity date. Records move to
 * archive (kept, visible only to system administrators); nothing is deleted here.
 * Records with no dated activity are held and reported, never archived.
 */
export const RETENTION_DEFAULT_YEARS = 3;
export const RETENTION_MIN_YEARS = 1;
export const RETENTION_MAX_YEARS = 10;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Admin-only: the write is tied to a live administrator session in the same statement.
export const ADMIN_GUARD = `EXISTS (SELECT 1 FROM admin_sessions s JOIN members m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>${DB_NOW} AND m.role='admin' AND m.status='active')`;

export type RetentionPlan = {
  retentionYears: number;
  cutoff: string;
  dueSubmissionIds: string[];
  alreadyArchived: number;
  heldWithoutActivity: number;
};

/** Taipei calendar date (UTC+8) for the given instant. */
export function taipeiDate(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Date exactly `years` before `today`; a leap day that does not exist rolls forward, as JavaScript does. */
export function retentionCutoff(today: string, years: number): string {
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year - years, month - 1, day)).toISOString().slice(0, 10);
}

/** The later of the activity's start and end dates; null when either present date is malformed or none exists. */
export function activityLastDate(activity: { date?: unknown; endDate?: unknown } | undefined): string | null {
  if (!activity) return null;
  const values = [activity.date, activity.endDate].filter((value) => value !== undefined && value !== null && value !== "");
  if (!values.length || !values.every((value) => typeof value === "string" && DATE.test(value))) return null;
  return (values as string[]).sort().at(-1) ?? null;
}

export function validRetentionYears(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= RETENTION_MIN_YEARS && (value as number) <= RETENTION_MAX_YEARS;
}

type Row = { id: string; archivedAt: string | null; activityId: string; memberId: string | null; participantId: string | null };

/** Groups a person's registrations (member, participant, or lone anonymous submission) and decides each group. */
export async function planRetention(db: D1Database, now: Date): Promise<RetentionPlan> {
  const settings = await db.prepare("SELECT retention_years AS years FROM data_retention_settings WHERE id=1").first<{ years: number }>();
  const retentionYears = settings?.years ?? RETENTION_DEFAULT_YEARS;
  if (!validRetentionYears(retentionYears)) throw new Error("INVALID_RETENTION_SETTING");
  const workspace = await db.prepare("SELECT data FROM workspace_states WHERE id=1").first<{ data: string }>();
  const activities = new Map<string, { date?: unknown; endDate?: unknown }>();
  try {
    for (const activity of (JSON.parse(workspace?.data ?? "{}") as { activities?: Array<{ id?: unknown } & { date?: unknown; endDate?: unknown }> }).activities ?? []) {
      if (typeof activity.id === "string") activities.set(activity.id, activity);
    }
  } catch {
    // Unreadable activity data leaves every group without a date, so nothing is archived.
  }
  const rows = (await db.prepare(
    `SELECT s.id AS id,s.archived_at AS archivedAt,f.activity_id AS activityId,i.member_id AS memberId,i.participant_id AS participantId
     FROM registration_submissions s
     JOIN registration_forms f ON f.id=s.form_id
     LEFT JOIN registration_identities i ON i.submission_id=s.id AND i.form_id=s.form_id`,
  ).all<Row>()).results;

  const groups = new Map<string, { rows: Row[]; last: string | null; dated: boolean }>();
  for (const row of rows) {
    const key = row.memberId ? `member:${row.memberId}` : row.participantId ? `participant:${row.participantId}` : `submission:${row.id}`;
    const group = groups.get(key) ?? { rows: [], last: null, dated: true };
    group.rows.push(row);
    const last = activityLastDate(activities.get(row.activityId));
    if (last === null) group.dated = false;
    else if (group.last === null || last > group.last) group.last = last;
    groups.set(key, group);
  }

  const cutoff = retentionCutoff(taipeiDate(now), retentionYears);
  const dueSubmissionIds: string[] = [];
  let alreadyArchived = 0, heldWithoutActivity = 0;
  for (const group of groups.values()) {
    const open = group.rows.filter((row) => row.archivedAt === null);
    alreadyArchived += group.rows.length - open.length;
    if (!group.dated || group.last === null) { heldWithoutActivity += open.length; continue; }
    if (group.last < cutoff) dueSubmissionIds.push(...open.map((row) => row.id));
  }
  return { retentionYears, cutoff, dueSubmissionIds, alreadyArchived, heldWithoutActivity };
}

/** Archives the given submissions and revokes their QR codes in one transaction. Returns the number archived now. */
export async function archiveRegistrations(
  db: D1Database, ids: string[], now: Date, admin: { tokenHash: string; userId: string },
): Promise<{ archived: number }> {
  if (!ids.length) return { archived: 0 };
  const stamp = now.toISOString();
  const idList = JSON.stringify(ids);
  const results = await db.batch([
    db.prepare(`UPDATE registration_submissions SET archived_at=? WHERE archived_at IS NULL AND id IN (SELECT value FROM json_each(?)) AND ${ADMIN_GUARD}`)
      .bind(stamp, idList, admin.tokenHash, admin.userId),
    db.prepare(`UPDATE registration_qr_tokens SET revoked_at=${DB_NOW} WHERE revoked_at IS NULL AND submission_id IN (SELECT value FROM json_each(?)) AND ${ADMIN_GUARD}`)
      .bind(idList, admin.tokenHash, admin.userId),
    db.prepare(`INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,created_at) SELECT ?,'archive_registrations','retention',CAST((SELECT COUNT(*) FROM registration_submissions WHERE archived_at=? AND id IN (SELECT value FROM json_each(?))) AS TEXT),? WHERE ${ADMIN_GUARD}`)
      .bind(admin.userId, stamp, idList, stamp, admin.tokenHash, admin.userId),
  ]);
  return { archived: Number(results[0]?.meta?.changes ?? 0) };
}

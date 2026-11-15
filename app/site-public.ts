// Explicit extensions support the isolated native Node TypeScript tests.
// @ts-expect-error TS5097: shared tsconfig does not enable allowImportingTsExtensions.
import { activityLastDate, taipeiDate } from "./retention.ts";

/** Public site data. Only fields listed here may reach an anonymous visitor. */
export type PublicActivity = {
  id: string;
  name: string;
  date: string;
  endDate: string | null;
  location: string;
  status: string;
  registrationSlug: string | null;
};
export type PublicAnnouncement = { id: string; title: string; body: string; updatedAt: string };
export type PublicSite = { activities: PublicActivity[]; announcements: PublicAnnouncement[] };

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/** Activities are public only when a manager has opted them in (publicListing === true). */
export async function readPublicSite(db: D1Database, now: Date): Promise<PublicSite> {
  const workspace = await db.prepare("SELECT data FROM workspace_states WHERE id=1").first<{ data: string }>();
  let rows: Array<Record<string, unknown>> = [];
  try { rows = (JSON.parse(workspace?.data ?? "{}") as { activities?: Array<Record<string, unknown>> }).activities ?? []; } catch { rows = []; }
  const forms = (await db.prepare("SELECT activity_id AS activityId, slug, status FROM registration_forms").all<{ activityId: string; slug: string; status: string }>()).results;
  const today = taipeiDate(now);
  const activities: PublicActivity[] = rows
    .filter((row) => row.publicListing === true && typeof row.id === "string")
    .map((row) => {
      const id = row.id as string;
      const form = forms.find((item) => item.activityId === id);
      const last = activityLastDate(row as { date?: unknown; endDate?: unknown });
      const open = Boolean(form && form.status === "open" && (last === null || today <= last));
      return {
        id,
        name: text(row.name, 120),
        date: text(row.date, 10),
        endDate: typeof row.endDate === "string" && row.endDate ? row.endDate.slice(0, 10) : null,
        location: text(row.location, 120),
        status: text(row.status, 30),
        registrationSlug: open && form ? form.slug : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const announcements = (await db.prepare("SELECT id, title, body, updated_at AS updatedAt FROM site_announcements WHERE published=1 ORDER BY updated_at DESC LIMIT 20").all<PublicAnnouncement>()).results;
  return { activities, announcements: announcements.map((row) => ({ id: row.id, title: row.title, body: row.body, updatedAt: row.updatedAt })) };
}

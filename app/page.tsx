import { env } from "cloudflare:workers";
import { getMember } from "./admin-auth";
import SiteHome, { type SiteAnnouncement } from "./site/site-home";
import { readPublicSite, type PublicSite } from "./site-public";

export const dynamic = "force-dynamic";

const EMPTY: PublicSite = { activities: [], announcements: [] };

/** Taipei calendar day as YYYY-MM-DD (en-CA formats ISO-style). */
function taipeiDay(value: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

async function loadSite(now: Date): Promise<PublicSite> {
  if (!env.DB) return EMPTY;
  try {
    return await readPublicSite(env.DB, now);
  } catch (error) {
    // The public page must still render when the data cannot be read.
    console.error("public site data unavailable", error);
    return EMPTY;
  }
}

export default async function Home() {
  const now = new Date();
  const [member, site] = await Promise.all([getMember().catch(() => null), loadSite(now)]);
  const announcements: SiteAnnouncement[] = site.announcements.map((item) => {
    const updated = new Date(item.updatedAt);
    return { id: item.id, title: item.title, body: item.body, day: Number.isNaN(updated.getTime()) ? "" : taipeiDay(updated) };
  });
  return (
    <SiteHome
      activities={site.activities}
      announcements={announcements}
      today={taipeiDay(now)}
      signedIn={Boolean(member)}
    />
  );
}

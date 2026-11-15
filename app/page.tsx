import { env } from "cloudflare:workers";
import { getMember } from "./admin-auth";
import SiteHome, { type SiteAnnouncement } from "./site/site-home";
import { readPublicSite, type PublicSite } from "./site-public";
import { buildSiteContent, readSiteContent, type SiteContent } from "./site-content";

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

async function loadContent(): Promise<SiteContent> {
  if (!env.DB) return buildSiteContent(undefined).content;
  try {
    return await readSiteContent(env.DB);
  } catch (error) {
    // Editable copy falls back to the code defaults when it cannot be read.
    console.error("site content unavailable", error);
    return buildSiteContent(undefined).content;
  }
}

export default async function Home() {
  const now = new Date();
  const [member, site, content] = await Promise.all([getMember().catch(() => null), loadSite(now), loadContent()]);
  const announcements: SiteAnnouncement[] = site.announcements.map((item) => {
    const updated = new Date(item.updatedAt);
    return { id: item.id, title: item.title, body: item.body, day: Number.isNaN(updated.getTime()) ? "" : taipeiDay(updated) };
  });
  return (
    <SiteHome
      activities={site.activities}
      announcements={announcements}
      content={content}
      today={taipeiDay(now)}
      signedIn={Boolean(member)}
    />
  );
}

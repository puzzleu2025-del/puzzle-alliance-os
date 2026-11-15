// Editable public copy (前台內容). Pure module: no imports, so the native Node tests can load it directly.
// The stored JSON is merged onto DEFAULT_SITE_CONTENT, so the public page never breaks on missing or bad rows.

export type SiteContent = {
  tagline: string;
  hero: { line1: string; line2: string; emphasis: string[]; subtitle: string; location: string; locationNote: string };
  quickEntries: Array<{ title: string; text: string }>;
  sections: {
    activities: { title: string; subtitle: string; more: string };
    benefits: { title: string };
    faq: { title: string; more: string };
    news: { title: string; subtitle: string };
    calendar: { title: string; subtitle: string };
    register: { title: string; subtitle: string };
  };
  benefits: Array<{ title: string; text: string }>;
  faqs: Array<{ question: string; answer: string }>;
  bottomBanner: { title: string; text: string; badgeTitle: string; badgeText: string };
  footer: { text: string };
};

/** Maximum sizes. The editor and the API both enforce these. */
export const SITE_CONTENT_LIMITS = {
  tagline: 60,
  heroLine: 60,
  heroEmphasis: { count: 4, length: 12 },
  heroSubtitle: 200,
  heroLocation: 60,
  heroLocationNote: 40,
  quickEntries: { count: 3, title: 20, text: 60 },
  benefits: { count: 4, title: 20, text: 60 },
  faqs: { count: 6, question: 80, answer: 400 },
  sectionTitle: 30,
  sectionSubtitle: 120,
  sectionMore: 20,
  bannerTitle: 40,
  bannerText: 200,
  bannerBadgeTitle: 30,
  bannerBadgeText: 120,
  footer: 120,
} as const;

export const DEFAULT_SITE_CONTENT: SiteContent = {
  tagline: "找到自己的價值，發現適合的位子，透過真實參與一起成長",
  hero: {
    line1: "找到自己的價值，",
    line2: "發現適合的位子，並透過真實參與一起成長。",
    emphasis: ["價值", "位子", "真實參與"],
    subtitle: "拼圖聯盟是一個正在穩健發展的社群型協會。透過多元活動、交流與合作，讓不同背景、目標與專長的夥伴在真實互動中連結、學習、累積經驗，找到自己在群體中的獨特價值，一起拼出更大的可能。",
    location: "目前主要活動地區：台北市 / 新北市",
    locationNote: "歡迎一起參與、共同成長",
  },
  quickEntries: [
    { title: "我想看看活動", text: "瀏覽近期活動，從一場有興趣的聚會開始。" },
    { title: "我想認識社群", text: "了解拼圖聯盟的理念、特色與社群氛圍。" },
    { title: "我想加入會員", text: "成為正式會員，參與更多活動與共創機會。" },
  ],
  sections: {
    activities: { title: "近期精選活動", subtitle: "近期於台北市 / 新北市舉辦的活動，歡迎報名參與！", more: "查看更多活動" },
    benefits: { title: "加入會員後，你可以獲得…" },
    faq: { title: "參與指南 / 常見問題", more: "查看完整問答" },
    news: { title: "消息", subtitle: "團隊公告與活動提醒。" },
    calendar: { title: "行事曆", subtitle: "月份可切換，有活動的日子會標示圓點。" },
    register: { title: "線上報名", subtitle: "目前開放報名的活動，點選即可前往報名表。" },
  },
  benefits: [
    { title: "優先參與活動", text: "名額保留、訊息搶先通知" },
    { title: "多元交流連結", text: "認識不同背景與專長的夥伴" },
    { title: "實際參與成長", text: "在真實專案與活動中累積經驗" },
    { title: "共同建構社群", text: "參與社群發展，讓拼圖聯盟更完整" },
  ],
  faqs: [
    { question: "拼圖聯盟是什麼樣的組織？", answer: "拼圖聯盟是一個正在穩健發展的社群型協會，透過活動、交流與合作，讓成員彼此連結、一起成長。" },
    { question: "誰適合加入？需要什麼條件嗎？", answer: "歡迎對社群活動有興趣、願意與夥伴互動的人加入，不需要特定背景或經驗。" },
    { question: "目前的活動都在哪裡舉辦？", answer: "目前主要活動地區為台北市與新北市，各活動的地點與時間會列在活動卡片與行事曆中。" },
    { question: "申請會員後，接下來會怎麼進行？", answer: "會員資格確認後，即可優先報名活動並收到活動通知，之後也會依社群發展邀請你參與更多內容。" },
  ],
  bottomBanner: {
    title: "更多內容，將隨著社群一起成長",
    text: "除了現有的社群活動與交流，未來我們也會陸續推出更多內容，例如：主題講座、實作專案、經驗分享、資源媒合等，讓拼圖聯盟的服務更完整、更多元。",
    badgeTitle: "協會正在穩健建設中",
    badgeText: "內容與服務會依社群發展逐步擴充，歡迎你現在就加入，一起參與並見證成長！",
  },
  footer: { text: "活動、消息與行事曆的公開窗口。" },
};

type Issues = string[];
type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

function text(input: unknown, max: number, path: string, issues: Issues, fallback: string): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value || value.length > max) {
    issues.push(path);
    return fallback;
  }
  return value;
}

function list<T, D>(input: unknown, max: number, path: string, issues: Issues, fallback: D[], item: (value: unknown, path: string, issues: Issues) => T): T[] {
  if (!Array.isArray(input)) {
    issues.push(path);
    return fallback.map((value, index) => item(value, `${path}[${index}]`, []));
  }
  if (input.length > max) issues.push(`${path} 最多 ${max} 筆`);
  return input.slice(0, max).map((value, index) => item(value, `${path}[${index}]`, issues));
}

/** Builds a complete SiteContent. Invalid or missing fields fall back to defaults and are reported in `issues`. */
export function buildSiteContent(input: unknown): { content: SiteContent; issues: Issues } {
  const issues: Issues = [];
  const data: Obj = isObject(input) ? input : {};
  const D = DEFAULT_SITE_CONTENT;
  const L = SITE_CONTENT_LIMITS;
  const obj = (value: unknown, path: string): Obj => {
    if (isObject(value)) return value;
    issues.push(path);
    return {};
  };

  const hero = obj(data.hero, "hero");
  const sections = obj(data.sections, "sections");
  const activities = obj(sections.activities, "sections.activities");
  const benefitsSection = obj(sections.benefits, "sections.benefits");
  const faq = obj(sections.faq, "sections.faq");
  const news = obj(sections.news, "sections.news");
  const calendar = obj(sections.calendar, "sections.calendar");
  const register = obj(sections.register, "sections.register");
  const banner = obj(data.bottomBanner, "bottomBanner");
  const footer = obj(data.footer, "footer");

  const content: SiteContent = {
    tagline: text(data.tagline, L.tagline, "tagline", issues, D.tagline),
    hero: {
      line1: text(hero.line1, L.heroLine, "hero.line1", issues, D.hero.line1),
      line2: text(hero.line2, L.heroLine, "hero.line2", issues, D.hero.line2),
      // Blank emphasis entries are dropped; an empty list is valid (no colored words).
      emphasis: list<string, string>(hero.emphasis, L.heroEmphasis.count, "hero.emphasis", issues, D.hero.emphasis, (value, path, errors) =>
        typeof value === "string" && value.trim() === "" ? "" : text(value, L.heroEmphasis.length, path, errors, ""),
      ).filter(Boolean),
      subtitle: text(hero.subtitle, L.heroSubtitle, "hero.subtitle", issues, D.hero.subtitle),
      location: text(hero.location, L.heroLocation, "hero.location", issues, D.hero.location),
      locationNote: text(hero.locationNote, L.heroLocationNote, "hero.locationNote", issues, D.hero.locationNote),
    },
    quickEntries: list(data.quickEntries, L.quickEntries.count, "quickEntries", issues, D.quickEntries, (value, path, errors) => {
      const row = obj(value, path);
      return { title: text(row.title, L.quickEntries.title, `${path}.title`, errors, ""), text: text(row.text, L.quickEntries.text, `${path}.text`, errors, "") };
    }),
    sections: {
      activities: {
        title: text(activities.title, L.sectionTitle, "sections.activities.title", issues, D.sections.activities.title),
        subtitle: text(activities.subtitle, L.sectionSubtitle, "sections.activities.subtitle", issues, D.sections.activities.subtitle),
        more: text(activities.more, L.sectionMore, "sections.activities.more", issues, D.sections.activities.more),
      },
      benefits: { title: text(benefitsSection.title, L.sectionTitle, "sections.benefits.title", issues, D.sections.benefits.title) },
      faq: {
        title: text(faq.title, L.sectionTitle, "sections.faq.title", issues, D.sections.faq.title),
        more: text(faq.more, L.sectionMore, "sections.faq.more", issues, D.sections.faq.more),
      },
      news: {
        title: text(news.title, L.sectionTitle, "sections.news.title", issues, D.sections.news.title),
        subtitle: text(news.subtitle, L.sectionSubtitle, "sections.news.subtitle", issues, D.sections.news.subtitle),
      },
      calendar: {
        title: text(calendar.title, L.sectionTitle, "sections.calendar.title", issues, D.sections.calendar.title),
        subtitle: text(calendar.subtitle, L.sectionSubtitle, "sections.calendar.subtitle", issues, D.sections.calendar.subtitle),
      },
      register: {
        title: text(register.title, L.sectionTitle, "sections.register.title", issues, D.sections.register.title),
        subtitle: text(register.subtitle, L.sectionSubtitle, "sections.register.subtitle", issues, D.sections.register.subtitle),
      },
    },
    benefits: list(data.benefits, L.benefits.count, "benefits", issues, D.benefits, (value, path, errors) => {
      const row = obj(value, path);
      return { title: text(row.title, L.benefits.title, `${path}.title`, errors, ""), text: text(row.text, L.benefits.text, `${path}.text`, errors, "") };
    }),
    faqs: list(data.faqs, L.faqs.count, "faqs", issues, D.faqs, (value, path, errors) => {
      const row = obj(value, path);
      return { question: text(row.question, L.faqs.question, `${path}.question`, errors, ""), answer: text(row.answer, L.faqs.answer, `${path}.answer`, errors, "") };
    }),
    bottomBanner: {
      title: text(banner.title, L.bannerTitle, "bottomBanner.title", issues, D.bottomBanner.title),
      text: text(banner.text, L.bannerText, "bottomBanner.text", issues, D.bottomBanner.text),
      badgeTitle: text(banner.badgeTitle, L.bannerBadgeTitle, "bottomBanner.badgeTitle", issues, D.bottomBanner.badgeTitle),
      badgeText: text(banner.badgeText, L.bannerBadgeText, "bottomBanner.badgeText", issues, D.bottomBanner.badgeText),
    },
    footer: { text: text(footer.text, L.footer, "footer.text", issues, D.footer.text) },
  };
  return { content, issues };
}

/** Strict validation for writes: returns the content, or the list of problem fields. */
export function parseSiteContent(input: unknown): { content: SiteContent } | { issues: Issues } {
  const { content, issues } = buildSiteContent(input);
  return issues.length ? { issues } : { content };
}

/** Server-side reader. A missing row or unreadable JSON gives the code defaults; bad fields fall back per field. */
export async function readSiteContent(db: D1Database): Promise<SiteContent> {
  const row = await db.prepare("SELECT content FROM site_content WHERE id=1").first<{ content: string }>();
  if (!row) return buildSiteContent(undefined).content;
  let stored: unknown = null;
  try { stored = JSON.parse(row.content); } catch { stored = null; }
  return buildSiteContent(stored).content;
}

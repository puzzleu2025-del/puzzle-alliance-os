"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PublicActivity } from "../site-public";
import type { SiteContent } from "../site-content";
import SiteCalendar from "./calendar";
import { activityDateLabel, formatZhDate, lastDay, parseYmd, weekdayOf } from "./site-format";
import "./site.css";

export type SiteAnnouncement = { id: string; title: string; body: string; day: string };

export type SiteHomeProps = {
  activities: PublicActivity[];
  announcements: SiteAnnouncement[];
  /** Editable copy, merged on the server with code defaults. */
  content: SiteContent;
  /** Taipei calendar day, YYYY-MM-DD, computed on the server. */
  today: string;
  signedIn: boolean;
};

const QUICK_LINKS = ["#activities", "#about", "#join"];
const QUICK_ICONS: IconName[] = ["calendar", "people", "crown"];
const BENEFIT_ICONS: IconName[] = ["people", "share", "sprout", "diamond"];
const MAX_FEATURED = 3;

export default function SiteHome({ activities, announcements, content, today, signedIn }: SiteHomeProps) {
  const upcoming = activities.filter((activity) => lastDay(activity.date, activity.endDate) >= today);
  const featured = upcoming.slice(0, MAX_FEATURED);
  const openForms = activities.filter((activity) => activity.registrationSlug);
  const { hero, sections } = content;

  return (
    <div className="st-root">
      <a className="st-skip" href="#st-main">跳到主要內容</a>

      <header className="st-header">
        <div className="st-container st-topbar">
          <a className="st-brand" href="#top" aria-label="拼圖聯盟 首頁">
            <PuzzleMark />
            <span className="st-brand-text">
              <strong>拼圖聯盟</strong>
              <small>Puzzle Alliance</small>
            </span>
          </a>
          <p className="st-tagline">{content.tagline}</p>
          <nav className="st-nav" aria-label="網站選單">
            <ul>
              <li><a href="#top">首頁</a></li>
              <li><a href="#activities">近期活動</a></li>
              <li><a href="#about">關於我們</a></li>
              <li><a href="#join">會員專區</a></li>
            </ul>
          </nav>
          <div className="st-actions">
            <a className="st-btn st-btn-primary st-btn-sm" href="#join">
              <Icon name="person-plus" />加入會員
            </a>
            <a className="st-btn st-btn-outline st-btn-sm" href="/backoffice">{signedIn ? "進入後台" : "登入"}</a>
          </div>
        </div>
      </header>

      <main id="st-main">
        <section id="top" className="st-hero" aria-labelledby="st-hero-title">
          <div className="st-container st-hero-grid">
            <div className="st-hero-copy">
              <p className="st-hero-kicker">拼圖聯盟 / Puzzle Alliance</p>
              <h1 id="st-hero-title" className="st-hero-title">
                <span className="st-hero-line"><Emphasized text={hero.line1} words={hero.emphasis} /></span>
                <span className="st-hero-line"><Emphasized text={hero.line2} words={hero.emphasis} /></span>
              </h1>
              <p className="st-hero-sub">{hero.subtitle}</p>
              <p className="st-pill">
                <Icon name="pin" />
                <span>{hero.location}</span>
                {hero.locationNote && (
                  <>
                    <span className="st-pill-sep" aria-hidden="true" />
                    <span className="st-pill-note">{hero.locationNote}</span>
                  </>
                )}
              </p>
            </div>
            {/* Photo area is intentionally empty: a lavender field, no picture. */}
            <div className="st-hero-field" aria-hidden="true" />
          </div>
        </section>

        {content.quickEntries.length > 0 && (
          <section className="st-container st-quick" aria-label="快速入口">
            <ul className="st-quick-list">
              {content.quickEntries.map((entry, index) => (
                <li key={`${entry.title}-${index}`}>
                  <a className="st-quick-card" href={QUICK_LINKS[index] ?? "#top"}>
                    <span className="st-quick-icon" aria-hidden="true"><Icon name={QUICK_ICONS[index] ?? "calendar"} /></span>
                    <span className="st-quick-body">
                      <strong>{entry.title}</strong>
                      <span>{entry.text}</span>
                    </span>
                    <span className="st-quick-arrow" aria-hidden="true"><Icon name="arrow" /></span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div id="activities" className="st-container st-main-grid">
          <section className="st-col-main" aria-labelledby="st-activities-title">
            <div className="st-section-head">
              <h2 id="st-activities-title" className="st-section-title">{sections.activities.title}</h2>
              <p className="st-section-sub">{sections.activities.subtitle}</p>
              <a className="st-more" href="#calendar">{sections.activities.more}<Icon name="arrow" /></a>
            </div>
            {featured.length === 0 ? (
              <div className="st-empty">
                <p className="st-empty-title">目前沒有公開活動，敬請期待</p>
              </div>
            ) : (
              <ul className="st-cards">
                {featured.map((activity) => (
                  <li key={activity.id}><ActivityCard activity={activity} /></li>
                ))}
              </ul>
            )}
          </section>

          <aside className="st-col-side">
            <section id="join" className="st-side-block" aria-labelledby="st-benefits-title">
              <h2 id="st-benefits-title" className="st-section-title">{sections.benefits.title}</h2>
              {content.benefits.length > 0 && (
                <ul className="st-benefits">
                  {content.benefits.map((item, index) => (
                    <li key={`${item.title}-${index}`} className="st-benefit">
                      <span className="st-benefit-icon" aria-hidden="true"><Icon name={BENEFIT_ICONS[index] ?? "sprout"} /></span>
                      <strong>{item.title}</strong>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section id="faq" className="st-side-block" aria-labelledby="st-faq-title">
              <div className="st-side-head">
                <h2 id="st-faq-title" className="st-section-title">{sections.faq.title}</h2>
                <a className="st-more" href="#faq">{sections.faq.more}<Icon name="arrow" /></a>
              </div>
              {content.faqs.length > 0 && (
                <div className="st-faq">
                  {content.faqs.map((item, index) => (
                    <details key={`${item.question}-${index}`} className="st-faq-item">
                      <summary>
                        <span className="st-faq-q">Q{index + 1}</span>
                        <span className="st-faq-question">{item.question}</span>
                        <span className="st-faq-toggle" aria-hidden="true"><Icon name="plus" /></span>
                      </summary>
                      <p>{item.answer}</p>
                    </details>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>

        <section id="about" className="st-container st-banner-wrap" aria-labelledby="st-banner-title">
          <div className="st-banner">
            <div className="st-banner-art" aria-hidden="true" />
            <div className="st-banner-copy">
              <h2 id="st-banner-title" className="st-banner-title">{content.bottomBanner.title}</h2>
              <p>{content.bottomBanner.text}</p>
            </div>
            <aside className="st-banner-badge">
              <span className="st-banner-badge-icon" aria-hidden="true"><Icon name="chart" /></span>
              <div>
                <strong>{content.bottomBanner.badgeTitle}</strong>
                <p>{content.bottomBanner.badgeText}</p>
              </div>
            </aside>
          </div>
        </section>

        <section id="announcements" className="st-section st-section-tint" aria-labelledby="st-announcements-title">
          <div className="st-container">
            <SectionHead id="st-announcements-title" title={sections.news.title} subtitle={sections.news.subtitle} />
            {announcements.length === 0 ? (
              <EmptyState title="目前沒有消息" text="有新的公告時會顯示在這裡。" />
            ) : (
              <div className="st-news-grid">
                {announcements.map((item) => <Announcement key={item.id} item={item} />)}
              </div>
            )}
          </div>
        </section>

        <section id="calendar" className="st-section" aria-labelledby="st-calendar-title">
          <div className="st-container">
            <SectionHead id="st-calendar-title" title={sections.calendar.title} subtitle={sections.calendar.subtitle} />
            <SiteCalendar activities={activities.filter((activity) => parseYmd(activity.date))} today={today} />
          </div>
        </section>

        <section id="register" className="st-section st-section-tint" aria-labelledby="st-register-title">
          <div className="st-container">
            <SectionHead id="st-register-title" title={sections.register.title} subtitle={sections.register.subtitle} />
            {openForms.length === 0 ? (
              <EmptyState title="目前沒有開放報名的活動" text="報名開放後，會在這裡列出可以前往的活動。" />
            ) : (
              <ul className="st-reg-list">
                {openForms.map((activity) => (
                  <li key={activity.id} className="st-reg-item">
                    <div>
                      <p className="st-reg-name">{activity.name || "未命名活動"}</p>
                      <p className="st-reg-meta">
                        {activityDateLabel(activity.date, activity.endDate)}
                        {activity.location ? `　${activity.location}` : ""}
                      </p>
                    </div>
                    <a className="st-btn st-btn-primary st-btn-sm" href={`/r/${activity.registrationSlug}`}>
                      前往報名<span className="st-sr">：{activity.name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      <footer className="st-footer">
        <div className="st-container st-footer-row">
          <div className="st-footer-brand">
            <PuzzleMark />
            <div>
              <strong>拼圖聯盟</strong>
              <small>Puzzle Alliance</small>
              <p>{content.footer.text}</p>
            </div>
          </div>
          <nav className="st-footer-links" aria-label="頁尾選單">
            <a href="#top">首頁</a>
            <a href="#activities">近期活動</a>
            <a href="#announcements">消息</a>
            <a href="#calendar">行事曆</a>
            <a href="#about">關於我們</a>
            <a href="#join">加入會員</a>
          </nav>
          <a className="st-footer-backoffice" href="/backoffice">後台入口</a>
        </div>
      </footer>
    </div>
  );
}

function SectionHead({ id, title, subtitle }: { id: string; title: string; subtitle?: string }) {
  return (
    <header className="st-section-head st-section-head--plain">
      <h2 id={id} className="st-section-title">{title}</h2>
      {subtitle && <p className="st-section-sub">{subtitle}</p>}
    </header>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="st-empty">
      <p className="st-empty-title">{title}</p>
      <p>{text}</p>
    </div>
  );
}

function ActivityCard({ activity }: { activity: PublicActivity }) {
  const titleId = useId();
  const parts = parseYmd(activity.date);
  const week = weekdayOf(activity.date);
  const name = activity.name || "未命名活動";
  return (
    <article className="st-card" aria-labelledby={titleId}>
      <div className="st-card-media" aria-hidden="true">
        {/* Image area is intentionally empty: same height on every card, no picture. */}
        {activity.location && (
          <span className="st-card-loc">
            <Icon name="pin" />
            {activity.location}
          </span>
        )}
      </div>
      <div className="st-card-body">
        <div className="st-card-row">
          <time className="st-datebadge" dateTime={activity.date}>
            {parts && <span className="st-datebadge-md">{parts.m}/{parts.d}</span>}
            {week && <span className="st-datebadge-wd">（{week}）</span>}
          </time>
          <div className="st-card-text">
            <h3 id={titleId} className="st-card-title">{name}</h3>
            <p className="st-card-desc">{activityDateLabel(activity.date, activity.endDate)}</p>
            <p className="st-card-desc">{activity.registrationSlug ? "報名開放中，歡迎參與。" : "目前尚未開放報名。"}</p>
          </div>
        </div>
        {activity.registrationSlug && (
          <a className="st-card-link" href={`/r/${activity.registrationSlug}`}>
            前往報名<span className="st-sr">：{name}</span><Icon name="arrow" />
          </a>
        )}
      </div>
    </article>
  );
}

/** Collapsed to three lines; the toggle appears only when the clamped text really overflows (measured, so narrow screens are handled). */
function Announcement({ item }: { item: SiteAnnouncement }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const titleId = useId();

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => {
      if (!open) setClipped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, item.body]);

  return (
    <article className="st-news" aria-labelledby={titleId}>
      {item.day && <time className="st-news-day" dateTime={item.day}>{formatZhDate(item.day)}</time>}
      <h3 id={titleId} className="st-news-title">{item.title}</h3>
      <div id={bodyId} ref={bodyRef} className={`st-news-body${open ? "" : " is-clamped"}`}>{item.body}</div>
      {(clipped || open) && (
        <button type="button" className="st-news-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
          {open ? "收合內容" : "展開全文"}
        </button>
      )}
    </article>
  );
}

/** Splits text so that the given words render in the brand purple. */
function Emphasized({ text, words }: { text: string; words: string[] }) {
  const list = words.filter(Boolean).sort((a, b) => b.length - a.length);
  if (list.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${list.map(escapeRegExp).join("|")})`);
  return (
    <>
      {text.split(pattern).map((part, index) => (
        list.includes(part) ? <span key={index} className="st-em">{part}</span> : <span key={index}>{part}</span>
      ))}
    </>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type IconName = "calendar" | "people" | "crown" | "share" | "sprout" | "diamond" | "arrow" | "plus" | "pin" | "chart" | "person-plus";

const ICON_PATHS: Record<IconName, string[]> = {
  calendar: ["M4 5.5h16v14H4z", "M4 10h16", "M8.5 3.5v4", "M15.5 3.5v4"],
  people: ["M9 11.2a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6z", "M3.5 20c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5", "M16 5.8a3 3 0 0 1 0 5.6", "M17.5 15.2c2 .8 3.2 2.5 3.5 4.8"],
  crown: ["M3.5 8.5l4.3 4 4.2-6.7 4.2 6.7 4.3-4-1.7 10.5H5.2z", "M5.2 19h13.6"],
  share: ["M6 13.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z", "M17.5 9.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z", "M17.5 19.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z", "M8.1 11.3l7.3-3.7M8.1 12.7l7.3 3.7"],
  sprout: ["M12 20.5v-9", "M12 11.5C12 8 9.6 5.5 5.5 5.5c0 3.6 2.4 6 6.5 6z", "M12 13.5c0-3.2 2.4-5.4 6.5-5.4 0 3.3-2.4 5.4-6.5 5.4z"],
  diamond: ["M7 4h10l3.5 5-8.5 11L3.5 9z", "M3.5 9h17", "M10 4l-1.8 5L12 20l3.8-11L14 4"],
  arrow: ["M5 12h13.5", "M13 6.5l5.5 5.5-5.5 5.5"],
  plus: ["M12 5v14", "M5 12h14"],
  pin: ["M12 21s-6.5-6-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z"],
  chart: ["M5 20v-7", "M10 20V6", "M15 20v-10", "M20 20v-4"],
  "person-plus": ["M9.5 11a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z", "M3 20c.7-3.4 3.2-5.4 6.5-5.4", "M18 8v6M15 11h6"],
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg className="st-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICON_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

function PuzzleMark() {
  return (
    <svg className="st-brand-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="16" height="16" rx="6" fill="#6b2fa6" />
      <rect x="21" y="3" width="16" height="16" rx="6" fill="#9a6cd6" />
      <rect x="3" y="21" width="16" height="16" rx="6" fill="#9a6cd6" />
      <rect x="21" y="21" width="16" height="16" rx="6" fill="#4b1f7a" />
    </svg>
  );
}

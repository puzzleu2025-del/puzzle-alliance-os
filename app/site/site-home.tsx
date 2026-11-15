"use client";

import { useEffect, useId, useRef, useState } from "react";
import LoginForm from "../login-form";
import type { PublicActivity } from "../site-public";
import SiteCalendar from "./calendar";
import { activityDateLabel, formatZhDate, lastDay, parseYmd, weekdayOf, formatDate } from "./site-format";
import "./site.css";

export type SiteAnnouncement = { id: string; title: string; body: string; day: string };

export type SiteHomeProps = {
  activities: PublicActivity[];
  announcements: SiteAnnouncement[];
  /** Taipei calendar day, YYYY-MM-DD, computed on the server. */
  today: string;
  signedIn: boolean;
};

const TONES = ["", "st-tone-1", "st-tone-2", "st-tone-3"];

export default function SiteHome({ activities, announcements, today, signedIn }: SiteHomeProps) {
  const [loginOpen, setLoginOpen] = useState(false);
  const loginId = useId();
  const upcoming = activities.filter((activity) => lastDay(activity.date, activity.endDate) >= today);
  const openForms = activities.filter((activity) => activity.registrationSlug);

  return (
    <div className="st-root">
      <a className="st-skip" href="#st-main">跳到主要內容</a>

      <header className="st-header">
        <div className="st-container st-header-row">
          <a className="st-brand" href="/" aria-label="拼圖聯盟 首頁">
            <PuzzleMark />
            <span>拼圖聯盟</span>
          </a>
          <div className="st-header-actions">
            {signedIn ? (
              <a className="st-btn st-btn-primary st-btn-sm" href="/backoffice">進入後台</a>
            ) : (
              <button
                type="button"
                className="st-btn st-btn-ghost st-btn-sm"
                aria-expanded={loginOpen}
                aria-controls={loginId}
                onClick={() => setLoginOpen((open) => !open)}
              >
                後台登入
              </button>
            )}
          </div>
          <nav className="st-nav" aria-label="網站選單">
            <ul>
              <li><a href="#activities">活動</a></li>
              <li><a href="#announcements">消息</a></li>
              <li><a href="#calendar">行事曆</a></li>
              <li><a href="#register">報名</a></li>
            </ul>
          </nav>
        </div>
      </header>

      {!signedIn && (
        <section id={loginId} className="st-login" aria-label="後台登入" hidden={!loginOpen}>
          <div className="st-container">
            <div className="st-login-card">
              <LoginForm />
            </div>
          </div>
        </section>
      )}

      <main id="st-main">
        <section className="st-hero" aria-labelledby="st-hero-title">
          <div className="st-container st-hero-grid">
            <div>
              <p className="st-eyebrow">PUZZLE ALLIANCE</p>
              <h1 id="st-hero-title" className="st-hero-title">
                每一片都重要，<br />拼出我們的每一場活動
              </h1>
              <p className="st-lead">
                拼圖聯盟的近期活動、最新消息與行事曆都在這裡公開。想報名，從下方的活動卡片或報名區開始。
              </p>
              <div className="st-hero-actions">
                <a className="st-btn st-btn-primary" href="#activities">看近期活動</a>
                <a className="st-btn st-btn-ghost" href="#calendar">查看行事曆</a>
              </div>
              <ul className="st-hero-stats" aria-label="目前概況">
                <li><strong>{upcoming.length}</strong><span>場近期活動</span></li>
                <li><strong>{announcements.length}</strong><span>則消息</span></li>
                <li><strong>{openForms.length}</strong><span>場開放報名</span></li>
              </ul>
            </div>
            <PuzzleArt />
          </div>
        </section>

        <section id="activities" className="st-section" aria-labelledby="st-activities-title">
          <div className="st-container">
            <SectionHead id="st-activities-title" eyebrow="ACTIVITIES" title="近期活動" note="依日期排列，只顯示已公開的活動。" />
            {upcoming.length === 0 ? (
              <EmptyState title="目前沒有公開活動" text="活動公開後會顯示在這裡。" />
            ) : (
              <ul className="st-cards">
                {upcoming.map((activity, index) => (
                  <li key={activity.id}>
                    <ActivityCard activity={activity} tone={index % TONES.length} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section id="announcements" className="st-section st-section-tint" aria-labelledby="st-announcements-title">
          <div className="st-container">
            <SectionHead id="st-announcements-title" eyebrow="NEWS" title="消息" note="團隊公告與活動提醒。" />
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
            <SectionHead id="st-calendar-title" eyebrow="CALENDAR" title="行事曆" note="月份可切換，有活動的日子會標示圓點。" />
            <SiteCalendar activities={activities.filter((activity) => parseYmd(activity.date))} today={today} />
          </div>
        </section>

        <section id="register" className="st-section st-section-tint" aria-labelledby="st-register-title">
          <div className="st-container">
            <SectionHead id="st-register-title" eyebrow="REGISTER" title="線上報名" note="目前開放報名的活動，點選即可前往報名表。" />
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
                    <a className="st-btn st-btn-primary" href={`/r/${activity.registrationSlug}`}>
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
        <div className="st-strip" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="st-container st-footer-row">
          <div>
            <p className="st-footer-brand">拼圖聯盟</p>
            <p>活動、消息與行事曆的公開窗口。</p>
          </div>
          <p><a href="/backoffice">後台入口</a></p>
        </div>
      </footer>
    </div>
  );
}

function SectionHead({ id, eyebrow, title, note }: { id: string; eyebrow: string; title: string; note?: string }) {
  return (
    <header className="st-section-head">
      <p className="st-eyebrow">{eyebrow}</p>
      <h2 id={id} className="st-section-title">{title}</h2>
      {note && <p className="st-section-note">{note}</p>}
    </header>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="st-empty">
      <div className="st-empty-art" aria-hidden="true"><i /><i /><i className="is-missing" /><i /></div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function ActivityCard({ activity, tone }: { activity: PublicActivity; tone: number }) {
  const titleId = useId();
  const parts = parseYmd(activity.date);
  const name = activity.name || "未命名活動";
  return (
    <article className={`st-card ${TONES[tone]}`.trim()} aria-labelledby={titleId}>
      <div className="st-card-top">
        <time className="st-datebadge" dateTime={activity.date}>
          <span className="st-datebadge-month">{parts ? `${parts.m} 月` : ""}</span>
          <span className="st-datebadge-day">{parts?.d ?? ""}</span>
          <span className="st-datebadge-week">{weekdayOf(activity.date) ? `週${weekdayOf(activity.date)}` : ""}</span>
        </time>
        <div className="st-card-body">
          <h3 id={titleId} className="st-card-title">{name}</h3>
          <p className="st-card-meta">
            {activity.endDate && activity.endDate !== activity.date
              ? `${formatDate(activity.date)} – ${formatDate(activity.endDate)}`
              : formatZhDate(activity.date)}
          </p>
          {activity.location && <p className="st-card-meta">地點：{activity.location}</p>}
        </div>
      </div>
      <div className="st-card-foot">
        {activity.registrationSlug ? (
          <a className="st-btn st-btn-primary" href={`/r/${activity.registrationSlug}`}>
            報名<span className="st-sr">：{name}</span>
          </a>
        ) : (
          <span className="st-chip">目前未開放報名</span>
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

function PuzzleMark() {
  return (
    <svg className="st-brand-mark" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="15" height="15" rx="5" fill="#1d5656" />
      <rect x="19" y="2" width="15" height="15" rx="5" fill="#a33f1a" />
      <rect x="2" y="19" width="15" height="15" rx="5" fill="#c98a1b" />
      <rect x="19" y="19" width="15" height="15" rx="5" fill="#6c3b58" />
    </svg>
  );
}

function PuzzleArt() {
  return (
    <div className="st-art" aria-hidden="true">
      <span className="st-piece st-piece--teal st-knob-r" />
      <span className="st-piece st-piece--terra st-knob-b" />
      <span className="st-piece st-piece--mustard" />
      <span className="st-piece st-piece--sage st-knob-r" />
      <span className="st-piece st-piece--plum st-knob-b" />
      <span className="st-piece st-piece--gap" />
      <span className="st-piece st-piece--ink st-knob-r" />
      <span className="st-piece st-piece--cream st-knob-b" />
      <span className="st-piece st-piece--teal-soft" />
    </div>
  );
}

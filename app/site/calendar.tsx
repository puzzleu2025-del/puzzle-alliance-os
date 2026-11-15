"use client";

import { useMemo, useState } from "react";
import { activityDateLabel, addDays, lastDay, parseYmd, WEEKDAYS } from "./site-format";
import "./site.css";

export type CalendarActivity = {
  id: string;
  name: string;
  date: string;
  endDate: string | null;
  location: string;
  registrationSlug: string | null;
};

type Props = { activities: CalendarActivity[]; today: string };

const MAX_SPAN_DAYS = 62;
const pad = (value: number) => String(value).padStart(2, "0");

export default function SiteCalendar({ activities, today }: Props) {
  const base = parseYmd(today) ?? { y: 2000, m: 1, d: 1 };
  const [view, setView] = useState({ y: base.y, m: base.m });
  const [selected, setSelected] = useState<string | null>(null);

  const dated = useMemo(() => activities.filter((activity) => parseYmd(activity.date)), [activities]);

  // Each activity is listed on every day it spans (capped so a bad end date cannot run away).
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarActivity[]>();
    for (const activity of dated) {
      let cursor = activity.date;
      const last = lastDay(activity.date, activity.endDate);
      for (let i = 0; i < MAX_SPAN_DAYS && cursor <= last; i++) {
        const list = map.get(cursor) ?? [];
        list.push(activity);
        map.set(cursor, list);
        cursor = addDays(cursor, 1);
      }
    }
    return map;
  }, [dated]);

  const daysInMonth = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const monthStart = `${view.y}-${pad(view.m)}-01`;
  const monthEnd = `${view.y}-${pad(view.m)}-${pad(daysInMonth)}`;
  const keyOf = (day: number) => `${view.y}-${pad(view.m)}-${pad(day)}`;

  const cells: Array<number | null> = [
    ...Array.from({ length: new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay() }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<number | null>> = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));

  const monthActivities = dated
    .filter((activity) => activity.date <= monthEnd && lastDay(activity.date, activity.endDate) >= monthStart)
    .sort((a, b) => a.date.localeCompare(b.date));
  const listed = selected ? byDay.get(selected) ?? [] : monthActivities;
  const isCurrentMonth = view.y === base.y && view.m === base.m;

  const shiftMonth = (delta: number) => {
    const next = new Date(Date.UTC(view.y, view.m - 1 + delta, 1));
    setView({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1 });
    setSelected(null);
  };

  return (
    <div className="st-cal">
      <div className="st-cal-main">
        <div className="st-cal-head">
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => shiftMonth(-1)}>
            ‹ 上個月
          </button>
          <h3 className="st-cal-title" aria-live="polite">
            {view.y} 年 {view.m} 月
          </h3>
          <button type="button" className="st-btn st-btn-ghost st-btn-sm" onClick={() => shiftMonth(1)}>
            下個月 ›
          </button>
        </div>
        {!isCurrentMonth && (
          <p className="st-cal-back">
            <button type="button" className="st-link-btn" onClick={() => { setView({ y: base.y, m: base.m }); setSelected(null); }}>
              回到本月
            </button>
          </p>
        )}
        <table className="st-cal-table">
          <caption className="st-sr">{view.y} 年 {view.m} 月行事曆</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((weekday) => <th key={weekday} scope="col">{weekday}</th>)}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={weekIndex}>
                {week.map((day, dayIndex) => {
                  if (day === null) return <td key={dayIndex} aria-hidden="true" />;
                  const key = keyOf(day);
                  const items = byDay.get(key) ?? [];
                  const isToday = key === today;
                  const isSelected = selected === key;
                  const classes = ["st-cal-cell", items.length ? "has-activity" : "", isToday ? "is-today" : ""].filter(Boolean).join(" ");
                  return (
                    <td key={dayIndex}>
                      {items.length > 0 ? (
                        <button
                          type="button"
                          className={classes}
                          aria-pressed={isSelected}
                          aria-label={`${view.m} 月 ${day} 日，${items.length} 場活動`}
                          onClick={() => setSelected(isSelected ? null : key)}
                        >
                          <span className="st-cal-day">{day}</span>
                          <span className="st-cal-dots" aria-hidden="true">
                            {items.slice(0, 3).map((item) => <i key={item.id} />)}
                          </span>
                        </button>
                      ) : (
                        <span className={classes}>
                          <span className="st-cal-day">{day}</span>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="st-cal-legend"><i aria-hidden="true" /> 有公開活動的日子，點選可查看當天活動</p>
      </div>

      <div className="st-cal-list" aria-live="polite">
        <h4 className="st-cal-list-title">
          {selected ? `${parseYmd(selected)?.m} 月 ${parseYmd(selected)?.d} 日的活動` : `${view.m} 月的活動`}
        </h4>
        {listed.length === 0 ? (
          <div className="st-cal-empty">
            <p>本月目前沒有公開活動。</p>
          </div>
        ) : (
          <ul>
            {listed.map((activity) => (
              <li key={`${activity.id}-${activity.date}`}>
                <time className="st-cal-when" dateTime={activity.date}>{activityDateLabel(activity.date, activity.endDate)}</time>
                <strong>{activity.name || "未命名活動"}</strong>
                {activity.location && <span className="st-cal-where">{activity.location}</span>}
                {activity.registrationSlug && (
                  <a className="st-link-inline" href={`/r/${activity.registrationSlug}`}>
                    前往報名<span className="st-sr">：{activity.name}</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <button type="button" className="st-link-btn" onClick={() => setSelected(null)}>
            顯示整個月份
          </button>
        )}
      </div>
    </div>
  );
}

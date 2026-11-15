// Date helpers for the public site. Dates are plain YYYY-MM-DD strings (Taipei calendar days),
// so formatting is deterministic on server and client (no locale or time-zone drift on hydration).

export type YearMonthDay = { y: number; m: number; d: number };

export const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const pad = (value: number) => String(value).padStart(2, "0");

export function parseYmd(value: string | null | undefined): YearMonthDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

export function ymdString({ y, m, d }: YearMonthDay) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function addDays(value: string, days: number) {
  const parts = parseYmd(value);
  if (!parts) return value;
  return ymdString(fromUtc(new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days))));
}

function fromUtc(date: Date): YearMonthDay {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function weekdayOf(value: string) {
  const parts = parseYmd(value);
  return parts ? WEEKDAYS[new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay()] : "";
}

/** 2026.11.20 */
export function formatDate(value: string) {
  const parts = parseYmd(value);
  return parts ? `${parts.y}.${pad(parts.m)}.${pad(parts.d)}` : value;
}

/** 2026 年 11 月 20 日 */
export function formatZhDate(value: string) {
  const parts = parseYmd(value);
  return parts ? `${parts.y} 年 ${parts.m} 月 ${parts.d} 日` : value;
}

/** Single day: 2026.11.20（五）. Multi-day: 2026.11.20 – 2026.11.22. */
export function activityDateLabel(date: string, endDate: string | null) {
  if (endDate && endDate !== date && parseYmd(endDate)) return `${formatDate(date)} – ${formatDate(endDate)}`;
  const week = weekdayOf(date);
  return week ? `${formatDate(date)}（${week}）` : formatDate(date);
}

/** Last calendar day an activity touches. */
export function lastDay(date: string, endDate: string | null) {
  return endDate && parseYmd(endDate) && endDate >= date ? endDate : date;
}

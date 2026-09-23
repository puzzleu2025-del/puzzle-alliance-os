import type { RegistrationForm, RegistrationSubmission } from "./registration-types";

export type ReminderKind = "five_days" | "one_day";

function shiftDate(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00+08:00`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(date);
}

export function registrationReminderSchedule(activityDate: string) {
  return {
    five_days: shiftDate(activityDate, -5),
    one_day: shiftDate(activityDate, -1),
  } satisfies Record<ReminderKind, string>;
}

export function registrationEmail(form: RegistrationForm, submission: RegistrationSubmission) {
  const field = form.fields.find((item) => item.type === "email")
    ?? form.fields.find((item) => /電子郵件|email|e-mail/i.test(item.label));
  const answer = field ? submission.answers[field.id] : "";
  return typeof answer === "string" ? answer.trim() : "";
}

export function registrationDisplayName(form: RegistrationForm, submission: RegistrationSubmission) {
  const field = form.fields.find((item) => /姓名|名字|name/i.test(item.label));
  const answer = field ? submission.answers[field.id] : "";
  return typeof answer === "string" && answer.trim() ? answer.trim() : "參加者";
}

export function reminderMessage(
  kind: ReminderKind,
  activityName: string,
  activityDate: string,
  form: RegistrationForm,
  submission: RegistrationSubmission,
) {
  const days = kind === "five_days" ? "5 天" : "1 天";
  return `${registrationDisplayName(form, submission)}您好：提醒您「${activityName}」將於 ${activityDate} 舉行，距離活動還有 ${days}。若行程有變，請儘早聯絡活動團隊。`;
}

export function reminderRecipients(form: RegistrationForm, submissions: RegistrationSubmission[]) {
  return submissions.flatMap((submission) => {
    const email = registrationEmail(form, submission);
    return email ? [{ submission, email }] : [];
  });
}

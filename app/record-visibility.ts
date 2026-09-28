import type { Activity, Meeting, Task } from "./management-panels";

const completed = new Set(["完成", "已完成", "結束", "已結束"]);
export const canViewHistory = (role?: string) => role === "admin" || role === "manager";
export function activityEnded(activity: Activity, now = new Date()) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(now);
  return completed.has(activity.status) || Boolean(activity.endDate && /^\d{4}-\d{2}-\d{2}$/.test(activity.endDate) && activity.endDate < today);
}
export function meetingEnded(meeting: Meeting, now = new Date()) {
  const end = Date.parse(meeting.endTime ?? "");
  return completed.has(meeting.status) || (Number.isFinite(end) && end < now.getTime());
}
export function taskEnded(task: Task, activities: Activity[], now = new Date()) {
  return completed.has(task.status) || task.status === "不適用" || activities.some((activity) => activity.id === task.activityId && activityEnded(activity, now));
}

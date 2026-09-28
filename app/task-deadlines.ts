type DeadlineActivity = {
  date?: string;
  phasePlans?: Record<string, { due?: string }>;
};
type DeadlineTask = { activityId?: string; due?: string; startDate?: string; phaseId?: string };

const phaseWeeks: Record<string, number> = { P1: -7, P2: -7, P3: -5, P4: -3, P5: -2, P6: -1, P7: 0, P8: 0, P9: 2 };

export function validTaskDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function taskDeadlineLimit(activity: DeadlineActivity | undefined, phaseId?: string) {
  if (!activity?.date || !validTaskDate(activity.date) || !phaseId || !(phaseId in phaseWeeks)) return "";
  const date = new Date(`${activity.date}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + phaseWeeks[phaseId] * 7);
  const baseline = date.toISOString().slice(0, 10);
  const override = activity.phasePlans?.[phaseId]?.due;
  return override && validTaskDate(override) && override < baseline ? override : baseline;
}

export function taskDeadlineError(task: DeadlineTask, activity: DeadlineActivity | undefined) {
  if (task.activityId && (!activity?.date || !validTaskDate(activity.date))) return "活動日期無效，無法計算任務階段期限";
  if (activity && !task.phaseId) return "活動任務請先選擇甘特階段，才能制定截止日期";
  if (task.phaseId && !(task.phaseId in phaseWeeks)) return "請選擇有效的甘特階段";
  if (!task.due || !validTaskDate(task.due)) return "請填寫有效的任務截止日期";
  if (task.startDate && (!validTaskDate(task.startDate) || task.startDate > task.due)) return "任務開始日期不可晚於截止日期";
  const limit = taskDeadlineLimit(activity, task.phaseId);
  return limit && task.due > limit ? `${task.phaseId} 任務可提前，但不可晚於階段截止日 ${limit}` : "";
}

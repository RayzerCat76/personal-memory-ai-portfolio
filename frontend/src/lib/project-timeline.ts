import type { StudyRecord } from "@/lib/study-store";

export type ProjectTimelineKind = "Milestone" | "Project task" | "Milestone task" | "Reminder";
export type ProjectTimelineItem = {
  key: string;
  kind: ProjectTimelineKind;
  title: string;
  parent?: string;
  dateLabel: string;
  sortTime: number | null;
  status: string;
  temporal: string;
};

const kindRank: Record<ProjectTimelineKind, number> = {
  Milestone: 0,
  "Project task": 1,
  "Milestone task": 2,
  Reminder: 3,
};

function localDateTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
}

function formatDate(value: string): string {
  const time = localDateTime(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })
    : value;
}

function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateTemporal(date: string, now: Date): string {
  const today = dayKey(now);
  if (date < today) return "Past date";
  if (date === today) return "Today";
  return "Upcoming";
}

function taskTemporal(date: string, done: boolean, now: Date): string {
  if (done) return "Complete";
  const today = dayKey(now);
  if (date < today) return "Past due";
  if (date === today) return "Due today";
  return "Upcoming";
}

function reminderTemporal(time: number, status: "scheduled" | "cancelled", now: Date): string {
  if (status === "cancelled") return "Cancelled";
  return time <= now.getTime() ? "Due now" : "Scheduled";
}

function itemSort(a: ProjectTimelineItem, b: ProjectTimelineItem): number {
  if (a.sortTime !== null && b.sortTime !== null && a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
  return kindRank[a.kind] - kindRank[b.kind] || a.title.localeCompare(b.title) || a.key.localeCompare(b.key);
}

export function projectTimeline(record: StudyRecord, now = new Date()): { dated: ProjectTimelineItem[]; unscheduled: ProjectTimelineItem[] } {
  if (record.kind !== "project") return { dated: [], unscheduled: [] };
  const items: ProjectTimelineItem[] = [];

  for (const milestone of record.milestones ?? []) {
    items.push({
      key: `milestone:${milestone.id}`,
      kind: "Milestone",
      title: milestone.title,
      dateLabel: milestone.due ? formatDate(milestone.due) : "",
      sortTime: milestone.due ? localDateTime(milestone.due) : null,
      status: milestone.status === "in-progress" ? "In progress" : milestone.status ? milestone.status[0].toUpperCase() + milestone.status.slice(1) : "Not set",
      temporal: milestone.due ? dateTemporal(milestone.due, now) : "Unscheduled",
    });

    for (const task of milestone.tasks) {
      items.push({
        key: `milestone-task:${milestone.id}:${task.id}`,
        kind: "Milestone task",
        title: task.title,
        parent: milestone.title,
        dateLabel: task.due ? formatDate(task.due) : "",
        sortTime: task.due ? localDateTime(task.due) : null,
        status: task.done ? "Complete" : "Open",
        temporal: task.due ? taskTemporal(task.due, task.done, now) : "Unscheduled",
      });
    }
  }

  for (const task of record.tasks) {
    items.push({
      key: `project-task:${task.id}`,
      kind: "Project task",
      title: task.title,
      dateLabel: task.due ? formatDate(task.due) : "",
      sortTime: task.due ? localDateTime(task.due) : null,
      status: task.done ? "Complete" : "Open",
      temporal: task.due ? taskTemporal(task.due, task.done, now) : "Unscheduled",
    });
  }

  for (const reminder of record.reminders ?? []) {
    const time = Date.parse(reminder.scheduledFor);
    items.push({
      key: `reminder:${reminder.id}`,
      kind: "Reminder",
      title: reminder.title,
      dateLabel: Number.isFinite(time) ? new Date(time).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : reminder.scheduledFor,
      sortTime: Number.isFinite(time) ? time : null,
      status: reminder.status === "cancelled" ? "Cancelled" : "Scheduled",
      temporal: Number.isFinite(time) ? reminderTemporal(time, reminder.status, now) : "Unscheduled",
    });
  }

  return {
    dated: items.filter(item => item.sortTime !== null).sort(itemSort),
    unscheduled: items.filter(item => item.sortTime === null).sort(itemSort),
  };
}
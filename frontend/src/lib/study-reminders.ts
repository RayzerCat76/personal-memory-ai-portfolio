import type { StudyReminder } from "@/lib/study-store";

export const reminderQuietHours = {
  startHour: 22,
  endHour: 7,
  label: "10:00 pm–7:00 am",
} as const;

export const reminderDeliveryStorageKey = "personal-study-reminder-delivery-v1";

export function isReminderQuietTime(date: Date): boolean {
  const hour = date.getHours();
  return hour >= reminderQuietHours.startHour || hour < reminderQuietHours.endHour;
}

export function reminderOccurrenceKey(projectId: string, reminder: StudyReminder): string {
  return `${projectId}:${reminder.id}:${reminder.scheduledFor}`;
}

export function toDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fromDateTimeLocal(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function formatReminderTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Invalid time";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function snoozedReminderTime(minutes: number, now = new Date()): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

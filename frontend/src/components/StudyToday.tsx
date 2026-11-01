"use client";

import { useEffect, useState } from "react";
import { listStudy, saveStudy, StudyRecord, StudyReminder } from "@/lib/study-store";
import { formatReminderTime, reminderQuietHours, snoozedReminderTime } from "@/lib/study-reminders";
import { useUiLocale } from "@/lib/ui-locale";

type ReminderItem = { reminder: StudyReminder; project: StudyRecord };
type PermissionState = NotificationPermission | "unsupported";

export default function StudyToday({ open }: { open: (view: "notes" | "projects") => void }) {
  const { locale, t } = useUiLocale();
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [permission, setPermission] = useState<PermissionState>("unsupported");
  const [reminderNotice, setReminderNotice] = useState("");

  async function refresh() { setRecords(await listStudy()); }

  useEffect(() => {
    void refresh().catch(() => setRecords([]));
    setPermission("Notification" in window ? Notification.permission : "unsupported");
    const onChange = () => { void refresh().catch(() => undefined); };
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    window.addEventListener("personal-study-changed", onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("personal-study-changed", onChange);
    };
  }, []);
  const activeRecords = records.filter(record => !record.archived);
  const note = activeRecords.filter(r => r.kind === "note")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))[0];
  const next = activeRecords.filter(r => r.kind === "project")
    .flatMap(project => project.tasks.filter(t => !t.done).map(task => ({ task, project })))
    .sort((a, b) => (a.task.due || "9999").localeCompare(b.task.due || "9999"))[0];
  const reminders: ReminderItem[] = activeRecords.filter(r => r.kind === "project")
    .flatMap(project => (project.reminders ?? [])
      .filter(reminder => reminder.status === "scheduled")
      .map(reminder => ({ reminder, project })))
    .sort((a, b) => a.reminder.scheduledFor.localeCompare(b.reminder.scheduledFor));
  const dueReminders = reminders.filter(item => Date.parse(item.reminder.scheduledFor) <= now.getTime());
  const nextReminder = reminders[0];

  async function enableNotifications() {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result);
    setReminderNotice(result === "granted" ? t("Notifications enabled while this app is open.", "应用打开时已启用浏览器通知。") : t("Browser notifications were not enabled. Reminders still appear here.", "未启用浏览器通知；提醒仍会显示在这里。"));
    if (result === "granted") window.dispatchEvent(new Event("personal-study-reminder-check"));
  }

  async function snooze(item: ReminderItem) {
    try {
      const saved = await saveStudy({
        ...item.project,
        reminders: (item.project.reminders ?? []).map(reminder => reminder.id === item.reminder.id
          ? { ...reminder, scheduledFor: snoozedReminderTime(10), status: "scheduled" as const }
          : reminder),
      });
      setRecords(current => current.map(record => record.id === saved.id ? saved : record));
      setNow(new Date());
      setReminderNotice(t("Reminder snoozed for 10 minutes.", "提醒已延后 10 分钟。"));
    } catch (error) {
      setReminderNotice(error instanceof Error ? error.message : t("Could not snooze reminder.", "无法延后提醒。"));
      void refresh().catch(() => undefined);
    }
  }
  return <section className="flowSection studyPanel">
    <h2>{t("A little progress today", "今天的一点进展")}</h2>
    {next ? <p>{next.task.title} · {next.project.title}{next.task.due ? ` · ${t("Due", "截止")} ${next.task.due}` : ""} <button onClick={() => open("projects")}>{t("Open projects", "打开项目")}</button></p>
      : <p>{t("No pending study tasks.", "没有待处理的学习任务。")} <button onClick={() => open("projects")}>{t("Your projects", "你的项目")}</button></p>}

    {nextReminder && <div className="memoryEntry" aria-label={t("Study reminders", "学习提醒")}>
      <h3>{t("Reminders", "提醒")}</h3>
      {dueReminders.length > 0 ? <>
        {dueReminders.slice(0, 3).map(item => <p key={`${item.project.id}:${item.reminder.id}`}>
          <strong>{t("Due now", "现在到期")}:</strong> {item.reminder.title} · {item.project.title} · {formatReminderTime(item.reminder.scheduledFor)}{" "}
          <button onClick={() => void snooze(item)}>{t("Snooze 10 min", "延后 10 分钟")}</button>
        </p>)}
        {dueReminders.length > 3 && <small>+{dueReminders.length - 3} {t("more due reminders in Projects.", "条到期提醒可在项目中查看。")}</small>}
      </> : <p><strong>{t("Next reminder", "下一个提醒")}:</strong> {nextReminder.reminder.title} · {nextReminder.project.title} · {formatReminderTime(nextReminder.reminder.scheduledFor)}</p>}
      <div className="reviewActions"><button onClick={() => open("projects")}>{t("Open projects", "打开项目")}</button>
        {permission === "default" && <button onClick={() => void enableNotifications()}>{t("Enable browser notifications", "启用浏览器通知")}</button>}
      </div>
      {permission === "granted" && <small>{t("Browser notifications are enabled while this app is open.", "应用打开时已启用浏览器通知。")}</small>}
      {permission === "denied" && <small>{t("Browser notifications are blocked. In-app reminders still work.", "浏览器通知已被阻止；应用内提醒仍可使用。")}</small>}
      {permission === "unsupported" && <small>{t("This browser does not expose notifications. In-app reminders still work.", "此浏览器不支持通知；应用内提醒仍可使用。")}</small>}
      <small> {t("Quiet hours", "免打扰时段")}: {reminderQuietHours.label}. {t("Due reminders remain visible here during quiet hours.", "免打扰时段内，到期提醒仍会显示在这里。")}</small>
      {reminderNotice && <p role="status">{reminderNotice}</p>}
    </div>}

    {note ? <p>{note.pinned ? t("Pinned note", "置顶笔记") : t("Recent note", "最近笔记")}: {note.title} <button onClick={() => open("notes")}>{t("Open notes", "打开笔记")}</button></p>
      : <button onClick={() => open("notes")}>{t("Add your first note", "添加第一条笔记")}</button>}
  </section>;
}

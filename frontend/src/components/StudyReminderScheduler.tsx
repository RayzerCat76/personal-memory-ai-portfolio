"use client";

import { useEffect } from "react";
import { listStudy } from "@/lib/study-store";
import {
  isReminderQuietTime,
  reminderDeliveryStorageKey,
  reminderOccurrenceKey,
} from "@/lib/study-reminders";

const checkEveryMs = 30_000;

type DeliveryLedger = Record<string, string>;

function readLedger(): DeliveryLedger {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(reminderDeliveryStorageKey) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as DeliveryLedger : {};
  } catch {
    return {};
  }
}

function writeLedger(ledger: DeliveryLedger) {
  const trimmed = Object.fromEntries(Object.entries(ledger)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 1000));
  try { window.localStorage.setItem(reminderDeliveryStorageKey, JSON.stringify(trimmed)); } catch { /* Best-effort duplicate suppression. */ }
}
export default function StudyReminderScheduler() {
  useEffect(() => {
    let stopped = false;

    async function checkReminders() {
      if (stopped || !("Notification" in window) || Notification.permission !== "granted") return;
      const now = new Date();
      if (isReminderQuietTime(now)) return;

      const records = await listStudy();
      if (stopped) return;
      const ledger = readLedger();
      let changed = false;

      for (const project of records.filter(record => record.kind === "project" && !record.archived)) {
        for (const reminder of project.reminders ?? []) {
          if (reminder.status !== "scheduled" || Date.parse(reminder.scheduledFor) > now.getTime()) continue;
          const key = reminderOccurrenceKey(project.id, reminder);
          if (ledger[key]) continue;
          try {
            new Notification("Study reminder", {
              body: `${reminder.title} · ${project.title}`,
              tag: `study-reminder:${project.id}:${reminder.id}`,
            });
            ledger[key] = now.toISOString();
            changed = true;
          } catch {
            // Keep the occurrence undelivered so a later app-open check can retry.
          }
        }
      }

      if (changed) writeLedger(ledger);
    }
    const onCheck = () => { void checkReminders(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void checkReminders(); };

    void checkReminders();
    const timer = window.setInterval(onCheck, checkEveryMs);
    window.addEventListener("personal-study-changed", onCheck);
    window.addEventListener("personal-study-reminder-check", onCheck);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("personal-study-changed", onCheck);
      window.removeEventListener("personal-study-reminder-check", onCheck);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}

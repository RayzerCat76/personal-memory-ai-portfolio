"use client";
import { useEffect, useState } from "react";
import styles from "./Study.module.css";
import StudySyncConflictReview from "./StudySyncConflictReview";
import ProjectTimeline from "./ProjectTimeline";
import { attachStudyFile, deleteStudy, exportStudy, listStudy, readStudyAttachment, restoreStudy, saveStudy, StudyAttachmentRef, StudyMilestoneStatus, StudyRecord } from "@/lib/study-store";
import { formatReminderTime, fromDateTimeLocal, reminderQuietHours, snoozedReminderTime, toDateTimeLocal } from "@/lib/study-reminders";
import { useUiLocale } from "@/lib/ui-locale";

const milestoneStatusLabel: Record<StudyMilestoneStatus, string> = { "": "Not set", planned: "Planned", "in-progress": "In progress", complete: "Complete" };
const milestoneStatusLabelZh: Record<StudyMilestoneStatus, string> = { "": "未设置", planned: "已计划", "in-progress": "进行中", complete: "已完成" };

function nextScheduledReminder(record: StudyRecord) {
  return (record.reminders ?? []).filter(reminder => reminder.status === "scheduled")
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];
}

export default function Study({ kind }: { kind: "note" | "project" }) {
  const { locale, t } = useUiLocale();
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [draft, setDraft] = useState<StudyRecord | null>(null);
  const [savedDraft, setSavedDraft] = useState<StudyRecord | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [due, setDue] = useState("");
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");
  const [milestoneStatus, setMilestoneStatus] = useState<StudyMilestoneStatus>("");
  const [milestoneTaskTitle, setMilestoneTaskTitle] = useState("");
  const [milestoneTaskDue, setMilestoneTaskDue] = useState("");
  const [milestoneTaskTargetId, setMilestoneTaskTargetId] = useState("");
  const [linkNoteTargetId, setLinkNoteTargetId] = useState("");
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  async function refresh() { setRecords(await listStudy()); }
  useEffect(() => { refresh().catch(() => setNotice(t("Local storage is unavailable. Export any open work before leaving.", "本地存储不可用。离开前请导出当前工作。"))); }, []);
  useEffect(() => {
    const onSync = () => { void refresh().catch(() => undefined); };
    window.addEventListener("personal-study-sync-applied", onSync);
    return () => window.removeEventListener("personal-study-sync-applied", onSync);
  }, []);

  function resetProjectInputs() {
    setTaskTitle("");
    setDue("");
    setMilestoneTitle("");
    setMilestoneDue("");
    setMilestoneStatus("");
    setMilestoneTaskTitle("");
    setMilestoneTaskDue("");
    setMilestoneTaskTargetId("");
    setLinkNoteTargetId("");
    setReminderTitle("");
    setReminderAt("");
  }

  function beginDraft(record: StudyRecord) {
    const opened = structuredClone(record);
    if (opened.kind === "project") {
      opened.nextAction ??= "";
      opened.milestones ??= [];
      opened.linkedNoteIds ??= [];
      opened.reminders ??= [];
    }
    setDraft(opened);
    setSavedDraft(structuredClone(opened));
    resetProjectInputs();
    if (opened.kind === "project") {
      if (opened.milestones?.length) setMilestoneTaskTargetId(opened.milestones[0].id);
      const linked = new Set(opened.linkedNoteIds ?? []);
      setLinkNoteTargetId(records.find(item => item.kind === "note" && !item.archived && !linked.has(item.id))?.id ?? "");
    }
    setNotice("");
  }

  function closeEditor() {
    if (!draft) return;
    const pendingInputs = !!taskTitle.trim() || !!due || !!milestoneTitle.trim() || !!milestoneDue || !!milestoneStatus
      || !!milestoneTaskTitle.trim() || !!milestoneTaskDue || !!reminderTitle.trim() || !!reminderAt;
    const changed = !savedDraft || JSON.stringify(draft) !== JSON.stringify(savedDraft) || pendingInputs;
    if (changed && !window.confirm(t("Discard unsaved changes?", "放弃尚未保存的更改吗？"))) return;
    setDraft(null);
    setSavedDraft(null);
    resetProjectInputs();
    if (changed) setNotice(t("Unsaved changes discarded.", "已放弃未保存的更改。"));
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setNotice(t("Saving…", "保存中…"));
    try {
      const saved = await saveStudy(draft);
      setDraft(saved);
      setSavedDraft(structuredClone(saved));
      resetProjectInputs();
      if (saved.kind === "project") {
        if (saved.milestones?.length) setMilestoneTaskTargetId(saved.milestones[0].id);
        const linked = new Set(saved.linkedNoteIds ?? []);
        setLinkNoteTargetId(records.find(item => item.kind === "note" && !item.archived && !linked.has(item.id))?.id ?? "");
      }
      try {
        await refresh();
        setNotice(t("✓ Changes saved", "✓ 更改已保存"));
      } catch {
        setNotice(t("✓ Changes saved, but the list could not refresh.", "✓ 更改已保存，但列表刷新失败。"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Could not save.", "无法保存。");
      setNotice(locale === "zh" ? `更改未保存 — ${message}` : `Changes not saved — ${message}`);
    } finally {
      setBusy(false);
    }
  }

  function hasUnsavedEditorWork(): boolean {
    if (!draft || !savedDraft) return true;
    const pendingInputs = !!taskTitle.trim() || !!due || !!milestoneTitle.trim() || !!milestoneDue || !!milestoneStatus
      || !!milestoneTaskTitle.trim() || !!milestoneTaskDue || !!reminderTitle.trim() || !!reminderAt;
    return JSON.stringify(draft) !== JSON.stringify(savedDraft) || pendingInputs;
  }

  async function attachFile(file: File) {
    if (!draft) return;
    if (draft.revision < 1) { setNotice(t("Save this item before attaching a file.", "添加文件前请先保存此项目。")); return; }
    if (hasUnsavedEditorWork()) { setNotice(t("Save your current edits before attaching a file.", "添加文件前请先保存当前编辑。")); return; }
    setBusy(true); setNotice(t("Saving attachment locally…", "正在本地保存附件…"));
    try {
      const saved = await attachStudyFile(draft, file);
      setDraft(saved); setSavedDraft(structuredClone(saved));
      await refresh();
      setNotice(t("✓ Attachment saved locally and queued for encrypted sync", "✓ 附件已保存到本地，并加入加密同步队列"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not attach this file.", "无法添加此文件。"));
    } finally { setBusy(false); }
  }

  async function downloadAttachment(ref: StudyAttachmentRef) {
    setBusy(true); setNotice("");
    try {
      const blob = await readStudyAttachment(ref);
      const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = ref.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Could not open this attachment.", "无法打开此附件。")); }
    finally { setBusy(false); }
  }

  async function toggleProjectTask(record: StudyRecord, taskId: string, done: boolean) {
    setBusy(true);
    setNotice(t("Saving…", "保存中…"));
    try {
      const saved = await saveStudy({
        ...record,
        tasks: record.tasks.map(task => task.id === taskId ? { ...task, done } : task),
      });
      setRecords(current => current.map(item => item.id === saved.id ? saved : item));
      setNotice(t("✓ Changes saved", "✓ 更改已保存"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Could not save.", "无法保存。");
      setNotice(locale === "zh" ? `更改未保存 — ${message}` : `Changes not saved — ${message}`);
      try { await refresh(); } catch { /* Keep the existing list if refresh also fails. */ }
    } finally {
      setBusy(false);
    }
  }

  async function setArchiveState(record: StudyRecord, archived: boolean) {
    setBusy(true);
    setNotice(archived ? t("Archiving…", "归档中…") : t("Restoring…", "恢复中…"));
    try {
      const saved = await saveStudy({ ...record, archived });
      setRecords(current => current.map(item => item.id === saved.id ? saved : item));
      setNotice(archived ? t("✓ Archived", "✓ 已归档") : t("✓ Restored", "✓ 已恢复"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Could not save.", "无法保存。");
      setNotice(locale === "zh" ? `${archived ? "归档" : "恢复"}未保存 — ${message}` : `${archived ? "Archive" : "Restore"} not saved — ${message}`);
      try { await refresh(); } catch { /* Keep the existing list if refresh also fails. */ }
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord(record: StudyRecord) {
    if (!window.confirm(kind === "note" ? t("Delete this note permanently? This cannot be undone unless you have a backup.", "永久删除这条笔记吗？除非有备份，否则无法撤销。") : t("Delete this project permanently? This cannot be undone unless you have a backup.", "永久删除这个项目吗？除非有备份，否则无法撤销。"))) return;
    setBusy(true);
    setNotice(t("Deleting…", "删除中…"));
    try {
      await deleteStudy(record);
      setRecords(current => current.filter(item => item.id !== record.id));
      setNotice(t("✓ Deleted", "✓ 已删除"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Could not delete.", "无法删除。");
      setNotice(locale === "zh" ? `更改未删除 — ${message}` : `Changes not deleted — ${message}`);
      try { await refresh(); } catch { /* Keep the existing list if refresh also fails. */ }
    } finally {
      setBusy(false);
    }
  }

  async function backup() {
    try {
      const url = URL.createObjectURL(new Blob([await exportStudy()], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "study-backup.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setNotice(t("Could not export your saved notes and projects.", "无法导出已保存的笔记和项目。")); }
  }
  async function restore(file: File) {
    setBusy(true);
    try {
      if (file.size > 150_000_000) throw new Error(t("Choose a backup smaller than 150 MB.", "请选择小于 150 MB 的备份。"));
      const count = await restoreStudy(await file.text()); await refresh(); setNotice(locale === "zh" ? `已恢复 ${count} 项。相同的现有项目已保留。` : `Restored ${count} items. Existing identical items were kept.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Could not restore.", "无法恢复。")); }
    finally { setBusy(false); }
  }
  const archivedCount = records.filter(r => r.kind === kind && !!r.archived).length;
  const noteById = new Map(records.filter(r => r.kind === "note").map(note => [note.id, note]));
  const activeNotes = records.filter(r => r.kind === "note" && !r.archived);
  const availableNotesForDraft = draft?.kind === "project"
    ? activeNotes.filter(note => !(draft.linkedNoteIds ?? []).includes(note.id))
    : [];
  const visible = records.filter(r => r.kind === kind && !!r.archived === showArchived
      && `${r.title} ${r.body} ${r.subject} ${r.unit}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.subject.localeCompare(b.subject) || a.unit.localeCompare(b.unit) || b.updatedAt.localeCompare(a.updatedAt));
  return <section className="studyPanel">
    <p>{kind === "note" ? t("Paste your notes and group them by subject and unit.", "粘贴笔记，并按学科和单元整理。") : t("Choose your own next steps. Progress comes from completed tasks and explicitly completed milestones.", "自行决定下一步。进度只来自已完成的任务和明确完成的里程碑。")}</p>
    <div className="reviewActions">
      {!showArchived && <button disabled={busy || !!draft} onClick={() => beginDraft({ id: crypto.randomUUID(), revision: 0, updatedAt: "", kind, title: "", body: "", subject: "", unit: "", pinned: false, tasks: [], archived: false, ...(kind === "project" ? { nextAction: "", milestones: [], linkedNoteIds: [], reminders: [] } : {}) })}>{kind === "note" ? t("New note", "新建笔记") : t("New project", "新建项目")}</button>}
      <button disabled={busy || !!draft} onClick={() => { setShowArchived(value => !value); setNotice(""); }}>
        {showArchived ? (kind === "note" ? t("Back to notes", "返回笔记") : t("Back to projects", "返回项目")) : `${t("Archived", "已归档")} (${archivedCount})`}
      </button>
    </div>
    <label>{t("Search", "搜索")} {showArchived ? t("archived ", "已归档") : ""}{kind === "note" ? t("notes", "笔记") : t("projects", "项目")}<input value={query} onChange={e => setQuery(e.target.value)} /></label>
    {notice && <p role="status">{notice}</p>}
    <StudySyncConflictReview kind={kind} />
    {draft ? <div className="studyEditor">
      <label>{t("Title", "标题")}<input value={draft.title} maxLength={500} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      {kind === "note" && <>
        <label>{t("Subject", "学科")}<input placeholder={t("Inbox", "收件箱")} value={draft.subject} disabled={busy} onChange={e => setDraft({ ...draft, subject: e.target.value })} /></label>
        <label>{t("Unit", "单元")}<input value={draft.unit} disabled={busy} onChange={e => setDraft({ ...draft, unit: e.target.value })} /></label>
      </>}
      <label>{kind === "note" ? t("Note", "笔记") : t("Project details", "项目详情")}<textarea value={draft.body} maxLength={100000} disabled={busy} onChange={e => setDraft({ ...draft, body: e.target.value })} /></label>
      <label><input type="checkbox" checked={draft.pinned} disabled={busy} onChange={e => setDraft({ ...draft, pinned: e.target.checked })} /> {t("Pin", "置顶")}</label>
      <h3>{t("Attachments", "附件")}</h3>
      {(draft.attachments ?? []).length ? (draft.attachments ?? []).map(ref => <div className="memoryEntry" key={ref.id}>
        <strong>{ref.name}</strong>
        <small>{Math.max(1, Math.ceil(ref.size / 1024))} KB · {t("encrypted sync epoch", "加密同步纪元")} {ref.keyEpoch}</small>
        <div className="reviewActions">
          <button type="button" disabled={busy} onClick={() => void downloadAttachment(ref)}>{t("Download local copy", "下载本地副本")}</button>
          <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, attachments: (draft.attachments ?? []).filter(item => item.id !== ref.id) })}>{t("Remove reference", "移除引用")}</button>
        </div>
      </div>) : <p>{t("No attachments yet.", "还没有附件。")}</p>}
      <label>{t("Attach a saved file", "添加已保存的文件")}<input type="file" disabled={busy || draft.revision < 1 || hasUnsavedEditorWork()} onChange={e => {
        const file = e.target.files?.[0]; if (file) void attachFile(file); e.target.value = "";
      }} /></label>
      <small>{draft.revision < 1 ? t("Save this item first. ", "请先保存此项目。") : ""}{t("Files stay on this device and are sent to the relay only as encrypted chunks. Save text/task edits before attaching.", "文件保留在此设备上，仅以加密数据块发送到中继。添加附件前请先保存文字/任务编辑。")}</small>
      {kind === "project" && <>
        <label>{t("Next action", "下一步行动")}<input value={draft.nextAction ?? ""} maxLength={10000} disabled={busy} onChange={e => setDraft({ ...draft, nextAction: e.target.value })} /></label>

        <ProjectTimeline project={draft} />

        <h3>{t("Reminders", "提醒")}</h3>
        {(draft.reminders ?? []).length > 0 ? (draft.reminders ?? []).map(reminder => <div className="memoryEntry" key={reminder.id}>
          <strong>{reminder.title}</strong>
          <small>{reminder.status === "cancelled" ? t("Cancelled", "已取消") : t("Scheduled", "已安排")} · {formatReminderTime(reminder.scheduledFor)}</small>
          {reminder.status === "scheduled" ? <>
            <label>{t("Reminder title", "提醒标题")}<input value={reminder.title} maxLength={10000} disabled={busy} onChange={e => setDraft({ ...draft, reminders: (draft.reminders ?? []).map(item => item.id === reminder.id ? { ...item, title: e.target.value } : item) })} /></label>
            <label>{t("Reminder time", "提醒时间")}<input type="datetime-local" value={toDateTimeLocal(reminder.scheduledFor)} disabled={busy} onChange={e => {
              const scheduledFor = fromDateTimeLocal(e.target.value);
              if (scheduledFor) setDraft({ ...draft, reminders: (draft.reminders ?? []).map(item => item.id === reminder.id ? { ...item, scheduledFor } : item) });
            }} /></label>
            <div className="reviewActions">
              {Date.parse(reminder.scheduledFor) <= Date.now() && <button disabled={busy} onClick={() => setDraft({ ...draft, reminders: (draft.reminders ?? []).map(item => item.id === reminder.id ? { ...item, scheduledFor: snoozedReminderTime(10) } : item) })}>{t("Snooze 10 min", "延后 10 分钟")}</button>}
              <button disabled={busy} onClick={() => setDraft({ ...draft, reminders: (draft.reminders ?? []).map(item => item.id === reminder.id ? { ...item, status: "cancelled" as const } : item) })}>{t("Cancel reminder", "取消提醒")}</button>
            </div>
          </> : <button disabled={busy} onClick={() => setDraft({ ...draft, reminders: (draft.reminders ?? []).map(item => item.id === reminder.id ? { ...item, status: "scheduled" as const } : item) })}>{t("Restore reminder", "恢复提醒")}</button>}
        </div>) : <p>{t("No reminders yet.", "还没有提醒。")}</p>}
        <label>{t("New reminder", "新提醒")}<input value={reminderTitle} maxLength={10000} disabled={busy} onChange={e => setReminderTitle(e.target.value)} /></label>
        <label>{t("Reminder time", "提醒时间")}<input type="datetime-local" value={reminderAt} disabled={busy} onChange={e => setReminderAt(e.target.value)} /></label>
        <button disabled={busy || !reminderTitle.trim() || !fromDateTimeLocal(reminderAt)} onClick={() => {
          const scheduledFor = fromDateTimeLocal(reminderAt);
          if (!scheduledFor) return;
          setDraft({ ...draft, reminders: [...(draft.reminders ?? []), { id: crypto.randomUUID(), title: reminderTitle.trim(), scheduledFor, status: "scheduled" }] });
          setReminderTitle(""); setReminderAt("");
        }}>{t("Add reminder", "添加提醒")}</button>
        <small>{locale === "zh" ? `浏览器通知可在应用打开时提醒你。免打扰时段为 ${reminderQuietHours.label}；提醒仍会显示在“今天”。` : `Browser notifications can alert while this app is open. Quiet hours are ${reminderQuietHours.label}; reminders still remain visible in Today.`}</small>

        <h3>{t("Linked notes", "关联笔记")}</h3>
        {(draft.linkedNoteIds ?? []).length > 0 ? (draft.linkedNoteIds ?? []).map(noteId => {
          const note = noteById.get(noteId);
          return <div className="memoryEntry" key={noteId}>
            <strong>{note?.title ?? t("Unavailable note", "不可用的笔记")}</strong>
            {note ? <small>{`${note.subject || (locale === "zh" ? "收件箱" : "Inbox")}${note.unit ? ` / ${note.unit}` : ""}${note.archived ? ` · ${t("Archived", "已归档")}` : ""}`}</small>
              : <small>{t("Deleted or missing from this browser · link retained until you unlink it", "已删除或此浏览器中缺失 · 关联会保留，直到你手动取消")}</small>}
            {note?.body && <p style={{ whiteSpace: "pre-wrap" }}>{note.body.slice(0, 160)}</p>}
            <button disabled={busy} onClick={() => setDraft({ ...draft, linkedNoteIds: (draft.linkedNoteIds ?? []).filter(id => id !== noteId) })}>{t("Unlink note", "取消关联")}</button>
          </div>;
        }) : <p>{t("No linked notes yet.", "还没有关联笔记。")}</p>}
        {availableNotesForDraft.length > 0 ? <>
          <label>{t("Link an existing note", "关联现有笔记")}<select value={linkNoteTargetId} disabled={busy} onChange={e => setLinkNoteTargetId(e.target.value)}>
            <option value="">{t("Choose a note", "选择笔记")}</option>
            {availableNotesForDraft.map(note => <option key={note.id} value={note.id}>{note.title} · {note.subject || (locale === "zh" ? "收件箱" : "Inbox")}{note.unit ? ` / ${note.unit}` : ""}</option>)}
          </select></label>
          <button disabled={busy || !linkNoteTargetId} onClick={() => {
            const linkedNoteIds = [...(draft.linkedNoteIds ?? []), linkNoteTargetId];
            setDraft({ ...draft, linkedNoteIds });
            setLinkNoteTargetId(activeNotes.find(note => !linkedNoteIds.includes(note.id))?.id ?? "");
          }}>{t("Link note", "关联笔记")}</button>
        </> : <small>{(draft.linkedNoteIds ?? []).length ? t("All active notes are already linked.", "所有有效笔记都已关联。") : t("Create a Note first, then link it here.", "请先创建笔记，然后在这里关联。")}</small>}

        <h3>{t("Project tasks", "项目任务")}</h3>
        <p>{draft.tasks.length ? (locale === "zh" ? `已完成 ${draft.tasks.filter(t => t.done).length} / ${draft.tasks.length} 个项目任务` : `${draft.tasks.filter(t => t.done).length} of ${draft.tasks.length} project tasks complete`) : t("No project-level tasks yet.", "还没有项目级任务。")}</p>
        {draft.tasks.map(t => <label key={t.id}><input type="checkbox" checked={t.done} disabled={busy} onChange={e => setDraft({ ...draft, tasks: draft.tasks.map(task => task.id === t.id ? { ...task, done: e.target.checked } : task) })} />{t.title}{t.due && ` · ${t.due}`}</label>)}
        <label>{t("Next project task", "下一个项目任务")}<input value={taskTitle} disabled={busy} onChange={e => setTaskTitle(e.target.value)} /></label>
        <label>{t("Due date (optional)", "截止日期（可选）")}<input type="date" value={due} disabled={busy} onChange={e => setDue(e.target.value)} /></label>
        <button disabled={busy || !taskTitle.trim()} onClick={() => { setDraft({ ...draft, tasks: [...draft.tasks, { id: crypto.randomUUID(), title: taskTitle.trim(), done: false, due }] }); setTaskTitle(""); setDue(""); }}>{t("Add project task", "添加项目任务")}</button>

        <h3>{t("Milestones", "里程碑")}</h3>
        {(draft.milestones ?? []).length > 0 ? <>
          <p>{locale === "zh" ? `已明确完成 ${(draft.milestones ?? []).filter(m => m.status === "complete").length} / ${(draft.milestones ?? []).length} 个里程碑 · 已完成 ${(draft.milestones ?? []).reduce((sum, m) => sum + m.tasks.filter(t => t.done).length, 0)} / ${(draft.milestones ?? []).reduce((sum, m) => sum + m.tasks.length, 0)} 个里程碑任务` : `${(draft.milestones ?? []).filter(m => m.status === "complete").length} of ${(draft.milestones ?? []).length} milestones explicitly complete · ${(draft.milestones ?? []).reduce((sum, m) => sum + m.tasks.filter(t => t.done).length, 0)} of ${(draft.milestones ?? []).reduce((sum, m) => sum + m.tasks.length, 0)} milestone tasks complete`}</p>
          {(draft.milestones ?? []).map(milestone => <div className="memoryEntry" key={milestone.id}>
            <label>{t("Milestone title", "里程碑标题")}<input value={milestone.title} maxLength={10000} disabled={busy} onChange={e => setDraft({ ...draft, milestones: (draft.milestones ?? []).map(item => item.id === milestone.id ? { ...item, title: e.target.value } : item) })} /></label>
            <label>{t("Date (optional)", "日期（可选）")}<input type="date" value={milestone.due} disabled={busy} onChange={e => setDraft({ ...draft, milestones: (draft.milestones ?? []).map(item => item.id === milestone.id ? { ...item, due: e.target.value } : item) })} /></label>
            <label>{t("Status", "状态")}<select value={milestone.status} disabled={busy} onChange={e => setDraft({ ...draft, milestones: (draft.milestones ?? []).map(item => item.id === milestone.id ? { ...item, status: e.target.value as StudyMilestoneStatus } : item) })}>
              <option value="">{t("Not set", "未设置")}</option>
              <option value="planned">{t("Planned", "已计划")}</option>
              <option value="in-progress">{t("In progress", "进行中")}</option>
              <option value="complete">{t("Complete", "已完成")}</option>
            </select></label>
            <p>{milestone.tasks.length ? (locale === "zh" ? `已完成 ${milestone.tasks.filter(t => t.done).length} / ${milestone.tasks.length} 个任务` : `${milestone.tasks.filter(t => t.done).length} of ${milestone.tasks.length} tasks complete`) : t("No tasks in this milestone yet.", "此里程碑还没有任务。")}</p>
            {milestone.tasks.map(task => <label key={task.id}><input type="checkbox" checked={task.done} disabled={busy} onChange={e => setDraft({ ...draft, milestones: (draft.milestones ?? []).map(item => item.id === milestone.id ? { ...item, tasks: item.tasks.map(existing => existing.id === task.id ? { ...existing, done: e.target.checked } : existing) } : item) })} />{task.title}{task.due && ` · ${task.due}`}</label>)}
          </div>)}
        </> : <p>{t("No milestones yet.", "还没有里程碑。")}</p>}

        <label>{t("New milestone", "新里程碑")}<input value={milestoneTitle} disabled={busy} onChange={e => setMilestoneTitle(e.target.value)} /></label>
        <label>{t("Milestone date (optional)", "里程碑日期（可选）")}<input type="date" value={milestoneDue} disabled={busy} onChange={e => setMilestoneDue(e.target.value)} /></label>
        <label>{t("Milestone status", "里程碑状态")}<select value={milestoneStatus} disabled={busy} onChange={e => setMilestoneStatus(e.target.value as StudyMilestoneStatus)}>
          <option value="">{t("Not set", "未设置")}</option>
          <option value="planned">{t("Planned", "已计划")}</option>
          <option value="in-progress">{t("In progress", "进行中")}</option>
          <option value="complete">{t("Complete", "已完成")}</option>
        </select></label>
        <button disabled={busy || !milestoneTitle.trim()} onClick={() => {
          const id = crypto.randomUUID();
          setDraft({ ...draft, milestones: [...(draft.milestones ?? []), { id, title: milestoneTitle.trim(), due: milestoneDue, status: milestoneStatus, tasks: [] }] });
          setMilestoneTaskTargetId(id);
          setMilestoneTitle(""); setMilestoneDue(""); setMilestoneStatus("");
        }}>{t("Add milestone", "添加里程碑")}</button>

        {(draft.milestones ?? []).length > 0 && <>
          <h3>{t("Add a milestone task", "添加里程碑任务")}</h3>
          <label>{t("Milestone", "里程碑")}<select value={milestoneTaskTargetId || (draft.milestones ?? [])[0]?.id || ""} disabled={busy} onChange={e => setMilestoneTaskTargetId(e.target.value)}>
            {(draft.milestones ?? []).map(milestone => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}
          </select></label>
          <label>{t("Task", "任务")}<input value={milestoneTaskTitle} disabled={busy} onChange={e => setMilestoneTaskTitle(e.target.value)} /></label>
          <label>{t("Task due date (optional)", "任务截止日期（可选）")}<input type="date" value={milestoneTaskDue} disabled={busy} onChange={e => setMilestoneTaskDue(e.target.value)} /></label>
          <button disabled={busy || !milestoneTaskTitle.trim() || !(milestoneTaskTargetId || (draft.milestones ?? [])[0]?.id)} onClick={() => {
            const targetId = milestoneTaskTargetId || (draft.milestones ?? [])[0]?.id;
            if (!targetId) return;
            setDraft({ ...draft, milestones: (draft.milestones ?? []).map(milestone => milestone.id === targetId ? { ...milestone, tasks: [...milestone.tasks, { id: crypto.randomUUID(), title: milestoneTaskTitle.trim(), done: false, due: milestoneTaskDue }] } : milestone) });
            setMilestoneTaskTitle(""); setMilestoneTaskDue("");
          }}>{t("Add milestone task", "添加里程碑任务")}</button>
        </>}
      </>}
      <div className="reviewActions"><button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{kind === "note" ? t("Save note", "保存笔记") : t("Save project", "保存项目")}</button>
        <button disabled={busy} onClick={closeEditor}>{t("Close editor", "关闭编辑器")}</button></div>
    </div> : visible.map(r => <article className="memoryEntry" key={r.id}>
      <small>{kind === "note" ? `${r.subject || (locale === "zh" ? "收件箱" : "Inbox")}${r.unit ? ` / ${r.unit}` : ""}` : (locale === "zh" ? `${r.tasks.filter(t => t.done).length} / ${r.tasks.length} 个项目任务 · ${(r.milestones ?? []).filter(m => m.status === "complete").length} / ${(r.milestones ?? []).length} 个里程碑` : `${r.tasks.filter(t => t.done).length} / ${r.tasks.length} project tasks · ${(r.milestones ?? []).filter(m => m.status === "complete").length} / ${(r.milestones ?? []).length} milestones`)}{(r.attachments ?? []).length ? (locale === "zh" ? ` · ${(r.attachments ?? []).length} 个附件` : ` · ${(r.attachments ?? []).length} attachment${(r.attachments ?? []).length === 1 ? "" : "s"}`) : ""}{r.pinned ? ` · ${t("Pinned", "已置顶")}` : ""}{showArchived ? ` · ${t("Archived", "已归档")}` : ""}</small>
      <h3>{r.title}</h3><p style={{ whiteSpace: "pre-wrap" }}>{r.body.slice(0, 200)}</p>
      {kind === "project" && r.nextAction?.trim() && <p><strong>{t("Next action:", "下一步行动：")}</strong> {r.nextAction}</p>}
      {kind === "project" && !showArchived && (() => {
        const reminder = nextScheduledReminder(r);
        return reminder ? <p><strong>{t("Reminder:", "提醒：")}</strong> {reminder.title} · {formatReminderTime(reminder.scheduledFor)}</p> : null;
      })()}
      {kind === "project" && !showArchived && (r.linkedNoteIds ?? []).length > 0 && <div className={styles.linkedNotesPreview} aria-label="Linked notes">
        <div className={styles.previewLabel}>{t("Linked notes", "关联笔记")}</div>
        {(r.linkedNoteIds ?? []).slice(0, 3).map(noteId => {
          const note = noteById.get(noteId);
          return <div className={styles.linkedNoteRow} key={noteId}>
            <span>{note?.title ?? t("Unavailable note", "不可用的笔记")}</span>
            <small>{note ? `${note.subject || (locale === "zh" ? "收件箱" : "Inbox")}${note.unit ? ` / ${note.unit}` : ""}${note.archived ? ` · ${t("Archived", "已归档")}` : ""}` : t("Deleted or missing", "已删除或缺失")}</small>
          </div>;
        })}
        {(r.linkedNoteIds ?? []).length > 3 && <small className={styles.moreLinkedNotes}>+{(r.linkedNoteIds ?? []).length - 3} {t("more", "条")}</small>}
      </div>}
      {kind === "project" && !showArchived && r.tasks.length > 0 && <div className="projectTaskList">
        {r.tasks.map(task => <label key={task.id}>
          <input
            type="checkbox"
            checked={task.done}
            disabled={busy}
            onChange={e => void toggleProjectTask(r, task.id, e.target.checked)}
          />
          {task.title}{task.due && ` · ${task.due}`}
        </label>)}
      </div>}
      {kind === "project" && !showArchived && (r.milestones ?? []).length > 0 && <div className={styles.milestonePreview} aria-label="Milestones">
        <div className={styles.previewLabel}>{t("Milestones", "里程碑")}</div>
        {(r.milestones ?? []).map((milestone, index, milestones) => <div className={styles.milestoneRow} key={milestone.id}>
          <div className={styles.rail} aria-hidden="true">
            <span className={`${styles.dot} ${milestone.status === "complete" ? styles.complete : milestone.status === "in-progress" ? styles.inProgress : milestone.status === "planned" ? styles.planned : ""}`} />
            {index < milestones.length - 1 && <span className={styles.line} />}
          </div>
          <div className={styles.milestoneContent}>
            <div className={styles.milestoneHeading}>
              <strong>{milestone.title}</strong>
              <small>{locale === "zh" ? milestoneStatusLabelZh[milestone.status] : milestoneStatusLabel[milestone.status]}{milestone.due && ` · ${milestone.due}`}</small>
            </div>
            {milestone.tasks.length > 0 ? <div className={styles.milestoneTasks}>
              {milestone.tasks.map(task => <div className={`${styles.milestoneTask} ${task.done ? styles.doneTask : ""}`} key={task.id}>
                <span className={styles.taskMark} aria-hidden="true">{task.done ? "✓" : "○"}</span>
                <span className={styles.taskTitle}>{task.title}</span>
                {task.due && <small className={styles.taskDue}>{task.due}</small>}
              </div>)}
            </div> : <small className={styles.noTasks}>{t("No tasks yet", "还没有任务")}</small>}
          </div>
        </div>)}
      </div>}
      <div className="reviewActions">
        <button disabled={busy} onClick={() => beginDraft(r)}>{t("Open", "打开")} {r.title}</button>
        {showArchived ? <>
          <button disabled={busy} onClick={() => void setArchiveState(r, false)}>{t("Restore from archive", "从归档恢复")}</button>
          <button disabled={busy} onClick={() => void deleteRecord(r)}>{t("Delete permanently", "永久删除")}</button>
        </> : <button disabled={busy} onClick={() => void setArchiveState(r, true)}>{t("Archive", "归档")}</button>}
      </div>
    </article>)}
    {!draft && !visible.length && <p>{showArchived ? (kind === "note" ? t("No archived notes.", "没有已归档笔记。") : t("No archived projects.", "没有已归档项目。")) : (kind === "note" ? t("No notes yet.", "还没有笔记。") : t("No projects yet.", "还没有项目。"))}</p>}
    <details><summary>{t("Backup and restore", "备份与恢复")}</summary><p>{t("Exports include saved notes and projects, including archived items, linked-note IDs, reminders, milestones and next actions. No cloud sync is connected.", "导出内容包括已保存的笔记和项目，以及归档项、关联笔记 ID、提醒、里程碑和下一步行动。当前未连接云端同步。")}</p>
      <button disabled={busy} onClick={() => void backup()}>{t("Export study backup", "导出学习数据备份")}</button>
      <label>{t("Restore study backup", "恢复学习数据备份")}<input type="file" accept=".json" disabled={busy || !!draft} onChange={e => { const f = e.target.files?.[0]; if (f) void restore(f); e.target.value = ""; }} /></label>
    </details>
    <small>{t("Saved in this browser on this device. Export a backup before clearing browser data. This does not enable offline AI or cross-device sync.", "数据保存在此设备的这个浏览器中。清除浏览器数据前请先导出备份。此功能本身不会启用离线 AI 或跨设备同步。")}</small>
  </section>;
}

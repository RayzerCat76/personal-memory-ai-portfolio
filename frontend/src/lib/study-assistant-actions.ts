"use client";

import type { StudyActionProposal, StudySource } from "@/lib/api";
import { listStudy, saveStudy, type StudyRecord } from "@/lib/study-store";

export type StudyActionParseResult =
  | { status: "proposal"; proposal: StudyActionProposal; source?: StudySource }
  | { status: "issue"; message: string }
  | { status: "none" };

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function activeProjects(records: StudyRecord[]): StudyRecord[] {
  return records.filter(
    (record) => record.kind === "project" && !record.archived,
  );
}

function matchByTitle<T extends { title: string }>(
  items: T[],
  query: string,
): T | "ambiguous" | null {
  const wanted = normalized(query);
  if (!wanted) return null;
  const exact = items.filter((item) => normalized(item.title) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return "ambiguous";
  const partial = items.filter(
    (item) =>
      normalized(item.title).includes(wanted) ||
      wanted.includes(normalized(item.title)),
  );
  return partial.length === 1
    ? partial[0]
    : partial.length > 1
      ? "ambiguous"
      : null;
}

function parseDue(value: string): { text: string; due: string } {
  const match =
    value.match(/^(.*?)(?:\s+(?:due|by)\s+(\d{4}-\d{2}-\d{2}))\s*$/i) ??
    value.match(/^(.*?)(?:[，,\s]+(?:截止|到期)\s*(\d{4}-\d{2}-\d{2}))\s*$/);
  return match
    ? { text: match[1].trim(), due: match[2] }
    : { text: value.trim(), due: "" };
}

function parseLocalDateTime(value: string): string | null {
  const clean = value.trim();
  const match = clean.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;
  const [, y, m, d, hh, mm, ss = "00"] = match;
  const date = new Date(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
    0,
  );
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(m) - 1 ||
    date.getDate() !== Number(d) ||
    date.getHours() !== Number(hh) ||
    date.getMinutes() !== Number(mm)
  )
    return null;
  return date.toISOString();
}

function splitNoteSpec(value: string): { title: string; body: string } {
  const parts = value.split(/\s+[—–]\s+/, 2);
  if (parts.length === 2)
    return { title: parts[0].trim(), body: parts[1].trim() };
  return { title: value.trim(), body: "" };
}

export function studySourceFromRecord(record: StudyRecord): StudySource {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    subject: record.subject,
    unit: record.unit,
    excerpt: record.body.replace(/\s+/g, " ").trim().slice(0, 500),
    ...(record.kind === "project" && record.nextAction
      ? { next_action: record.nextAction }
      : {}),
    ...(record.tasks.length
      ? {
          tasks: record.tasks
            .slice(0, 20)
            .map((task) => ({
              title: task.title,
              done: task.done,
              due: task.due,
            })),
        }
      : {}),
    ...(record.kind === "project" && (record.reminders ?? []).length
      ? {
          reminders: (record.reminders ?? [])
            .slice(0, 20)
            .map((reminder) => ({
              title: reminder.title,
              scheduled_for: reminder.scheduledFor,
              status: reminder.status,
            })),
        }
      : {}),
  };
}

function projectFailure(
  project: StudyRecord | "ambiguous" | null,
  name: string,
  locale: "en" | "zh",
): StudyActionParseResult | null {
  if (project === "ambiguous")
    return {
      status: "issue",
      message: locale === "zh"
        ? `有多个进行中的项目符合“${name}”，请使用完整项目标题。`
        : `More than one active Project matches “${name}”. Use the exact Project title.`,
    };
  if (!project)
    return {
      status: "issue",
      message: locale === "zh"
        ? `没有找到符合“${name}”的进行中项目。`
        : `I couldn't find an active Project matching “${name}”.`,
    };
  return null;
}

export async function parseStudyAction(
  text: string,
  locale: "en" | "zh",
): Promise<StudyActionParseResult> {
  const trimmed = text.trim();
  let match =
    trimmed.match(
      /^(?:create|make|add)\s+(?:a\s+)?note(?:\s+(?:called|titled))?\s*[:\-]?\s*(.+)$/i,
    ) ??
    trimmed.match(
      /^(?:创建|建立|新建|新增)(?:一个|一個)?(?:笔记|筆記)(?:叫|名为|名為|标题为|標題為)?\s*[:：\-]?\s*(.+)$/,
    );
  if (match) {
    const { title, body } = splitNoteSpec(match[1]);
    if (!title || title.length > 500 || body.length > 100000)
      return {
        status: "issue",
        message:
          locale === "zh"
            ? "笔记标题或内容长度不合适。"
            : "The Note title or body is not a valid length.",
      };
    return {
      status: "proposal",
      proposal: { kind: "create-note", locale, title, body },
    };
  }

  match =
    trimmed.match(
      /^(?:add|create)\s+(?:a\s+)?task\s+(?:to|for|in)\s+(?:project\s+)?(.+?)\s*:\s*(.+)$/i,
    ) ??
    trimmed.match(
      /^(?:给|在)(?:项目|項目)\s*(.+?)(?:里|裡|中)?(?:添加|新增|加)(?:一个|一個)?(?:任务|任務)\s*[:：]\s*(.+)$/,
    );
  if (match) {
    const records = await listStudy();
    const project = matchByTitle(activeProjects(records), match[1]);
    const failure = projectFailure(project, match[1], locale);
    if (failure) return failure;
    if (!project || project === "ambiguous") return { status: "issue", message: "Project match failed safely." };
    const { text: taskTitle, due } = parseDue(match[2]);
    if (!taskTitle || taskTitle.length > 10000)
      return {
        status: "issue",
        message:
          locale === "zh"
            ? "任务标题不能为空。"
            : "The task title cannot be blank.",
      };
    return {
      status: "proposal",
      proposal: {
        kind: "add-project-task",
        locale,
        project_id: project.id,
        project_title: project.title,
        expected_revision: project.revision,
        task_title: taskTitle,
        due,
      },
      source: studySourceFromRecord(project),
    };
  }

  match =
    trimmed.match(
      /^mark\s+task\s+(.+?)\s+(?:complete|done)\s+(?:in|for)\s+(?:project\s+)?(.+)$/i,
    ) ??
    trimmed.match(
      /^(?:complete|finish)\s+task\s+(?:in|for)\s+(?:project\s+)?(.+?)\s*:\s*(.+)$/i,
    ) ??
    trimmed.match(
      /^(?:完成|标记完成|標記完成)(?:项目|項目)\s*(.+?)(?:里|裡|中)?(?:的)?(?:任务|任務)\s*[:：]\s*(.+)$/,
    );
  if (match) {
    const englishMark = /^mark\s/i.test(trimmed);
    const projectName = englishMark ? match[2] : match[1];
    const taskName = englishMark ? match[1] : match[2];
    const records = await listStudy();
    const project = matchByTitle(activeProjects(records), projectName);
    const failure = projectFailure(project, projectName, locale);
    if (failure) return failure;
    if (!project || project === "ambiguous") return { status: "issue", message: "Project match failed safely." };
    const task = matchByTitle(
      project.tasks.filter((item) => !item.done),
      taskName,
    );
    if (task === "ambiguous")
      return {
        status: "issue",
        message: `More than one open task matches “${taskName}”. Use the exact task title.`,
      };
    if (!task)
      return {
        status: "issue",
        message:
          locale === "zh"
            ? `在项目“${project.title}”里没找到这个未完成任务。`
            : `I couldn't find that open task in “${project.title}”.`,
      };
    return {
      status: "proposal",
      proposal: {
        kind: "complete-project-task",
        locale,
        project_id: project.id,
        project_title: project.title,
        expected_revision: project.revision,
        task_id: task.id,
        task_title: task.title,
      },
      source: studySourceFromRecord(project),
    };
  }

  match =
    trimmed.match(
      /^(?:schedule|add|create)\s+(?:a\s+)?reminder\s+(?:in|for)\s+(?:project\s+)?(.+?)\s*:\s*(.+?)\s+(?:at|for)\s+(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?)$/i,
    ) ??
    trimmed.match(
      /^(?:在)?(?:项目|項目)\s*(.+?)(?:里|裡|中)?(?:添加|新增|安排|设定|設定)(?:一个|一個)?提醒\s*[:：]\s*(.+?)[，,\s]+(?:时间|時間)\s*[:：]?\s*(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?)$/,
    );
  if (match) {
    const records = await listStudy();
    const project = matchByTitle(activeProjects(records), match[1]);
    const failure = projectFailure(project, match[1], locale);
    if (failure) return failure;
    if (!project || project === "ambiguous") return { status: "issue", message: "Project match failed safely." };
    const scheduledFor = parseLocalDateTime(match[3]);
    if (!scheduledFor)
      return {
        status: "issue",
        message:
          locale === "zh"
            ? "提醒时间请使用 YYYY-MM-DD HH:MM。"
            : "Use YYYY-MM-DD HH:MM for the reminder time.",
      };
    return {
      status: "proposal",
      proposal: {
        kind: "schedule-project-reminder",
        locale,
        project_id: project.id,
        project_title: project.title,
        expected_revision: project.revision,
        reminder_title: match[2].trim(),
        scheduled_for: scheduledFor,
      },
      source: studySourceFromRecord(project),
    };
  }

  match =
    trimmed.match(
      /^cancel\s+reminder\s+(?:in|for)\s+(?:project\s+)?(.+?)\s*:\s*(.+)$/i,
    ) ??
    trimmed.match(
      /^取消(?:项目|項目)\s*(.+?)(?:里|裡|中)?(?:的)?提醒\s*[:：]\s*(.+)$/,
    );
  if (match) {
    const records = await listStudy();
    const project = matchByTitle(activeProjects(records), match[1]);
    const failure = projectFailure(project, match[1], locale);
    if (failure) return failure;
    if (!project || project === "ambiguous") return { status: "issue", message: "Project match failed safely." };
    const reminder = matchByTitle(
      (project.reminders ?? []).filter((item) => item.status === "scheduled"),
      match[2],
    );
    if (reminder === "ambiguous")
      return {
        status: "issue",
        message: `More than one scheduled reminder matches “${match[2]}”. Use the exact reminder title.`,
      };
    if (!reminder)
      return {
        status: "issue",
        message:
          locale === "zh"
            ? `在项目“${project.title}”里没找到这个已安排的提醒。`
            : `I couldn't find that scheduled reminder in “${project.title}”.`,
      };
    return {
      status: "proposal",
      proposal: {
        kind: "cancel-project-reminder",
        locale,
        project_id: project.id,
        project_title: project.title,
        expected_revision: project.revision,
        reminder_id: reminder.id,
        reminder_title: reminder.title,
      },
      source: studySourceFromRecord(project),
    };
  }

  const mutationIntent = /^(?:create|make|add|complete|finish|mark|schedule|cancel)\b/i.test(trimmed)
    || /^(?:创建|建立|新建|新增|给|在|完成|标记完成|標記完成|取消)/.test(trimmed);
  const studyWord = /\b(note|task|project|reminder)\b/i.test(trimmed) || /(笔记|筆記|任务|任務|项目|項目|提醒)/.test(trimmed);
  if (mutationIntent && studyWord) return { status: "issue", message: locale === "zh"
    ? "我识别到你想修改笔记/项目，但这句话无法安全解析。请使用明确格式，例如：给项目 Physics IA 添加任务：Revise graphs 截止 2026-09-22。"
    : "I recognized a Study change request, but I could not parse it safely. Use an explicit form such as: Add task to Physics IA: Revise graphs due 2026-09-22." };

  return { status: "none" };
}

export function describeStudyAction(proposal: StudyActionProposal): string {
  const zh = proposal.locale === "zh";
  switch (proposal.kind) {
    case "create-note":
      return zh ? `创建笔记“${proposal.title}”${proposal.body ? `，包含 ${proposal.body.length} 个字符的内容` : ""}` : `create Note “${proposal.title}”${proposal.body ? ` with ${proposal.body.length} characters of text` : ""}`;
    case "add-project-task":
      return zh ? `在项目“${proposal.project_title}”添加任务“${proposal.task_title}”${proposal.due ? `，截止 ${proposal.due}` : ""}` : `add task “${proposal.task_title}” to Project “${proposal.project_title}”${proposal.due ? `, due ${proposal.due}` : ""}`;
    case "complete-project-task":
      return zh ? `把项目“${proposal.project_title}”里的任务“${proposal.task_title}”标记为完成` : `mark task “${proposal.task_title}” complete in Project “${proposal.project_title}”`;
    case "schedule-project-reminder":
      return zh ? `在项目“${proposal.project_title}”安排提醒“${proposal.reminder_title}”，时间 ${new Date(proposal.scheduled_for).toLocaleString()}` : `schedule reminder “${proposal.reminder_title}” in Project “${proposal.project_title}” for ${new Date(proposal.scheduled_for).toLocaleString()}`;
    case "cancel-project-reminder":
      return zh ? `取消项目“${proposal.project_title}”里的提醒“${proposal.reminder_title}”` : `cancel reminder “${proposal.reminder_title}” in Project “${proposal.project_title}”`;
  }
}

export async function executeStudyAction(
  proposal: StudyActionProposal,
): Promise<StudySource> {
  const records = await listStudy();
  if (proposal.kind === "create-note") {
    if (
      records.some(
        (record) =>
          record.kind === "note" &&
          !record.archived &&
          normalized(record.title) === normalized(proposal.title),
      )
    )
      throw new Error("A current Note with that title already exists.");
    const record: StudyRecord = {
      id: crypto.randomUUID(),
      revision: 0,
      updatedAt: "",
      kind: "note",
      title: proposal.title,
      body: proposal.body,
      subject: "",
      unit: "",
      pinned: false,
      tasks: [],
      archived: false,
    };
    return studySourceFromRecord(await saveStudy(record));
  }
  const project = records.find(
    (record) =>
      record.id === proposal.project_id &&
      record.kind === "project" &&
      !record.archived,
  );
  if (!project)
    throw new Error(
      "That Project is no longer available. Ask again before making the change.",
    );
  if (project.revision !== proposal.expected_revision)
    throw new Error(
      "That Project changed after this action was proposed. Ask again so I can use the latest revision.",
    );
  if (proposal.kind === "add-project-task") {
    if (
      project.tasks.some(
        (task) => normalized(task.title) === normalized(proposal.task_title),
      )
    )
      throw new Error("That Project already has a task with this title.");
    return studySourceFromRecord(
      await saveStudy({
        ...project,
        tasks: [
          ...project.tasks,
          {
            id: crypto.randomUUID(),
            title: proposal.task_title,
            done: false,
            due: proposal.due,
          },
        ],
      }),
    );
  }
  if (proposal.kind === "complete-project-task") {
    const task = project.tasks.find((item) => item.id === proposal.task_id);
    if (!task || task.done)
      throw new Error(
        "That task is no longer an open task. Ask again before making the change.",
      );
    return studySourceFromRecord(
      await saveStudy({
        ...project,
        tasks: project.tasks.map((item) =>
          item.id === proposal.task_id ? { ...item, done: true } : item,
        ),
      }),
    );
  }
  if (proposal.kind === "schedule-project-reminder") {
    if (
      (project.reminders ?? []).some(
        (item) =>
          item.status === "scheduled" &&
          normalized(item.title) === normalized(proposal.reminder_title) &&
          item.scheduledFor === proposal.scheduled_for,
      )
    )
      throw new Error("That reminder is already scheduled.");
    return studySourceFromRecord(
      await saveStudy({
        ...project,
        reminders: [
          ...(project.reminders ?? []),
          {
            id: crypto.randomUUID(),
            title: proposal.reminder_title,
            scheduledFor: proposal.scheduled_for,
            status: "scheduled",
          },
        ],
      }),
    );
  }
  const reminder = (project.reminders ?? []).find(
    (item) => item.id === proposal.reminder_id,
  );
  if (!reminder || reminder.status !== "scheduled")
    throw new Error(
      "That reminder is no longer scheduled. Ask again before making the change.",
    );
  return studySourceFromRecord(
    await saveStudy({
      ...project,
      reminders: (project.reminders ?? []).map((item) =>
        item.id === proposal.reminder_id
          ? { ...item, status: "cancelled" as const }
          : item,
      ),
    }),
  );
}

"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, browserMemoryEnabled, readableEvidence, memoryTypes, CalibrationVerdict, ChatFileContext, ChatResponse, Memory, OpenLoop } from "@/lib/api";
import MemoryEvidence from "@/components/MemoryEvidence";
import MemoryContextNote from "@/components/MemoryContextNote";
import ContextReview from "@/components/ContextReview";
import MemoryBackup from "@/components/MemoryBackup";
import { giftConfig, giftStorageKey } from "@/lib/gift";

import SourceReview from "@/components/SourceReview";
import ArchiveSearch from "@/components/ArchiveSearch";

import StudyToday from "@/components/StudyToday";
import Study from "@/components/Study";
import StudyReminderScheduler from "@/components/StudyReminderScheduler";
import StudySyncAgent from "@/components/StudySyncAgent";
import StudyDevices from "@/components/StudyDevices";
import MemorySyncConflictReview from "@/components/MemorySyncConflictReview";
import DeviceReadiness from "@/components/DeviceReadiness";
import PersonaPicker from "@/components/PersonaPicker";
import VoiceConversation from "@/components/VoiceConversation";
import { answerArtifact, ArtifactFormat, downloadArtifact, readAskFiles } from "@/lib/ask-files";
import { describeStudyAction, executeStudyAction } from "@/lib/study-assistant-actions";
import { personaStudyActionMessage } from "@/lib/persona";
import { useUiLocale, type UiLocale } from "@/lib/ui-locale";

type View = "home" | "memories" | "context" | "loops" | "notes" | "projects" | "devices";
const lastAskStorageKey = "personal-memory-ai-last-ask-v1";
const replyModeStorageKey = "personal-memory-ai-reply-mode-v1";
type ReplyMode = "text" | "audio" | "both";

function replyIncludesText(mode: ReplyMode): boolean { return mode === "text" || mode === "both"; }
function replyIncludesAudio(mode: ReplyMode): boolean { return mode === "audio" || mode === "both"; }

function answerSourceLabel(answer: ChatResponse, fileNames: string[], locale: UiLocale): string {
  const zh = locale === "zh";
  if (answer.mode === "memory-miss") return zh ? "记忆检查" : "Memory check";
  const sources: string[] = [];
  if (answer.evidence.length) sources.push(zh ? "你的记忆" : "your Memory");
  if (answer.study_sources?.length) sources.push(zh ? "你的笔记/项目" : "your Notes/Projects");
  if (fileNames.length) sources.push(zh ? "你的文件" : "your files");
  if (answer.web_sources?.length) sources.push(zh ? "网页" : "the web");
  return sources.length ? `${zh ? "来源：" : "From "}${sources.join(" + ")}` : (zh ? "角色回复" : "Character reply");
}

export default function Home() {
  const { locale: uiLocale, setLocale: setUiLocale, t } = useUiLocale();
  const [view, setView] = useState<View>("home");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loops, setLoops] = useState<OpenLoop[]>([]);
  const [seedFeedback, setSeedFeedback] = useState<Record<string, CalibrationVerdict>>({});
  const [question, setQuestion] = useState("");
  const [askFiles, setAskFiles] = useState<ChatFileContext[]>([]);
  const [answerFileNames, setAnswerFileNames] = useState<string[]>([]);
  const [artifactFormat, setArtifactFormat] = useState<ArtifactFormat>("md");
  const [rememberText, setRememberText] = useState("");
  const [answer, setAnswer] = useState<ChatResponse | null>(null);
  const [speechRequest, setSpeechRequest] = useState<{ id: number; text: string } | null>(null);
  const [replyMode, setReplyMode] = useState<ReplyMode>("text");
  const [answerReplyMode, setAnswerReplyMode] = useState<ReplyMode>("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [giftOpen, setGiftOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [correctionText, setCorrectionText] = useState("");
  const [correctionType, setCorrectionType] = useState("");
  const [correctionNotice, setCorrectionNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [allMemories, activeLoops, feedbackResponse] = await Promise.all([
        api.memories(),
        api.openLoops(),
        api.friendSeedFeedback(),
      ]);
      setMemories(allMemories);
      setLoops(activeLoops);
      setSeedFeedback(feedbackResponse.feedback);
      setConnected(true);
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : "Unable to reach the memory service.");
    }
  }, []);

  useEffect(() => {
    api.health().then(() => setConnected(true)).catch(() => setConnected(false));
    api.importFriendSeed().catch(() => null).finally(() => refresh());

    try {
      if (!window.localStorage.getItem(giftStorageKey)) setGiftOpen(true);
    } catch {
      setGiftOpen(true);
    }
  }, [refresh]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(replyModeStorageKey);
      if (stored === "text" || stored === "audio" || stored === "both") setReplyMode(stored);
    } catch {
      // Text remains the safe default when local preferences are unavailable.
    }
  }, []);

  useEffect(() => {
    const onMemoryPeerApplied = () => { void refresh(); };
    window.addEventListener("personal-memory-peer-applied", onMemoryPeerApplied);
    return () => window.removeEventListener("personal-memory-peer-applied", onMemoryPeerApplied);
  }, [refresh]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(lastAskStorageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as { question?: unknown; answer?: unknown; replyMode?: unknown };
      const storedAnswer = stored.answer as Partial<ChatResponse> | undefined;
      if (typeof stored.question === "string" && storedAnswer && typeof storedAnswer.answer === "string" && Array.isArray(storedAnswer.evidence)) {
        setQuestion(stored.question);
        setAnswer(storedAnswer as ChatResponse);
        if (stored.replyMode === "text" || stored.replyMode === "audio" || stored.replyMode === "both") setAnswerReplyMode(stored.replyMode);
      }
    } catch {
      // A malformed or unavailable session store must never break Ask.
    }
  }, []);

  const pending = useMemo(
    () => memories.filter(
      (memory) => memory.status === "unconfirmed",
    ),
    [memories, seedFeedback],
  );
  const confirmed = useMemo(
    () => memories.filter((memory) => memory.status === "confirmed"),
    [memories],
  );
  const needsCorrection = useMemo(
    () => memories.filter(
      (memory) => memory.status === "unconfirmed" && memory.source_type === "friend_seed" && seedFeedback[memory.id] === "sort_of",
    ),
    [memories, seedFeedback],
  );
  const friendSeeds = useMemo(
    () => memories.filter((memory) => memory.source_type === "friend_seed" && (memory.status === "unconfirmed" || memory.status === "confirmed")),
    [memories],
  );
  const acceptedFriendSeeds = useMemo(
    () => friendSeeds.filter((memory) => memory.status === "confirmed").length,
    [friendSeeds],
  );

  const namedRecipient = giftConfig.recipientName.toLowerCase() === "you" ? null : giftConfig.recipientName;

  function closeGift() {
    try {
      window.localStorage.setItem(giftStorageKey, "1");
    } catch {
      // The reveal still closes even if local storage is unavailable.
    }
    setGiftOpen(false);
  }

  function chooseReplyMode(mode: ReplyMode) {
    setReplyMode(mode);
    try { window.localStorage.setItem(replyModeStorageKey, mode); } catch { /* Preference remains active for this session. */ }
  }

  function presentAssistantReply(nextAnswer: ChatResponse): ReplyMode {
    const mode = replyMode;
    setAnswer(nextAnswer);
    setAnswerReplyMode(mode);
    if (replyIncludesAudio(mode)) setSpeechRequest({ id: Date.now(), text: nextAnswer.answer });
    return mode;
  }

  async function runAsk(rawText: string) {
    const text = rawText.trim() || (askFiles.length ? "Summarize the attached file or files." : "");
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const nextAnswer = await api.chat(text, askFiles);
      const mode = presentAssistantReply(nextAnswer);
      setAnswerFileNames(askFiles.map(file => file.name));
      try {
        window.sessionStorage.setItem(lastAskStorageKey, JSON.stringify({ question: text, answer: nextAnswer, replyMode: mode }));
      } catch {
        // Keep the answer even when session storage is unavailable or full.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Question failed.");
    } finally {
      setBusy(false);
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    await runAsk(question);
  }

  async function askFromVoice(text: string) {
    setQuestion(text);
    await runAsk(text);
  }

  async function confirmStudyAction() {
    const proposal = answer?.study_action_proposal;
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const source = await executeStudyAction(proposal);
      const nextAnswer: ChatResponse = {
        ...answer,
        answer: personaStudyActionMessage(proposal.locale, "completed", describeStudyAction(proposal)),
        study_action_proposal: undefined,
        study_sources: [source],
      };
      const mode = presentAssistantReply(nextAnswer);
      try { window.sessionStorage.setItem(lastAskStorageKey, JSON.stringify({ question, answer: nextAnswer, replyMode: mode })); } catch { /* Visible state still updates. */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the Study change.");
    } finally {
      setBusy(false);
    }
  }

  function cancelStudyAction() {
    const proposal = answer?.study_action_proposal;
    if (!proposal || busy) return;
    const nextAnswer: ChatResponse = {
      ...answer,
      answer: personaStudyActionMessage(proposal.locale, "cancelled", describeStudyAction(proposal)),
      study_action_proposal: undefined,
    };
    const mode = presentAssistantReply(nextAnswer);
    try { window.sessionStorage.setItem(lastAskStorageKey, JSON.stringify({ question, answer: nextAnswer, replyMode: mode })); } catch { /* Visible state still updates. */ }
  }

  async function chooseAskFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    try { setAskFiles(await readAskFiles(Array.from(files))); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not read the attached file."); }
  }

  function downloadAnswer() {
    if (!answer) return;
    const artifact = answerArtifact(answer.answer, artifactFormat);
    downloadArtifact(artifact.filename, artifact.blob);
  }

  async function remember(event: FormEvent) {
    event.preventDefault();
    const text = rememberText.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ingest(text);
      if (result.candidate_memories.length === 0) {
        setError(
          "I couldn't identify a durable memory from that wording yet. Nothing was saved; try phrasing it a little more explicitly.",
        );
        return;
      }
      setRememberText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyse that memory.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCorrection(event: FormEvent) {
    event.preventDefault();
    if (!editingMemory || !correctionText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.correctMemory(editingMemory.id, correctionText.trim(), editingMemory.content, correctionType, editingMemory.type);
      setEditingMemory(null);
      setCorrectionNotice("Correction saved. Review it, then confirm separately when it is accurate.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the correction.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewMemory(memory: Memory, action: "confirm" | "reject") {
    setBusy(true);
    setError(null);
    try {
      if (action === "confirm") await api.confirmMemory(memory.id);
      else await api.rejectMemory(memory.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update memory.");
    } finally {
      setBusy(false);
    }
  }

  async function calibrateMemory(memory: Memory, verdict: CalibrationVerdict) {
    setBusy(true);
    setError(null);
    try {
      await api.calibrateMemory(memory.id, verdict);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that calibration.");
    } finally {
      setBusy(false);
    }
  }

  async function completeLoop(loop: OpenLoop) {
    setBusy(true);
    try {
      await api.completeLoop(loop.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close that loop.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <StudyReminderScheduler />
      {giftOpen && (
        <div className="giftOverlay" role="dialog" aria-modal="true" aria-label="Birthday gift introduction">
          <section className="giftCard">
            <div className="giftMark">M</div>
            <p className="giftKicker">{uiLocale === "zh" ? `来自 ${giftConfig.giverName} 的生日礼物` : `A BIRTHDAY GIFT FROM ${giftConfig.giverName.toUpperCase()}`}</p>
            <h2>{namedRecipient ? (uiLocale === "zh" ? `${namedRecipient}，这是给你的。` : `${namedRecipient}, this one is yours.`) : t("This one is yours.", "这是给你的。")}</h2>
            <p className="giftLead">{uiLocale === "zh" ? giftConfig.messageZh : giftConfig.message}</p>
            <div className="giftPrinciples">
              <span><strong>01</strong> {t("It remembers with evidence.", "它以证据为基础记住事情。")}</span>
              <span><strong>02</strong> {t("You decide what becomes true.", "由你决定什么可以成为可信记忆。")}</span>
              <span><strong>03</strong> {t("It gets better as you use it.", "它会随着你的使用逐渐变得更懂你。")}</span>
            </div>
            <button className="giftPrimary" onClick={closeGift}>{t("Open my memory", "打开我的记忆")}</button>
            <small>{t("Your personal data can stay on this computer.", "你的个人数据可以只保留在这台电脑上。")}</small>
          </section>
        </div>
      )}

      <aside className="sidebar">
        <div className="brand" onClick={() => setView("home")} role="button" tabIndex={0}>
          <span className="brandMark">M</span>
          <div>
            <strong>{giftConfig.productName}</strong>
            <small>{t("private by design", "隐私优先设计")}</small>
          </div>
        </div>

        <nav>
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>{t("Today", "今天")}</button>
          <button className={view === "notes" ? "active" : ""} onClick={() => setView("notes")}>{t("Notes", "笔记")}</button>
          <button className={view === "projects" ? "active" : ""} onClick={() => setView("projects")}>{t("Projects", "项目")}</button>
          <button className={view === "devices" ? "active" : ""} onClick={() => setView("devices")}>{t("Devices", "设备")}</button>
          <button className={view === "memories" ? "active" : ""} onClick={() => setView("memories")}>{t("Memories", "记忆")} <span>{confirmed.length}</span></button>
          <button className={view === "context" ? "active" : ""} onClick={() => setView("context")}>{t("Context review", "语境审核")} <span>{memories.filter(memory => (memory.status === "confirmed" || memory.status === "unconfirmed") && !memory.active_context_note).length}</span></button>
          <button className={view === "loops" ? "active" : ""} onClick={() => setView("loops")}>{t("Open loops", "待办线索")} <span>{loops.length}</span></button>
          <button className="giftNav" onClick={() => setGiftOpen(true)}>{t("Gift from", "来自")} {giftConfig.giverName}{uiLocale === "zh" ? " 的礼物" : ""}</button>
        </nav>

        <div className="sidebarFoot">
          <div className={`statusDot ${connected ? "online" : ""}`} />
          <span>{browserMemoryEnabled ? t("Browser memory ready", "浏览器记忆已就绪") : connected === null ? t("Checking service", "正在检查服务") : connected ? t("Local memory online", "本地记忆在线") : t("Backend offline", "后端离线")}</span>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">{uiLocale === "zh" ? (namedRecipient ? `个人记忆系统 · 给 ${namedRecipient}` : "个人记忆系统 · V0.3") : (namedRecipient ? `PERSONAL MEMORY SYSTEM · FOR ${namedRecipient.toUpperCase()}` : "PERSONAL MEMORY SYSTEM · V0.3")}</p>
            <h1>{view === "home" ? t("What are you trying to remember?", "你想记住什么？") : view === "memories" ? t("What I know about you", "我所知道的你") : view === "context" ? t("What did this memory mean?", "这段记忆意味着什么？") : view === "notes" ? t("Your notes", "你的笔记") : view === "projects" ? t("Your projects", "你的项目") : view === "devices" ? t("Your trusted devices", "你的可信设备") : t("Things still in motion", "仍在进行的事项")}</h1>
          </div>
          <div className="topbarPills"><div className="uiLocaleControl" role="group" aria-label={t("Interface language", "界面语言")}>
            <button type="button" className={uiLocale === "en" ? "selected" : ""} onClick={() => setUiLocale("en")}>EN</button>
            <button type="button" className={uiLocale === "zh" ? "selected" : ""} onClick={() => setUiLocale("zh")}>中文</button>
          </div><span className="privacyPill">{t("Stored locally", "本地存储")}</span><PersonaPicker /><DeviceReadiness /><StudySyncAgent /></div>
        </header>

        {error && view !== "notes" && view !== "projects" && <div className="errorBanner">{connected === false ? t("The memory service is unavailable. Your local notes and projects still work.", "记忆服务暂不可用；你的本地笔记和项目仍可正常使用。") : error}</div>}

        {view === "home" && (
          <>
            <StudyToday open={setView} />
            <form className="askBox askBoxEnhanced" onSubmit={ask}>
              <div className="askInputRow">
                <input
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder={t("Message, recall a memory, search the web, or attach a file…", "输入消息、回忆记忆、搜索网页或添加文件…")}
                  aria-label={t("Message assistant", "给助手发消息")}
                />
                <label className="askAttachButton">{t("Attach", "添加文件")}
                  <input type="file" multiple accept=".txt,.md,.markdown,.json,.csv,.tsv,.js,.ts,.tsx,.jsx,.py,.html,.css,.xml,.yaml,.yml,.tex,.log,text/*,application/json,application/xml"
                    onChange={event => { void chooseAskFiles(event.target.files); event.target.value = ""; }} />
                </label>
                <button disabled={busy || (!question.trim() && !askFiles.length)}>{busy ? t("Thinking…", "思考中…") : t("Send", "发送")}</button>
              </div>
              <div className="askComposerOptions">
                <VoiceConversation disabled={busy} onVoiceText={askFromVoice} speakRequest={speechRequest}
                  onNotice={message => setError(message || null)} />
                <div className="replyModeControl" role="group" aria-label={t("Reply format", "回复格式")}>
                  <span>{t("Reply", "回复")}</span>
                  {(["text", "audio", "both"] as ReplyMode[]).map(mode => <button key={mode} type="button"
                    disabled={busy} aria-pressed={replyMode === mode} className={replyMode === mode ? "selected" : ""}
                    onClick={() => chooseReplyMode(mode)}>{mode === "text" ? t("Text", "文字") : mode === "audio" ? t("Audio", "语音") : t("Both", "文字 + 语音")}</button>)}
                </div>
              </div>
              {askFiles.length > 0 && <div className="askFileTray" aria-label={t("Attached Ask files", "已添加的对话文件")}>
                {askFiles.map((file, index) => <button type="button" className="askFileChip" key={`${file.name}-${index}`}
                  onClick={() => setAskFiles(files => files.filter((_, i) => i !== index))} title={t("Remove file", "移除文件")}>
                  {file.name}{file.truncated ? ` · ${t("excerpt", "摘录")}` : ""} <span>×</span>
                </button>)}
                <small>{t("Local question context only · not saved as Memory evidence.", "仅作为本次本地对话上下文 · 不会保存为记忆证据。")}</small>
              </div>}
            </form>

            {answer && (
              <section className="answerArea">
                <p className="answerLabel">{answerSourceLabel(answer, answerFileNames, uiLocale)}</p>
                {replyIncludesText(answerReplyMode) ? <p className="answerText">{answer.answer}</p> : <p className="answerAudioOnly">{t("Audio reply selected", "已选择语音回复")}</p>}
                {answer.study_action_proposal && <div className="studyActionProposal" aria-label={t("Proposed Study change", "拟进行的学习记录更改")}>
                  <small>{t("Proposed local change · nothing has been saved yet", "拟进行本地更改 · 尚未保存任何内容")}</small>
                  <strong>{describeStudyAction(answer.study_action_proposal)}</strong>
                  <div>
                    <button type="button" disabled={busy} onClick={() => void confirmStudyAction()}>{busy ? t("Saving…", "保存中…") : t("Confirm change", "确认更改")}</button>
                    <button type="button" disabled={busy} onClick={cancelStudyAction}>{t("Cancel", "取消")}</button>
                  </div>
                </div>}
                {answerFileNames.length > 0 && <p className="fileContextNotice">{answer.file_context_used ? t("File context used", "已使用文件上下文") : t("File attached, but not analysed", "文件已添加，但未分析")}: {answerFileNames.join(", ")} · {t("transient, not Memory evidence.", "仅用于本次对话，不属于记忆证据。")}</p>}
                {answer.study_sources && answer.study_sources.length > 0 && <div className="studySources" aria-label={t("Notes and Projects sources", "笔记和项目来源")}>
                  <small>{t("Notes/Projects · local working context, not Memory evidence", "笔记/项目 · 本地工作上下文，不属于记忆证据")}</small>
                  {answer.study_sources.map(source => <div className="studySourceCard" key={source.id}>
                    <strong>{source.kind === "project" ? t("Project", "项目") : t("Note", "笔记")} · {source.title}</strong>
                    {(source.subject || source.unit) && <span>{source.subject || t("Inbox", "收件箱")}{source.unit ? ` / ${source.unit}` : ""}</span>}
                    {source.next_action && <span>{t("Next", "下一步")}: {source.next_action}</span>}
                    {source.tasks?.some(task => !task.done) && <span>{t("Open tasks", "未完成任务")}: {source.tasks.filter(task => !task.done).slice(0, 3).map(task => `${task.title}${task.due ? ` · ${task.due}` : ""}`).join("; ")}</span>}
                    {source.reminders?.some(reminder => reminder.status === "scheduled") && <span>{t("Reminders", "提醒")}: {source.reminders.filter(reminder => reminder.status === "scheduled").slice(0, 3).map(reminder => `${reminder.title} · ${new Date(reminder.scheduled_for).toLocaleString()}`).join("; ")}</span>}
                    {!source.next_action && !source.tasks?.length && !source.reminders?.length && source.excerpt && <span>{source.excerpt}</span>}
                  </div>)}
                </div>}
                {answer.web_sources && answer.web_sources.length > 0 && <div className="webSources" aria-label={t("Web sources", "网页来源")}>
                  <small>{t("Web sources · external context, not Memory evidence", "网页来源 · 外部上下文，不属于记忆证据")}</small>
                  {answer.web_sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
                    <strong>[W{index + 1}] {source.title}</strong>
                    <span>{source.snippet || source.url}</span>
                  </a>)}
                </div>}
                <div className="artifactActions">
                  <label>{t("Download answer as", "下载回复格式")}
                    <select value={artifactFormat} onChange={event => setArtifactFormat(event.target.value as ArtifactFormat)}>
                      <option value="md">Markdown</option><option value="txt">Text</option><option value="json">JSON</option><option value="csv">CSV</option>
                    </select>
                  </label>
                  <button type="button" onClick={downloadAnswer}>{t("Generate file", "生成文件")}</button>
                </div>
                {answer.evidence.length > 0 && (
                  <div className="evidenceLine">
                    {answer.evidence.map((item) => (
                      <div key={item.memory_id}>
                        <span>{item.content}</span>
                        {item.sources ? (
                          <details className="memorySources">
                            <summary>{t("Original evidence", "原始证据")}</summary>
                            {item.sources.length ? item.sources.map((source, index) => (
                              <div key={`${source.source_id}-${index}`}>
                                <small>{t("Source", "来源")} {index + 1}</small>
                                <blockquote>{readableEvidence(source.evidence_text)}</blockquote>
                              </div>
                            )) : <p>{t("No original evidence is stored for this memory.", "这条记忆没有保存原始证据。")}</p>}
                          </details>
                        ) : <MemoryEvidence memoryId={item.memory_id} />}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            <div className="homeColumns">
              <section className="flowSection">
                <div className="sectionHeading">
                  <div>
                    <p className="eyebrow">{t("OPEN LOOPS", "待办线索")}</p>
                    <h2>{t("Things you said you’d come back to", "你说过之后要回来处理的事")}</h2>
                  </div>
                  <button className="textButton" onClick={() => setView("loops")}>{t("See all", "查看全部")}</button>
                </div>

                {loops.length === 0 ? (
                  <p className="emptyState">{t("Nothing unresolved right now.", "目前没有未解决事项。")}</p>
                ) : (
                  <div className="plainList">
                    {loops.slice(0, 4).map((loop) => (
                      <div className="listRow" key={loop.id}>
                        <button className="circleCheck" onClick={() => completeLoop(loop)} aria-label={t("Mark complete", "标记为完成")} />
                        <div>
                          <p>{loop.content}</p>
                          <small>{loop.kind === "goal" ? t("Goal", "目标") : t("Commitment", "承诺")}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="flowSection pendingSection">
                <div className="sectionHeading">
                  <div>
                    <p className="eyebrow">{t("REVIEW", "审核")}</p>
                    <h2>{pending.length ? (uiLocale === "zh" ? `${pending.length} 条记忆等待你确认` : `${pending.length} memories need your call`) : t("No memories waiting for review", "没有等待审核的记忆")}</h2>
                  </div>
                </div>

                {!browserMemoryEnabled && <><SourceReview onSaved={refresh} /><ArchiveSearch onSaved={refresh} /></>}
                {browserMemoryEnabled && <p className="archiveBoundary">{t("Original chat/archive review stays on the private import workstation; reviewed memories and their evidence are what travel with this gift.", "原始聊天/归档审核保留在私有导入工作站；随这份礼物同步的是已经审核过的记忆及其证据。")}</p>}
                {correctionNotice && <p role="status">{correctionNotice}</p>}
                {pending.map((memory) => {
                  const fromFriend = memory.source_type === "friend_seed";
                  return (
                    <div className={`reviewRow ${fromFriend ? "friendSeedRow" : ""}`} key={memory.id}>
                      <div>
                        <small>
                          {fromFriend
                            ? (uiLocale === "zh" ? `来自 ${giftConfig.giverName} · 未确认` : `FROM ${giftConfig.giverName.toUpperCase()} · UNCONFIRMED`)
                            : `${memory.type.toUpperCase()} · ${memory.confidence_label}`}
                        </small>
                        <p>{memory.content}</p>
                        <MemoryEvidence key={`${memory.id}-${memory.updated_at}`} memoryId={memory.id} />
                        <MemoryContextNote memory={memory} onChanged={refresh} />
                      </div>
                      {editingMemory?.id === memory.id ? (
                        <form onSubmit={saveCorrection} className="correctionForm">
                          <label htmlFor={`correction-${memory.id}`}>{t("Correct the memory", "更正记忆")}</label>
                          <textarea id={`correction-${memory.id}`} value={correctionText} maxLength={20000}
                            onChange={(event) => setCorrectionText(event.target.value)} disabled={busy} autoFocus />
                          <label htmlFor={`category-${memory.id}`}>{t("Memory category", "记忆类别")}</label>
                          <select id={`category-${memory.id}`} value={correctionType} onChange={(event) => setCorrectionType(event.target.value)} disabled={busy}>
                            {memoryTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
                          </select>
                          <small>{t("The original evidence stays unchanged. Saving does not confirm this memory.", "原始证据保持不变；保存更正并不会自动确认这条记忆。")}</small>
                          <div className="reviewActions">
                            <button type="submit" disabled={busy || !correctionText.trim()}>{t("Save correction", "保存更正")}</button>
                            <button type="button" disabled={busy} onClick={() => setEditingMemory(null)}>{t("Cancel", "取消")}</button>
                          </div>
                        </form>
                      ) : <div>
                      <div className="reviewActions">
                        <button disabled={busy || editingMemory !== null} onClick={() => {
                          setEditingMemory(memory); setCorrectionText(memory.content); setCorrectionType(memory.type); setCorrectionNotice("");
                        }}>{t("Edit", "编辑")}</button>
                      </div>
                      {fromFriend ? (
                        <div className="reviewActions calibrationActions">
                          <button className="approve" disabled={busy || editingMemory !== null} onClick={() => calibrateMemory(memory, "accurate")}>{t("Accurate", "准确")}</button>
                          <button disabled={busy || editingMemory !== null} onClick={() => calibrateMemory(memory, "sort_of")}>{t("Sort of", "部分准确")}</button>
                          <button className="slander" disabled={busy || editingMemory !== null} onClick={() => calibrateMemory(memory, "slander")}>{t("Slander", "不准确")}</button>
                        </div>
                      ) : (
                        <div className="reviewActions">
                          <button className="approve" disabled={busy || editingMemory !== null} onClick={() => reviewMemory(memory, "confirm")}>{t("Keep", "保留")}</button>
                          <button disabled={busy || editingMemory !== null} onClick={() => reviewMemory(memory, "reject")}>{t("Not me", "不是我")}</button>
                        </div>
                      )}</div>}
                    </div>
                  );
                })}

                {needsCorrection.length > 0 && (
                  <p className="correctionNote">
                    {uiLocale === "zh" ? `${needsCorrection.length} 条记忆被标记为“部分准确”。确认前请先用上方“编辑”更正措辞。` : `${needsCorrection.length} ${needsCorrection.length === 1 ? "memory is" : "memories are"} marked “sort of”. Use Edit above to correct the wording before confirming.`}
                  </p>
                )}
              </section>
            </div>

            <section className="fromFriend">
              <div>
                <p className="eyebrow">{uiLocale === "zh" ? `来自 ${giftConfig.giverName}` : `FROM ${giftConfig.giverName.toUpperCase()}`}</p>
                {friendSeeds.length > 0 ? (
                  <p>
                    {uiLocale === "zh" ? `${giftConfig.giverName} 留下了 ${friendSeeds.length} 条起始记忆。你已经确认 ${acceptedFriendSeeds} 条；其余内容在你决定之前不会进入 AI 的可信记忆。` : <>{giftConfig.giverName} left {friendSeeds.length} starting {friendSeeds.length === 1 ? "memory" : "memories"}. You&apos;ve confirmed {acceptedFriendSeeds}; the rest stay outside the AI&apos;s trusted memory until you decide.</>}
                  </p>
                ) : (
                  <p>{uiLocale === "zh" ? giftConfig.messageZh : giftConfig.message}</p>
                )}
              </div>
              <button className="textButton" onClick={() => setGiftOpen(true)}>{t("Replay opening", "重新播放开场")}</button>
            </section>

            <section className="rememberStrip">
              <div>
                <p className="eyebrow">{t("TEACH IT SOMETHING", "告诉它一些事")}</p>
                <h2>{t("Anything worth remembering?", "有什么值得记住的吗？")}</h2>
                <p>{t("Say it normally. The system will propose memories rather than silently treating them as fact.", "自然地说就好。系统会先提出候选记忆，不会默默把它当作事实。")}</p>
              </div>
              <form onSubmit={remember}>
                <input value={rememberText} onChange={(event) => setRememberText(event.target.value)} placeholder={t("I decided to… / I prefer… / I need to…", "我决定… / 我更喜欢… / 我需要…")} />
                <button disabled={busy || !rememberText.trim()}>{t("Remember", "记住")}</button>
              </form>
            </section>
          </>
        )}

        {view === "notes" && <Study key="notes" kind="note" />}
        {view === "projects" && <Study key="projects" kind="project" />}
        {view === "devices" && <StudyDevices />}
        {view === "memories" && (
          <section className="memoryLedger">
            <div className="ledgerStats">
              <span><strong>{confirmed.length}</strong> {t("confirmed", "已确认")}</span>
              <span><strong>{pending.length}</strong> {t("awaiting review", "等待审核")}</span>
              <span><strong>{needsCorrection.length}</strong> {t("needs correction", "需要更正")}</span>
              <span><strong>{memories.filter((memory) => memory.status === "superseded").length}</strong> {t("historical", "历史记录")}</span>
            </div>
            <MemorySyncConflictReview onResolved={refresh} />
            <MemoryBackup onRestored={refresh} />
            {memories.length === 0 ? (
              <p className="emptyState">{t("No memories yet.", "还没有记忆。")}</p>
            ) : memories.map((memory) => (
              <article className="memoryEntry" key={memory.id}>
                <div className="memoryMeta">
                  <span>{memory.type}</span>
                  <span>{memory.status}</span>
                  <span>{memory.source_type.replaceAll("_", " ")}</span>
                  {seedFeedback[memory.id] && <span>calibration: {seedFeedback[memory.id].replaceAll("_", " ")}</span>}
                </div>
                <h3>{memory.content}</h3>
                <MemoryEvidence key={`${memory.id}-${memory.updated_at}`} memoryId={memory.id} />
                {(memory.status === "confirmed" || memory.status === "unconfirmed") && <MemoryContextNote memory={memory} onChanged={refresh} />}
                <div className="memoryFoot">
                  <span>{memory.confidence_label}</span>
                  <span>{memory.evidence_count} {t("evidence items", "条证据")}</span>
                </div>
              </article>
            ))}
          </section>
        )}

        {view === "context" && <ContextReview memories={memories} onChanged={refresh} />}

        {view === "loops" && (
          <section className="loopsPage">
            <MemorySyncConflictReview onResolved={refresh} />
            {loops.length === 0 ? <p className="emptyState">{t("Nothing unresolved right now.", "目前没有未解决事项。")}</p> : loops.map((loop) => (
              <article className="loopEntry" key={loop.id}>
                <button className="circleCheck large" onClick={() => completeLoop(loop)} aria-label={t("Mark complete", "标记为完成")} />
                <div>
                  <p className="eyebrow">{loop.kind === "goal" ? t("Goal", "目标") : t("Commitment", "承诺")}</p>
                  <h3>{loop.content}</h3>
                  <small>{t("Opened", "创建于")} {new Date(loop.created_at).toLocaleDateString()}</small>
                </div>
              </article>
            ))}
          </section>
        )}

        <footer>
          <span>{t("Built from evidence, not guesses.", "以证据为基础，而不是猜测。")}</span>
          <span>{uiLocale === "zh" ? `版本 0.3 · ${giftConfig.giverName} 制作` : `Version 0.3 · built by ${giftConfig.giverName}`}</span>
        </footer>
      </section>
    </main>
  );
}

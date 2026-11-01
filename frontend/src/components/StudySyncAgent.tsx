"use client";

import { useEffect, useRef, useState } from "react";
import {
  getStudyPeerStatus,
  markStudyPeerOffline,
  runStudyPeerSync,
  StudyPeerStatus,
} from "@/lib/study-peer-persistence";
import { getJihuRelayConfig } from "@/lib/study-jihu-auth";
import { getJihuStudyRelay } from "@/lib/study-jihu-relay";
import { useUiLocale } from "@/lib/ui-locale";

const label = {
  "saved-offline": "Saved offline",
  syncing: "Syncing",
  "up-to-date": "Up to date",
  "needs-review": "Needs review",
  revoked: "Revoked",
} as const;

export default function StudySyncAgent() {
  const { locale, t } = useUiLocale();
  const [state, setState] = useState<StudyPeerStatus | null>(null);
  const running = useRef(false);
  const rerun = useRef(false);
  const url = process.env.NEXT_PUBLIC_STUDY_PEER_RELAY_URL?.trim() ?? "";
  const jihuConfigured = Boolean(getJihuRelayConfig());
  const configured = Boolean(url) || jihuConfigured;

  useEffect(() => {
    if (!configured) { setState(null); return; }
    let disposed = false;
    const load = async () => {
      try { const next = await getStudyPeerStatus(); if (!disposed) setState(next); }
      catch { /* Study storage surfaces its own errors. */ }
    };
    const sync = async () => {
      if (!configured || !navigator.onLine) { await load(); return; }
      if (running.current) { rerun.current = true; return; }
      running.current = true;
      do {
        rerun.current = false;
        try { await runStudyPeerSync(jihuConfigured ? getJihuStudyRelay() : url); } catch { /* Durable encrypted outbox remains queued. */ }
        await load();
      } while (!disposed && rerun.current && navigator.onLine);
      running.current = false;
    };
    const onState = () => { void load(); };
    const onNeed = () => { void markStudyPeerOffline().then(() => sync()).catch(() => sync()); };
    const onOnline = () => { void sync(); };
    const onOffline = () => { void markStudyPeerOffline().then(load).catch(() => undefined); };
    const onVisibility = () => { if (document.visibilityState === "visible") void sync(); };
    window.addEventListener("personal-study-sync-state", onState);
    window.addEventListener("personal-study-sync-needed", onNeed);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    if (!navigator.onLine) void markStudyPeerOffline().then(load).catch(() => load());
    else { void load(); void sync(); }
    return () => {
      disposed = true;
      window.removeEventListener("personal-study-sync-state", onState);
      window.removeEventListener("personal-study-sync-needed", onNeed);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [configured, jihuConfigured, url]);

  if (!configured) return null;
  const phase = state?.phase ?? "saved-offline";
  const title = state?.lastError || t("Study records synchronize as encrypted peer-replica changes when the relay is reachable.", "中继可用时，学习记录会以加密的对等副本变更进行同步。");
  const zhLabel = { "saved-offline": "离线已保存", syncing: "同步中", "up-to-date": "已是最新", "needs-review": "需要审核", revoked: "已撤销" } as const;
  return <span className="privacyPill" data-study-sync-state={phase} title={title}>{locale === "zh" ? zhLabel[phase] : label[phase]}</span>;
}
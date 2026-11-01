"use client";

import { useEffect, useMemo, useState } from "react";
import { beginJihuAuthorization, disconnectJihu, getJihuAuthStatus, getJihuRelayConfig, JihuAuthStatus } from "@/lib/study-jihu-auth";
import { getJihuStudyRelay, validateJihuStudyRelay } from "@/lib/study-jihu-relay";
import { useUiLocale } from "@/lib/ui-locale";
import {
  approveStudyDevicePairing,
  beginStudyDevicePairing,
  completeStudyDevicePairing,
  createStudyRecoveryKit,
  getStudyPeerStatus,
  getStudyTrustedDevices,
  inspectStudyPairingRequest,
  recoverStudyPeerFromKit,
  requestStudyDevicePairing,
  runStudyPeerSync,
  revokeStudyPeerDevice,
  StudyPairingAdminRequest,
  StudyPairingJoinSession,
  StudyPairingOfferSession,
  StudyRecoveryMaterial,
  StudyTrustedDeviceInfo,
} from "@/lib/study-peer-persistence";

export default function StudyDevices() {
  const { locale, t } = useUiLocale();
  const [devices, setDevices] = useState<StudyTrustedDeviceInfo[]>([]);
  const [offer, setOffer] = useState<StudyPairingOfferSession | null>(null);
  const [adminRequest, setAdminRequest] = useState<StudyPairingAdminRequest | null>(null);
  const [enteredCode, setEnteredCode] = useState("");
  const [joinPayload, setJoinPayload] = useState("");
  const [joinSession, setJoinSession] = useState<StudyPairingJoinSession | null>(null);
  const [recovery, setRecovery] = useState<StudyRecoveryMaterial | null>(null);
  const [restoreKit, setRestoreKit] = useState("");
  const [restoreSecret, setRestoreSecret] = useState("");
  const [quickRecoverySecret, setQuickRecoverySecret] = useState("");
  const [quickRecovered, setQuickRecovered] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [jihuAuth, setJihuAuth] = useState<JihuAuthStatus | null>(null);
  const relayUrl = process.env.NEXT_PUBLIC_STUDY_PEER_RELAY_URL?.trim() ?? "";
  const bundledRecoveryKitUrl = process.env.NEXT_PUBLIC_BUNDLED_RECOVERY_KIT_URL?.trim() ?? "";
  const jihuConfigured = Boolean(getJihuRelayConfig());
  const relayReady = Boolean(relayUrl) || Boolean(jihuConfigured && jihuAuth?.connected);
  const relaySource = () => {
    if (jihuConfigured) {
      if (!jihuAuth?.connected) throw new Error(t("Connect JihuLab before using cross-device sync.", "使用跨设备同步前请先连接 JihuLab。"));
      return getJihuStudyRelay();
    }
    if (!relayUrl) throw new Error(t("No encrypted relay is configured.", "尚未配置加密中继。"));
    return relayUrl;
  };

  const refresh = async () => setDevices(await getStudyTrustedDevices());
  useEffect(() => {
    void refresh().catch(error => setNotice(error instanceof Error ? error.message : t("Could not load trusted devices.", "无法加载可信设备。")));
    if (jihuConfigured) void getJihuAuthStatus().then(setJihuAuth).catch(() => undefined);
    const onChange = () => { void refresh().catch(() => undefined); };
    const onRelayAuth = () => { void getJihuAuthStatus().then(setJihuAuth).catch(() => undefined); };
    window.addEventListener("personal-study-sync-applied", onChange);
    window.addEventListener("personal-study-sync-state", onChange);
    window.addEventListener("personal-study-relay-auth", onRelayAuth);
    return () => {
      window.removeEventListener("personal-study-sync-applied", onChange);
      window.removeEventListener("personal-study-sync-state", onChange);
      window.removeEventListener("personal-study-relay-auth", onRelayAuth);
    };
  }, [jihuConfigured]);

  useEffect(() => {
    if (!bundledRecoveryKitUrl) return;
    let active = true;
    void Promise.all([
      fetch(bundledRecoveryKitUrl, { cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error(t("Bundled recovery file unavailable.", "内置恢复文件不可用。"));
        return JSON.parse(await response.text()) as { vaultId?: string };
      }),
      getStudyPeerStatus(),
    ]).then(([kit, status]) => {
      if (active && kit.vaultId && kit.vaultId === status.vaultId) setQuickRecovered(true);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [bundledRecoveryKitUrl]);

  const current = useMemo(() => devices.find(device => device.current), [devices]);
  const isAdmin = current?.admin === true && !current.revoked;

  async function run(action: () => Promise<void>) {
    setBusy(true); setNotice("");
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : t("Device action failed.", "设备操作失败。")); }
    finally { setBusy(false); }
  }

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setNotice(locale === "zh" ? "已复制。" : `${label} copied.`); }
    catch { setNotice(locale === "zh" ? "无法复制；请手动选择并复制。" : `Could not copy ${label.toLowerCase()}; select it manually.`); }
  }

  return <section className="devicePanel">
    <p>{t("Every trusted device keeps its own local copy. The relay carries encrypted changes; it does not decide which version is true.", "每台可信设备都保留自己的本地副本。中继只传递加密变更，不负责决定哪个版本是真实版本。")}</p>
    {notice && <p role="status" className="deviceNotice">{notice}</p>}

    {bundledRecoveryKitUrl && <section className="quickDeviceSetup">
      <p className="eyebrow">{t("FIRST DEVICE SETUP", "首台设备设置")}</p>
      <h2>{t("Set up this device", "设置此设备")}</h2>
      <p>{t("This private copy is prepared for the first device receiving the gift. You only need the separate recovery code and one sync sign-in.", "此私有副本已为接收礼物的第一台设备准备好。你只需要单独的恢复码，并登录一次同步服务。")}</p>
      <div className="quickSetupStep">
        <strong>{t("1. Unlock this copy", "1. 解锁此副本")}</strong>
        <span>{quickRecovered ? t("Ready on this device.", "此设备已就绪。") : t("The encrypted recovery file is already included. Enter the separate recovery code once.", "已内置加密恢复文件；只需输入一次单独的恢复码。")}</span>
        {!quickRecovered && <>
          <input aria-label={t("Recovery code", "恢复码")} type="password" autoComplete="off" value={quickRecoverySecret}
            onChange={event => setQuickRecoverySecret(event.target.value)} placeholder={t("Recovery code", "恢复码")} />
          <button disabled={busy || !quickRecoverySecret.trim()} onClick={() => void run(async () => {
            const response = await fetch(bundledRecoveryKitUrl, { cache: "no-store" });
            if (!response.ok) throw new Error(t("The bundled recovery file could not be opened.", "无法打开内置恢复文件。"));
            const kitText = await response.text();
            const kit = JSON.parse(kitText) as { signer?: { deviceId?: string } };
            if (!kit.signer?.deviceId) throw new Error(t("The bundled recovery file is invalid.", "内置恢复文件无效。"));
            await recoverStudyPeerFromKit(kitText, quickRecoverySecret.trim());
            await revokeStudyPeerDevice(kit.signer.deviceId);
            setQuickRecoverySecret(""); setQuickRecovered(true); await refresh();
            setNotice(t("This copy is unlocked. Connect secure sync to finish setup.", "此副本已解锁。连接安全同步即可完成设置。"));
          })}>{t("Unlock my memory", "解锁我的记忆")}</button>
        </>}
      </div>
      <div className="quickSetupStep">
        <strong>{t("2. Connect secure sync", "2. 连接安全同步")}</strong>
        <span>{jihuAuth?.connected ? t("Connected.", "已连接。") : t("Sign in once so this device can reach the encrypted sync mailbox.", "登录一次，让此设备可以访问加密同步信箱。")}</span>
        {!jihuAuth?.connected && <button disabled={busy || !jihuConfigured} onClick={() => void run(beginJihuAuthorization)}>{t("Connect sync", "连接同步")}</button>}
      </div>
      <div className="quickSetupStep">
        <strong>{t("3. Finish", "3. 完成")}</strong>
        <span>{t("Download any newer encrypted changes and make this device the active copy.", "下载最新的加密变更，并将此设备设为当前副本。")}</span>
        <button disabled={busy || !quickRecovered || !jihuAuth?.connected} onClick={() => void run(async () => {
          await runStudyPeerSync(getJihuStudyRelay()); await refresh();
          setNotice(t("This device is ready. Your encrypted memories are now available here.", "此设备已就绪，你的加密记忆现在可以在这里使用。"));
        })}>{t("Finish setup", "完成设置")}</button>
      </div>
      <small>{t("Use the advanced controls below only when adding another device or recovering later.", "仅在添加其他设备或日后恢复时使用下方高级控制。")}</small>
    </section>}

    {jihuConfigured && <section className="deviceSection">
      <div className="sectionHeading"><div><p className="eyebrow">{t("ENCRYPTED RELAY", "加密中继")}</p><h2>JihuLab</h2></div></div>
      <p>{jihuAuth?.connected ? t("Connected to the private JihuLab relay repository.", "已连接到私有 JihuLab 中继仓库。") : t("Connect this browser to the private JihuLab relay using OAuth PKCE.", "通过 OAuth PKCE 将此浏览器连接到私有 JihuLab 中继。")}</p>
      <div className="reviewActions">
        {!jihuAuth?.connected && <button disabled={busy} onClick={() => void run(beginJihuAuthorization)}>{t("Connect JihuLab", "连接 JihuLab")}</button>}
        {jihuAuth?.connected && <button disabled={busy} onClick={() => void run(async () => { await validateJihuStudyRelay(); setNotice(t("JihuLab relay is reachable and private.", "JihuLab 中继可访问且为私有。")); })}>{t("Check private relay", "检查私有中继")}</button>}
        {jihuAuth?.connected && <button disabled={busy} onClick={() => void run(async () => { await disconnectJihu(); setJihuAuth(await getJihuAuthStatus()); setNotice(t("JihuLab credentials were removed from this browser.", "已从此浏览器移除 JihuLab 凭据。")); })}>{t("Disconnect on this browser", "在此浏览器断开连接")}</button>}
      </div>
    </section>}

    <section className="deviceSection">
      <div className="sectionHeading"><div><p className="eyebrow">{t("TRUSTED DEVICES", "可信设备")}</p><h2>{t("Your replicas", "你的副本")}</h2></div></div>
      <div className="deviceList">
        {devices.map(device => <article className="deviceCard" key={device.deviceId}>
          <div><strong>{device.current ? t("This device", "此设备") : `${t("Device", "设备")} ${device.deviceId.slice(0, 8)}`}</strong>
            <small>{device.admin ? t("Admin", "管理员") : t("Trusted", "可信")}{device.revoked ? ` · ${t("Revoked", "已撤销")}` : ""} · {t("epoch", "纪元")} {device.currentEpoch}</small></div>
          {isAdmin && !device.current && !device.revoked && <button disabled={busy} onClick={() => {
            if (!window.confirm(locale === "zh" ? `撤销设备 ${device.deviceId.slice(0, 8)}？密钥轮换后，它将无法访问未来的同步。` : `Revoke device ${device.deviceId.slice(0, 8)}? It will lose access to future sync after the key rotates.`)) return;
            void run(async () => { await revokeStudyPeerDevice(device.deviceId); await refresh(); setNotice(t("Device revoked. A new encryption epoch is queued for the remaining devices.", "设备已撤销。其余设备将进入新的加密纪元。")); });
          }}>{t("Revoke device", "撤销设备")}</button>}
        </article>)}
      </div>
    </section>

    {isAdmin && <section className="deviceSection">
      <div className="sectionHeading"><div><p className="eyebrow">{t("ADD A DEVICE", "添加设备")}</p><h2>{t("Approve another replica", "批准另一个副本")}</h2></div></div>
      <p>{t("Create a temporary pairing payload on this admin device, paste it on the new device, then compare the six-digit code before approving.", "在管理员设备上创建临时配对数据，将其粘贴到新设备，再核对六位代码后批准。")}</p>
      {!relayReady && <small>{t("Pairing needs a configured encrypted relay. Recovery-kit export still works offline.", "配对需要已配置的加密中继；恢复包仍可离线导出。")}</small>}
      <div className="reviewActions"><button disabled={busy || !relayReady} onClick={() => void run(async () => {
        const next = await beginStudyDevicePairing(); setOffer(next); setAdminRequest(null); setEnteredCode(""); setNotice(t("Pairing payload created. It expires in 15 minutes.", "配对数据已创建，15 分钟后过期。"));
      })}>{t("Create pairing payload", "创建配对数据")}</button></div>
      {offer && <div className="pairingBox">
        <label>{t("Pairing payload", "配对数据")}<textarea aria-label="Pairing payload" readOnly value={offer.payload} /></label>
        <div className="reviewActions">
          <button disabled={busy} onClick={() => void copy(offer.payload, "Pairing payload")}>{t("Copy pairing payload", "复制配对数据")}</button>
          <button disabled={busy || !relayReady} onClick={() => void run(async () => {
            const next = await inspectStudyPairingRequest(offer.payload, relaySource());
            setAdminRequest(next); setNotice(next ? t("Join request found. Compare the code with the new device.", "已找到加入请求，请与新设备核对代码。") : t("No join request yet.", "暂时没有加入请求。"));
          })}>{t("Check for join request", "检查加入请求")}</button>
        </div>
        {adminRequest && <div className="verificationBox">
          <small>{t("Request from device", "请求来自设备")} {adminRequest.request.candidateDeviceId.slice(0, 8)}</small>
          <p>{t("Expected code on the new device", "新设备上的预期代码")}: <strong className="pairingCode">{adminRequest.shortCode}</strong></p>
          <label>{t("Code shown on new device", "新设备显示的代码")}<input aria-label="Code shown on new device" inputMode="numeric" maxLength={6} value={enteredCode} onChange={event => setEnteredCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
          <button disabled={busy || enteredCode.length !== 6} onClick={() => void run(async () => {
            await approveStudyDevicePairing(offer.payload, adminRequest.request, enteredCode, relaySource());
            await refresh(); setNotice(t("Device approved. The encrypted vault key is available only to that pairing session.", "设备已批准。加密保险库密钥仅对该配对会话可用。"));
          })}>{t("Approve device", "批准设备")}</button>
        </div>}
      </div>}
    </section>}

    <section className="deviceSection">
      <div className="sectionHeading"><div><p className="eyebrow">{t("JOIN", "加入")}</p><h2>{t("Join an existing vault", "加入现有保险库")}</h2></div></div>
      <p>{t("Use this only on a new, empty device. Your existing local Notes or Projects will never be silently replaced.", "仅在新的空设备上使用。现有本地笔记或项目绝不会被静默替换。")}</p>
      <label>{t("Paste pairing payload", "粘贴配对数据")}<textarea aria-label="Paste pairing payload" value={joinPayload} onChange={event => setJoinPayload(event.target.value)} /></label>
      <button disabled={busy || !relayReady || !joinPayload.trim()} onClick={() => void run(async () => {
        const session = await requestStudyDevicePairing(joinPayload, "", relaySource()); setJoinSession(session); setNotice(t("Join request sent. Compare this code on the admin device before it approves you.", "加入请求已发送。批准前请在管理员设备上核对此代码。"));
      })}>{t("Request to join", "请求加入")}</button>
      {joinSession && <div className="verificationBox">
        <p>{t("Verification code", "验证码")}: <strong className="pairingCode" data-pairing-short-code>{joinSession.shortCode}</strong></p>
        <small>{t("Do not continue if the admin device shows a different code.", "如果管理员设备显示不同代码，请不要继续。")}</small>
        <div className="reviewActions"><button disabled={busy || !relayReady} onClick={() => void run(async () => {
          const completed = await completeStudyDevicePairing(joinSession, relaySource());
          if (!completed) { setNotice(t("Approval is not available yet.", "尚未获得批准。")); return; }
          setJoinSession(null); setJoinPayload(""); await refresh(); setNotice(t("This device joined the vault. Encrypted catch-up is starting.", "此设备已加入保险库，正在同步缺失的加密变更。"));
        })}>{t("Check for approval", "检查批准状态")}</button></div>
      </div>}
    </section>

    <section className="deviceSection">
      <div className="sectionHeading"><div><p className="eyebrow">{t("RECOVERY", "恢复")}</p><h2>{t("Offline recovery kit", "离线恢复包")}</h2></div></div>
      <p>{t("The kit and its recovery secret must be stored separately. The secret is shown here but is never included inside the kit or uploaded by this flow.", "恢复包和恢复密钥必须分开保存。密钥会显示在这里，但不会被包含在恢复包中，也不会由此流程上传。")}</p>
      {isAdmin && <button disabled={busy} onClick={() => void run(async () => { setRecovery(await createStudyRecoveryKit()); setNotice(t("Recovery kit created. Store the kit and secret separately.", "恢复包已创建。请将恢复包和密钥分开保存。")); })}>{t("Create recovery kit", "创建恢复包")}</button>}
      {recovery && <div className="pairingBox">
        <label>{t("Recovery kit", "恢复包")}<textarea aria-label="Recovery kit" readOnly value={recovery.kit} /></label>
        <button disabled={busy} onClick={() => void copy(recovery.kit, "Recovery kit")}>{t("Copy recovery kit", "复制恢复包")}</button>
        <label>{t("Recovery secret", "恢复密钥")}<input aria-label="Recovery secret" readOnly value={recovery.secret} /></label>
        <button disabled={busy} onClick={() => void copy(recovery.secret, "Recovery secret")}>{t("Copy recovery secret", "复制恢复密钥")}</button>
      </div>}
      <details className="recoveryRestore"><summary>{t("Recover onto this empty device", "恢复到此空设备")}</summary>
        <label>{t("Recovery kit to restore", "用于恢复的恢复包")}<textarea aria-label="Recovery kit to restore" value={restoreKit} onChange={event => setRestoreKit(event.target.value)} /></label>
        <label>{t("Recovery secret", "恢复密钥")}<input aria-label="Recovery secret to restore" value={restoreSecret} onChange={event => setRestoreSecret(event.target.value)} /></label>
        <button disabled={busy || !restoreKit.trim() || !restoreSecret.trim()} onClick={() => void run(async () => {
          await recoverStudyPeerFromKit(restoreKit, restoreSecret); setRestoreKit(""); setRestoreSecret(""); await refresh(); setNotice(t("Recovery complete. This device is now an admin replica and can catch up from the relay.", "恢复完成。此设备现在是管理员副本，可从中继同步最新变更。"));
        })}>{t("Recover this device", "恢复此设备")}</button>
      </details>
    </section>
  </section>;
}

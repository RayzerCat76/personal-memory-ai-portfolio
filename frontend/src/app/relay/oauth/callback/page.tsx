"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { announceJihuConnected, completeJihuAuthorization } from "@/lib/study-jihu-auth";

export default function JihuOAuthCallbackPage() {
  const [message, setMessage] = useState("Finishing JihuLab connection…");
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    const error = params.get("error") ?? "";
    if (error) { setMessage(`JihuLab did not authorize the relay (${error}).`); return; }
    if (!code || !state) { setMessage("The JihuLab callback is missing its authorization code or state."); return; }
    void completeJihuAuthorization(code, state).then(() => {
      announceJihuConnected();
      setOk(true);
      setMessage("JihuLab relay connected. No client secret was stored in this app.");
    }).catch(reason => setMessage(reason instanceof Error ? reason.message : "Could not finish JihuLab connection."));
  }, []);

  return <main className="shell"><section className="panel">
    <p className="eyebrow">ENCRYPTED RELAY</p>
    <h1>{ok ? "JihuLab connected" : "Connecting JihuLab"}</h1>
    <p role="status">{message}</p>
    <Link href="/">Return to Personal Memory AI</Link>
  </section></main>;
}

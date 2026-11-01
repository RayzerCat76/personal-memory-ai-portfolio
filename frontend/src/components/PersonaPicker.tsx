"use client";

import { useEffect, useState } from "react";
import { activePersona, applyPersonaTheme, getPersona, personaPacks, personaStorageKey } from "@/lib/persona";
import { useUiLocale } from "@/lib/ui-locale";

export default function PersonaPicker() {
  const { locale, t } = useUiLocale();
  const [selected, setSelected] = useState("neutral");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const pack = activePersona();
    setSelected(pack.id);
    applyPersonaTheme(pack);
  }, []);

  function choose(id: string) {
    const pack = getPersona(id);
    try { window.localStorage.setItem(personaStorageKey, pack.id); } catch { /* theme still applies for this session */ }
    setSelected(pack.id);
    applyPersonaTheme(pack);
    window.dispatchEvent(new CustomEvent("personal-memory-persona-changed", { detail: { id: pack.id } }));
    setOpen(false);
  }

  const current = getPersona(selected);
  return <div className="personaPicker">
    <button className="personaPill" onClick={() => setOpen(value => !value)} aria-expanded={open}>{t("Style", "角色风格")} · {current.displayName[locale]}</button>
    {open && <section className="personaCard" aria-label={t("Character style", "角色风格")}>
      <div><strong>{t("Character style", "角色风格")}</strong><small>{t("Theme and response tone only. Memory truth never changes.", "只改变主题和回复语气，不会改变记忆事实。")}</small></div>
      <div className="personaOptions">
        {personaPacks.map(pack => <button key={pack.id} className={pack.id === selected ? "selected" : ""} onClick={() => choose(pack.id)}>
          <strong>{pack.displayName[locale]}</strong><span>{pack.description[locale]}</span>
        </button>)}
      </div>
    </section>}
  </div>;
}

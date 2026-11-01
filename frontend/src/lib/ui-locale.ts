"use client";

import { useCallback, useEffect, useState } from "react";

export type UiLocale = "en" | "zh";
export const uiLocaleStorageKey = "personal-memory-ai-ui-locale-v1";
const uiLocaleEvent = "personal-memory-ui-locale-changed";

function storedUiLocale(): UiLocale {
  try { return window.localStorage.getItem(uiLocaleStorageKey) === "zh" ? "zh" : "en"; }
  catch { return "en"; }
}

export function setStoredUiLocale(locale: UiLocale): void {
  try { window.localStorage.setItem(uiLocaleStorageKey, locale); } catch { /* Session-only selection still works. */ }
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  window.dispatchEvent(new CustomEvent(uiLocaleEvent, { detail: { locale } }));
}

export function useUiLocale() {
  const [locale, setLocaleState] = useState<UiLocale>("en");
  useEffect(() => {
    const apply = () => { const next = storedUiLocale(); setLocaleState(next); document.documentElement.lang = next === "zh" ? "zh-CN" : "en"; };
    const onCustom = (event: Event) => {
      const next = (event as CustomEvent<{ locale?: UiLocale }>).detail?.locale;
      if (next === "en" || next === "zh") { setLocaleState(next); document.documentElement.lang = next === "zh" ? "zh-CN" : "en"; }
      else apply();
    };
    apply();
    window.addEventListener(uiLocaleEvent, onCustom);
    window.addEventListener("storage", apply);
    return () => { window.removeEventListener(uiLocaleEvent, onCustom); window.removeEventListener("storage", apply); };
  }, []);
  const setLocale = useCallback((next: UiLocale) => setStoredUiLocale(next), []);
  const t = useCallback((en: string, zh: string) => locale === "zh" ? zh : en, [locale]);
  return { locale, setLocale, t };
}

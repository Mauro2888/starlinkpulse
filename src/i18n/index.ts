// UI translations (react-i18next). Keys are the English source strings
// ("gettext style"): en.json maps them to themselves (plus plural forms),
// it.json holds the Italian. See CONTRIBUTING.md → Translations.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { AppLanguage } from "@/types/models";
import { setFormatLocale, type FormatLocale } from "@/lib/format";
import en from "@/locales/en.json";
import it from "@/locales/it.json";

export const LANGUAGES: readonly FormatLocale[] = ["en", "it"];

/** "system" follows the OS/browser language; anything that isn't Italian falls back to English. */
export function resolveLanguage(pref: AppLanguage | null | undefined, nav?: string): FormatLocale {
  if (pref === "en" || pref === "it") return pref;
  const sys = (nav ?? (typeof navigator !== "undefined" ? navigator.language : "en")).toLowerCase();
  return sys.startsWith("it") ? "it" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: "en",
  fallbackLng: "en",
  // English sentences are the keys: no nesting or namespace separators.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Switches UI strings, number/date formatting and <html lang>. */
export function applyLanguage(lng: FormatLocale): void {
  setFormatLocale(lng);
  if (i18n.language !== lng) void i18n.changeLanguage(lng);
  if (typeof document !== "undefined") document.documentElement.lang = lng;
}

export default i18n;

/** Untyped translate for non-React code (lib helpers). Returns the key if missing. */
export function tr(key: string, opts?: Record<string, unknown>): string {
  return (opts ? i18n.t(key, opts as never) : i18n.t(key)) as string;
}

// Pure formatting helpers. Every function accepts null/undefined/NaN and
// returns the EM_DASH placeholder instead of throwing.

export const EM_DASH = "—";

// ---- Locale -----------------------------------------------------------------
// Set by the i18n layer (src/i18n). Numbers use Intl with this locale, so Italian
// gets comma decimals; times are always 24 h.

export type FormatLocale = "en" | "it";
let LOCALE: FormatLocale = "en";

const WORDS: Record<FormatLocale, { day: string; now: string; ago: (x: string) => string }> = {
  en: { day: "d", now: "just now", ago: (x) => `${x} ago` },
  it: { day: "g", now: "adesso", ago: (x) => `${x} fa` },
};

export function setFormatLocale(l: FormatLocale): void {
  LOCALE = l;
}

export function getFormatLocale(): FormatLocale {
  return LOCALE;
}

const nfCache = new Map<string, Intl.NumberFormat>();

/** Locale-aware number with at most `digits` decimals (trailing zeros dropped unless `fixed`). */
export function fmtNum(n: number, digits = 1, fixed = false): string {
  const key = `${LOCALE}|${digits}|${fixed}`;
  let nf = nfCache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(LOCALE, {
      maximumFractionDigits: digits,
      minimumFractionDigits: fixed ? digits : 0,
    });
    nfCache.set(key, nf);
  }
  return nf.format(n);
}

/** Locale date/time string, e.g. "22 Nov 2026, 18:03" (always 24 h). */
export function formatDateTime(
  ms: number,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Date(ms).toLocaleString(LOCALE, { hourCycle: "h23", ...opts });
}

export function formatDate(ms: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleDateString(LOCALE, opts);
}

export function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface ValueParts {
  value: string;
  unit: string;
}

const NONE: ValueParts = { value: EM_DASH, unit: "" };

/** Splits a bit rate into a display value and unit (bps / Kbps / Mbps / Gbps). */
export function formatBpsParts(bps: number | null | undefined): ValueParts {
  if (!isNum(bps) || bps < 0) return NONE;
  if (bps >= 1e9) return { value: trim(bps / 1e9, 2), unit: "Gbps" };
  if (bps >= 1e6) return { value: trim(bps / 1e6, bps >= 1e8 ? 0 : 1), unit: "Mbps" };
  if (bps >= 1e3) return { value: trim(bps / 1e3, bps >= 1e5 ? 0 : 1), unit: "Kbps" };
  return { value: String(Math.round(bps)), unit: "bps" };
}

export function formatBps(bps: number | null | undefined): string {
  return join(formatBpsParts(bps));
}

/** Latency in milliseconds. */
export function formatMsParts(ms: number | null | undefined): ValueParts {
  if (!isNum(ms) || ms < 0) return NONE;
  return { value: ms >= 100 ? String(Math.round(ms)) : trim(ms, 1), unit: "ms" };
}

export function formatMs(ms: number | null | undefined): string {
  return join(formatMsParts(ms));
}

/**
 * Formats a 0..1 fraction as a percentage. Tiny non-zero values are shown
 * as "<0.1 %" so they are not mistaken for zero.
 */
export function formatPercentParts(
  fraction: number | null | undefined,
  digits = 1,
): ValueParts {
  if (!isNum(fraction)) return NONE;
  const pct = fraction * 100;
  const min = 1 / 10 ** digits;
  if (pct > 0 && pct < min) return { value: `<${min}`, unit: "%" };
  return { value: trim(pct, digits), unit: "%" };
}

export function formatPercent(fraction: number | null | undefined, digits = 1): string {
  return join(formatPercentParts(fraction, digits));
}

export function formatWattsParts(w: number | null | undefined): ValueParts {
  if (!isNum(w) || w < 0) return NONE;
  return { value: trim(w, w >= 100 ? 0 : 1), unit: "W" };
}

export function formatWatts(w: number | null | undefined): string {
  return join(formatWattsParts(w));
}

/** Compact duration: "45 s", "12 min", "3 h 05 min", "2 d 4 h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return EM_DASH;
  const s = Math.floor(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  const d = Math.floor(h / 24);
  return `${d} ${WORDS[LOCALE].day} ${h % 24} h`;
}

/** Duration from milliseconds, with sub-second precision for short events. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (!isNum(ms) || ms < 0) return EM_DASH;
  if (ms < 10_000) return `${trim(ms / 1000, 1)} s`;
  return formatDuration(ms / 1000);
}

/** "14:05" for ranges within a day, "Mon 14:05" otherwise. */
export function formatClock(ms: number | null | undefined, withDay = false): string {
  if (!isNum(ms)) return EM_DASH;
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!withDay) return hm;
  const day = d.toLocaleDateString(LOCALE, { weekday: "short" });
  return `${day} ${hm}`;
}

/** Relative time like "12 s ago" for freshness indicators. */
export function formatAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!isNum(ms)) return EM_DASH;
  const diff = Math.max(0, (now - ms) / 1000);
  if (diff < 5) return WORDS[LOCALE].now;
  return WORDS[LOCALE].ago(formatDuration(diff));
}

/** Turns "POLICY_LIMIT" / "thermalThrottle" into "Policy limit" / "Thermal throttle". */
export function humanizeEnum(raw: string | null | undefined): string {
  if (!raw) return EM_DASH;
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function trim(n: number, digits: number): string {
  return fmtNum(n, digits);
}

function join(p: ValueParts): string {
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

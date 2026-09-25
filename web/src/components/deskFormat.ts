/** Small formatters shared by the inspector and crew strip. */

/** Token counts: thousands as "348k" (whole), millions as "1M" / "1.5M" (one decimal only when needed). */
export const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n)) return "?";
  if (n >= 999_500) {
    const m = Math.round(n / 100_000) / 10;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
};

/** "348k / 1M · 35%" for a context reading. */
export const contextReadout = (usedTokens: number, maxTokens: number, percent?: number): string => {
  const pct = typeof percent === "number" && Number.isFinite(percent) ? percent : maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;
  return `${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)} · ${Math.round(pct)}%`;
};

export const timeOf = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const ageOf = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

/** Meter tone by percent used: ok under 60, warn 60–85, err above. */
export const meterTone = (percent: number): "ok" | "warn" | "err" => (percent < 60 ? "ok" : percent <= 85 ? "warn" : "err");

export const shortId = (id: string): string => id.slice(0, 8);

/** Short labels for common model option ids; unknown ids pass through unchanged. */
const OPTION_LABELS: Record<string, string> = {
  effort: "effort",
  reasoningEffort: "effort",
  reasoning: "reasoning",
  contextWindow: "ctx",
  fastMode: "fast",
  thinking: "thinking",
  serviceTier: "tier",
};

/** "resets in 2d" / "resets in 3h" / "resets in 12m" for a future timestamp. */
export const resetsIn = (iso: string | null, now = Date.now()): string | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "resets now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `resets in ${h}h`;
  return `resets in ${Math.round(h / 24)}d`;
};
export const optionLabel = (id: string): string => OPTION_LABELS[id] ?? id;

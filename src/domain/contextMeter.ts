/**
 * A member's context meter: how much its thread sends the model on each call, its largest call, and how often the
 * harness compacted it. Read from the harness's own transcript (src/usage/threadCosts.ts), so only Claude threads have
 * one. It is information for the user and the Consigliere: nothing acts on it.
 *
 * Shared by the service (rooms-board members, the room costs route) and the page (the member card), so both say it in
 * the same words.
 */

/** "near compaction" from this share of the model's window. */
export const NEAR_COMPACTION_SHARE = 0.75;

export interface ContextMeter {
  available: boolean;
  /** Why there is none: not a Claude thread, or a Claude thread whose transcript could not be found or read. */
  reason: "not_claude" | "no_session" | "no_transcript" | "unreadable" | null;
  /** What the last call sent the model (input, cache read and cache write tokens); null before the first call. */
  tokens: number | null;
  /** The largest call the thread has made, or the largest context a compaction started from. */
  peak: number | null;
  /** Compactions the transcript records (Claude Code's compact boundaries, automatic and /compact alike). */
  compactions: number;
  lastCompactionAt: string | null;
  /** The model's context window in tokens: from T3's model manifest, else Backroom's table; null when unknown. */
  window: number | null;
  windowSource: "manifest" | "table" | null;
  /** tokens has passed NEAR_COMPACTION_SHARE of the window. */
  nearCompaction: boolean;
  /** When tokens was measured: the last call, or the compaction after it. */
  at: string | null;
}

/** 575k, 1M, 1.2M: the meter's rounding (a context is never read to the token). */
export function meterTokens(n: number): string {
  if (n >= 999_500) {
    const m = Math.round(n / 100_000) / 10;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export const compactionsPhrase = (count: number): string => (count === 0 ? "no compactions" : `${count} compaction${count === 1 ? "" : "s"}`);

/**
 * The meter in one phrase: "context ≈ 575k, 6 compactions", "context ≈ 812k (near compaction), 2 compactions",
 * "no meter" for a thread that is not Claude's, "context unknown" for a Claude thread whose transcript was not read.
 */
export function contextPhrase(meter: ContextMeter | null | undefined): string {
  if (!meter || (!meter.available && meter.reason === "not_claude")) return "no meter";
  if (!meter.available) return "context unknown";
  if (meter.tokens === null) return `context not measured yet, ${compactionsPhrase(meter.compactions)}`;
  return `context ≈ ${meterTokens(meter.tokens)}${meter.nearCompaction ? " (near compaction)" : ""}, ${compactionsPhrase(meter.compactions)}`;
}

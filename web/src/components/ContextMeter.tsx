import type { Compaction, ContextMeter, ContextWindowReading, Desk } from "../types.ts";
import { contextReadout, fmtTokens, meterTone, timeOf } from "./deskFormat.ts";
import { NEAR_COMPACTION_SHARE, compactionsPhrase, contextPhrase, meterTokens } from "../../../src/domain/contextMeter.ts";

type ContextFacts = Pick<Desk, "contextWindow" | "compactions"> & Partial<Pick<Desk, "contextReporting" | "autoCompactWindow" | "lastCompaction">>;

export const lastCompactionOf = (desk: ContextFacts): Compaction | null =>
  desk.lastCompaction ?? (desk.compactions.length > 0 ? (desk.compactions[desk.compactions.length - 1] as Compaction) : null);

/** "auto-compacts at 200k tokens (T3 setting)" or "auto-compaction: harness default". */
export const compactionSetting = (desk: ContextFacts): string =>
  typeof desk.autoCompactWindow === "number" ? `auto-compacts at ${fmtTokens(desk.autoCompactWindow)} tokens (T3 setting)` : "auto-compaction: harness default";

export const lastCompactionLine = (desk: ContextFacts): string | null => {
  const last = lastCompactionOf(desk);
  return last ? `last compaction: ${fmtTokens(last.beforeTokens)} → ${fmtTokens(last.afterTokens)} at ${timeOf(last.at)}` : null;
};

/** Tooltip for the tile readout: token breakdown, reading time, compaction setting and last compaction. */
export function contextTooltip(desk: ContextFacts): string {
  const lines: string[] = [];
  const reading = desk.contextWindow;
  if (reading) {
    const parts: string[] = [];
    if (typeof reading.inputTokens === "number") parts.push(`input ${fmtTokens(reading.inputTokens)}`);
    if (typeof reading.outputTokens === "number") parts.push(`output ${fmtTokens(reading.outputTokens)}`);
    if (typeof reading.totalProcessedTokens === "number") parts.push(`total processed ${fmtTokens(reading.totalProcessedTokens)}`);
    if (parts.length > 0) lines.push(parts.join(" · "));
    lines.push(`reading at ${timeOf(reading.at)}`);
  }
  lines.push(compactionSetting(desk));
  const last = lastCompactionLine(desk);
  if (last) lines.push(last);
  return lines.join("\n");
}

/** Compact crew-tile readout: "348k / 1M · 35%" over a thin bar, or the not-reported / no-reading states. */
export function ContextReadout({ desk }: { desk: ContextFacts }) {
  const reading = desk.contextWindow;
  if (!reading) {
    if (desk.contextReporting === false) {
      return (
        <span className="crew-context mono not-reported" title="This provider does not report context usage to T3">
          context not reported
        </span>
      );
    }
    return (
      <span className="crew-context mono no-reading" title={contextTooltip(desk)}>
        context —
      </span>
    );
  }
  const percent = Math.max(0, Math.min(100, reading.percent));
  const tone = meterTone(percent);
  const label = contextReadout(reading.usedTokens, reading.maxTokens, reading.percent);
  return (
    <span
      className={`crew-context mono meter-${tone}`}
      title={contextTooltip(desk)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={`Context window ${label}`}
    >
      <span className="crew-readout">{label}</span>
      <span className="meter-bar">
        <span className="meter-fill" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/** Thin context-window meter: used/max tokens, percent, tone by usage (ok < 60, warn ≤ 85, err above). */
export function ContextMeter({ reading, compact = false }: { reading: ContextWindowReading; compact?: boolean }) {
  const percent = Math.max(0, Math.min(100, reading.percent));
  const tone = meterTone(percent);
  const label = `${fmtTokens(reading.usedTokens)} / ${fmtTokens(reading.maxTokens)} · ${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  return (
    <span
      className={`context-meter meter-${tone}${compact ? " compact" : ""}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={`Context window ${label}`}
      title={`Context window ${label} (as of ${timeOf(reading.at)})`}
    >
      <span className="meter-bar">
        <span className="meter-fill" style={{ width: `${percent}%` }} />
      </span>
      {!compact ? <span className="meter-label mono">{label}</span> : <span className="meter-pct mono">{Math.round(percent)}%</span>}
    </span>
  );
}

/**
 * The member card's line from Backroom's context meter (the Claude transcript): the same words as `rooms-board members`
 * ("context ≈ 575k, 6 compactions"). Under T3's own reading it adds only what that lacks: "6 compactions", and
 * "near compaction" past three quarters of the window. Information only: nothing acts on it.
 */
export function ContextMeterLine({ meter, besideReading }: { meter: ContextMeter; besideReading: boolean }) {
  if (!meter.available) {
    return (
      <span className="crew-context crew-meter mono no-reading" title={meter.reason === "not_claude" ? "Backroom meters Claude threads only: it reads their transcripts" : "Backroom could not find or read this thread's Claude transcript"}>
        {contextPhrase(meter)}
      </span>
    );
  }
  const text = besideReading ? `${compactionsPhrase(meter.compactions)}${meter.nearCompaction ? " · near compaction" : ""}` : contextPhrase(meter);
  const lines = [
    "From the thread's Claude transcript.",
    meter.tokens !== null ? `Last call sent ${meterTokens(meter.tokens)} tokens${meter.at ? ` at ${timeOf(meter.at)}` : ""}.` : "No call yet.",
    meter.peak !== null ? `Peak ${meterTokens(meter.peak)}.` : null,
    meter.window !== null ? `Window ${meterTokens(meter.window)} (${meter.windowSource === "manifest" ? "T3's model manifest" : "Backroom's table"}); "near compaction" from ${Math.round(NEAR_COMPACTION_SHARE * 100)}%.` : "Window unknown.",
    `${compactionsPhrase(meter.compactions)}${meter.lastCompactionAt ? `, the last at ${timeOf(meter.lastCompactionAt)}` : ""}.`,
  ];
  return (
    <span className={`crew-context crew-meter mono${meter.nearCompaction ? " meter-warn" : ""}`} title={lines.filter(Boolean).join("\n")}>
      <span className="crew-readout">{text}</span>
    </span>
  );
}

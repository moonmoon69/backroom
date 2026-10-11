/**
 * A provider's usage windows, grouped for its header line. Windows whose labels share a family before " · " (two or more
 * of them: Antigravity's "Gemini · 5-hour" and "Gemini · Weekly") are one row, the family named once and each window
 * labelled by the part after it. A window with no sibling stays whole ("Weekly · Fable" beside Claude's "Weekly").
 */
import type { UsageWindow } from "./types.ts";

const SEPARATOR = " · ";

export type UsageRow =
  | { kind: "window"; window: UsageWindow }
  | { kind: "family"; family: string; windows: Array<{ window: UsageWindow; short: string }> };

const familyOf = (label: string): string | null => {
  const at = label.indexOf(SEPARATOR);
  return at > 0 && at + SEPARATOR.length < label.length ? label.slice(0, at) : null;
};

/** The rows in the order the provider reports its windows: a family where its first window is. */
export function usageRows(windows: readonly UsageWindow[]): UsageRow[] {
  const counts = new Map<string, number>();
  for (const window of windows) {
    const family = familyOf(window.label);
    if (family !== null) counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const rows: UsageRow[] = [];
  const families = new Map<string, Extract<UsageRow, { kind: "family" }>>();
  for (const window of windows) {
    const family = familyOf(window.label);
    if (family === null || (counts.get(family) ?? 0) < 2) {
      rows.push({ kind: "window", window });
      continue;
    }
    let row = families.get(family);
    if (!row) {
      row = { kind: "family", family, windows: [] };
      families.set(family, row);
      rows.push(row);
    }
    row.windows.push({ window, short: window.label.slice(family.length + SEPARATOR.length) });
  }
  return rows;
}

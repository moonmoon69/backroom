/**
 * `/steer` on the journal (stage 4/5 plan, item L4a): which requests want their owner's running turn, and the T3
 * messages that carried them there. Pure reads of a projection, like work.ts.
 *
 * A steered request is an ordinary request whose ID starts with `steer:`. While its owner has a live host run that T3
 * is running, the host offers it to that run as a sync receipt over every unread input since the run's watermark and
 * sends them with T3's `steer_active`; the receipt is confirmed once T3 shows the message attached to that run. The
 * receipt ID carries the T3 command and message IDs, so after a restart the host resends the same message and finds
 * it by its ID. When the run has ended by the time T3 has the message, T3 starts a run of its own for it, and the host
 * adopts that run as the host run for what the steer carried. Otherwise the request waits like any other.
 */
import type { Projection, SyncReceipt } from "../engine/index.ts";
import { runRecords, reservedSeq } from "./work.ts";

export const STEER_REQUEST = "steer:";
const RECEIPT = "t3steer:";

/** A request that goes into its owner's running turn when there is one. */
export function wantsSteer(requestId: string): boolean {
  return requestId.startsWith(STEER_REQUEST);
}

export function steerReceiptId(commandId: string, messageId: string): string {
  return `${RECEIPT}${commandId}:${messageId}`;
}

export function steerIds(receiptId: string): { commandId: string; messageId: string } | null {
  const match = new RegExp(`^${RECEIPT}([^:]+):([^:]+)$`).exec(receiptId);
  return match ? { commandId: match[1]!, messageId: match[2]! } : null;
}

export interface SteerOffer {
  /** The host run the steer was offered to. */
  runId: string;
  seatId: string;
  receipt: SyncReceipt;
  commandId: string;
  messageId: string;
}

/** Every steer offered to the seat's runs, oldest first. */
export function steerOffers(p: Projection, seatId: string): SteerOffer[] {
  const out: SteerOffer[] = [];
  for (const e of p.events) {
    const d = e.data;
    if (d.kind !== "sync.offered") continue;
    const ids = steerIds(d.receipt.id);
    const run = p.runs.get(d.runId);
    if (!ids || !run || run.seatId !== seatId) continue;
    // The run's copy: confirming it marks it there.
    out.push({ runId: run.id, seatId, receipt: run.receipts.find((r) => r.id === d.receipt.id) ?? d.receipt, ...ids });
  }
  return out;
}

/** The T3 message IDs of every steer offered on the seat's runs: T3 has them as user messages, but they are the board's. */
export function steerMessageIds(p: Projection, seatId: string): Set<string> {
  return new Set(steerOffers(p, seatId).map((s) => s.messageId));
}

/**
 * Steers T3 may have run as a run of their own, still open for adoption: unconfirmed, their run has ended, no host run
 * of the seat was reserved after it, and no host run took the message yet. Once a later run is reserved, the window has
 * closed: what the steer carried went in that run, and a run T3 started for it is imported as a note.
 */
export function adoptableSteers(p: Projection, seatId: string): Array<SteerOffer & { carrierT3RunId: string | null }> {
  const records = runRecords(p);
  const hostRuns = [...p.runs.values()].filter((r) => r.seatId === seatId);
  const taken = new Set(hostRuns.map((r) => r.dispatchMessageId));
  return steerOffers(p, seatId).flatMap((s) => {
    const run = p.runs.get(s.runId)!;
    if (s.receipt.confirmed || run.phase !== "terminal" || taken.has(s.messageId)) return [];
    const after = reservedSeq(p, run.id);
    if (hostRuns.some((r) => reservedSeq(p, r.id) > after)) return [];
    return [{ ...s, carrierT3RunId: records.get(run.id)?.t3?.id ?? null }];
  });
}

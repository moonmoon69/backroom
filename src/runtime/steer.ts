/**
 * Messages into a running turn (stage 4/5 plan, item L4a; M1: every message): which inputs go into their seat's running
 * turn, and the T3 messages that carried them there. Pure reads of a projection, like work.ts.
 *
 * A request, a correction or a retry from the user or the orchestrator goes into its owner's running turn, as a harness
 * takes a message typed while it works: while the owner has a live host run that T3 is running, the host offers that run
 * a sync receipt over every unread input since the run's watermark and sends them with T3's `steer_active`; the receipt
 * is confirmed once T3 shows the member working after the message in that run. The receipt ID carries the T3 command and
 * message IDs, so after a restart the host resends the same message and finds it by its ID. When the run has ended by
 * the time T3 has the message, T3 starts a run of its own for it, and the host adopts that run as the host run for what
 * the message carried. Otherwise what it carried waits for the seat's next turn like any other input. "Steer" is T3's
 * name for the mechanism, and the journal's receipts keep it (`t3steer:`).
 */
import type { Input, Projection, Run, SyncReceipt } from "../engine/index.ts";
import type { T3ThreadDetail, T3TurnItem } from "../adapter/types.ts";
import { deliveredInputs, inputTree } from "../engine/index.ts";
import { backroomRequest, keepAliveRun, runRecords, reservedSeq } from "./work.ts";

const RECEIPT = "t3steer:";
/** The inputs a person sends: they go into a running turn. Results, follow-ups, notices, cancels and keep-alives ride along. */
const MESSAGES: ReadonlySet<string> = new Set(["request", "correction", "retry"]);

/**
 * An input that goes into its seat's running turn: a request, correction or retry from the user or the orchestrator.
 * Backroom's own requests (a seat briefing, a reseat's checkpoint or call-off; journals from before B1 hold them as the
 * user's) wait for the turn's end, as every other input does unless a message carries it along.
 */
export function goesIntoTurn(p: Projection, input: Input): boolean {
  // Only the user and the orchestrator send these (the core refuses the rest); Backroom's own requests are known by
  // their return address, or by their IDs in journals from before B1.
  return MESSAGES.has(input.intent) && input.requestIds.every((id) => {
    const q = p.requests.get(id);
    return !q || !backroomRequest(q);
  });
}

/**
 * Whether a run takes messages into its turn: not a keep-alive's ("reply in one line, use no tools", and that line would
 * answer the message), nor one working on Backroom's own request (a seat briefing's acknowledgement, or a reseat's
 * checkpoint, whose final answers the checkpoint only).
 */
export function takesMessages(p: Projection, run: Run): boolean {
  if (keepAliveRun(p, run)) return false;
  return !inputTree(deliveredInputs(p, run.id)).some((i) => i.requestIds.some((id) => {
    const q = p.requests.get(id);
    return q !== undefined && q.owner === run.seatId && backroomRequest(q);
  }));
}

export function steerReceiptId(commandId: string, messageId: string): string {
  return `${RECEIPT}${commandId}:${messageId}`;
}

export function steerIds(receiptId: string): { commandId: string; messageId: string } | null {
  const match = new RegExp(`^${RECEIPT}([^:]+):([^:]+)$`).exec(receiptId);
  return match ? { commandId: match[1]!, messageId: match[2]! } : null;
}

export interface SteerOffer {
  /** The host run the message was offered to. */
  runId: string;
  seatId: string;
  receipt: SyncReceipt;
  commandId: string;
  messageId: string;
}

/** Every message offered to the seat's runs, oldest first. */
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

/** The T3 message IDs of every message offered on the seat's runs: T3 has them as user messages, but they are the board's. */
export function steerMessageIds(p: Projection, seatId: string): Set<string> {
  return new Set(steerOffers(p, seatId).map((s) => s.messageId));
}

/** What the member does that shows it took a message: it writes, thinks, or works after it. */
const WORK: ReadonlySet<T3TurnItem["type"]> = new Set([
  "assistant_message", "reasoning", "proposed_plan", "todo_list", "command_execution", "file_change", "file_search", "web_search",
  "dynamic_tool", "subagent", "approval_request", "user_input_request",
]);

/**
 * The turn item of a message T3 shows in the T3 run, when the member worked after it in that run; null otherwise. A
 * message T3 records after the run's last work (it landed as the model wrote its final, and T3 neither moved it to a run
 * of its own nor fed it to the model) was never taken: its run's final does not answer what it carried.
 */
export function takenInRun(detail: Pick<T3ThreadDetail, "messages" | "turnItems">, messageId: string, t3RunId: string): Extract<T3TurnItem, { type: "user_message" }> | null {
  const m = detail.messages.find((x) => x.id === messageId);
  if (!m || m.runId !== t3RunId) return null;
  const item = detail.turnItems.find((x): x is Extract<T3TurnItem, { type: "user_message" }> => x.type === "user_message" && x.messageId === messageId);
  if (!item || item.runId !== t3RunId) return null;
  return detail.turnItems.some((x) => x.runId === t3RunId && x.ordinal > item.ordinal && WORK.has(x.type)) ? item : null;
}

/**
 * Offers T3 may have run as a run of their own, still open for adoption: unconfirmed, their run has ended, no host run
 * of the seat was reserved after it, and no host run took the message yet. Once a later run is reserved, the window has
 * closed: what the offer carried went in that run, and a run T3 started for it is imported as a note.
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

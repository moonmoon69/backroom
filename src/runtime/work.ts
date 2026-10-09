/**
 * What a run works on, read from the journal (stage 4/5 plan, "Lean semantics" §1, as H5 left it: members only answer).
 * Pure functions over a projection: no I/O, no clock. The host uses them to choose which requests a final answers; the
 * engine still decides every outcome.
 */
import type { SeatStanding } from "../briefing/envelope.ts";
import { deliveredInputs, inputTree } from "../engine/index.ts";
import type { Activity, Projection, Request, RoomEvent, Run } from "../engine/index.ts";

/** Inputs that give a seat a request to answer: the request itself, a correction, a retry or a handover. */
export const TARGETING: ReadonlySet<string> = new Set(["request", "correction", "retry", "transfer"]);

/**
 * From a request ID, the first request up the parent chain that the seat owns, if it is still open. Since H5 no post
 * has a parent (only the orchestrator and the user post, and nothing goes under another request), so this is the
 * request itself when the seat owns it and it is open.
 */
export function ownedTarget(p: Projection, requestId: string, seatId: string): Request | null {
  let q = p.requests.get(requestId);
  while (q && q.owner !== seatId) q = q.parentId ? p.requests.get(q.parentId) : undefined;
  return q && q.state === "open" ? q : null;
}

/** The request IDs the engine lets this run's output name: its open requests at the watermark and its delivered inputs'. */
export function allowedIds(p: Projection, run: Run): Set<string> {
  const contexts = [...run.envelope.openRequests, ...run.receipts.filter((r) => r.confirmed).flatMap((r) => r.envelope.openRequests)];
  return new Set([...contexts.map((r) => r.id), ...inputTree(deliveredInputs(p, run.id)).flatMap((i) => i.requestIds)]);
}

export function eventSeq(p: Projection, predicate: (e: RoomEvent) => boolean): number | null {
  return p.events.find(predicate)?.seq ?? null;
}

/** Where a run's reservation sits in the log; marks made after it are marks made during the run. */
export function reservedSeq(p: Projection, runId: string): number {
  return eventSeq(p, (e) => e.data.kind === "run.prepared" && e.data.run.id === runId) ?? 0;
}

/** §1: a final answers the open requests its run was given: requests, corrections, retries and handovers. */
export function finalTargets(p: Projection, run: Run): string[] {
  const targets = new Set<string>();
  for (const input of inputTree(deliveredInputs(p, run.id))) {
    if (!TARGETING.has(input.intent)) continue;
    for (const id of input.requestIds) {
      const q = ownedTarget(p, id, run.seatId);
      if (q) targets.add(q.id);
    }
  }
  const allowed = allowedIds(p, run);
  const selected = [...targets].filter((id) => allowed.has(id));
  // A reseat's checkpoint run answers the checkpoint only: the seat's other requests stay open for the fresh seat (L4b).
  // The checkpoint is Backroom's request (the user's in journals from before B1).
  const checkpoints = selected.filter((id) => id.startsWith(RESEAT_CHECKPOINT) && ["$system", "$user"].includes(p.requests.get(id)?.returnTo ?? ""));
  return checkpoints.length > 0 ? checkpoints : selected;
}

/** H6: a run that brought only keep-alives: it asks nothing, and its reply is a note. */
export function keepAliveRun(p: Projection, run: Run): boolean {
  const delivered = inputTree(deliveredInputs(p, run.id));
  return delivered.length > 0 && delivered.every((i) => i.intent === "keep-alive");
}

/**
 * The seats busy with a run: one the journal has not ended and T3 has not refused (prepared, sending, accepted, running
 * or uncertain). An alias pool picks another member then, and a room's browser is not stopped for idleness.
 */
export function seatsWithLiveRuns(p: Projection): Set<string> {
  return new Set([...p.runs.values()].filter((run) => run.phase !== "terminal" && run.phase !== "rejected").map((run) => run.seatId));
}

/** The ID prefix of the request that asks a member for its reseat checkpoint (L4b, src/app/engineSeats.ts); reserved. */
export const RESEAT_CHECKPOINT = "reseat:";

/** The seat's background work on the journal. The host registers none since H5; the core keeps the commands. */
export function pendingActivities(p: Projection, seatId: string): Activity[] {
  return [...p.activities.values()].filter((a) => a.seatId === seatId && (a.status === "pending" || a.status === "uncertain"));
}

export function openOwned(p: Projection, ids: readonly string[], seatId: string): string[] {
  return ids.filter((id) => {
    const q = p.requests.get(id);
    return q?.state === "open" && q.owner === seatId;
  });
}

/**
 * What a run's `sending` phase froze before the message left: the dispatch command, the exact text and images T3 is
 * sent (on every resend too), and the standing record the seat's thread holds once T3 has it (L2's ledger, read back
 * from the journal).
 */
export interface Dispatch { dispatch: string; text: string; images: Array<{ eventId: string; names: string[] }>; held: SeatStanding | null }

export function frozenDispatch(p: Projection, runId: string): Dispatch | null {
  for (const e of p.events) {
    if (e.data.kind !== "run.phase" || e.data.runId !== runId || e.data.phase !== "sending") continue;
    return JSON.parse(e.data.evidence) as Dispatch;
  }
  return null;
}

/** Per host run, in one pass over the journal: the T3 run it was matched to (accepted, with T3's ordinal) and what its sending froze. */
export function runRecords(p: Projection): Map<string, { reservedSeq: number; seatId: string; t3: { id: string; ordinal: number } | null; frozen: Dispatch | null }> {
  const records = new Map<string, { reservedSeq: number; seatId: string; t3: { id: string; ordinal: number } | null; frozen: Dispatch | null }>();
  for (const e of p.events) {
    const d = e.data;
    if (d.kind === "run.prepared") records.set(d.run.id, { reservedSeq: e.seq, seatId: d.run.seatId, t3: null, frozen: null });
    if (d.kind !== "run.phase") continue;
    const record = records.get(d.runId);
    if (!record) continue;
    if (d.phase === "sending") record.frozen = JSON.parse(d.evidence) as Dispatch;
    const ordinal = d.phase === "accepted" && d.providerRunId ? /ordinal:(\d+)/.exec(d.evidence) : null;
    if (ordinal) record.t3 = { id: d.providerRunId!, ordinal: Number(ordinal[1]) };
  }
  return records;
}

/**
 * The requests a seat's turn that answers nothing follows up on: those its latest answer closed, else those its latest
 * output named, whatever the outcome.
 */
export function followedRequests(p: Projection, seatId: string): string[] {
  let named: string[] = [];
  for (let i = p.events.length - 1; i >= 0; i--) {
    const d = p.events[i]!.data;
    if (d.kind !== "output" || d.author !== seatId || d.claims.length === 0) continue;
    const answered = d.claims.filter((c) => c.outcome === "answered").map((c) => c.requestId);
    if (answered.length) return answered;
    if (named.length === 0) named = d.claims.map((c) => c.requestId);
  }
  return named;
}

/** A cancel recorded to apply when its owner's current turn ends (§6, co-batched): which request and the cancel's ID. */
export interface DeferredCancel { requestId: string; cancelId: string; actor: string; noteSeq: number }

export const DEFERRED_CANCEL = "cancel-deferred:";

export function deferredCancels(p: Projection): DeferredCancel[] {
  const out: DeferredCancel[] = [];
  for (const e of p.events) {
    if (e.data.kind !== "note" || !e.id.startsWith(DEFERRED_CANCEL)) continue;
    const [requestId, cancelId] = JSON.parse(e.id.slice(DEFERRED_CANCEL.length)) as [string, string];
    out.push({ requestId, cancelId, actor: e.data.author, noteSeq: e.seq });
  }
  return out;
}

export function committed(p: Projection, actor: string, id: string): boolean {
  return p.commandKeys.has(JSON.stringify([actor, id]));
}

/**
 * §6: the cancel that stops a run, if any: applied to a request of the run's seat while the run was live (after its
 * reservation, before its end), and not one held to the turn's end (those apply as it ends and stop nothing). The host
 * sends its interrupt to T3 with the command ID `interrupt:<cancel ID>`.
 */
export function stoppingCancel(p: Projection, run: Run): string | null {
  const deferred = new Set(deferredCancels(p).map((d) => d.cancelId));
  const from = reservedSeq(p, run.id);
  for (const e of p.events) {
    if (e.seq <= from) continue;
    if (e.data.kind === "run.ended" && e.data.runId === run.id) return null;
    if (e.data.kind === "cancel" && e.data.applied && !deferred.has(e.id) && p.requests.get(e.data.requestId)?.owner === run.seatId) return e.id;
  }
  return null;
}

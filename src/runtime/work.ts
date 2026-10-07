/**
 * What a run is working on, read from the journal ("Lean semantics" §1 and §2 of the stage 4/5 plan). Pure functions
 * over a projection: no I/O, no clock. The host uses them to choose which requests a final answers; the engine still
 * decides every outcome (answered, pending_activity, superseded, late).
 */
import type { SeatStanding } from "../briefing/envelope.ts";
import { deliveredInputs, inputTree } from "../engine/index.ts";
import type { Activity, Projection, Request, RoomEvent, Run } from "../engine/index.ts";

/** Inputs that bear on a request: the request itself, a correction, a retry or transfer, or the answer to a child. */
const TARGETING = new Set(["request", "correction", "retry", "transfer", "result"]);

/** From a request ID, the first request up the parent chain that is open and owned by the seat. */
export function firstOpenOwned(p: Projection, requestId: string, seatId: string): Request | null {
  let q = p.requests.get(requestId);
  while (q && !(q.state === "open" && q.owner === seatId)) q = q.parentId ? p.requests.get(q.parentId) : undefined;
  return q ?? null;
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

/** Requests the seat marked with `rooms-board working` after `afterSeq`. */
export function workingMarks(p: Projection, seatId: string, afterSeq: number): Set<string> {
  const ids = new Set<string>();
  for (const e of p.events) {
    if (e.seq <= afterSeq || e.data.kind !== "progress" || e.data.author !== seatId || e.data.milestone !== "working") continue;
    for (const id of e.data.requestIds) ids.add(id);
  }
  return ids;
}

/**
 * §1: the requests this run's final answers. Each delivered request, correction, retry, transfer or result walks up to
 * the seat's first open owned request. Requests the member marked `working` during the run are left out; requests it
 * answered explicitly are no longer open, so the walk passes them.
 */
export function finalTargets(p: Projection, run: Run): string[] {
  const targets = new Set<string>();
  for (const input of inputTree(deliveredInputs(p, run.id))) {
    if (!TARGETING.has(input.intent)) continue;
    for (const id of input.requestIds) {
      const q = firstOpenOwned(p, id, run.seatId);
      if (q) targets.add(q.id);
    }
  }
  const marked = workingMarks(p, run.seatId, reservedSeq(p, run.id));
  const allowed = allowedIds(p, run);
  return [...targets].filter((id) => !marked.has(id) && allowed.has(id));
}

export function isPending(a: Activity): boolean {
  return a.status === "pending" || a.status === "uncertain";
}

export function pendingActivities(p: Projection, seatId: string): Activity[] {
  return [...p.activities.values()].filter((a) => a.seatId === seatId && isPending(a));
}

export function activityStartedSeq(p: Projection, activityId: string): number {
  return eventSeq(p, (e) => e.data.kind === "activity.started" && e.data.activity.id === activityId) ?? 0;
}

/**
 * §2: an activity the member holds itself. Every `work:` activity is; a `bg:` one becomes so once any of its requests
 * gets a `working` mark after it was registered. Read from the journal's progress events, stored nowhere else.
 */
export function memberHeld(p: Projection, a: Activity): boolean {
  if (a.id.startsWith("work:")) return true;
  const marks = workingMarks(p, a.seatId, activityStartedSeq(p, a.id));
  return a.requestIds.some((id) => marks.has(id));
}

export function openOwned(p: Projection, ids: readonly string[], seatId: string): string[] {
  return ids.filter((id) => {
    const q = p.requests.get(id);
    return q?.state === "open" && q.owner === seatId;
  });
}

/** The body of the last non-empty output imported for a run: its final, re-used when background work ends quietly. */
export function lastFinal(p: Projection, runId: string): string {
  for (let i = p.events.length - 1; i >= 0; i--) {
    const d = p.events[i]!.data;
    if (d.kind === "output" && d.association.kind === "run" && d.association.id === runId && d.body.length > 0) return d.body;
  }
  return "";
}

/**
 * What a run's `sending` phase froze before the message left: the dispatch command, the background tasks T3 already
 * listed (so only work this run started holds its requests, §2), the exact text and images T3 is sent (on every resend
 * too), and the standing record the seat's thread holds once T3 has it (L2's ledger, read back from the journal).
 */
export interface Dispatch { dispatch: string; bgBefore: string[]; text: string; images: Array<{ eventId: string; names: string[] }>; held: SeatStanding | null }

export function frozenDispatch(p: Projection, runId: string): Dispatch | null {
  for (const e of p.events) {
    if (e.data.kind !== "run.phase" || e.data.runId !== runId || e.data.phase !== "sending") continue;
    return JSON.parse(e.data.evidence) as Dispatch;
  }
  return null;
}

/** Per host run, in one pass over the journal: the T3 run it was matched to (accepted) and what its sending froze. */
export function runRecords(p: Projection): Map<string, { reservedSeq: number; seatId: string; t3: { id: string; ordinal: number } | null; frozen: Dispatch | null }> {
  const records = new Map<string, { reservedSeq: number; seatId: string; t3: { id: string; ordinal: number } | null; frozen: Dispatch | null }>();
  for (const e of p.events) {
    const d = e.data;
    if (d.kind === "run.prepared") records.set(d.run.id, { reservedSeq: e.seq, seatId: d.run.seatId, t3: null, frozen: null });
    if (d.kind !== "run.phase") continue;
    const record = records.get(d.runId);
    if (!record) continue;
    if (d.phase === "sending") record.frozen = JSON.parse(d.evidence) as Dispatch;
    const match = d.phase === "accepted" ? /^t3run:(\S+) ordinal:(\d+)$/.exec(d.evidence) : null;
    if (match) record.t3 = { id: match[1]!, ordinal: Number(match[2]) };
  }
  return records;
}

/** The requests the seat's latest answer closed: a later self-started turn's note goes under them ("after answer", §5). */
export function lastAnswered(p: Projection, seatId: string): string[] {
  for (let i = p.events.length - 1; i >= 0; i--) {
    const d = p.events[i]!.data;
    if (d.kind !== "output" || d.author !== seatId) continue;
    const ids = d.claims.filter((c) => c.outcome === "answered").map((c) => c.requestId);
    if (ids.length) return ids;
  }
  return [];
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

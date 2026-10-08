import type { Projection, RoomEvent } from "./types.ts";
import { editEntry, initializeHistory, rememberEvent } from "./incremental.ts";

/** Rebuild only from committed events. No provider, database, queue, time or randomness. */
export function emptyProjection(events: readonly RoomEvent[] = []): Projection {
  const p: Projection = {
    events, seats: new Map(), requests: new Map(), runs: new Map(), activities: new Map(),
    subscriptions: [], sourceKeys: new Map(), commandKeys: new Set(), blocked: new Map(), orchestrator: null,
  };
  initializeHistory(p);
  return p;
}

/** Apply exactly one verified event to a fresh fold or a transaction-owned entry overlay. */
export function applyEvent(p: Projection, original: RoomEvent): void {
    rememberEvent(p, original);
    p.commandKeys.add(original.commandKey);
    const d = structuredClone(original.data);
    switch (d.kind) {
      case "seat.created":
        if (p.seats.has(d.seatId)) throw new Error("seat identity reused");
        p.seats.set(d.seatId, { id: d.seatId, threadId: d.threadId, cursor: 0, status: "active", activeRunId: null });
        if (d.orchestrator) p.orchestrator = d.seatId;
        break;
      case "seat.retired":
        editEntry(p, "seats", d.seatId).status = "retired";
        if (p.orchestrator === d.seatId) p.orchestrator = null;
        break;
      case "orchestrator.set": p.orchestrator = d.seatId; break;
      case "request":
        p.requests.set(d.request.id, { ...d.request, state: "open", answerId: null });
        break;
      case "correction": {
        const request = editEntry(p, "requests", d.requestId);
        request.version = original.seq;
        request.corrections.push({ eventId: original.id, seq: original.seq, body: d.body });
        break;
      }
      case "cancel": if (d.applied) editEntry(p, "requests", d.requestId).state = "cancelled"; break;
      case "run.prepared": {
        const seat = editEntry(p, "seats", d.run.seatId);
        if (seat.activeRunId !== null) throw new Error("multiple unresolved runs");
        p.runs.set(d.run.id, d.run);
        seat.activeRunId = d.run.id;
        p.blocked.delete(seat.id);
        break;
      }
      case "run.phase": {
        const run = editEntry(p, "runs", d.runId);
        run.phase = d.phase;
        if (d.providerRunId !== undefined) run.providerRunId = d.providerRunId;
        break;
      }
      case "sync.offered": editEntry(p, "runs", d.runId).receipts.push(d.receipt); break;
      case "sync.confirmed": {
        const run = editEntry(p, "runs", d.runId);
        const receipt = run.receipts.find((r) => r.id === d.receiptId)!;
        receipt.confirmed = true;
        run.through = Math.max(run.through, receipt.envelope.through);
        break;
      }
      case "run.ended": {
        const run = editEntry(p, "runs", d.runId);
        run.phase = "terminal";
        run.through = d.through;
        run.failure = d.failure;
        const seat = editEntry(p, "seats", run.seatId);
        if (d.consumed) seat.cursor = d.through;
        if (seat.activeRunId === run.id) seat.activeRunId = null;
        break;
      }
      case "output":
        if (p.sourceKeys.has(d.sourceKey)) throw new Error("duplicate source emission");
        p.sourceKeys.set(d.sourceKey, original.id);
        for (const claim of d.claims) if (claim.outcome === "answered") {
          const request = editEntry(p, "requests", claim.requestId);
          if (request.state !== "open" || request.answerId !== null) throw new Error("duplicate terminal claim");
          request.state = "answered";
          request.answerId = original.id;
        }
        break;
      case "activity.started": p.activities.set(d.activity.id, d.activity); break;
      case "activity.status": editEntry(p, "activities", d.activityId).status = d.status; break;
      case "subscription":
        p.subscriptions = p.subscriptions.filter((s) => s.seatId !== d.subscription.seatId || s.requestId !== d.subscription.requestId);
        if (d.enabled) p.subscriptions.push(d.subscription);
        break;
      case "transfer": {
        editEntry(p, "seats", d.oldSeatId).status = "retired";
        if (p.seats.has(d.newSeatId)) throw new Error("seat identity reused");
        p.seats.set(d.newSeatId, { id: d.newSeatId, threadId: d.threadId, cursor: d.cutoff, status: "active", activeRunId: null });
        for (const id of d.owned) editEntry(p, "requests", id).owner = d.newSeatId;
        for (const id of d.awaited) editEntry(p, "requests", id).returnTo = d.newSeatId;
        p.subscriptions = structuredClone(p.subscriptions);
        for (const s of p.subscriptions) if (s.seatId === d.oldSeatId) s.seatId = d.newSeatId;
        if (p.orchestrator === d.oldSeatId) p.orchestrator = d.newSeatId;
        break;
      }
      case "delivery.blocked": p.blocked.set(d.seatId, d.eventId); break;
      case "note": case "progress": case "notice": case "retry": break;
      default: throw new Error("invalid authoritative journal event kind");
    }
}

/** Full replay remains available for historical prefixes, cold recovery and audits. */
export function fold(events: readonly RoomEvent[]): Projection {
  const p = emptyProjection(events);
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) throw new Error("invalid event order or identity");
    applyEvent(p, event);
  }
  return p;
}

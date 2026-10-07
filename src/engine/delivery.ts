import type { Envelope, Input, Principal, Projection, RequestContext, RoomEvent, Selection } from "./types.ts";
import { fold } from "./fold.ts";

/** A single event can carry many claims, but it is still delivered once per seat. */
export function inputFor(event: RoomEvent, seatId: Principal): Input | null {
  const d = event.data;
  if (!("recipients" in d) || !("author" in d) || d.author === seatId || !d.recipients.includes(seatId)) return null;
  const base = { eventId: event.id, seq: event.seq, inherited: [] as Input[] };
  switch (d.kind) {
    case "request": return { ...base, intent: "request", body: d.request.body, requestIds: [d.request.id] };
    case "correction": return { ...base, intent: "correction", body: d.body, requestIds: [d.requestId] };
    case "cancel": return d.applied ? { ...base, intent: "cancel", body: "Request cancelled", requestIds: [d.requestId] } : null;
    case "progress": return { ...base, intent: "progress", body: d.body, requestIds: d.requestIds };
    case "output": {
      const claims = d.claims.filter((c) => c.outcome === "answered" && c.returnTo === seatId);
      if (claims.length) return { ...base, intent: "result", body: d.body, requestIds: claims.map((c) => c.requestId) };
      if (d.disposition.kind === "progress") return { ...base, intent: "progress", body: d.body, requestIds: d.disposition.requestIds };
      return null;
    }
    case "notice": return { ...base, intent: d.intent, body: d.body, requestIds: d.requestIds };
    case "transfer": return { ...base, intent: "transfer", body: d.body, requestIds: [...d.owned, ...d.awaited], inherited: d.inherited };
    case "retry": return { ...base, intent: "retry", body: d.body, requestIds: d.requestIds, inherited: d.inherited };
    default: return null; // Notes, operations, live responses and receipts never wake.
  }
}

export function unread(p: Projection, seatId: string, after = p.seats.get(seatId)?.cursor ?? 0): Input[] {
  return p.events.filter((e) => e.seq > after).flatMap((e) => {
    const input = inputFor(e, seatId);
    return input && deliveryDisposition(p, e, seatId) === "pending" ? [input] : [];
  });
}
/** Explicit delivery classifications come from cursor/transfer events, never mutable flags. */
export function deliveryDisposition(p: Projection, event: RoomEvent, seatId: string): "context" | "pending" | "delivered" | "transferred" | "undeliverable" {
  if (!inputFor(event, seatId)) return "context";
  if (event.seq <= (p.seats.get(seatId)?.cursor ?? 0)) return "delivered";
  const transfer = p.events.find((e) => e.data.kind === "transfer" && e.data.oldSeatId === seatId);
  if (transfer?.data.kind === "transfer") {
    if (inputTree(transfer.data.inherited).some((i) => i.eventId === event.id)) return "transferred";
    if (event.seq > transfer.data.cutoff) return "undeliverable";
  }
  return "pending";
}
export function openRequests(p: Projection, seatId: string): RequestContext[] {
  return [...p.requests.values()].filter((r) => r.owner === seatId && r.state === "open").map((r) => ({
    id: r.id, rootId: r.rootId, parentId: r.parentId, owner: r.owner,
    returnTo: r.returnTo, body: r.body, version: r.version, corrections: r.corrections,
  }));
}
export function inputTree(inputs: readonly Input[]): Input[] {
  return inputs.flatMap((input) => [input, ...inputTree(input.inherited)]);
}
export function envelopeBytes(envelope: Envelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}

/** Oldest complete prefix within the budget. The first oversized body is never skipped. */
export function selectPrefix(p: Projection, seatId: string, maxBytes: number, after?: number, sync = false): Selection {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("positive byte budget required");
  const seat = p.seats.get(seatId);
  if (!seat) throw new Error("unknown seat");
  const base = after ?? seat.cursor;
  const candidates = unread(p, seatId, base);
  if (!sync && !candidates.length) return { kind: "idle" };
  const make = (through: number, inputs: Input[]): Envelope => ({
    base, through, inputs, openRequests: openRequests(fold(p.events.slice(0, through)), seatId), contextThrough: through,
  });
  const selected: Input[] = [];
  for (const input of candidates) {
    const envelope = make(input.seq, [...selected, input]);
    const bytes = envelopeBytes(envelope);
    if (bytes > maxBytes) {
      if (!selected.length) return { kind: "blocked", eventId: input.eventId, requiredBytes: bytes };
      return { kind: "ready", envelope: make(input.seq - 1, selected) };
    }
    selected.push(input);
  }
  const envelope = make(p.events.length, selected);
  const bytes = envelopeBytes(envelope);
  if (bytes > maxBytes) return { kind: "blocked", eventId: candidates[0]?.eventId ?? "open-context", requiredBytes: bytes };
  return { kind: "ready", envelope };
}

/** Delivered inputs, including inherited content and confirmed syncs, retained for retry. */
export function deliveredInputs(p: Projection, runId: string): Input[] {
  const run = p.runs.get(runId)!;
  const inputs = [...run.envelope.inputs, ...run.receipts.filter((r) => r.confirmed).flatMap((r) => r.envelope.inputs)];
  return [...new Map(inputs.map((i) => [i.eventId, i])).values()].sort((a, b) => a.seq - b.seq);
}

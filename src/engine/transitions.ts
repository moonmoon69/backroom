import { createHash } from "node:crypto";
import { journalHistory, ProjectionOverlay } from "./incremental.ts";
import { applyEvent, fold } from "./fold.ts";
import { deliveredInputs, deliveryDisposition, inputFor, inputTree, selectPrefix, unread } from "./delivery.ts";
import type { Association, ClaimOutcome, Command, Decision, Disposition, EventData, Principal, Projection, Request, RoomEvent, Run, Seat } from "./types.ts";

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function unique(ids: readonly string[]): string[] { return [...new Set(ids)]; }
function emissionIdentity(association: Association, disposition: Disposition): string {
  return JSON.stringify([association.kind, "id" in association ? association.id : null,
    disposition.kind, "requestIds" in disposition ? disposition.requestIds : null,
    disposition.kind === "progress" ? disposition.milestone ?? null : null]);
}
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && unique(a).sort().every((id, i) => id === unique(b).sort()[i]);
}
function unresolved(status: string): boolean { return status === "pending" || status === "uncertain"; }
function active(p: Projection, id: Principal): boolean { return id === "$user" || p.seats.get(id)?.status !== "retired" && p.seats.has(id); }
function descendant(p: Projection, child: string, parent: string): boolean {
  let r = p.requests.get(child);
  while (r) {
    if (r.id === parent) return true;
    r = r.parentId ? p.requests.get(r.parentId) : undefined;
  }
  return false;
}
/** The single blocking rule: a request stays open while background work or an open child request remains under it. */
function pendingWork(p: Projection, requestId: string): boolean {
  return [...p.activities.values()].some((a) => unresolved(a.status) && a.requestIds.some((id) => descendant(p, id, requestId)))
    || [...p.requests.values()].some((r) => r.id !== requestId && r.state === "open" && descendant(p, r.id, requestId));
}
function resumableIds(p: Projection, run: Run): string[] {
  const contexts = [...run.envelope.openRequests, ...run.receipts.filter((r) => r.confirmed).flatMap((r) => r.envelope.openRequests)];
  return unique([...contexts.map((r) => r.id), ...inputTree(deliveredInputs(p, run.id)).flatMap((i) => i.requestIds)]);
}
/** Open requests of the seat that an unread result or correction after `through` bears on: each walks up to its first open owned ancestor. */
function unseenResultTargets(p: Projection, seatId: string, through: number): Set<string> {
  const targets = new Set<string>();
  for (let i = through; i < p.events.length; i++) {
    const e = p.events[i]!, input = inputFor(e, seatId);
    if (!input || input.intent !== "result" && input.intent !== "correction" || deliveryDisposition(p, e, seatId) !== "pending") continue;
    for (const id of input.requestIds) {
      let q = p.requests.get(id);
      while (q && !(q.owner === seatId && q.state === "open")) q = q.parentId ? p.requests.get(q.parentId) : undefined;
      if (q) targets.add(q.id);
    }
  }
  return targets;
}
function progressRecipients(p: Projection, author: Principal, ids: readonly string[], milestone: string | undefined): Principal[] {
  if (!milestone) return [];
  return unique(p.subscriptions.filter((s) => ids.includes(s.requestId) && s.milestones.includes(milestone) && s.seatId !== author && active(p, s.seatId)).map((s) => s.seatId));
}

/**
 * Decide against a committed, room-scoped log. The caller authenticates actor and provider
 * correlation, then appends ALL returned events under a head compare/room transaction.
 * A race must rerun this function against the winning log. Nothing here dispatches work.
 */
export function decide(log: readonly RoomEvent[], command: Command): Decision {
  return decideProjection(new ProjectionOverlay(fold(log)), command);
}

/** Decide using verified journal-derived state: `initial` is the room before the command, `view()` as its events apply. */
export function decideProjection(transaction: ProjectionOverlay, command: Command): Decision {
  requireThat(command.id.length > 0 && command.actor.length > 0, "command identity required");
  const initial = transaction.nextLayer();
  const log = initial.events;
  const history = journalHistory(initial);
  const key = JSON.stringify([command.actor, command.id]);
  const events: RoomEvent[] = [];
  const result = (outcome: Decision["outcome"] = "appended"): Decision => ({ expectedSeq: log.length, events, outcome });
  if (initial.commandKeys.has(key)) return result("duplicate");
  requireThat(!history.events.has(command.id) && !history.prefixes.has(command.id), "event identity collision");
  const view = (): Projection => transaction.p;
  const emit = (data: EventData): string => {
    const id = events.length === 0 ? command.id : `${command.id}/${events.length}`;
    requireThat(!history.events.has(id), "event identity collision");
    const event = { id, seq: log.length + events.length + 1, commandKey: key, data: structuredClone(data) };
    events.push(event);
    transaction.events.push(event);
    applyEvent(transaction.p, event);
    return id;
  };
  const seat = (id: string, p = view()) => {
    const value = p.seats.get(id);
    requireThat(value, "unknown seat");
    return value;
  };
  const request = (id: string, p = view()): Request => {
    const value = p.requests.get(id);
    requireThat(value, "unknown request");
    return value;
  };
  const run = (id: string, p = view()): Run => {
    const value = p.runs.get(id);
    requireThat(value, "unknown run");
    return value;
  };
  const system = () => requireThat(command.actor === "$system", "adapter/store principal required");
  const actor = () => {
    requireThat(command.actor !== "$system", "system cannot author member intent");
    if (command.actor !== "$user") requireThat(seat(command.actor).status === "active", "author seat is not active");
  };
  const manager = () => requireThat(command.actor === "$user" || command.actor === view().orchestrator, "user or orchestrator required");
  const controlsRequest = (r: Request) => requireThat(command.actor === "$user" || command.actor === r.returnTo || command.actor === view().orchestrator, "requester authorization required");
  const notice = (intent: "error" | "attention" | "keep-alive", body: string, requestIds: string[], targets: Principal[], causeId: string, author: Principal) => {
    // A notice with no recipient is still a visible recovery fact. It never recursively reports delivery failure.
    emit({ kind: "notice", intent, body, requestIds: unique(requestIds), author, recipients: unique(targets).filter((t) => t !== author && active(view(), t)), causeId });
  };
  const attention = (body: string, causeId: string, ids: string[], author: Principal) => {
    const o = view().orchestrator;
    notice("attention", body, ids, o ? [o] : [], causeId, author);
  };
  /** A seat leaves (transfer, retire) only when it is known to be quiet: no run and no background work. */
  const quiescent = (s: Seat, evidence: string) => {
    requireThat(s.status === "active" && s.activeRunId === null, "old run must be reconciled and stopped");
    requireThat(evidence.length > 0, "provider quiescence proof reference required");
    requireThat(![...initial.activities.values()].some((a) => a.seatId === s.id && unresolved(a.status)), "known background work prevents transfer");
  };
  const undeliverable = (targets: Principal[], causeId: string, ids: string[], author: Principal) => {
    if (targets.some((t) => !active(view(), t))) attention("Undeliverable to immutable retired seat; original content remains on board", causeId, ids, author);
  };
  switch (command.type) {
    case "observe_end": {
      system();
      const r = run(command.runId);
      const outputId = initial.sourceKeys.get(command.sourceKey);
      const output = outputId ? history.events.get(outputId)?.data : undefined;
      requireThat(output?.kind === "output" && output.association.kind === "run" && output.association.id === r.id
        && command.evidence.length > 0, "terminal observation needs an already-imported exact run emission");
      if (r.phase === "terminal") return result("duplicate");
      requireThat(["accepted", "running", "uncertain"].includes(r.phase), "terminal observation requires established association");
      if (command.failure !== null) {
        const fresh = inputTree(deliveredInputs(initial, r.id)).filter((i) => !["error", "attention", "progress", "cancel", "keep-alive"].includes(i.intent));
        const affected = unique(fresh.flatMap((i) => i.requestIds)).filter((id) => initial.requests.get(id)?.state === "open");
        if (!history.errorNotices.has(r.id))
          notice("error", command.failure, affected, fresh.length ? [...affected.map((id) => request(id).returnTo), ...(initial.orchestrator ? [initial.orchestrator] : [])] : [], r.id, r.seatId);
      }
      emit({ kind: "run.ended", runId: r.id, through: r.through, failure: command.failure, consumed: true });
      break;
    }
    case "seat": {
      manager();
      requireThat(command.seatId.length > 0 && !command.seatId.startsWith("$") && !initial.seats.has(command.seatId), "fresh immutable seat ID required");
      requireThat(command.threadId.length > 0 && ![...initial.seats.values()].some((s) => s.threadId === command.threadId), "fresh provider thread required");
      requireThat(!command.orchestrator || initial.orchestrator === null, "orchestrator already seated");
      emit({ kind: "seat.created", seatId: command.seatId, threadId: command.threadId, orchestrator: command.orchestrator ?? false });
      break;
    }
    case "request": {
      // Backroom ($system) asks a seat for itself (a seat briefing): under nothing, and its answer wakes nobody.
      if (command.actor === "$system") requireThat(command.to !== "$user" && !command.parentId, "Backroom asks a seat, under nothing");
      else actor();
      if (command.to !== "$user") seat(command.to);
      requireThat(command.to !== command.actor, "own request cannot create a wake");
      const parent = command.parentId ? request(command.parentId) : null;
      if (parent) requireThat(command.actor === "$user" || command.actor === parent.owner || command.actor === parent.returnTo || command.actor === initial.orchestrator, "unrelated causal parent");
      const recipients = [command.to];
      const id = emit({ kind: "request", author: command.actor, recipients, request: {
        id: command.id, rootId: parent?.rootId ?? command.id, parentId: parent?.id ?? null,
        owner: command.to, returnTo: command.actor, body: command.body, version: log.length + 1, corrections: [],
      } });
      undeliverable(recipients, id, [command.id], command.actor);
      break;
    }
    case "correct": {
      actor();
      const r = request(command.requestId);
      controlsRequest(r);
      requireThat(r.state === "open", "closed request needs a new request");
      const id = emit({ kind: "correction", requestId: r.id, body: command.body, author: command.actor, recipients: [r.owner] });
      undeliverable([r.owner], id, [r.id], command.actor);
      break;
    }
    case "cancel": {
      actor();
      const r = request(command.requestId);
      controlsRequest(r);
      const applied = r.state === "open";
      emit({ kind: "cancel", requestId: r.id, applied, author: command.actor, recipients: applied ? [r.owner] : [] });
      // Stopping a live turn is the host's (an interrupt through T3); only a run T3 rejected ends here.
      const activeRunId = r.owner === "$user" ? null : seat(r.owner).activeRunId;
      if (applied && activeRunId && run(activeRunId).phase === "rejected") {
        const rejected = run(activeRunId);
        emit({ kind: "run.ended", runId: rejected.id, through: rejected.envelope.base, failure: "definite rejection; explicit cancel", consumed: false });
      }
      break;
    }
    case "post": {
      actor();
      const ids = unique(command.requestIds ?? []);
      for (const id of ids) requireThat(request(id).owner === command.actor || command.actor === "$user", "progress requires causal ownership");
      emit({ kind: command.intent, body: command.body, author: command.actor, requestIds: ids, milestone: command.milestone ?? null,
        recipients: command.intent === "progress" ? progressRecipients(initial, command.actor, ids, command.milestone) : [] });
      break;
    }
    case "subscribe": {
      actor();
      requireThat(command.actor !== "$user", "agent seat subscription required");
      request(command.requestId);
      requireThat(command.milestones.every((m) => m.length > 0), "named milestones required");
      emit({ kind: "subscription", subscription: { seatId: command.actor, requestId: command.requestId, milestones: unique(command.milestones) }, enabled: command.enabled });
      break;
    }
    case "reserve": {
      system();
      const s = seat(command.seatId);
      requireThat(s.status === "active" && s.activeRunId === null, "seat has unresolved activity or is not active");
      requireThat(!initial.runs.has(command.runId) && command.runId.length > 0, "fresh run identity required");
      requireThat(command.dispatchCommandId.length > 0 && command.dispatchMessageId.length > 0, "stable dispatch identities required");
      requireThat(![...initial.runs.values()].some((r) => r.dispatchCommandId === command.dispatchCommandId || r.dispatchMessageId === command.dispatchMessageId), "dispatch identity reused");
      const selection = selectPrefix(initial, s.id, command.maxBytes);
      if (selection.kind === "idle") return result("idle");
      if (selection.kind === "blocked") {
        if (initial.blocked.get(s.id) !== selection.eventId) emit({ kind: "delivery.blocked", seatId: s.id, eventId: selection.eventId, requiredBytes: selection.requiredBytes });
        return result("blocked");
      }
      emit({ kind: "run.prepared", run: { id: command.runId, seatId: s.id, phase: "prepared", envelope: selection.envelope,
        through: selection.envelope.through, dispatchCommandId: command.dispatchCommandId, dispatchMessageId: command.dispatchMessageId, receipts: [], failure: null } });
      break;
    }
    case "phase": {
      system();
      requireThat(command.evidence.length > 0, "phase evidence required");
      const r = run(command.runId);
      const next: Record<string, string[]> = {
        prepared: ["sending", "accepted", "uncertain", "rejected"], sending: ["accepted", "uncertain", "rejected"],
        accepted: ["running", "uncertain"], running: ["uncertain"], uncertain: ["accepted", "running", "rejected"], rejected: [], terminal: [],
      };
      requireThat(next[r.phase]!.includes(command.phase), "invalid run transition; reconcile same reservation");
      const t3 = command.providerRunId;
      if (t3 !== undefined) {
        requireThat(t3.length > 0 && ["accepted", "running", "uncertain"].includes(command.phase), "T3 run identity needs a phase T3 took");
        requireThat(!r.providerRunId || r.providerRunId === t3, "provider binding changed");
        requireThat(![...initial.runs.values()].some((other) => other.id !== r.id && other.providerRunId === t3), "provider run already bound to another local run");
      }
      emit({ kind: "run.phase", runId: r.id, phase: command.phase, evidence: command.evidence, ...(t3 === undefined ? {} : { providerRunId: t3 }) });
      break;
    }
    case "sync": {
      const r = run(command.runId);
      requireThat(command.actor === "$system" || command.actor === r.seatId, "run owner required");
      requireThat(["accepted", "running", "uncertain"].includes(r.phase), "sync requires live run");
      requireThat(command.receiptId.length > 0 && ![...initial.runs.values()].some((x) => x.receipts.some((q) => q.id === command.receiptId)), "fresh receipt identity required");
      const selection = selectPrefix(initial, r.seatId, command.maxBytes, r.through, true);
      if (selection.kind === "blocked") {
        if (initial.blocked.get(r.seatId) !== selection.eventId) emit({ kind: "delivery.blocked", seatId: r.seatId, eventId: selection.eventId, requiredBytes: selection.requiredBytes });
        return result("blocked");
      }
      requireThat(selection.kind === "ready", "sync selection required");
      const digest = createHash("sha256").update(JSON.stringify([r.id, command.receiptId, selection.envelope])).digest("hex");
      emit({ kind: "sync.offered", runId: r.id, receipt: { id: command.receiptId, digest, envelope: selection.envelope, confirmed: false } });
      break;
    }
    case "confirm_sync": {
      system();
      requireThat(command.evidence.length > 0, "durable transcript exposure evidence required");
      const r = run(command.runId);
      const receipt = r.receipts.find((item) => item.id === command.receiptId);
      requireThat(receipt && receipt.digest === command.digest, "invalid sync receipt");
      requireThat(r.phase !== "terminal", "cannot extend terminal run delivery");
      requireThat(receipt.envelope.base <= r.through, "incomplete sync prefix");
      if (receipt.confirmed) return result("duplicate");
      emit({ kind: "sync.confirmed", runId: r.id, receiptId: receipt.id, evidence: command.evidence });
      break;
    }
    case "activity_start": {
      const r = run(command.runId);
      requireThat(command.actor === "$system" || command.actor === r.seatId, "activity owner required");
      requireThat(["accepted", "running", "uncertain"].includes(r.phase), "activity must bind live originating run");
      requireThat(command.activityId.length > 0 && !initial.activities.has(command.activityId), "fresh activity identity required");
      requireThat(command.requestIds.length > 0 && sameIds(command.requestIds, unique(command.requestIds)), "explicit distinct activity associations required");
      for (const id of command.requestIds) {
        const q = request(id);
        requireThat(q.owner === r.seatId && q.state === "open" && resumableIds(initial, r).includes(id), "activity cannot guess or attach to unrelated work");
      }
      emit({ kind: "activity.started", activity: { id: command.activityId, seatId: r.seatId, runId: r.id, requestIds: command.requestIds, through: r.through, status: command.status } });
      break;
    }
    case "activity_status": {
      system();
      const a = initial.activities.get(command.activityId);
      requireThat(a && unresolved(a.status), "unknown or resolved activity");
      requireThat(command.evidence.length > 0, "activity resolution evidence required");
      emit({ kind: "activity.status", activityId: a.id, status: command.status, evidence: command.evidence });
      break;
    }
    case "retry": {
      actor();
      const r = run(command.runId);
      requireThat(command.actor === "$user" || command.actor === initial.orchestrator || command.actor === r.seatId, "retry authority required");
      requireThat(command.actor !== r.seatId, "explicit retry must be issued by user or another lawful requester");
      requireThat(r.phase === "rejected" || r.phase === "terminal" && r.failure !== null, "only known failed/rejected runs can be retried");
      requireThat(seat(r.seatId).status !== "retired", "cannot retry a retired run");
      if (r.phase === "rejected") emit({ kind: "run.ended", runId: r.id, through: r.envelope.base, failure: "definite rejection; explicit retry", consumed: false });
      const inputs = r.phase === "rejected" ? [] : deliveredInputs(initial, r.id);
      emit({ kind: "retry", runId: r.id, author: command.actor, recipients: [r.seatId], inherited: inputs, requestIds: unique(inputTree(r.envelope.inputs).flatMap((i) => i.requestIds)), body: command.body });
      break;
    }
    case "keep_alive": {
      // H6: Backroom wakes an idle seat to keep its thread's prompt cache warm. The notice asks nothing and answers nothing.
      system();
      const s = seat(command.seatId);
      requireThat(s.status === "active" && s.activeRunId === null, "keep-alive needs an idle active seat");
      requireThat(command.body.length > 0, "keep-alive body required");
      notice("keep-alive", command.body, [], [s.id], s.id, "$system");
      break;
    }
    case "transfer": {
      manager();
      actor();
      const s = seat(command.oldSeatId);
      quiescent(s, command.evidence);
      requireThat(command.newSeatId.length > 0 && !command.newSeatId.startsWith("$") && !initial.seats.has(command.newSeatId), "fresh immutable seat ID required");
      requireThat(command.threadId.length > 0 && ![...initial.seats.values()].some((x) => x.threadId === command.threadId), "fresh provider thread required");
      const owned = [...initial.requests.values()].filter((r) => r.owner === s.id && r.state === "open").map((r) => r.id);
      const awaited = [...initial.requests.values()].filter((r) => r.returnTo === s.id && r.state === "open").map((r) => r.id);
      requireThat(sameIds(command.owned, owned) && sameIds(command.awaited, awaited), "transfer must name exact open owned/awaited requests");
      emit({ kind: "transfer", oldSeatId: s.id, newSeatId: command.newSeatId, threadId: command.threadId, cutoff: log.length,
        owned, awaited, inherited: unread(initial, s.id), author: command.actor, recipients: [command.newSeatId], body: command.body, evidence: command.evidence });
      break;
    }
    case "retire": {
      // A seat leaves without a successor: transfer's checks, and it may own no open request, since nothing takes it over.
      manager();
      actor();
      const s = seat(command.seatId);
      quiescent(s, command.evidence);
      requireThat(![...initial.requests.values()].some((r) => r.owner === s.id && r.state === "open"), "open owned requests prevent retirement; transfer, answer or cancel them");
      emit({ kind: "seat.retired", seatId: s.id, author: command.actor, evidence: command.evidence });
      break;
    }
    case "designate": {
      requireThat(command.actor === "$user", "only the user designates the orchestrator");
      if (command.seatId !== null) requireThat(seat(command.seatId).status === "active", "orchestrator must be an active seat");
      if (initial.orchestrator === command.seatId) return result("idle");
      emit({ kind: "orchestrator.set", seatId: command.seatId, author: command.actor });
      break;
    }
    case "output": {
      requireThat(command.actor === "$system" || command.actor === command.author, "output author mismatch");
      requireThat(command.sourceKey.length > 0, "source emission identity required");
      requireThat(!command.activityCompletion || command.association.kind === "activity", "activity completion needs explicit activity identity");
      requireThat(command.disposition.kind !== "silent" || command.body === "", "silent consumption has no prose output");
      const priorId = initial.sourceKeys.get(command.sourceKey);
      if (priorId) {
        const prior = history.events.get(priorId)!.data;
        requireThat(prior.kind === "output" && prior.author === command.author
          && prior.body === command.body
          && emissionIdentity(prior.association, prior.disposition)
            === emissionIdentity(command.association, command.association.kind === "orphan" ? { kind: "yield" } : command.disposition),
        "source identity conflicts with immutable emission");
        // Message import can precede the independently observed provider turn end.
        // Reuse the emission; terminal metadata must not strand the reservation or re-claim work.
        if (command.terminal && command.association.kind === "run") {
          const r = run(command.association.id);
          if (r.phase !== "terminal") {
            requireThat(["accepted", "running", "uncertain"].includes(r.phase), "terminal observation requires established provider association");
            emit({ kind: "run.ended", runId: r.id, through: run(r.id).through,
              failure: prior.disposition.kind === "error" ? prior.body : null, consumed: true });
            return result();
          }
        }
        return result("duplicate");
      }
      if (command.association.kind === "orphan") {
        requireThat(command.actor === "$system" && !command.terminal, "unassociated native output cannot finish a run");
        const id = emit({ kind: "output", author: command.author, sourceKey: command.sourceKey, association: command.association,
          disposition: { kind: "yield" }, body: command.body, claims: [], recipients: [] });
        attention("Orphan native output: no proven causal association", id, [], command.author);
        break;
      }
      const a = command.association.kind === "activity" ? initial.activities.get(command.association.id) : null;
      if (command.association.kind === "activity") requireThat(a, "unknown activity; import as orphan instead");
      const r = run(a?.runId ?? command.association.id);
      requireThat(r.seatId === command.author, "immutable run/seat association mismatch");
      requireThat(["accepted", "running", "uncertain", "terminal"].includes(r.phase), "output requires established provider run association");
      requireThat(!a || !command.terminal, "activity result does not terminate a provider run");
      if (a && command.activityCompletion) {
        requireThat(unresolved(a.status), "activity already resolved");
        emit({ kind: "activity.status", activityId: a.id, status: command.activityCompletion, evidence: `explicit correlated activity completion ${command.sourceKey}` });
      }
      const p = view();
      const currentRun = run(r.id, p);
      const through = a?.through ?? currentRun.through;
      const allowedIds = a?.requestIds ?? resumableIds(p, currentRun);
      const disposition: Disposition = command.disposition;
      const selected = "requestIds" in disposition ? disposition.requestIds : [];
      requireThat(sameIds(selected, unique(selected)), "distinct selected requests required");
      if (disposition.kind === "answer") requireThat(selected.length > 0, "explicit nonempty answer selection required");
      for (const id of selected) requireThat(allowedIds.includes(id), "request not exposed or causally associated with this output");
      const claims: ClaimOutcome[] = [];
      const unseen = disposition.kind === "answer" ? unseenResultTargets(p, r.seatId, through) : new Set<string>();
      if (disposition.kind === "answer") for (const id of selected) {
        const q = request(id, p);
        const outcome = q.owner !== r.seatId || seat(r.seatId, p).status === "retired" || q.state === "cancelled" ? "late"
          : q.state === "answered" ? "already_answered" : q.version > through || unseen.has(id) ? "superseded"
          : pendingWork(p, id) ? "pending_activity" : "answered";
        claims.push({ requestId: id, outcome, returnTo: q.returnTo });
      }
      const progressIds = selected.filter((id) => request(id, p).owner === r.seatId && seat(r.seatId, p).status !== "retired");
      // An answer to Backroom's own request wakes nobody: Backroom reads the journal.
      const recipients = disposition.kind === "progress" ? progressRecipients(p, command.author, progressIds, disposition.milestone)
        : unique(claims.filter((c) => c.outcome === "answered" && c.returnTo !== "$system").map((c) => c.returnTo));
      const outputId = emit({ kind: "output", author: command.author, sourceKey: command.sourceKey, association: command.association, disposition, body: command.body, claims, recipients });
      undeliverable(recipients, outputId, claims.map((c) => c.requestId), command.author);
      if (claims.some((c) => c.outcome === "late")) attention("Late output retained; cancelled/transferred generation cannot claim completion", outputId, claims.filter((c) => c.outcome === "late").map((c) => c.requestId), command.author);
      if (disposition.kind === "error") {
        const fresh = inputTree(deliveredInputs(p, r.id)).filter((i) => !["error", "attention", "progress", "cancel", "keep-alive"].includes(i.intent));
        const affected = new Set<string>();
        const freshWork = a !== null || fresh.length > 0;
        const scope = a ? a.requestIds : [...fresh.flatMap((i) => i.requestIds), ...(fresh.length ? selected : [])];
        for (const id of scope) {
          let q: Request | undefined = p.requests.get(id);
          while (q && q.owner !== r.seatId) q = q.parentId ? p.requests.get(q.parentId) : undefined;
          if (q && q.state === "open") affected.add(q.id);
        }
        const ids = [...affected];
        const targets = freshWork ? [...ids.map((id) => request(id, p).returnTo), ...(p.orchestrator ? [p.orchestrator] : [])] : [];
        const cause = a ? `activity:${a.id}` : r.id;
        if (!journalHistory(p).errorNotices.has(cause)) {
          notice("error", freshWork ? command.body : `Recovery failure: ${command.body}`, ids, targets, cause, command.author);
        }
      }
      if (command.terminal && currentRun.phase !== "terminal") {
        requireThat(command.association.kind === "run", "terminal output must bind originating run");
        emit({ kind: "run.ended", runId: r.id, through: currentRun.through, failure: disposition.kind === "error" ? command.body : null, consumed: true });
      }
      break;
    }
    default:
      // A command the lean core dropped (or never had) is refused, never taken as an empty success.
      throw new Error(`unknown command type: ${(command as { type: string }).type}`);
  }
  // emit has already applied and validated each event exactly once.
  return result();
}

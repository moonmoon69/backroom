import { createHash } from "node:crypto";
import { journalHistory, ProjectionOverlay } from "./incremental.ts";
import { applyEvent, fold } from "./fold.ts";
import { deliveredInputs, inputTree, selectPrefix, unread } from "./delivery.ts";
import { T3_CONTRACT_ID, T3_SERVER_VERSION, T3_SOURCE_COMMIT, hash } from "./provider.ts";
import { canonicalJSON, exactAlias, resultDigest, sourceKey, sourceIdentity, toolClosure } from "./result.ts";
import { validateCapability, validateSourceCheckpoint, validateOriginalNativeSource, validateOperationSource, validateOperationPacket, operationKey, parseActivity, localReceipts } from "./operations.ts";
import { declarationBinding, declarationLimits, originalDeclarationOwner, validateDeclaredSource } from "./declared.ts";
import type { OperationBinding, OperationReceipt } from "./operation-types.ts";
import type { Association, ClaimOutcome, Command, Control, Decision, Disposition, EventData, Principal, Projection, Request, RoomEvent, Run } from "./types.ts";

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
function pendingWork(p: Projection, requestId: string, originatingRunId: string): boolean {
  return [...p.providerHolds.values()].some((h) => h.held && h.seatId === p.requests.get(requestId)?.owner
      && h.scope !== "reseat" && (h.scope !== "dispatch" || h.runId === originatingRunId)
      && (h.requestIds ? h.requestIds.some((id) => descendant(p, id, requestId))
      : (h.runId === null || (h.runId === originatingRunId || h.code.startsWith("native_activity:") || h.code.startsWith("control_effect:"))
        && p.runs.has(h.runId) && resumableIds(p, p.runs.get(h.runId)!).some((id) => descendant(p, id, requestId)))))
    || [...p.activities.values()].some((a) => unresolved(a.status) && a.requestIds.some((id) => descendant(p, id, requestId)))
    || [...p.requests.values()].some((r) => r.id !== requestId && r.state === "open" && descendant(p, r.id, requestId))
    || [...p.controls.values()].some((c) => c.phase !== "obsolete" && descendant(p, c.requestId, requestId)
      && (c.phase !== "accepted" || p.providerHolds.get(JSON.stringify([p.runs.get(c.runId)!.seatId, c.runId, `control_effect:${c.id}`]))?.held !== false));
}
function resumableIds(p: Projection, run: Run): string[] {
  const contexts = [...run.envelope.openRequests, ...run.receipts.filter((r) => r.confirmed).flatMap((r) => r.envelope.openRequests)];
  return unique([...contexts.map((r) => r.id), ...inputTree(deliveredInputs(p, run.id)).flatMap((i) => i.requestIds)]);
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

/** Decide using verified journal-derived state. Nested effects share one entry overlay. */
export function decideProjection(transaction: ProjectionOverlay, command: Command, accept?: (data: EventData) => void,
  registrationHistory?: Readonly<Record<string, number>>): Decision {
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
    if (accept) accept(event.data);
    else { transaction.events.push(event); applyEvent(transaction.p, event); }
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
  const notice = (intent: "error" | "attention", body: string, requestIds: string[], targets: Principal[], causeId: string, author: Principal) => {
    // A notice with no recipient is still a visible recovery fact. It never recursively reports delivery failure.
    emit({ kind: "notice", intent, body, requestIds: unique(requestIds), author, recipients: unique(targets).filter((t) => t !== author && active(view(), t)), causeId });
  };
  const attention = (body: string, causeId: string, ids: string[], author: Principal) => {
    const o = view().orchestrator;
    notice("attention", body, ids, o ? [o] : [], causeId, author);
  };
  const undeliverable = (targets: Principal[], causeId: string, ids: string[], author: Principal) => {
    if (targets.some((t) => !active(view(), t))) attention("Undeliverable to immutable retired seat; original content remains on board", causeId, ids, author);
  };
  const confirm = (runId: string, receiptId: string, digest: string, evidence: string) => {
    const r = run(runId);
    const receipt = r.receipts.find((item) => item.id === receiptId);
    requireThat(receipt && receipt.digest === digest, "invalid sync receipt");
    requireThat(r.phase !== "terminal", "cannot extend terminal run delivery");
    requireThat(receipt.envelope.base <= r.through, "incomplete sync prefix");
    if (!receipt.confirmed) emit({ kind: "sync.confirmed", runId, receiptId, evidence });
  };
  const settleInvocation = (source: import("./provider.ts").NativeToolSource, deliveryConfirmed: boolean) => {
    const p = view(), authorized = [...p.capabilities.values()].find((c) => c.nativeRunId === source.providerRunId && c.threadId === source.threadId);
    const r = authorized ? p.runs.get(authorized.runId) : [...p.runs.values()].find((r) => r.providerRunId === source.providerRunId && seat(r.seatId, p).threadId === source.threadId);
    requireThat(r, "invocation must bind original run");
    const aliases = [source, ...(p.providerObservations.get(r.seatId)?.sources ?? []).filter((s) => exactAlias(s, source))];
    const ids = new Set(aliases.flatMap((s) => [s.itemId, s.nodeId].filter((id): id is string => id !== null)));
    for (const h of p.providerHolds.values()) if (h.held && h.runId === r.id && [...ids].some((id) => h.code === `native_activity:${id}` || h.code === `result_unavailable:${id}`))
      emit({ kind: "provider.hold", hold: { ...h, held: false, detail: "Exact original invocation result/local effects recorded atomically." } });
    const key = JSON.stringify([r.seatId, r.id, `own_delivery:${sourceKey(source)}`]);
    if (!deliveryConfirmed || p.providerHolds.get(key)?.held) emit({ kind: "provider.hold", hold: { key, seatId: r.seatId, runId: r.id,
      code: `own_delivery:${sourceKey(source)}`, detail: deliveryConfirmed ? "Exact local receipt response observed." : "Local effects committed; original native response delivery remains unproven.",
      held: !deliveryConfirmed, scope: "reseat", requestIds: [] } });
  };

  switch (command.type) {
    case "close_tool": {
      system(); const r = run(command.runId), full = command.source, evidence = toolClosure(full);
      const cap = [...initial.capabilities.values()].find((c) => c.runId === r.id && c.nativeRunId === full.providerRunId);
      requireThat(evidence && full.threadId === seat(r.seatId).threadId && full.providerRunId === (cap?.nativeRunId ?? r.providerRunId)
        && full.generation !== null, "positive closure must preserve exact original invocation");
      validateOriginalNativeSource(initial, full);
      const o = initial.providerObservations.get(r.seatId);
      requireThat(o && o.sequence === command.sequence && full.sequence === o.sequence
        && command.sourceCheckpointDigest === hash(canonicalJSON(o.sources ?? [])), "closure detail checkpoint superseded");
      const current = o.sources?.find((v) => v.itemId === full.itemId && v.nodeId === full.nodeId);
      requireThat(current && sourceIdentity(current) === sourceIdentity(full) && current.updatedAt === full.updatedAt
        && current.status === full.status && current.nodeStatus === full.nodeStatus && current.exitCode === full.exitCode,
      "closure source identity/outcome changed before commit");
      const key = sourceKey(full), prior = initial.toolClosures.get(key);
      requireThat(![...initial.operationBindings.values()].some((b) => b.source.itemId === full.itemId && b.source.threadId === full.threadId),
        "receipt-backed local invocation cannot become ordinary closure");
      if (prior) {
        requireThat(sourceIdentity(prior.source) === sourceIdentity(full) && canonicalJSON(prior.evidence) === canonicalJSON(evidence),
          "original closure evidence changed");
        return result("duplicate");
      }
      const firstHold = initial.events.find((e) => e.data.kind === "provider.hold" && e.data.hold.runId === r.id
        && [full.itemId, full.nodeId].some((id) => id !== null && e.data.kind === "provider.hold" && e.data.hold.code === `native_activity:${id}`));
      const requestIds = firstHold?.data.kind === "provider.hold" ? firstHold.data.hold.requestIds ?? resumableIds(initial, r) : resumableIds(initial, r);
      emit({ kind: "tool.closed", closure: { key, runId: r.id, generation: full.generation, requestIds, through: r.through,
        source: full, evidence, sourceCheckpointDigest: command.sourceCheckpointDigest } });
      settleInvocation(full, true); break;
    }
    case "activity_bind": {
      system(); const a = initial.activities.get(command.activityId), r = a && run(a.runId);
      requireThat(a && !a.declaration && r && unresolved(a.status) && a.nativeSource?.nativeId === null
        && a.generation === command.generation && a.nativeSource.generation === command.generation
        && a.nativeSource.providerRunId === r.providerRunId && command.nativeId.length > 0,
      "pending original activity needs one prelaunch native identity");
      const o = initial.providerObservations.get(r.seatId), t = r.transport;
      requireThat(o && t && o.sequence === command.sequence && o.threadId === seat(r.seatId).threadId
        && o.environmentId === t.environmentId && o.serverVersion === t.serverVersion && o.contract === t.contract,
      "prelaunch activity source checkpoint changed before binding");
      requireThat(!history.nativeIds.has(command.nativeId), "native activity already observed before binding");
      requireThat(![...initial.activities.values()].some((other) => other.id !== a.id
        && other.nativeSource?.providerRunId === a.nativeSource!.providerRunId
        && other.nativeSource.generation === command.generation && other.nativeSource.nativeId === command.nativeId),
      "native identity already belongs to another registered activity");
      emit({ kind: "activity.native_bound", activityId: a.id, nativeId: command.nativeId, generation: command.generation }); break;
    }
    case "authorize_run": {
      system(); const c = command.capability, r = run(c.runId), s = seat(c.seatId);
      requireThat(c.seatId === r.seatId && s.status === "active" && c.threadId === s.threadId
        && !initial.capabilities.has(c.id) && /^[a-f0-9]{64}$/.test(c.tokenHash)
        && Number.isSafeInteger(c.generation) && c.generation > 0 && c.server.length > 0,
      "immutable authenticated run capability required");
      requireThat(r.transport && c.environmentId === r.transport.environmentId && c.serverVersion === r.transport.serverVersion
        && c.contract === r.transport.contract, "capability must bind frozen provider origin");
      requireThat(!c.nativeRunId || c.activityId && initial.activities.get(c.activityId)?.runId === r.id
        && c.nativeRunId.length > 0, "native continuation requires explicit original activity authorization");
      emit({ kind: "board.capability", capability: c }); break;
    }
    case "activity_operation": {
      system(); const packet = command.packet, intent = parseActivity(packet.intent), cap = initial.capabilities.get(packet.capabilityId);
      requireThat(cap && packet.intentJSON === canonicalJSON(intent), "authenticated activity raw intent required");
      validateCapability(initial, cap); validateOperationSource(initial, cap, intent, packet.source);
      const o = initial.providerObservations.get(cap.seatId), r = run(cap.runId);
      requireThat(o && o.sequence === packet.sequence && o.environmentId === cap.environmentId && o.serverVersion === cap.serverVersion
        && o.contract === cap.contract, "activity checkpoint/origin changed before commit");
      requireThat(packet.sourceCheckpointDigest === hash(canonicalJSON(o.sources ?? [])), "prior activity source coverage changed before commit");
      const checkpoint = (s: import("./provider.ts").NativeToolSource) => {
        validateOriginalNativeSource(initial, s);
        const matches = o.sources?.filter((v) => v.itemId === s.itemId && v.providerRunId === s.providerRunId && v.generation === s.generation) ?? [];
        requireThat(matches.length === 1 && sourceIdentity(matches[0]!) === sourceIdentity(s) && matches[0]!.status === s.status
          && matches[0]!.updatedAt === s.updatedAt && matches[0]!.exitCode === s.exitCode
          && matches[0]!.nodeStatus === s.nodeStatus, "activity source changed before commit");
      };
      checkpoint(packet.source);
      const receiptKey = operationKey(cap.id, intent.clientId);
      requireThat(!initial.activityReceipts.has(receiptKey), "recover original activity receipt");
      const apply = (effect: Command) => { decideProjection(transaction, effect, emit); };
      if (intent.schema === "backroom.activity.v2") {
        if (intent.operation === "register_activity") {
          requireThat(!cap.activityId && !cap.nativeRunId && intent.activityGeneration === cap.generation && r.providerRunId,
            "declare registration in original generation before launch");
          const registration = { provenance: "member_declared" as const, registrationReceiptKey: receiptKey, capabilityId: cap.id,
            seatId: cap.seatId, threadId: cap.threadId, environmentId: cap.environmentId, providerThreadId: packet.source.providerThreadId!,
            runId: r.id, providerRunId: r.providerRunId, generation: cap.generation, requestIds: intent.requestIds, through: r.through,
            registeredAt: initial.events.length + 1, sourceSequenceFloor: o.sequence, limitations: declarationLimits,
            ...(registrationHistory && Object.keys(registrationHistory).length ? { sourceHistoryHeads: { ...registrationHistory } } : {}) };
          apply({ type: "activity_start", id: `${command.id}:register`, actor: "$system", activityId: intent.activityId, runId: r.id,
            requestIds: intent.requestIds, status: "pending", generation: cap.generation, declaration: { registration } });
        } else {
          const a = initial.activities.get(intent.activityId);
          requireThat(a && unresolved(a.status), "pending original declared activity required");
          const reg = originalDeclarationOwner(a, cap, intent);
          if (intent.operation === "bind_activity") {
            const source = packet.originalSource ?? null;
            if (source) { checkpoint(source); requireThat(source.sequence === o.sequence, "binding detail superseded"); }
            const binding = declarationBinding(initial, a, cap, intent, source, receiptKey);
            emit({ kind: "activity.declared_bound", activityId: a.id, binding });
          } else {
            const binding = a.declaration!.binding, full = packet.resultSource;
            requireThat(binding && !a.declaration!.result && intent.bindingReceiptKey === binding.bindingReceiptKey,
              "explicit result needs immutable original binding receipt");
            const bound = binding.originalSource;
            const retained = bound && [...initial.toolClosures.values()].find((c) => c.source.itemId === bound.itemId && c.runId === reg.runId);
            requireThat(!retained || full, "null cannot hide retained original result");
            requireThat(!bound || !Object.hasOwn(bound, "output") && !bound.fileChange || full,
              "null cannot hide the retained original binding result");
            const available = bound && (o.sources ?? []).find((v) => v.itemId === bound.itemId && v.providerRunId === reg.providerRunId
              && v.generation === reg.generation);
            requireThat(!available || !Object.hasOwn(available, "output") && !toolClosure(available) || full,
              "null cannot hide available original result");
            requireThat((full === null) === (intent.resultRef === null), "retain exact original result reference");
            if (full) {
              requireThat(bound && full.itemId === bound.itemId && intent.resultRef?.itemId === full.itemId,
                "result must reference the immutable original source");
              validateDeclaredSource(initial, reg, full); checkpoint(full);
              requireThat(full.sequence === o.sequence, "declared result detail superseded before commit");
              const evidence = toolClosure(full);
              requireThat(!evidence || evidence.outcome !== "failed" || intent.completion === "failed", "native failure cannot become success");
            } else requireThat(intent.unavailableReason, "unavailable original result needs explicit reason");
            emit({ kind: "activity.declared_result", activityId: a.id, result: { provenance: "member_declared", resultReceiptKey: receiptKey,
              bindingReceiptKey: binding.bindingReceiptKey, completion: intent.completion, body: intent.body, originalSource: full,
              evidence: full ? toolClosure(full) : null, unavailableReason: intent.unavailableReason, limitations: binding.limitations } });
            apply({ type: "output", id: `${command.id}:result`, actor: "$system", author: cap.seatId,
              sourceKey: JSON.stringify(["activity-result", receiptKey]), association: { kind: "activity", id: a.id },
              body: intent.body, disposition: { kind: "yield" }, activityCompletion: intent.completion, terminal: false });
          }
        }
      } else if (intent.operation === "register_activity") {
        requireThat(!cap.activityId && !cap.nativeRunId && intent.activityGeneration === cap.generation, "register before original generation background launch");
        requireThat(!(intent.nativeId !== null && history.nativeIds.has(intent.nativeId)), "background activity already launched before registration");
        requireThat(intent.nativeId === null || ![...initial.activities.values()].some((a) => a.nativeSource && a.nativeSource.providerRunId === r.providerRunId
          && a.nativeSource.generation === intent.activityGeneration && a.nativeSource.nativeId === intent.nativeId), "native identity already registered");
        apply({ type: "activity_start", id: `${command.id}:register`, actor: "$system", activityId: intent.activityId, runId: cap.runId,
          requestIds: intent.requestIds, status: "pending", generation: intent.activityGeneration,
          nativeSource: { providerRunId: r.providerRunId!, generation: intent.activityGeneration, nativeId: intent.nativeId } });
      } else {
        const a = initial.activities.get(intent.activityId), full = packet.resultSource;
        requireThat(a && !a.declaration && a.runId === cap.runId && a.generation === intent.activityGeneration && unresolved(a.status)
          && (!cap.activityId || cap.activityId === a.id) && full && a.nativeSource
          && full.providerRunId === a.nativeSource.providerRunId && full.generation === a.nativeSource.generation
          && a.nativeSource.nativeId !== null && full.nativeRef?.nativeId === a.nativeSource.nativeId
          && intent.toolRef.itemId === full.itemId && intent.toolRef.digest === resultDigest(full)
          && sameIds(a.requestIds, intent.toolRef.requestIds), "original registered activity generation/result required");
        checkpoint(full);
        requireThat(full.sequence === o.sequence, "activity result detail superseded before commit");
        const key = sourceKey(full), prior = initial.toolResults.get(key);
        requireThat(!prior || prior.digest === intent.toolRef.digest && sameIds(prior.requestIds, a.requestIds), "activity result conflicts with original causal consumption");
        if (!prior) emit({ kind: "tool.result", result: { key, runId: r.id, requestIds: a.requestIds, source: full, digest: intent.toolRef.digest, through: a.through } });
        settleInvocation(full, true);
        apply({ type: "output", id: `${command.id}:result`, actor: "$system", author: cap.seatId,
          sourceKey: JSON.stringify(["activity-result", receiptKey]), association: { kind: "activity", id: a.id },
          body: intent.body, disposition: intent.disposition, activityCompletion: intent.completion, terminal: false });
      }
      const claims = events.flatMap((e) => e.data.kind === "output" ? e.data.claims : []);
      const responseJSON = canonicalJSON({ schema: intent.schema === "backroom.activity.v2" ? "backroom.activity-result.v2" : "backroom.activity-result.v1",
        recorded: true, activityId: intent.activityId, claims,
        ...(intent.schema === "backroom.activity.v2" ? { provenance: "member_declared", receiptKey, operation: intent.operation } : {}) });
      requireThat(Buffer.byteLength(responseJSON) < 8192, "finite activity response required");
      emit({ kind: "activity.operation_receipt", receipt: { key: receiptKey, capabilityId: cap.id, intentJSON: packet.intentJSON, packet, responseJSON,
        ...(intent.schema === "backroom.activity.v2" ? { provenance: "member_declared" as const } : {}) } });
      for (const source of [packet.source, ...(packet.aliases ?? []).filter((s) => sourceKey(s) !== sourceKey(packet.source))]) {
        validateOperationSource(initial, cap, intent, source); checkpoint(source);
        emit({ kind: "board.operation_binding", binding: { key: sourceKey(source), receiptKey, receiptKind: "activity", source, confirmed: false } });
        settleInvocation(source, false);
      }
      break;
    }
    case "source_conflict": {
      system(); const r = run(command.runId);
      requireThat(r.seatId === command.seatId && command.code.length > 0, "conflict exact run scope required");
      emit({ kind: "provider.conflict", seatId: r.seatId, runId: r.id, source: command.source, code: command.code });
      const hold = { key: JSON.stringify([r.seatId, r.id, command.code]), seatId: r.seatId, runId: r.id,
        code: command.code, detail: "Changed native source retained; immutable result/delivery conflict requires reconciliation.",
        held: true, scope: command.code.startsWith("own_response_conflict:") ? "reseat" as const : "work" as const,
        requestIds: command.code.startsWith("own_response_conflict:") ? [] : initial.providerHolds.get(JSON.stringify([r.seatId, r.id, command.code]))?.requestIds
          ?? (command.code.startsWith("recorded_result_conflict:") ? [...initial.toolResults.values(), ...initial.toolClosures.values()].find((t) => t.runId === r.id
            && t.source.itemId === command.source.itemId)?.requestIds : undefined)
          ?? [...initial.activities.values()].find((a) => command.code === `declared_source_conflict:${a.id}`)?.declaration?.registration.requestIds
          ?? (command.code.startsWith("native_source_conflict:") ? [...initial.providerHolds.values()].find((h) => h.runId === r.id
            && [command.source.itemId, command.source.nodeId].some((id) => id !== null && h.code === `native_activity:${id}`))?.requestIds : undefined)
          ?? resumableIds(initial, r) };
      emit({ kind: "provider.hold", hold }); break;
    }
    case "bind_operation": {
      system(); const receipt = localReceipts(initial).find((r) => r.key === command.receiptKey);
      requireThat(receipt, "local receipt required");
      const cap = initial.capabilities.get(receipt.capabilityId)!;
      validateOperationSource(initial, cap, receipt.packet.intent, command.source);
      validateSourceCheckpoint(initial, cap, command.source);
      if (command.confirmed) requireThat(Object.hasOwn(command.source, "output")
        && canonicalJSON(command.source.output) === receipt.responseJSON, "exact original local response required");
      const key = sourceKey(command.source), prior = initial.operationBindings.get(key);
      requireThat(!prior || prior.receiptKey === receipt.key && sourceIdentity(prior.source) === sourceIdentity(command.source), "own source binding conflict");
      const binding: OperationBinding = { key, receiptKey: receipt.key, source: command.source, confirmed: command.confirmed || prior?.confirmed === true,
        ...(initial.activityReceipts.has(receipt.key) ? { receiptKind: "activity" as const } : {}) };
      if (canonicalJSON(prior ?? null) === canonicalJSON(binding)) return result("duplicate");
      emit({ kind: "board.operation_binding", binding });
      settleInvocation(command.source, command.confirmed); break;
    }
    case "local_operation": {
      system(); const packet = command.packet;
      const cap = validateOperationPacket(initial, packet), r = run(cap.runId);
      const receiptKey = operationKey(cap.id, packet.intent.clientId);
      requireThat(!initial.operationReceipts.has(receiptKey), "operation already committed; recover raw intent receipt");
      for (const source of [packet.source, ...(packet.aliases ?? []).filter((s) => sourceKey(s) !== sourceKey(packet.source))]) {
        emit({ kind: "board.operation_binding", binding: { key: sourceKey(source), receiptKey, source, confirmed: false } });
        settleInvocation(source, false);
      }
      for (const { ref, source } of packet.tools) {
        const key = sourceKey(source), digest = resultDigest(source), prior = view().toolResults.get(key);
        requireThat(digest === ref.digest && (!prior || prior.digest === digest
          && sameIds(prior.requestIds, ref.requestIds)), "immutable source result/association conflict");
        if (!prior) emit({ kind: "tool.result", result: { key, runId: r.id, requestIds: ref.requestIds, source, digest, through: r.through } });
        settleInvocation(source, true);
      }
      let claims: OperationReceipt["result"]["claims"] = [];
      if (packet.intent.operation === "finish") {
        const effect = decideProjection(transaction, { id: `${command.id}:finish`, actor: "$system", type: "output",
          author: r.seatId, sourceKey: JSON.stringify(["local-finish", receiptKey]), association: cap.activityId ? { kind: "activity", id: cap.activityId } : { kind: "run", id: r.id },
          body: packet.intent.body, disposition: packet.intent.disposition, terminal: false }, emit);
        for (const e of effect.events) if (e.data.kind === "output") claims = e.data.claims;
      }
      const inner = { recorded: true as const, operation: packet.intent.operation, tools: packet.tools.map((t) => t.ref.itemId), claims, view: packet.view, ...(packet.activities ? { activities: packet.activities } : {}) };
      const intentDigest = hash(packet.intentJSON), resultHash = hash(canonicalJSON(inner));
      const responseJSON = canonicalJSON({ schema: "backroom.operation-result.v1", result: inner,
        receipt: { clientId: packet.intent.clientId, intentDigest, resultDigest: resultHash } });
      requireThat(Buffer.byteLength(responseJSON) < 8192, "local response exceeds finite result bound");
      const receipt: OperationReceipt = { key: receiptKey, capabilityId: cap.id, seatId: cap.seatId, threadId: cap.threadId,
        runId: cap.runId, generation: cap.generation, clientId: packet.intent.clientId, intentJSON: packet.intentJSON,
        intentDigest, packet, result: inner, resultDigest: resultHash, responseJSON };
      emit({ kind: "board.operation_receipt", receipt }); break;
    }
    case "freeze_transport": {
      system();
      const t = command.target.kind === "run" ? run(command.target.id) : initial.controls.get(command.target.id);
      requireThat(t && !t.transport, "transport target missing or already frozen");
      const r = command.target.kind === "run" ? run(command.target.id) : run((t as Control).runId);
      const wire = JSON.parse(command.transport.wireJSON) as Record<string, unknown>;
      requireThat(command.transport.digest === createHash("sha256").update(command.transport.wireJSON).digest("hex"), "frozen wire digest mismatch");
      requireThat(wire.threadId === seat(r.seatId).threadId && wire.commandId === (command.target.kind === "run" ? r.dispatchCommandId : (t as Control).commandId), "frozen wire identity mismatch");
      if (command.target.kind === "run") {
        requireThat(wire.type === "message.dispatch" && wire.messageId === r.dispatchMessageId
          && (wire.dispatchMode as { type?: string })?.type === "start_immediately", "only frozen same-ID start dispatch is supported");
        requireThat(typeof wire.text === "string", "frozen input text required");
        requireThat(Array.isArray(wire.attachments) && wire.attachments.length === 0, "reserved textual dispatch forbids mutable attachments");
        const input = JSON.parse(wire.text) as { schema?: string; runId?: string; envelope?: unknown };
        requireThat(input.schema === "backroom.envelope.v1" && input.runId === r.id
          && JSON.stringify(input.envelope) === JSON.stringify(r.envelope), "wire must include the exact complete reserved envelope");
      } else {
        const c = t as Control;
        requireThat(c.kind === "interrupt" ? wire.type === "run.interrupt" && wire.runId === r.providerRunId
          : wire.type === "runtime-request.respond" && wire.requestId === request(c.requestId).live?.providerRequestId, "frozen control identity mismatch");
        if (c.kind === "runtime_reply") {
          const response = JSON.parse(c.body) as { answers?: unknown; decision?: unknown };
          requireThat(JSON.stringify(wire.answers) === JSON.stringify(response.answers)
            && JSON.stringify(wire.decision) === JSON.stringify(response.decision), "wire response must preserve the original live answer");
        }
      }
      requireThat(command.transport.environmentId.length > 0 && command.transport.serverVersion.length > 0 && command.transport.contract.length > 0, "transport contract identity required");
      if (command.transport.dispatchPolicy) requireThat(command.target.kind === "run"
        && command.transport.dispatchPolicy.kind === "t3-reserved-start-immediately-v1" && command.transport.dispatchPolicy.maxPackets === 2
        && command.transport.dispatchPolicy.sourceCommit === T3_SOURCE_COMMIT && command.transport.serverVersion === T3_SERVER_VERSION
        && command.transport.contract === T3_CONTRACT_ID, "reserved dispatch policy requires exact pinned source/version");
      emit({ kind: "transport.frozen", target: command.target, transport: { ...command.transport, attempts: 0 } });
      break;
    }
    case "transport_attempt": {
      system();
      const t = command.target.kind === "run" ? run(command.target.id) : initial.controls.get(command.target.id);
      requireThat(t?.transport && t.transport.attempts === command.expectedAttempts && command.evidence.length > 0, "attempt must compare the frozen transport and carry provider evidence");
      if (command.target.kind === "run") {
        const r = run(command.target.id);
        if (r.transport!.dispatchPolicy) {
          const t = r.transport!, o = initial.providerObservations.get(r.seatId);
          requireThat(t.dispatchPolicy!.sourceCommit === T3_SOURCE_COMMIT && t.dispatchPolicy!.maxPackets === 2
            && t.serverVersion === T3_SERVER_VERSION && t.contract === T3_CONTRACT_ID && t.attempts < 2
            && o && o.environmentId === t.environmentId && o.serverVersion === t.serverVersion && o.contract === t.contract
            && ![...initial.providerHolds.values()].some((h) => h.held && h.seatId === r.seatId
              && (h.code === "history" || h.code === "origin" || h.code === "snapshot_order" || h.code.includes("contract") || h.code === "binding")),
          "pinned reserved dispatch origin/history/bound required");
        } else requireThat(!initial.providerObservations.get(r.seatId)?.pending.length
          && ![...initial.providerHolds.values()].some((h) => h.seatId === r.seatId && h.held && h.code === "native_pending"),
          "known native work prevents run transport attempt");
      }
      requireThat(!["terminal", "rejected", "accepted", "running", "obsolete"].includes(t.phase), "resolved transport cannot be resent");
      emit({ kind: "transport.attempt", target: command.target, attempt: command.expectedAttempts + 1, evidence: command.evidence });
      if (t.phase !== "sending") {
        if (command.target.kind === "run") emit({ kind: "run.phase", runId: command.target.id, phase: "sending", evidence: command.evidence });
        else emit({ kind: "control.phase", controlId: command.target.id, phase: "sending", evidence: command.evidence });
      }
      break;
    }
    case "bind_provider": {
      system();
      const r = run(command.runId);
      requireThat(command.providerRunId.length > 0 && command.evidence.length > 0, "provider binding evidence required");
      requireThat(!r.providerRunId || r.providerRunId === command.providerRunId, "provider binding changed");
      requireThat(![...initial.runs.values()].some((other) => other.id !== r.id && other.providerRunId === command.providerRunId), "provider run already bound to another local run");
      if (r.providerRunId) return result("duplicate");
      emit({ kind: "provider.bound", runId: r.id, providerRunId: command.providerRunId, evidence: command.evidence });
      break;
    }
    case "provider_status": {
      system(); const r = run(command.runId);
      requireThat(r.providerRunId === command.providerRunId && initial.providerObservations.get(r.seatId)?.sequence === command.sequence
        && ["preparing", "queued", "starting", "running", "waiting", "completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(command.status),
      "native status requires exact bound source checkpoint");
      if (r.nativeStatus === command.status && (r.queueHeld ?? false) === command.queueHeld) return result("duplicate");
      emit({ kind: "provider.status", runId: r.id, providerRunId: command.providerRunId, status: command.status, queueHeld: command.queueHeld, sequence: command.sequence }); break;
    }
    case "provider_hold": {
      system();
      const h = command.hold;
      seat(h.seatId);
      requireThat(h.key.length > 0 && h.code.length > 0 && h.detail.length > 0 && (h.runId === null || run(h.runId).seatId === h.seatId), "provider hold requires exact scope and evidence");
      const prior = initial.providerHolds.get(h.key);
      requireThat(!h.requestIds || sameIds(h.requestIds, unique(h.requestIds)) && h.requestIds.every((id) => initial.requests.has(id)), "hold causal requests must be explicit known immutable identities");
      requireThat(!prior?.requestIds || h.scope === prior.scope && h.requestIds && sameIds(h.requestIds, prior.requestIds), "hold scope and causal set cannot drift");
      if (JSON.stringify(initial.providerHolds.get(h.key)) === JSON.stringify(h)) return result("duplicate");
      emit({ kind: "provider.hold", hold: h });
      break;
    }
    case "observe_provider": {
      system();
      const o = command.observation, s = seat(o.seatId), prior = initial.providerObservations.get(o.seatId);
      requireThat(o.threadId === s.threadId && o.environmentId.length > 0 && o.serverVersion.length > 0
        && o.contract.length > 0 && Number.isSafeInteger(o.sequence) && o.sequence >= 0, "provider observation requires exact origin/thread/sequence");
      requireThat(!prior || prior.threadId === o.threadId && prior.environmentId === o.environmentId
        && prior.serverVersion === o.serverVersion && prior.contract === o.contract && o.sequence >= prior.sequence,
        "provider observation origin changed or sequence regressed");
      const transports = [...initial.runs.values()].filter((r) => r.seatId === s.id).map((r) => r.transport)
        .concat([...initial.controls.values()].filter((c) => run(c.runId).seatId === s.id).map((c) => c.transport));
      requireThat(transports.every((t) => !t || t.environmentId === o.environmentId && t.serverVersion === o.serverVersion
        && t.contract === o.contract), "provider observation differs from frozen transport origin");
      requireThat([...command.pending, ...command.settled].every((key) => key.length > 0)
        && !command.pending.some((key) => command.settled.includes(key)), "native work evidence conflicts");
      const pending = unique([...(prior?.pending ?? []), ...command.pending]).filter((key) => !command.settled.includes(key)).sort();
      const observation = { ...o, pending };
      if (JSON.stringify(prior) !== JSON.stringify(observation)) emit({ kind: "provider.observed", observation });
      const hold = { key: JSON.stringify([o.seatId, null, "native_pending"]), seatId: o.seatId, runId: null,
        scope: "reseat" as const, requestIds: [],
        code: "native_pending", detail: pending.length ? `Known native work remains: ${pending.join(", ")}.`
          : "Resolved known native work by exact terminal/root association evidence.", held: pending.length > 0 };
      const oldHold = initial.providerHolds.get(hold.key);
      if ((oldHold || hold.held) && JSON.stringify(oldHold) !== JSON.stringify(hold)) emit({ kind: "provider.hold", hold });
      if (!events.length) return result("duplicate");
      break;
    }
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
        const fresh = inputTree(deliveredInputs(initial, r.id)).filter((i) => !["error", "attention", "progress", "cancel"].includes(i.intent));
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
      actor();
      if (command.to !== "$user") seat(command.to);
      requireThat(command.to !== command.actor, "own request cannot create a wake");
      const parent = command.parentId ? request(command.parentId) : null;
      if (parent) requireThat(command.actor === "$user" || command.actor === parent.owner || command.actor === parent.returnTo || command.actor === initial.orchestrator, "unrelated causal parent");
      if (command.live) {
        const r = run(command.live.runId);
        requireThat(r.seatId === command.actor && r.phase !== "terminal" && r.phase !== "rejected", "live question must bind author's current run");
        requireThat(command.live.providerRequestId.length > 0, "provider request identity required");
        requireThat(![...initial.requests.values()].some((q) => q.live?.runId === r.id && q.live.providerRequestId === command.live!.providerRequestId), "duplicate runtime question identity");
      }
      const recipients = [command.to];
      const id = emit({ kind: "request", author: command.actor, recipients, live: command.live ?? null, request: {
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
      const activeRunId = r.owner === "$user" ? null : seat(r.owner).activeRunId;
      if (applied && activeRunId && run(activeRunId).phase === "rejected") {
        const rejected = run(activeRunId);
        emit({ kind: "run.ended", runId: rejected.id, through: rejected.envelope.base, failure: "definite rejection; explicit cancel", consumed: false });
      } else if (applied && activeRunId && ![...initial.controls.values()].some((c) => c.runId === activeRunId && c.kind === "interrupt")) {
        emit({ kind: "control.prepared", recipients: [], control: { id: `${command.id}/interrupt`, runId: activeRunId, requestId: r.id,
          commandId: `interrupt:${command.id}`, kind: "interrupt", phase: "prepared", body: "Cancel request", author: command.actor } });
      }
      break;
    }
    case "user_answer": {
      requireThat(command.actor === "$user", "user answer requires authenticated user");
      const q = request(command.requestId);
      requireThat(q.owner === "$user" && q.state === "open" && !q.live, "unanswered message-mode user question required");
      const id = emit({ kind: "output", author: "$user", sourceKey: `user:${command.id}`, association: { kind: "user" },
        disposition: { kind: "answer", requestIds: [q.id] }, body: command.body,
        claims: [{ requestId: q.id, outcome: "answered", returnTo: q.returnTo }], recipients: [q.returnTo] });
      undeliverable([q.returnTo], id, [q.id], "$user");
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
      requireThat(![...initial.providerHolds.values()].some((h) => h.held && h.seatId === s.id && h.scope !== "work" && h.scope !== "reseat"), "provider dispatch uncertainty prevents reservation");
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
      emit({ kind: "run.phase", runId: r.id, phase: command.phase, evidence: command.evidence });
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
      confirm(command.runId, command.receiptId, command.digest, command.evidence);
      if (!events.length) return result("duplicate");
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
      emit({ kind: "activity.started", activity: { id: command.activityId, seatId: r.seatId, runId: r.id, requestIds: command.requestIds, through: r.through, status: command.status,
        ...(command.generation === undefined ? {} : { generation: command.generation }), ...(command.nativeSource === undefined ? {} : { nativeSource: command.nativeSource }),
        ...(command.declaration === undefined ? {} : { declaration: command.declaration }) } });
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
    case "runtime_reply": {
      actor();
      const q = request(command.requestId);
      requireThat(q.owner === command.actor && q.live && q.state === "open", "authorized unanswered live question required");
      requireThat(!initial.controls.has(command.id), "fresh control identity required");
      requireThat(command.commandId.length > 0 && ![...initial.controls.values()].some((c) => c.commandId === command.commandId), "fresh stable control command required");
      const r = run(q.live.runId);
      emit({ kind: "control.prepared", recipients: [], control: { id: command.id, commandId: command.commandId,
        kind: "runtime_reply", runId: r.id, requestId: q.id, body: command.body, author: command.actor,
        phase: r.phase === "terminal" ? "uncertain" : "prepared" } });
      break;
    }
    case "control_phase": {
      system();
      const c = initial.controls.get(command.controlId);
      requireThat(c && command.evidence.length > 0, "control and receipt/runtime evidence required");
      const allowed: Record<string, string[]> = { prepared: ["sending", "uncertain", "accepted", "obsolete"], sending: ["uncertain", "accepted", "obsolete"], uncertain: ["accepted", "obsolete"], accepted: [], obsolete: [] };
      requireThat(allowed[c.phase]!.includes(command.phase), "invalid control transition; unknown receipt cannot be blindly resent");
      emit({ kind: "control.phase", controlId: c.id, phase: command.phase, evidence: command.evidence });
      if (command.phase === "accepted") {
        const r = run(c.runId), key = JSON.stringify([r.seatId, r.id, `control_effect:${c.id}`]), causal: string[] = [];
        let q: Request | undefined = request(c.requestId);
        while (q) { causal.push(q.id); q = q.parentId ? initial.requests.get(q.parentId) : undefined; }
        emit({ kind: "provider.hold", hold: { key, seatId: r.seatId, runId: r.id, code: `control_effect:${c.id}`,
          detail: "App acceptance does not establish native runtime effect completion.", held: true, scope: "work",
          requestIds: initial.providerHolds.get(key)?.requestIds ?? causal } });
      }
      if (command.phase === "obsolete" && c.kind === "runtime_reply") {
        const o = initial.orchestrator;
        notice("attention", `Live response not applied: ${c.body}`, [c.requestId], [c.author, ...(o ? [o] : [])], c.id, "$system");
      }
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
    case "transfer": {
      manager();
      actor();
      const s = seat(command.oldSeatId);
      requireThat(s.status === "active" && s.activeRunId === null, "old run must be reconciled and stopped");
      requireThat(command.evidence.length > 0, "provider quiescence proof reference required");
      requireThat(![...initial.providerHolds.values()].some((h) => h.held && h.seatId === s.id), "provider uncertainty prevents transfer");
      requireThat(![...initial.activities.values()].some((a) => a.seatId === s.id && unresolved(a.status)), "known background work prevents transfer");
      requireThat(![...initial.controls.values()].some((c) => run(c.runId).seatId === s.id && c.phase !== "obsolete"
        && (c.phase !== "accepted" || initial.providerHolds.get(JSON.stringify([s.id, c.runId, `control_effect:${c.id}`]))?.held !== false)), "unresolved runtime control prevents transfer");
      requireThat(command.newSeatId.length > 0 && !command.newSeatId.startsWith("$") && !initial.seats.has(command.newSeatId), "fresh immutable seat ID required");
      requireThat(command.threadId.length > 0 && ![...initial.seats.values()].some((x) => x.threadId === command.threadId), "fresh provider thread required");
      const owned = [...initial.requests.values()].filter((r) => r.owner === s.id && r.state === "open").map((r) => r.id);
      const awaited = [...initial.requests.values()].filter((r) => r.returnTo === s.id && r.state === "open").map((r) => r.id);
      requireThat(sameIds(command.owned, owned) && sameIds(command.awaited, awaited), "transfer must name exact open owned/awaited requests");
      emit({ kind: "transfer", oldSeatId: s.id, newSeatId: command.newSeatId, threadId: command.threadId, cutoff: log.length,
        owned, awaited, inherited: unread(initial, s.id), author: command.actor, recipients: [command.newSeatId], body: command.body, evidence: command.evidence });
      break;
    }
    case "output": {
      requireThat(command.actor === "$system" || command.actor === command.author, "output author mismatch");
      requireThat(command.sourceKey.length > 0, "source emission identity required");
      requireThat(command.association.kind !== "user", "use authenticated user_answer intent");
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
            for (const receipt of command.receipts ?? []) confirm(r.id, receipt.id, receipt.digest, "terminal observation echoed exact sync receipt");
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
      for (const receipt of command.receipts ?? []) confirm(r.id, receipt.id, receipt.digest, "finish echoed exact sync receipt");
      if (a && command.activityCompletion) {
        requireThat(unresolved(a.status), "activity already resolved");
        emit({ kind: "activity.status", activityId: a.id, status: command.activityCompletion, evidence: `explicit ${a.declaration ? "member-declared" : "correlated"} activity completion ${command.sourceKey}`,
          ...(a.declaration ? { provenance: "member_declared" as const } : {}) });
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
      if (disposition.kind === "answer") for (const id of selected) {
        const q = request(id, p);
        requireThat(!q.live, "live question needs runtime_reply control");
        const outcome = q.owner !== r.seatId || seat(r.seatId, p).status === "retired" || q.state === "cancelled" ? "late"
          : q.state === "answered" ? "already_answered" : q.version > through ? "superseded"
          : pendingWork(p, id, r.id) ? "pending_activity" : "answered";
        claims.push({ requestId: id, outcome, returnTo: q.returnTo });
      }
      const progressIds = selected.filter((id) => request(id, p).owner === r.seatId && seat(r.seatId, p).status !== "retired");
      const recipients = disposition.kind === "progress" ? progressRecipients(p, command.author, progressIds, disposition.milestone)
        : unique(claims.filter((c) => c.outcome === "answered").map((c) => c.returnTo));
      const outputId = emit({ kind: "output", author: command.author, sourceKey: command.sourceKey, association: command.association, disposition, body: command.body, claims, recipients });
      undeliverable(recipients, outputId, claims.map((c) => c.requestId), command.author);
      if (claims.some((c) => c.outcome === "late")) attention("Late output retained; cancelled/transferred generation cannot claim completion", outputId, claims.filter((c) => c.outcome === "late").map((c) => c.requestId), command.author);
      if (disposition.kind === "error") {
        const fresh = inputTree(deliveredInputs(p, r.id)).filter((i) => !["error", "attention", "progress", "cancel"].includes(i.intent));
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
  }
  // emit has already applied and validated each event exactly once.
  return result();
}

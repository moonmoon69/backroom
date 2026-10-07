import type { Activity, Projection } from "./types.ts";
import type { ActivityV2Intent, DeclaredBinding, DeclaredRegistration, DeclaredResult, NativeHandle, RunCapability } from "./operation-types.ts";
import type { NativeToolSource } from "./provider.ts";
import { canonicalJSON, sourceContradiction, sourceIdentity, toolClosure } from "./result.ts";
import { originalNativeSourceMatches, validateOriginalNativeSource } from "./operations.ts";

export const declarationLimits = ["member_declared_intent_not_provider_certified_launch", "physical_result_truth_unverified",
  "exactly_once_external_effects_unverified", "unreported_external_work_unverified"];
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function handleOwnershipKey(registration: Pick<DeclaredRegistration, "environmentId" | "providerThreadId">, handle: NativeHandle): string {
  return canonicalJSON([registration.environmentId, registration.providerThreadId, handle.namespace, handle.value]);
}
export function originalDeclarationOwner(a: Activity, cap: RunCapability, intent: ActivityV2Intent): DeclaredRegistration {
  const reg = a.declaration?.registration;
  requireThat(reg && reg.runId === cap.runId && reg.seatId === cap.seatId && reg.threadId === cap.threadId
    && reg.environmentId === cap.environmentId && intent.activityGeneration === reg.generation
    && (cap.activityId === a.id && !!cap.nativeRunId || !cap.activityId && !cap.nativeRunId && cap.generation === reg.generation),
  "original declared activity owner or explicit original continuation required");
  return reg;
}
export function observedHandleSources(p: Projection, value: string): NativeToolSource[] {
  return p.events.flatMap((e) => e.data.kind === "provider.observed" ? e.data.observation.sources ?? [] : [])
    .filter((s) => s.nativeRef?.nativeId === value);
}
/** All rooms share environment/native-thread history. Freeze each foreign journal
 * prefix at registration rather than compare event numbers across rooms or infer
 * launch time from a native sequence. No observation supplies a logical binding. */
export function validateScopedHandleHistory(p: Projection, reg: DeclaredRegistration, handle: NativeHandle,
  original: NativeToolSource | null, room: string, originalRoom: string,
  results: readonly DeclaredClaim[], outcomes: OutcomeScope): void {
  // Validate revisions against their chronological first origin/item/complete,
  // not the restored latest source or a future complete record applied backwards.
  const evidence: Parameters<typeof originalNativeSourceMatches>[0] = { origin: undefined, item: undefined, complete: undefined };
  // Terminal outcomes are immutable too: a later restored success cannot erase a
  // retained failure, and an earlier settlement does not excuse a new claim.
  const terminal: TerminalOutcome = { item: null, node: null };
  const environments = new Map<string, { environmentId: string; threadId: string }>();
  const related = relatedSource(reg, handle, original);
  for (const event of p.events) {
    if (event.data.kind === "provider.conflict") {
      const conflict = event.data, scope = environments.get(conflict.seatId);
      requireThat(!(scope?.environmentId === reg.environmentId && scope.threadId === conflict.source.threadId && related(conflict.source)),
        "retained native source conflict prevents new declaration claims");
      continue;
    }
    if (event.data.kind !== "provider.observed") continue;
    const observation = event.data.observation;
    environments.set(observation.seatId, observation);
    if (observation.environmentId !== reg.environmentId) continue;
    const historyHead = reg.sourceHistoryHeads && Object.hasOwn(reg.sourceHistoryHeads, room) ? reg.sourceHistoryHeads[room]! : 0;
    const knownBefore = room === originalRoom ? event.seq <= reg.registeredAt
      : event.seq <= historyHead || observation.sequence <= reg.sourceSequenceFloor;
    if (handle.namespace === "task" && knownBefore
      && observation.pending.includes(`background:${reg.providerThreadId}:${handle.value}`))
      throw new Error("native task already known in registered environment/provider-thread before registration");
    for (const source of (observation.sources ?? []).filter(related)) {
      requireThat(handle.namespace === "provider_item", "process/task namespace cannot reinterpret a known native item handle");
      requireThat(!knownBefore, "native reference already known before registered checkpoint");
      requireThat(original && source.threadId === reg.threadId && source.providerThreadId === reg.providerThreadId
        && source.providerRunId === reg.providerRunId && source.generation === reg.generation,
      "known native reference belongs to another original run/thread/generation");
      requireThat(!sourceContradiction(source), "retained native source contradiction prevents new declaration claims");
      evidence.origin ??= source;
      if (source.itemId !== null) {
        evidence.item ??= source;
        if (source.complete) evidence.complete ??= source;
      }
      requireThat(originalNativeSourceMatches(evidence, source) && originalNativeSourceMatches(evidence, original),
        "native invocation differs from its first authoritative origin or established item");
      const outcome = terminalOutcome(source);
      for (const part of source.itemId === null ? ["node"] as const : ["item", "node"] as const) {
        requireThat(terminal[part] === null || outcome[part] === terminal[part],
          "native invocation outcome changed or reopened after its first terminal observation");
        terminal[part] = outcome[part];
        if (outcome[part] === null) continue;
        outcomes[part].add(outcome[part]);
        requireThat(outcomes[part].size === 1, "retained native outcome contradicts another terminal outcome in its scope");
      }
      requireThat(!failed(outcome) || results.every((r) => r.completion === "failed"), "retained native outcome failed; it cannot be declared done");
    }
  }
}
type DeclaredClaim = Pick<DeclaredResult, "completion" | "originalSource">;
function relatedSource(reg: DeclaredRegistration, handle: NativeHandle, original: NativeToolSource | null) {
  return (source: NativeToolSource) => (source.providerThreadId === reg.providerThreadId
    || source.nodeEvidence?.providerThreadId === reg.providerThreadId) && (source.nativeRef?.nativeId === handle.value
    || handle.namespace === "provider_item" && !!original && source.threadId === original.threadId
      && (source.itemId !== null && source.itemId === original.itemId || source.nodeId !== null && source.nodeId === original.nodeId));
}
/** Terminal values one native invocation has across its environment/provider-thread
 * scope, whichever room retained them. Rooms read the same item at different times,
 * so values are compared without order: a scope keeps at most one per part. */
export interface OutcomeScope { item: Set<string>; node: Set<string> }
/** Seeds the scope with the declared originals and the original room's own retained
 * observations. They are checked only when a foreign room adds a terminal value, so
 * conflicts confined to the original room keep their local pending_activity receipts. */
export function outcomeScope(own: Projection, reg: DeclaredRegistration, handle: NativeHandle,
  original: NativeToolSource | null, results: readonly DeclaredClaim[]): OutcomeScope {
  const scope: OutcomeScope = { item: new Set(), node: new Set() }, related = relatedSource(reg, handle, original);
  const observed = own.events.flatMap((e) => e.data.kind === "provider.observed" && e.data.observation.environmentId === reg.environmentId
    ? (e.data.observation.sources ?? []).filter((s) => related(s) && s.providerRunId === reg.providerRunId && s.generation === reg.generation) : []);
  for (const source of [original, ...results.map((r) => r.originalSource), ...observed]) if (source) {
    const outcome = terminalOutcome(source);
    for (const part of ["item", "node"] as const) if (outcome[part] !== null) scope[part].add(outcome[part]);
  }
  return scope;
}
interface TerminalOutcome { item: string | null; node: string | null }
const ended = (status: string | undefined) => status !== undefined && ["completed", "failed", "cancelled", "interrupted"].includes(status) ? status : null;
/** Item status and exit code, and node status, once each is terminal. */
function terminalOutcome(s: NativeToolSource): TerminalOutcome {
  return { item: s.itemId !== null && ended(s.status) ? canonicalJSON([s.status, s.exitCode ?? null]) : null,
    node: ended(s.itemId === null ? s.status : s.nodeStatus) };
}
const failed = (o: TerminalOutcome) => o.item !== null && o.item !== canonicalJSON(["completed", 0]) && o.item !== canonicalJSON(["completed", null])
  || o.node !== null && o.node !== "completed";
/** Checks the original source independently of the member's physical-launch promise. */
export function validateDeclaredSource(p: Projection, reg: DeclaredRegistration, source: NativeToolSource): void {
  validateOriginalNativeSource(p, source);
  const recorded = [...p.toolClosures.values(), ...p.toolResults.values()].find((r) => r.runId === reg.runId
    && (r.source.itemId === source.itemId || r.source.nodeId === source.nodeId));
  requireThat(!recorded || recorded.source.status === source.status && recorded.source.nodeStatus === source.nodeStatus
    && recorded.source.exitCode === source.exitCode && (!Object.hasOwn(recorded.source, "output")
      || Object.hasOwn(source, "output") && canonicalJSON(recorded.source.output) === canonicalJSON(source.output)),
  "declared reference conflicts with retained original native outcome/body");
  requireThat(!p.events.some((e) => e.data.kind === "provider.conflict" && e.data.runId === reg.runId
    && (e.data.source.itemId === source.itemId || e.data.source.nodeId === source.nodeId)),
    "known native source contradiction prevents new declaration claims");
  requireThat(source.threadId === reg.threadId && source.providerThreadId === reg.providerThreadId
    && source.providerRunId === reg.providerRunId && source.generation === reg.generation && source.itemId && source.nodeId
    && source.attemptId && source.rootNodeId && source.providerTurnId && source.nativeRef?.strength === "strong"
    && source.nativeRef.driver === "codex" && (source.complete || !!toolClosure(source)) && !sourceContradiction(source),
  "available native reference must preserve original registration origin");
  const first = p.events.find((e) => e.data.kind === "provider.observed" && (e.data.observation.sources ?? []).some((s) =>
    s.threadId === reg.threadId && (s.itemId !== null && s.itemId === source.itemId || s.nodeId !== null && s.nodeId === source.nodeId)));
  requireThat(first && first.seq > reg.registeredAt, "native source known before registration");
}
export function declarationBinding(p: Projection, a: Activity, cap: RunCapability,
  intent: Extract<ActivityV2Intent, { operation: "bind_activity" }>, source: NativeToolSource | null, receiptKey: string): DeclaredBinding {
  const reg = originalDeclarationOwner(a, cap, intent);
  requireThat(!a.declaration!.binding && !a.declaration!.result && intent.registrationReceiptKey === reg.registrationReceiptKey,
    "one immutable original registration binding required");
  if (intent.nativeHandle.namespace === "task") requireThat(!p.events.some((e) => e.seq <= reg.registeredAt
    && e.data.kind === "provider.observed" && e.data.observation.environmentId === reg.environmentId
    && e.data.observation.pending.includes(`background:${reg.providerThreadId}:${intent.nativeHandle.value}`)),
    "native task was already known before registration");
  const observed = observedHandleSources(p, intent.nativeHandle.value).filter((s) => s.providerThreadId === reg.providerThreadId);
  if (intent.nativeHandle.namespace === "provider_item") {
    requireThat(source && intent.originalSourceRef?.itemId === source.itemId
      && source.nativeRef?.nativeId === intent.nativeHandle.value, "provider_item must equal its actual strong native reference");
  } else {
    requireThat(observed.length === 0, "process/task namespace cannot reinterpret a known native item handle");
  }
  requireThat((source === null) === (intent.originalSourceRef === null), "retain the supplied original source reference");
  if (source) validateDeclaredSource(p, reg, source);
  const key = handleOwnershipKey(reg, intent.nativeHandle);
  requireThat(![...p.activities.values()].some((other) => other.declaration?.binding?.ownershipKey === key),
    "native handle ownership tombstone already exists");
  return { provenance: "member_declared", bindingReceiptKey: receiptKey, ownershipKey: key, nativeHandle: intent.nativeHandle,
    originalSource: source, availability: source ? "reference_available" : "reference_unavailable",
    correlation: intent.nativeHandle.namespace === "provider_item" ? "strong_native_reference" : source ? "supporting_context_only" : "unverified",
    limitations: [...declarationLimits, ...(intent.nativeHandle.namespace === "provider_item" ? [] : ["native_handle_to_item_correlation_unverified"])] };
}
/** A newly visible contradiction holds affected claims while retaining historical declarations. */
export function declarationContradictions(p: Projection, a: Activity, sources: readonly NativeToolSource[]): NativeToolSource[] {
  const d = a.declaration;
  if (!d?.binding) return [];
  return sources.filter((s) => {
    const bound = d.binding!.originalSource;
    const related = bound ? s.itemId === bound.itemId || s.nodeId === bound.nodeId : s.nativeRef?.nativeId === d.binding!.nativeHandle.value;
    if (!related || s.providerThreadId !== d.registration.providerThreadId) return false;
    if (!bound) return true; // An opaque declaration never certified a native item relationship.
    return sourceContradiction(s) || s.providerRunId !== d.registration.providerRunId || s.generation !== d.registration.generation
      || !sourceIdentityCompatible(p, bound, s) || !!d.result?.originalSource &&
      (s.status !== d.result.originalSource.status || s.exitCode !== d.result.originalSource.exitCode);
  });
}
function sourceIdentityCompatible(p: Projection, original: NativeToolSource, source: NativeToolSource): boolean {
  try { validateOriginalNativeSource(p, source); return sourceIdentity(original) === sourceIdentity(source); } catch { return false; }
}

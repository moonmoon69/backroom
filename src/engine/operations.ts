import { z } from "zod";
import { nativeEvidence } from "./incremental.ts";
import { dispositionSchema, hash } from "./provider.ts";
import type { NativeToolSource } from "./provider.ts";
import type { ActivityIntent, LocalOperationPacket, OperationIntent, RunCapability } from "./operation-types.ts";
import type { Projection } from "./types.ts";
import { canonicalJSON, resultDigest, sourceIdentity, sourceKey } from "./result.ts";
import { deliveredInputs, inputTree } from "./delivery.ts";

const id = z.string().min(1).max(256);
const requestIds = z.array(id).min(1).max(32).refine((ids) => new Set(ids).size === ids.length);
const toolRef = z.object({ itemId: id, digest: z.string().regex(/^[a-f0-9]{64}$/), requestIds }).strict();
const base = { schema: z.literal("backroom.operation.v1"), clientId: id, nonce: id, originRunId: id };
export const operationSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("own_run_view"), offset: z.number().int().nonnegative().optional() }).strict(),
  z.object({ ...base, operation: z.literal("consume_tool_result"), toolRefs: z.array(toolRef).min(1).max(16) }).strict(),
  z.object({ ...base, operation: z.literal("finish"), toolRefs: z.array(toolRef).max(16).default([]), body: z.string().max(4096), disposition: dispositionSchema }).strict(),
]);
export function parseOperation(raw: unknown): OperationIntent { return operationSchema.parse(raw) as OperationIntent; }
const activityBase = { schema: z.literal("backroom.activity.v1"), clientId: id, nonce: id, originRunId: id, activityId: id,
  activityGeneration: z.number().int().positive().safe() };
export const activityV1Schema = z.discriminatedUnion("operation", [
  z.object({ ...activityBase, operation: z.literal("register_activity"), requestIds, nativeId: id.nullable() }).strict(),
  z.object({ ...activityBase, operation: z.literal("record_activity_result"), toolRef, body: z.string().max(4096),
    disposition: dispositionSchema, completion: z.enum(["done", "failed"]) }).strict(),
]);
const declaredBase = { ...activityBase, schema: z.literal("backroom.activity.v2"), provenance: z.literal("member_declared") };
const itemRef = z.object({ itemId: id }).strict().nullable();
export const activityV2Schema = z.discriminatedUnion("operation", [
  z.object({ ...declaredBase, operation: z.literal("register_activity"), requestIds, nativeId: z.null() }).strict(),
  z.object({ ...declaredBase, operation: z.literal("bind_activity"), registrationReceiptKey: z.string().min(1).max(1024),
    nativeHandle: z.object({ namespace: z.enum(["provider_item", "process", "task"]), value: id }).strict(), originalSourceRef: itemRef }).strict(),
  z.object({ ...declaredBase, operation: z.literal("record_activity_result"), bindingReceiptKey: z.string().min(1).max(1024),
    completion: z.enum(["done", "failed"]), body: z.string().max(4096), resultRef: itemRef,
    unavailableReason: z.string().min(1).max(1024).nullable() }).strict(),
]);
export const activitySchema = z.union([activityV1Schema, activityV2Schema]);
export function parseActivity(raw: unknown): ActivityIntent { return activitySchema.parse(raw) as ActivityIntent; }
export function operationKey(capabilityId: string, clientId: string): string { return JSON.stringify([capabilityId, clientId]); }
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
/** Node origin and later established item identity are separate immutable evidence. */
export function originalNativeEvidence(p: Projection, source: NativeToolSource): {
  origin: NativeToolSource | undefined; item: NativeToolSource | undefined; complete: NativeToolSource | undefined;
} {
  return nativeEvidence(p, source);
}
export function originalNativeSourceMatches(evidence: ReturnType<typeof originalNativeEvidence>, source: NativeToolSource): boolean {
  const { origin: first, item, complete } = evidence;
  if (!first) return true;
  const origin = (s: NativeToolSource) => canonicalJSON([s.threadId, s.providerRunId, s.nodeId, s.rootNodeId,
    s.providerThreadId, s.providerTurnId, s.attemptId, s.generation, s.nativeRef, s.nodeEvidence ?? null]);
  return origin(first) === origin(source) && (source.itemId === null
    || (!item || item.type === source.type) && (!complete || sourceIdentity(complete) === sourceIdentity(source)));
}
/** First journaled origin AND established complete identity survive node-first arrival. */
export function validateOriginalNativeSource(p: Projection, source: NativeToolSource): void {
  requireThat(originalNativeSourceMatches(originalNativeEvidence(p, source), source), "native invocation differs from its first authoritative origin or established item");
}
export function validateCapability(p: Projection, cap: RunCapability): void {
  const seat = p.seats.get(cap.seatId), run = p.runs.get(cap.runId), t = run?.transport;
  requireThat(seat && seat.status !== "retired" && seat.threadId === cap.threadId && run?.seatId === cap.seatId
    && t && t.environmentId === cap.environmentId && t.serverVersion === cap.serverVersion && t.contract === cap.contract,
  "run capability fenced or wrong origin");
  if (cap.activityId) requireThat(p.activities.get(cap.activityId)?.runId === cap.runId, "continuation requires original registered activity");
}
export function validateOperationSource(p: Projection, cap: RunCapability, intent: OperationIntent | ActivityIntent, source: NativeToolSource): void {
  validateOriginalNativeSource(p, source);
  validateCurrentOperationSource(p, cap, intent, source);
}
/** Fresh native authentication precedes journal import; immutable history still gates every effect. */
export function validateCurrentOperationSource(p: Projection, cap: RunCapability, intent: OperationIntent | ActivityIntent, source: NativeToolSource): void {
  validateCapability(p, cap);
  const run = p.runs.get(cap.runId)!;
  requireThat(intent.originRunId === cap.runId && source.threadId === cap.threadId
    && source.providerRunId === (cap.nativeRunId ?? run.providerRunId) && source.generation === cap.generation && source.attemptId
    && source.rootNodeId && source.providerThreadId && source.providerTurnId && source.nodeId && source.itemId
    && source.nativeRef?.driver === "codex" && source.nativeRef.strength === "strong"
    && source.type === "dynamic_tool" && source.complete && source.issues.length === 0
    && ["running", "completed", "failed"].includes(source.status), "exact original native invocation/generation required");
  const provenance = source.toolSource as { kind?: unknown; key?: unknown } | null;
  requireThat(provenance?.kind === "integration" && provenance.key === `mcp:${cap.server.toLowerCase()}`
    && source.toolName === `${cap.server}.${intent.operation}` && Object.hasOwn(source, "input")
    && canonicalJSON(source.input) === canonicalJSON(intent), "configured MCP provenance and raw nonce/intent required");
}
export function validateSourceCheckpoint(p: Projection, cap: RunCapability, s: NativeToolSource): void {
  const o = p.providerObservations.get(cap.seatId);
  const matches = o?.sources?.filter((v) => v.itemId === s.itemId && v.providerRunId === s.providerRunId && v.generation === s.generation) ?? [];
  requireThat(o && o.threadId === cap.threadId && o.environmentId === cap.environmentId && o.serverVersion === cap.serverVersion
    && o.contract === cap.contract && matches.length === 1 && sourceIdentity(matches[0]!) === sourceIdentity(s)
    && matches[0]!.status === s.status && matches[0]!.updatedAt === s.updatedAt
    && matches[0]!.exitCode === s.exitCode && matches[0]!.nodeStatus === s.nodeStatus
    && s.sequence <= o.sequence, "source changed before serialized commit");
}
export function validateOperationPacket(p: Projection, packet: LocalOperationPacket): RunCapability {
  const cap = p.capabilities.get(packet.capabilityId);
  requireThat(cap && packet.intentJSON === canonicalJSON(parseOperation(packet.intent)), "authenticated canonical intent required");
  validateOperationSource(p, cap, packet.intent, packet.source);
  const o = p.providerObservations.get(cap.seatId);
  requireThat(o && o.sequence === packet.sequence && o.threadId === cap.threadId
    && o.environmentId === cap.environmentId && o.serverVersion === cap.serverVersion && o.contract === cap.contract,
  "source checkpoint changed before serialized commit");
  requireThat(packet.sourceCheckpointDigest === hash(canonicalJSON(o.sources ?? [])), "prior source coverage changed before serialized commit");
  const checkpoint = (s: NativeToolSource) => {
    const matches = o.sources?.filter((v) => v.itemId === s.itemId && v.providerRunId === s.providerRunId && v.generation === s.generation) ?? [];
    requireThat(matches.length === 1 && sourceIdentity(matches[0]!) === sourceIdentity(s)
      && matches[0]!.status === s.status && matches[0]!.updatedAt === s.updatedAt
      && matches[0]!.exitCode === s.exitCode && matches[0]!.nodeStatus === s.nodeStatus
      && s.sequence <= o.sequence, "source identity/outcome changed before commit");
  };
  checkpoint(packet.source);
  for (const alias of packet.aliases ?? []) { validateOperationSource(p, cap, packet.intent, alias); checkpoint(alias); }
  const r = p.runs.get(cap.runId)!;
  const exposed = new Set([...r.envelope.openRequests, ...r.receipts.filter((r) => r.confirmed).flatMap((r) => r.envelope.openRequests)].map((q) => q.id));
  for (const i of inputTree(deliveredInputs(p, r.id))) for (const id of i.requestIds) exposed.add(id);
  if (cap.activityId) for (const id of exposed) if (!p.activities.get(cap.activityId)!.requestIds.includes(id)) exposed.delete(id);
  const expected = packet.intent.operation === "own_run_view" ? [] : packet.intent.toolRefs;
  requireThat(packet.tools.length === expected.length && new Set(expected.map((t) => t.itemId)).size === expected.length, "exact distinct tool references required");
  for (const [index, item] of packet.tools.entries()) {
    validateOriginalNativeSource(p, item.source);
    requireThat(canonicalJSON(item.ref) === canonicalJSON(expected[index]) && item.source.itemId === item.ref.itemId
      && item.source.threadId === cap.threadId && item.source.providerRunId === (cap.nativeRunId ?? r.providerRunId)
      && item.source.generation === cap.generation && item.ref.digest === resultDigest(item.source)
      && item.ref.requestIds.every((id) => exposed.has(id)), "ordinary result must retain original exposed causal source");
    const closed = p.toolClosures.get(sourceKey(item.source));
    requireThat(!closed || closed.source.status === item.source.status && closed.source.exitCode === item.source.exitCode
      && (!Object.hasOwn(closed.source, "output") || Object.hasOwn(item.source, "output")
        && canonicalJSON(closed.source.output) === canonicalJSON(item.source.output)), "consumption conflicts with original closed evidence");
    checkpoint(item.source);
    requireThat(item.source.sequence === o.sequence, "ordinary result detail superseded before commit");
    requireThat(![...p.operationBindings.values()].some((b) => b.source.itemId === item.source.itemId
      && b.source.providerRunId === item.source.providerRunId), "closed local operation is already classified, never consume recursively");
  }
  return cap;
}

/** Normalize journaled local receipts without consuming their native response. */
export function localReceipts(p: Projection) {
  return [...p.operationReceipts.values(), ...[...p.activityReceipts.values()].map((r) => {
    const c = p.capabilities.get(r.capabilityId)!;
    return { ...r, seatId: c.seatId, threadId: c.threadId, runId: c.runId, generation: c.generation };
  })];
}

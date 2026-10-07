import { z } from "zod";
import { HttpT3Adapter } from "./http.ts";
import { T3CommandRejected } from "./types.ts";
import { T3_CONTRACT_ID, T3_SERVER_VERSION, T3_SOURCE_COMMIT, activeStatus, decodeOutput, hash, terminalStatus } from "../engine/provider.ts";
import type { CommandEvidence, NativeFileChange, NativePayloadAvailability, NativeToolSource, ProviderAdapter, ProviderContract, ProviderSnapshot } from "../engine/provider.ts";
import type { FrozenTransport, TransportTarget } from "../engine/types.ts";
import { canonicalJSON, exactAlias, fileChangeIdentity, losslessSmallValue, payloadFields } from "../engine/result.ts";

const row = z.object({ id: z.string().min(1) }).passthrough();
const snapshotSchema = z.object({
  snapshotSequence: z.number().int().nonnegative().safe(),
  hasMoreHistory: z.boolean().optional(), historyCursor: z.string().nullable().optional(),
  payloadBudgetExceeded: z.boolean().optional(),
  projection: z.object({
    thread: row, runs: z.array(row), attempts: z.array(row), nodes: z.array(row),
    subagents: z.array(row), providerThreads: z.array(row), providerTurns: z.array(row),
    runtimeRequests: z.array(row), messages: z.array(row), turnItems: z.array(row), contextTransfers: z.array(row),
  }).passthrough(),
}).passthrough();
const str = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const ended = ["completed", "interrupted", "failed", "cancelled"];
/** Per-entity enums from the pinned contract; one entity's settled status cannot settle another. */
const statuses = {
  runs: ["preparing", "queued", "starting", "running", "waiting", ...ended, "rolled_back"],
  attempts: ["pending", "running", ...ended, "superseded"],
  nodes: ["idle", "pending", "running", "waiting", ...ended, "rolled_back"],
  subagents: ["idle", "pending", "running", "waiting", ...ended],
  providerTurns: ["pending", "running", ...ended],
  runtimeRequests: ["pending", "resolved", "expired", "cancelled"],
  contextTransfers: ["pending", "resolved_native", "resolved_portable", "failed", "consumed", "superseded"],
  turnItems: ["idle", "pending", "running", "waiting", ...ended],
};
const known = (kind: keyof typeof statuses, v: unknown): v is string => typeof v === "string" && statuses[kind].includes(v);

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const present = (value: object, key: string): boolean => Object.hasOwn(value, key);
const fileChangeSchema = z.object({ fileName: z.string().min(1), additions: z.number().int().nonnegative().safe().optional(),
  deletions: z.number().int().nonnegative().safe().optional(), diffStr: z.string().optional(), oldStr: z.string().optional(), newStr: z.string().optional(),
  changes: z.array(z.object({ operation: z.string().min(1), path: z.string().min(1), oldPath: z.string().min(1).optional(),
    fileType: z.string().min(1).optional(), mimeType: z.string().min(1).optional() })).optional() });
/** The pinned detail projector is lossless only on this deliberately narrow value subset. */
export const smallLosslessValue = losslessSmallValue;

function nativeRef(value: unknown): NativeToolSource["nativeRef"] {
  const ref = object(value);
  return ref && str(ref.driver) && str(ref.nativeId) && ["strong", "weak", "none"].includes(String(ref.strength))
    ? { driver: String(ref.driver), nativeId: String(ref.nativeId), strength: String(ref.strength) } : null;
}

type RawProjection = z.infer<typeof snapshotSchema>["projection"];
/** Source identity comes exclusively from exact pinned projection edges, never a latest-run guess. */
function toolSource(p: RawProjection, record: RawProjection["turnItems"][number], threadId: string, sequence: number, isNode = false): NativeToolSource {
  const issues: string[] = [];
  const node = isNode ? record : p.nodes.find((n) => n.id === record.nodeId);
  const runId = str(record.runId), turnId = str(record.providerTurnId), providerThreadId = str(record.providerThreadId);
  const turn = p.providerTurns.find((t) => t.id === turnId);
  const attempt = p.attempts.find((a) => a.id === turn?.runAttemptId);
  const providerThread = p.providerThreads.find((t) => t.id === providerThreadId);
  const root = p.nodes.find((n) => n.id === node?.rootNodeId);
  const ref = nativeRef(record.nativeItemRef), nodeRef = nativeRef(node?.nativeItemRef);
  if (record.threadId !== threadId || node?.threadId !== threadId || !runId || node?.runId !== runId
    || !p.runs.some((r) => r.id === runId && r.threadId === threadId)) issues.push("tool_origin");
  if (!node || node.kind !== "tool_call" || !root || root.kind !== "root_turn" || root.runId !== runId
    || root.threadId !== threadId || root.rootNodeId !== root.id) issues.push("tool_node_root");
  if (!ref || ref.strength !== "strong" || !nodeRef || JSON.stringify(ref) !== JSON.stringify(nodeRef)) issues.push("tool_native_alias");
  if (!providerThreadId || providerThreadId !== node?.providerThreadId || !turnId || turnId !== node?.providerTurnId
    || !providerThread || providerThread.appThreadId !== threadId || providerThread.driver !== ref?.driver
    || !turn || turn.nodeId !== root?.id || turn.providerThreadId !== providerThreadId
    // RunAttempt has no threadId in the pinned contract. Its immutable run/root/
    // provider-thread edges above establish origin through their actual thread fields.
    || !attempt || attempt.runId !== runId || attempt.providerThreadId !== providerThreadId
    || attempt.rootNodeId !== root?.id || !Number.isSafeInteger(attempt.attemptOrdinal) || Number(attempt.attemptOrdinal) < 1) issues.push("tool_generation");
  if (!known(isNode ? "nodes" : "turnItems", record.status)) issues.push("tool_status");
  if (!isNode && typeof record.type !== "string") issues.push("tool_type_invalid");
  if (!isNode && !["command_execution", "dynamic_tool", "file_change"].includes(String(record.type))) issues.push("tool_type_unsupported");
  const parsedFile = !isNode && record.type === "file_change" ? fileChangeSchema.safeParse(record) : null;
  if (parsedFile && !parsedFile.success) issues.push("tool_file_metadata_unavailable");
  if (!isNode && record.type !== "file_change" && (!present(record, "input") || !smallLosslessValue(record.input))) issues.push("tool_input_unavailable");
  if (isNode) issues.push("tool_item_unavailable");
  if (!isNode && !str(record.updatedAt)) issues.push("tool_revision_unavailable");
  return { threadId, providerRunId: runId, itemId: isNode ? null : record.id,
    nodeId: node?.id ?? null, rootNodeId: root?.id ?? null, providerThreadId, providerTurnId: turnId,
    attemptId: str(attempt?.id), generation: Number.isSafeInteger(attempt?.attemptOrdinal) ? Number(attempt?.attemptOrdinal) : null,
    nativeRef: ref, type: isNode ? "tool_node" : typeof record.type === "string" ? record.type : "unknown",
    nodeEvidence: { threadId: str(node?.threadId), providerRunId: str(node?.runId), rootNodeId: str(node?.rootNodeId),
      providerThreadId: str(node?.providerThreadId), providerTurnId: str(node?.providerTurnId), nativeRef: nodeRef },
    status: String(record.status), ...(typeof node?.status === "string" ? { nodeStatus: node.status } : {}),
    toolName: str(record.toolName), toolSource: record.toolSource ?? null,
    ...(isNode || !present(record, "input") ? {} : { input: record.input }),
    ...(Number.isSafeInteger(record.exitCode) ? { exitCode: Number(record.exitCode) } : {}),
    ...(typeof record.outputIndicatesFailure === "boolean" ? { outputIndicatesFailure: record.outputIndicatesFailure } : {}),
    ...(parsedFile?.success ? { fileChange: parsedFile.data as NativeFileChange } : {}),
    ...(str(record.startedAt) || str(record.completedAt) ? { resultMetadata: {
      ...(str(record.startedAt) ? { startedAt: String(record.startedAt) } : {}),
      ...(str(record.completedAt) ? { completedAt: String(record.completedAt) } : {}) } } : {}),
    updatedAt: str(record.updatedAt), sequence, complete: issues.length === 0, issues };
}

function sourceIdentity(s: NativeToolSource): string {
  const { sequence: _sequence, complete: _complete, issues: _issues, output: _output, outputIndicatesFailure: _failure,
    detailObserved: _detail, payloadAvailability: _availability, fileChange: file, ...identity } = s;
  return canonicalJSON({ ...identity, ...(file ? { fileChange: fileChangeIdentity(file) } : {}) });
}

/** Pure normalization of a full source-matched snapshot. No cached shell or latest-job correlation. */
export function normalizeT3Snapshot(raw: unknown, threadId: string): ProviderSnapshot {
  const s = snapshotSchema.parse(raw), p = s.projection;
  if (p.thread.id !== threadId) throw new Error("snapshot thread identity mismatch");
  const issues: string[] = [];
  for (const kind of ["runs", "attempts", "nodes", "subagents", "providerThreads", "providerTurns", "runtimeRequests", "messages", "turnItems", "contextTransfers"] as const) {
    const value = p[kind];
    const ids = value.flatMap((r: unknown) => r && typeof r === "object" ? [Reflect.get(r, "id")] : []);
    if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) issues.push(`duplicate_or_missing_identity:${kind}`);
  }
  const complete = s.hasMoreHistory !== true && s.historyCursor == null && s.payloadBudgetExceeded !== true;
  if (!complete) issues.push("incomplete_history");
  const pending: string[] = [];
  const settled: string[] = [];
  const scan = (kind: keyof typeof statuses, rows: typeof p.runs) => {
    for (const r of rows) {
      if (!known(kind, r.status)) { issues.push(`unknown_status:${kind}:${r.id}`); pending.push(`${kind}:${r.id}`); }
      else if (activeStatus(r.status)) pending.push(`${kind}:${r.id}`);
      else if (terminalStatus(r.status) || ["resolved", "expired"].includes(r.status)
        || kind === "attempts" && r.status === "superseded") settled.push(`${kind}:${r.id}`);
    }
  };
  for (const kind of ["runs", "attempts", "nodes", "subagents", "providerTurns", "runtimeRequests"] as const) scan(kind, p[kind]);
  for (const r of p.contextTransfers) {
    // A pending transfer is work regardless of the latest run's status.
    if (!known("contextTransfers", r.status)) issues.push(`unknown_status:contextTransfers:${r.id}`);
    if (!["consumed", "failed", "superseded"].includes(String(r.status))) pending.push(`contextTransfer:${r.id}`);
    else settled.push(`contextTransfer:${r.id}`);
  }
  const links = p.thread.pullRequests;
  if (links !== undefined && !Array.isArray(links)) issues.push("invalid_pull_request_links");
  const watchKeys = new Set<string>();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || typeof link !== "object" || !str(link.host) || !str(link.repository)
      || !Number.isSafeInteger(link.number) || link.number < 1) { issues.push("invalid_pull_request_identity"); continue; }
    const key = `pullRequestWatch:${JSON.stringify([link.host, link.repository, link.number])}`;
    if (watchKeys.has(key)) issues.push("duplicate_pull_request_identity");
    watchKeys.add(key);
    if (link.source === "stack-dismissed" || link.watch === undefined) settled.push(key);
    else {
      pending.push(key);
      if (!link.watch || typeof link.watch !== "object" || !str(link.watch.startedAt)) issues.push("invalid_pull_request_watch");
    }
  }
  for (const a of p.subagents) {
    if (!["provider_native", "app_owned"].includes(String(a.origin))) issues.push(`unknown_subagent_origin:${a.id}`);
    // Native lifecycle terminal is not a future-wake delivery receipt: Claude can
    // retain a private wake report after child/node/item/root all become terminal.
    // No uniform public native-child wake settlement/fence exists in this contract.
    if (a.origin === "provider_native" && (activeStatus(String(a.status)) || terminalStatus(String(a.status))))
      pending.push(`nativeChildWake:${a.id}`);
    if (a.completionDelivery !== undefined) {
      const state = a.completionDelivery && typeof a.completionDelivery === "object"
        ? Reflect.get(a.completionDelivery, "state") : undefined;
      const key = `childDelivery:${a.id}`;
      if (["acknowledged", "delivered", "disposed"].includes(String(state))) settled.push(key);
      else {
        pending.push(key);
        if (!["pending", "claimed"].includes(String(state))) issues.push(`unknown_child_delivery:${a.id}`);
      }
    }
  }
  for (const r of p.runs) if (r.delegatedCompletion !== undefined) {
    const cohort = r.delegatedCompletion && typeof r.delegatedCompletion === "object" ? r.delegatedCompletion : null;
    const disposition = cohort && Reflect.get(cohort, "disposition"), delivery = cohort && Reflect.get(cohort, "delivery");
    const key = `cohort:${r.id}`;
    if (["stopped", "disposed"].includes(String(disposition)) || disposition === "open" && delivery === null) settled.push(key);
    else {
      pending.push(key);
      if (disposition !== "open" || !delivery || typeof delivery !== "object" || !str(Reflect.get(delivery, "messageId")))
        issues.push(`unknown_completion_cohort:${r.id}`);
    }
  }
  for (const r of p.providerThreads) {
    if (!Array.isArray(r.pendingBackgroundTasks)) { issues.push(`missing_background_roster:${r.id}`); continue; }
    for (const t of r.pendingBackgroundTasks) {
      const id = t && typeof t === "object" ? str(Reflect.get(t, "taskId")) : null;
      if (!id) issues.push(`invalid_background_roster:${r.id}`);
      pending.push(`background:${r.id}:${id ?? "unknown"}`);
    }
  }
  const runs = p.runs.map((r) => {
    if (!str(r.userMessageId) || !known("runs", r.status)) issues.push(`invalid_run:${r.id}`);
    if (r.threadId !== undefined && r.threadId !== threadId || r.queueHeld !== undefined && typeof r.queueHeld !== "boolean") issues.push(`invalid_run_origin:${r.id}`);
    const inputs = p.messages.filter((m) => m.id === r.userMessageId && m.role === "user" && m.runId === r.id);
    if (inputs.some((m) => m.threadId !== undefined && m.threadId !== threadId)) issues.push(`invalid_input_origin:${r.id}`);
    return { id: r.id, userMessageId: str(r.userMessageId) ?? "", status: String(r.status),
      ...(typeof r.queueHeld === "boolean" ? { queueHeld: r.queueHeld } : {}),
      inputText: inputs.length === 1 && typeof inputs[0]?.text === "string" ? inputs[0].text : null };
  });
  // Only exact root-turn edges may be covered by the known active root. Tools/children and
  // unrelated native turns remain pending even while that root is producing an answer.
  const rootWork: { key: string; runId: string }[] = [];
  const roots = p.nodes.filter((n) => n.kind === "root_turn" && n.parentNodeId === null
    && n.rootNodeId === n.id && n.countsForRun === true && str(n.runId));
  for (const n of roots) rootWork.push({ key: `nodes:${n.id}`, runId: String(n.runId) });
  const rootAttempts = p.attempts.filter((a) => roots.some((n) => n.id === a.rootNodeId && n.runId === a.runId));
  for (const a of rootAttempts) rootWork.push({ key: `attempts:${a.id}`, runId: String(a.runId) });
  for (const t of p.providerTurns) {
    const n = roots.find((n) => n.id === t.nodeId && n.providerTurnId === t.id);
    if (n && rootAttempts.some((a) => a.id === t.runAttemptId && a.rootNodeId === n.id && a.runId === n.runId))
      rootWork.push({ key: `providerTurns:${t.id}`, runId: String(n.runId) });
  }
  const emissions = p.messages.filter((m) => m.role === "assistant").map((m) => {
    const items = p.turnItems.filter((i) => i.type === "assistant_message" && i.messageId === m.id);
    const i = items.length === 1 ? items[0] : undefined;
    const runId = str(m.runId);
    const consistent = i !== undefined && i.runId === m.runId && i.text === m.text && typeof m.text === "string"
      && (m.threadId === undefined || m.threadId === threadId) && (i.threadId === undefined || i.threadId === threadId);
    const stable = consistent && m.streaming === false && i?.streaming === false && terminalStatus(String(i.status)) && m.textTruncated !== true && i.textTruncated !== true;
    const decoded = typeof m.text === "string" ? decodeOutput(m.text) : null;
    const providerRun = runs.find((r) => r.id === runId);
    return { id: m.id, runId: consistent ? runId : null, activityId: null,
      body: decoded?.body ?? (typeof m.text === "string" ? m.text : ""), disposition: decoded?.disposition ?? null,
      receipts: decoded?.receipts ?? [], final: !!providerRun && terminalStatus(providerRun.status), complete: stable };
  });
  const retainedActivityItems = p.turnItems.filter((i) => ["subagent", "command_execution", "dynamic_tool", "file_change"].includes(String(i.type)));
  const activities: import("../engine/provider.ts").ProviderActivity[] = retainedActivityItems.map((i) => ({
    id: i.id, runId: str(i.runId), status: String(i.status), requestIds: null,
    ...(i.type === "subagent" ? { originalChild: { item: structuredClone(i),
      child: structuredClone(p.subagents.find((c) => c.id === i.subagentId && c.runId === i.runId) ?? null) } } : {}),
  }));
  const unrepresentedToolNodes = new Set<string>();
  for (const n of p.nodes.filter((n) => ["subagent", "tool_call"].includes(String(n.kind)))) {
    const represented = retainedActivityItems.find((i) => {
      if (i.threadId !== threadId || n.threadId !== threadId || i.runId !== n.runId
        || i.providerThreadId !== n.providerThreadId || i.providerTurnId !== n.providerTurnId
        || !(i.nodeId === n.id || n.kind === "subagent" && i.type === "subagent" && i.subagentId === n.id)) return false;
      return n.kind !== "tool_call" || exactAlias(toolSource(p, n, threadId, s.snapshotSequence, true),
        toolSource(p, i, threadId, s.snapshotSequence));
    });
    // Unsupported or contradictory items do not represent a closed invocation.
    // Preserve their exact causal node even when terminal.
    if (!represented) {
      activities.push({ id: n.id, runId: str(n.runId), status: String(n.status), requestIds: null });
      if (n.kind === "tool_call") unrepresentedToolNodes.add(n.id);
    } else if (n.kind === "tool_call" && terminalStatus(String(n.status)) && represented.status === n.status)
      settled.push(`activity:${n.id}`);
  }
  for (const child of p.subagents) {
    if (!activities.some((a) => a.id === child.id && a.runId === child.runId)
      && !retainedActivityItems.some((i) => i.type === "subagent" && i.subagentId === child.id
        && i.threadId === threadId && child.threadId === threadId && i.runId === child.runId))
      activities.push({ id: child.id, runId: str(child.runId), status: String(child.status), requestIds: null,
        originalChild: { item: null, child: structuredClone(child) } });
  }
  for (const a of activities) {
    if (activeStatus(a.status) || !known("turnItems", a.status)) pending.push(`activity:${a.id}`);
    if (terminalStatus(a.status) && !unrepresentedToolNodes.has(a.id)) settled.push(`activity:${a.id}`);
    if (!known("turnItems", a.status)) issues.push(`unknown_activity_status:${a.id}`);
  }
  const questions = p.runtimeRequests.map((q) => {
    const mode = q.responseCapability && typeof q.responseCapability === "object" ? Reflect.get(q.responseCapability, "type") : null;
    const node = p.nodes.find((n) => n.id === q.nodeId);
    if (!["live", "message", "not_resumable"].includes(String(mode))) issues.push(`unknown_response_mode:${q.id}`);
    return { id: q.id, runId: str(node?.runId), status: String(q.status),
      mode: (["live", "message"].includes(String(mode)) ? mode : "not_resumable") as "live" | "message" | "not_resumable", kind: String(q.kind) };
  });
  // Retain EVERY original item identity and kind for comparisons with earlier
  // classifications. Unsupported/message items cannot become consumable results.
  const toolSources = p.turnItems.map((i) => toolSource(p, i, threadId, s.snapshotSequence));
  for (const n of p.nodes.filter((n) => n.kind === "tool_call")) {
    // A node event is committed before the corresponding item event. Keep its exact
    // work visible; only a proven node/item edge can later coalesce these aliases.
    const nodeSource = toolSource(p, n, threadId, s.snapshotSequence, true);
    if (!toolSources.some((i) => exactAlias(nodeSource, i))) toolSources.push(nodeSource);
  }
  return { threadId, sequence: s.snapshotSequence, complete, idle: pending.length === 0 && issues.length === 0,
    runs, emissions, activities, questions, pending: [...new Set(pending)], rootWork, settled, issues, toolSources };
}

/** Isolated, deliberately conservative public T3 transport. No caller in the live service. */
export class EngineHttpT3Adapter implements ProviderAdapter {
  readonly http: HttpT3Adapter;
  constructor(http: HttpT3Adapter) { this.http = http; }
  async contract(): Promise<ProviderContract> {
    const d = await this.http.describe();
    const supported = d.orchestrationProtocolVersion === 2 && d.serverVersion === T3_SERVER_VERSION;
    return { id: T3_CONTRACT_ID, environmentId: d.environmentId, serverVersion: d.serverVersion, supported,
      durableSameId: supported, receiptLookup: false, authoritativeAbsence: false,
      atomicIdleStart: false, nativeCoverage: supported, controlCompletion: false, syncExposure: false,
      ...(supported ? { reservedDispatchPolicy: { kind: "t3-reserved-start-immediately-v1" as const, maxPackets: 2 as const, sourceCommit: T3_SOURCE_COMMIT } } : {}),
      evidence: supported ? "Pinned source: transactional app receipts retained; no public lookup; start_immediately queues on a busy race. Full projection covers reported native work only."
        : "Unmatched T3 version/protocol: re-audit source before using this contract." };
  }
  async inspect(threadId: string): Promise<ProviderSnapshot> { return normalizeT3Snapshot(await this.http.engineSnapshot(threadId), threadId); }
  /** Two actual detail reads bracketed by complete monotone checkpoints. Snapshot output is never consumed. */
  async detail(threadId: string, itemId: string): Promise<NativeToolSource> {
    const c = await this.contract();
    if (!c.supported) throw new Error("Unsupported pinned detail contract");
    const before = snapshotSchema.parse(await this.http.engineSnapshot(threadId));
    const checkpoint = normalizeT3Snapshot(before, threadId);
    if (!checkpoint.complete || checkpoint.issues.length) throw new Error("Incomplete source checkpoint");
    const original = checkpoint.toolSources?.find((s) => s.itemId === itemId);
    if (!original || !["command_execution", "dynamic_tool", "file_change"].includes(original.type)) throw new Error("Exact ordinary source item unavailable");
    const read = async (): Promise<Record<string, unknown>> => {
      const result = object(await this.http.engineTurnItem(threadId, itemId));
      const item = object(result?.item);
      if (!item || item.id !== itemId || item.threadId !== threadId
        || !["command_execution", "dynamic_tool", "file_change"].includes(String(item.type))) throw new Error("Exact ordinary detail unavailable");
      return item;
    };
    const first = await read();
    const after = snapshotSchema.parse(await this.http.engineSnapshot(threadId));
    const next = normalizeT3Snapshot(after, threadId);
    if (!next.complete || next.issues.length || next.sequence < checkpoint.sequence) throw new Error("Unstable source checkpoint");
    const current = next.toolSources?.find((s) => s.itemId === itemId);
    if (!current || sourceIdentity(original) !== sourceIdentity(current)) throw new Error("Changed source identity/generation");
    const second = await read();
    const final = snapshotSchema.parse(await this.http.engineSnapshot(threadId));
    const finalCheckpoint = normalizeT3Snapshot(final, threadId);
    // Snapshot outputs are omitted and updatedAt only keys a provider cache. The
    // second body covers this floor only if no event arrived across its read.
    if (!finalCheckpoint.complete || finalCheckpoint.issues.length || finalCheckpoint.sequence !== next.sequence)
      throw new Error("Unproved detail coverage at final source checkpoint");
    const finalSource = finalCheckpoint.toolSources?.find((s) => s.itemId === itemId);
    if (!finalSource || sourceIdentity(current) !== sourceIdentity(finalSource)) throw new Error("Changed final source identity/generation");
    const finalContract = await this.contract();
    if (!finalContract.supported || finalContract.environmentId !== c.environmentId || finalContract.serverVersion !== c.serverVersion
      || finalContract.id !== c.id) throw new Error("Changed detail endpoint contract");
    const source = toolSource(final.projection, { ...second, id: itemId }, threadId, finalCheckpoint.sequence);
    const issues = [...source.issues];
    if (canonicalJSON(first) !== canonicalJSON(second)) issues.push("unstable_detail");
    if (sourceIdentity(current) !== sourceIdentity(source)) issues.push("detail_checkpoint_mismatch");
    for (const key of ["outputOmitted", "inputOmitted", "textTruncated", "partial", "truncated", "payloadBudgetExceeded", "withheld"])
      if (second[key] === true) issues.push(`detail_${key}`);
    if (source.type !== "file_change" && (present(second, "output") ? !smallLosslessValue(second.output) : terminalStatus(source.status))) issues.push("detail_output_unavailable");
    if (source.type === "command_execution" && (typeof second.input !== "string" || terminalStatus(source.status)
      && (present(second, "output") && typeof second.output !== "string" || !Number.isSafeInteger(second.exitCode) || second.exitCode !== current.exitCode))) issues.push("detail_command_outcome");
    const availability: Record<string, NativePayloadAvailability> = {
      ...(present(second, "input") ? payloadFields(second.input, "input") : { input: { status: "unavailable" as const, reason: "Native item supplies no input field." } }),
      ...(present(second, "output") ? payloadFields(second.output, "output") : { output: { status: "unavailable" as const, reason: "Native detail supplies no output body." } }),
      ...(source.fileChange ? payloadFields(source.fileChange, "fileChange") : {}),
    };
    // An explicit omission flag qualifies availability even when a partial body exists.
    for (const field of ["input", "output"] as const) if (second[`${field}Omitted`] === true || second.withheld === true)
      availability[field] = { status: present(second, field) ? "partial" : "omitted", reason: "The actual native detail reports withheld or omitted bytes." };
    if (["textTruncated", "partial", "truncated", "payloadBudgetExceeded"].some((key) => second[key] === true) && present(second, "output"))
      availability.output = { status: "partial", reason: "The actual native detail marks the retained payload partial." };
    if (source.fileChange) for (const field of ["diffStr", "oldStr", "newStr"] as const) if (!Object.hasOwn(source.fileChange, field))
      availability[`fileChange.${field}`] = { status: "omitted", reason: "The pinned file-change projection strips this field; its bytes were not captured." };
    return { ...source, ...(present(second, "output") ? { output: second.output } : {}), detailObserved: true, payloadAvailability: availability,
      complete: issues.length === 0, issues: [...new Set(issues)] };
  }
  async lookup(_wireJSON: string): Promise<CommandEvidence> {
    return { kind: "unknown", evidence: "T3 exposes no public read-by-command receipt; absence from a transcript is not nonacceptance." };
  }
  async send(wireJSON: string, target: TransportTarget, frozen?: FrozenTransport): Promise<CommandEvidence> {
    const c = await this.contract();
    if (!c.supported) return { kind: "unknown", evidence: "Unmatched endpoint contract; no provider write performed." };
    if (frozen && (frozen.environmentId !== c.environmentId || frozen.serverVersion !== c.serverVersion || frozen.contract !== c.id
      || frozen.wireJSON !== wireJSON || frozen.digest !== hash(wireJSON)))
      return { kind: "unknown", evidence: "Endpoint origin/contract or exact frozen bytes changed; no provider write performed." };
    if (target.kind === "run" && (!frozen || canonicalJSON(frozen.dispatchPolicy ?? null) !== canonicalJSON(c.reservedDispatchPolicy ?? null)
      || !Number.isInteger(frozen.attempts) || frozen.attempts < 1 || frozen.attempts > 2))
      return { kind: "unknown", evidence: "Journaled pinned reserved MESSAGE policy and bounded attempt required; no provider write performed." };
    let command: Record<string, unknown>;
    try {
      const value = object(JSON.parse(wireJSON));
      if (!value || !str(value.commandId) || !str(value.threadId)) throw new Error("Invalid exact command");
      command = value;
      if (target.kind === "run") {
        z.object({ type: z.literal("message.dispatch"), commandId: z.string().min(1), threadId: z.string().min(1),
          messageId: z.string().min(1), text: z.string(), attachments: z.array(z.never()).length(0),
          modelSelection: z.object({ instanceId: z.string().min(1), model: z.string().min(1), options: z.record(z.string(), z.unknown()).optional() }).strict(),
          createdBy: z.literal("user"), creationSource: z.literal("server"),
          dispatchMode: z.object({ type: z.literal("start_immediately") }).strict() }).strict().parse(command);
      } else if (command.type !== "run.interrupt" && command.type !== "runtime-request.respond") throw new Error("Unsupported control");
    } catch { return { kind: "rejected", evidence: "Invalid exact reserved MESSAGE/control command; no provider write performed." }; }
    try {
      const result = z.object({ sequence: z.number().int().nonnegative() }).parse(await this.http.engineDispatch(wireJSON));
      return { kind: "accepted", evidence: `T3 app committed command at sequence ${result.sequence}; runtime/tool effect is not proven.` };
    } catch (error) {
      // Generic RPC Failure (including OrchestratorDispatchError) can follow commit.
      // Only source-enumerated precommit/rejected tags justify definite rejection.
      if (error instanceof T3CommandRejected) {
        const body = error.body as { cause?: unknown } | null;
        const failures = Array.isArray(body?.cause) ? body.cause : [body?.cause];
        const safe = new Set(["OrchestratorCommandRejectedError", "OrchestratorCommandPreviouslyRejectedError", "OrchestratorCommandIdConflictError", "OrchestratorSubagentThreadReadOnlyError", "OrchestratorProjectionError", "OrchestratorProviderAdapterError"]);
        const wire = JSON.parse(wireJSON) as { commandId: string; type: string };
        const tags = failures.flatMap((f) => {
          if (!f || typeof f !== "object" || Reflect.get(f, "_tag") !== "Fail") return [];
          const outer = Reflect.get(f, "error");
          if (!outer || typeof outer !== "object" || Reflect.get(outer, "_tag") !== "OrchestrationV2DispatchCommandError"
            || Reflect.get(outer, "commandId") !== wire.commandId || Reflect.get(outer, "commandType") !== wire.type) return [];
          const cause = Reflect.get(outer, "cause");
          return cause && typeof cause === "object" ? [Reflect.get(cause, "_tag")] : [];
        });
        if (tags.length === 1 && safe.has(String(tags[0]))) return { kind: "rejected", evidence: `Source-backed definite rejection: ${String(tags[0])}` };
      }
      return { kind: "unknown", evidence: "No trustworthy acceptance response; reconcile the same command, do not infer rejection." };
    }
  }
}

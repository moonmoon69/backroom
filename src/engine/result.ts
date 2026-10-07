import { hash, terminalStatus } from "./provider.ts";
import type { NativeFileChange, NativePayloadAvailability, NativeToolSource } from "./provider.ts";

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("dense finite JSON array required");
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(Reflect.get(value, k))}`).join(",")}}`;
  throw new Error("finite lossless JSON required");
}
export function losslessSmallValue(value: unknown): boolean {
  const seen = new Set<object>();
  function valid(v: unknown, depth: number): boolean {
    if (depth > 64) return false;
    if (typeof v === "string") return !/output truncated for transport|Unserializable tool|\[.*(?:truncated|summary).*\]/i.test(v);
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0);
    if (!v || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v) && Object.keys(v).length !== v.length) return false;
    if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    if (!Array.isArray(v) && Object.keys(v).some((k) => /^(data|mimeType|source|summary|truncated|outputOmitted|inputOmitted|payloadBudgetExceeded|partial)$/i.test(k))) return false;
    if (!Array.isArray(v) && Reflect.get(v, "type") === "image") return false;
    return Object.values(v).every((x) => valid(x, depth + 1));
  }
  try { return valid(value, 0) && Buffer.byteLength(canonicalJSON(value), "utf8") < 8192; } catch { return false; }
}
export function sourceKey(s: NativeToolSource): string { return JSON.stringify([s.threadId, s.itemId ?? s.nodeId, s.providerRunId, s.generation]); }
const contradictorySourceIssues = new Set(["tool_origin", "tool_node_root", "tool_native_alias", "tool_generation", "tool_status", "tool_type_invalid"]);
/** Missing response/item detail is availability; present contradictory origin edges are causal uncertainty. */
export function sourceContradiction(s: NativeToolSource): boolean {
  return s.issues.some((issue) => contradictorySourceIssues.has(issue));
}
/** The pinned producer settles node then item; only equal terminal outcomes prove an ordinary result. */
export function ordinaryOutcomeCoherent(s: NativeToolSource): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(s.status) && s.nodeStatus === s.status;
}
export function exactAlias(a: NativeToolSource, b: NativeToolSource): boolean {
  if (sourceContradiction(a) || sourceContradiction(b) || a.threadId !== b.threadId
    || a.providerRunId === null || a.providerRunId !== b.providerRunId || a.generation === null || a.generation !== b.generation
    || a.attemptId === null || a.attemptId !== b.attemptId || a.providerTurnId === null || a.providerTurnId !== b.providerTurnId
    || a.rootNodeId === null || a.rootNodeId !== b.rootNodeId || a.providerThreadId === null || a.providerThreadId !== b.providerThreadId
    || a.nativeRef?.strength !== "strong" || b.nativeRef?.strength !== "strong" || canonicalJSON(a.nativeRef) !== canonicalJSON(b.nativeRef)
    || a.nodeId === null || a.nodeId !== b.nodeId) return false;
  const supported = (s: NativeToolSource) => ["command_execution", "dynamic_tool", "file_change"].includes(s.type) && s.complete && s.issues.length === 0 && s.itemId !== null
    && (s.type !== "file_change" || !!s.fileChange)
    && (!terminalStatus(s.status) || ordinaryOutcomeCoherent(s));
  if (a.itemId !== null && b.itemId !== null)
    return a.itemId === b.itemId && a.type === b.type && supported(a) && supported(b) && sourceIdentity(a) === sourceIdentity(b);
  const node = a.itemId === null ? a : b, item = a.itemId === null ? b : a;
  return node.type === "tool_node" && node.issues.length === 1 && node.issues[0] === "tool_item_unavailable" && supported(item)
    && (!terminalStatus(item.status) || node.status === item.status)
    && (!node.nodeEvidence || !item.nodeEvidence || canonicalJSON(node.nodeEvidence) === canonicalJSON(item.nodeEvidence));
}
export function sourceIdentity(s: NativeToolSource): string {
  return canonicalJSON({ threadId: s.threadId, providerRunId: s.providerRunId, itemId: s.itemId, nodeId: s.nodeId,
    rootNodeId: s.rootNodeId, providerThreadId: s.providerThreadId, providerTurnId: s.providerTurnId,
    attemptId: s.attemptId, generation: s.generation, nativeRef: s.nativeRef, type: s.type,
    toolName: s.toolName, toolSource: s.toolSource, input: s.input ?? null,
    ...(s.type === "file_change" ? { fileChange: fileChangeIdentity(s.fileChange) } : {}), nodeEvidence: s.nodeEvidence ?? null,
    contradictions: s.issues.filter((issue) => contradictorySourceIssues.has(issue)).sort() });
}
/** File identity/counts are invocation identity; diff/old/new are result payload. */
export function fileChangeIdentity(value: NativeFileChange | undefined): unknown {
  if (!value) return null;
  const { diffStr: _diff, oldStr: _old, newStr: _new, ...identity } = value;
  return identity;
}

/** Availability of the bytes actually retained, never an assertion about omitted bytes. */
export function payloadFields(value: unknown, path: string): Record<string, NativePayloadAvailability> {
  const fields: Record<string, NativePayloadAvailability> = {};
  function walk(v: unknown, p: string): boolean {
    let partial = false;
    if (typeof v === "string" && /output truncated for transport|Unserializable tool|\[.*(?:truncated|summary).*\]/i.test(v)) partial = true;
    if (v && typeof v === "object") {
      const record = v as Record<string, unknown>;
      for (const [key, child] of Object.entries(record)) partial = walk(child, `${p}.${key}`) || partial;
      if (["truncated", "partial", "outputOmitted", "inputOmitted", "payloadBudgetExceeded", "withheld"].some((key) => record[key] === true)) partial = true;
      if (record.type === "image") {
        const imageSource = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : null;
        if (typeof record.data !== "string" && typeof imageSource?.data !== "string") {
          fields[`${p}.${imageSource ? "source.data" : "data"}`] = { status: "omitted", reason: "Native detail supplies image metadata; image bytes were not captured." };
          partial = true;
        }
      }
    }
    fields[p] = { status: partial ? "partial" : "complete", ...(partial ? { reason: "Only the retained native projection is available." } : {}) };
    return partial;
  }
  walk(value, path);
  return fields;
}

export interface ToolClosureEvidence {
  schema: "backroom.tool.closed.v1";
  sourceKey: string;
  sourceIdentity: string;
  source: Pick<NativeToolSource, "threadId" | "providerRunId" | "itemId" | "nodeId" | "rootNodeId" | "providerThreadId"
    | "providerTurnId" | "attemptId" | "generation" | "nativeRef" | "type" | "toolName" | "toolSource" | "nodeEvidence">;
  outcome: "done" | "failed";
  status: string;
  nodeStatus: string;
  checkpoint: { sequence: number; updatedAt: string };
  retained: { input?: unknown; output?: unknown; exitCode?: number; fileChange?: NativeFileChange; resultMetadata?: NativeToolSource["resultMetadata"] };
  availability: Record<string, NativePayloadAvailability>;
  /** Hash of the retained JSON only. This never certifies omitted image/diff bytes. */
  retainedDigest: string;
  limitations: string[];
}
const closureAvailabilityIssues = new Set(["detail_output_unavailable", "detail_outputOmitted", "detail_inputOmitted", "detail_textTruncated",
  "detail_partial", "detail_truncated", "detail_payloadBudgetExceeded", "detail_withheld"]);

/** Positive closure of ONE invocation. Consumption and independent/background work remain separate. */
export function toolClosure(s: NativeToolSource): ToolClosureEvidence | null {
  if (sourceContradiction(s) || s.issues.some((issue) => !closureAvailabilityIssues.has(issue))
    || !["command_execution", "dynamic_tool", "file_change"].includes(s.type)
    || !["completed", "failed"].includes(s.status) || !ordinaryOutcomeCoherent(s)
    || !s.threadId || !s.providerRunId || !s.itemId || !s.nodeId || !s.rootNodeId || !s.providerThreadId || !s.providerTurnId || !s.attemptId
    || !Number.isSafeInteger(s.generation) || Number(s.generation) < 1 || !Number.isSafeInteger(s.sequence) || s.sequence < 0
    || !s.updatedAt || s.nativeRef?.strength !== "strong" || !s.nativeRef.driver || !s.nativeRef.nativeId) return null;
  if (s.nodeEvidence && (s.nodeEvidence.threadId !== s.threadId || s.nodeEvidence.providerRunId !== s.providerRunId
    || s.nodeEvidence.rootNodeId !== s.rootNodeId || s.nodeEvidence.providerThreadId !== s.providerThreadId
    || s.nodeEvidence.providerTurnId !== s.providerTurnId || canonicalJSON(s.nodeEvidence.nativeRef) !== canonicalJSON(s.nativeRef))) return null;
  let outcome: ToolClosureEvidence["outcome"] = s.status === "failed" ? "failed" : "done";
  if (s.type === "command_execution") {
    if (typeof s.input !== "string" || !Number.isSafeInteger(s.exitCode) || s.status === "failed" && s.exitCode === 0
      || s.status === "completed" && s.exitCode === 0 && s.outputIndicatesFailure === true) return null;
    if (s.exitCode !== 0) outcome = "failed";
  } else if (s.type === "dynamic_tool" && (!s.detailObserved || !Object.hasOwn(s, "output"))) return null;
  else if (s.type === "file_change" && (!s.fileChange?.fileName || !s.detailObserved)) return null;
  const retained: ToolClosureEvidence["retained"] = {
    ...(Object.hasOwn(s, "input") ? { input: s.input } : {}), ...(Object.hasOwn(s, "output") ? { output: s.output } : {}),
    ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }), ...(s.fileChange ? { fileChange: s.fileChange } : {}),
    ...(s.resultMetadata ? { resultMetadata: s.resultMetadata } : {}),
  };
  let retainedDigest: string;
  try { retainedDigest = hash(canonicalJSON(retained)); } catch { return null; }
  const availability: ToolClosureEvidence["availability"] = {
    ...(Object.hasOwn(s, "input") ? payloadFields(s.input, "input") : { input: { status: "unavailable" as const, reason: "No input field in the supported native item." } }),
    ...(Object.hasOwn(s, "output") ? payloadFields(s.output, "output") : { output: { status: "unavailable" as const, reason: "No output body available at the source checkpoint." } }),
    ...(s.fileChange ? payloadFields(s.fileChange, "fileChange") : {}),
    ...(s.resultMetadata ? payloadFields(s.resultMetadata, "resultMetadata") : {}), ...s.payloadAvailability,
  };
  if (s.type === "command_execution") availability.exitCode = { status: s.exitCode === undefined ? "unavailable" : "complete" };
  const limitations = ["Invocation closure does not certify physical truth, exactly-once effects or absence of unreported detached work."];
  if (s.type === "dynamic_tool") limitations.push("A returned dynamic-tool call does not settle any background job it launched.");
  if (s.type === "file_change") {
    for (const field of ["diffStr", "oldStr", "newStr"] as const) if (!Object.hasOwn(s.fileChange!, field))
      availability[`fileChange.${field}`] = { status: "omitted", reason: "The pinned native file-change detail omits this field; no diff bytes were captured." };
    if (["diffStr", "oldStr", "newStr"].some((field) => !Object.hasOwn(s.fileChange!, field))) {
      availability.fileChange = { status: "partial", reason: "Native file metadata is retained; diff/old/new payload fields are omitted." };
      limitations.push("Native edit metadata is retained; omitted diff/old/new bytes are not consumed or captured.");
    }
  }
  if (Object.entries(availability).some(([field, a]) => /(?:^|\.)data$/.test(field) && a.status === "omitted"))
    limitations.push("Native image metadata is retained; image bytes were not captured and have no byte digest.");
  return { schema: "backroom.tool.closed.v1", sourceKey: sourceKey(s), sourceIdentity: sourceIdentity(s),
    source: { threadId: s.threadId, providerRunId: s.providerRunId, itemId: s.itemId, nodeId: s.nodeId, rootNodeId: s.rootNodeId,
      providerThreadId: s.providerThreadId, providerTurnId: s.providerTurnId, attemptId: s.attemptId, generation: s.generation,
      nativeRef: structuredClone(s.nativeRef), type: s.type, toolName: s.toolName, toolSource: structuredClone(s.toolSource),
      ...(s.nodeEvidence ? { nodeEvidence: structuredClone(s.nodeEvidence) } : {}) }, outcome, status: s.status, nodeStatus: s.nodeStatus!,
    checkpoint: { sequence: s.sequence, updatedAt: s.updatedAt }, retained: structuredClone(retained), availability: structuredClone(availability), retainedDigest, limitations };
}
export function resultDigest(s: NativeToolSource): string {
  if (!s.complete || s.issues.length || !ordinaryOutcomeCoherent(s)
    || !s.itemId || !s.providerRunId || !s.attemptId || s.generation === null
    || !Object.hasOwn(s, "input") || !Object.hasOwn(s, "output") || !losslessSmallValue(s.input) || !losslessSmallValue(s.output))
    throw new Error("original lossless small result unavailable");
  if (s.type === "command_execution" && (typeof s.input !== "string" || typeof s.output !== "string" || !Number.isSafeInteger(s.exitCode)))
    throw new Error("exact command text/output/exitCode required");
  if (s.type !== "command_execution" && s.type !== "dynamic_tool") throw new Error("ordinary invocation required");
  return hash(canonicalJSON({ identity: sourceIdentity(s), status: s.status, nodeStatus: s.nodeStatus,
    input: s.input, output: s.output, exitCode: s.exitCode ?? null }));
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Disposition, FrozenTransport, TransportTarget } from "./types.ts";

export const T3_SOURCE_COMMIT = "fd1c3386c4d60f3477ab3f13c87537848de099f5";
export const T3_SERVER_VERSION = "0.0.46-nightly.20261006.2735";
export const T3_CONTRACT_ID = `t3-v2:${T3_SOURCE_COMMIT}`;
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const activeStatus = (status: string): boolean => ["pending", "preparing", "queued", "starting", "running", "waiting"].includes(status);
export const terminalStatus = (status: string): boolean => ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);

/** Capabilities belong to the exact endpoint/version, never to a provider name alone. */
export interface ProviderContract {
  id: string;
  environmentId: string;
  serverVersion: string;
  supported: boolean;
  durableSameId: boolean;
  receiptLookup: boolean;
  authoritativeAbsence: boolean;
  atomicIdleStart: boolean;
  reservedDispatchPolicy?: ReservedDispatchPolicy;
  /** Coverage of reported native work, not a promise about unreported processes. */
  nativeCoverage: boolean;
  /** Whether command acceptance plus native terminal evidence proves control effects have settled. */
  controlCompletion: boolean;
  syncExposure: boolean;
  evidence: string;
}
export interface ReservedDispatchPolicy {
  kind: "t3-reserved-start-immediately-v1";
  maxPackets: 2;
  sourceCommit: string;
}
export type PayloadAvailability = "complete" | "partial" | "omitted" | "unavailable";
export interface NativePayloadAvailability { status: PayloadAvailability; reason?: string }
/** Actual supported file-change fields. Absent diff fields remain absent. */
export interface NativeFileChange {
  fileName: string;
  additions?: number;
  deletions?: number;
  changes?: { operation: string; path: string; oldPath?: string; fileType?: string; mimeType?: string }[];
  diffStr?: string;
  oldStr?: string;
  newStr?: string;
}
export interface NativeToolSource {
  threadId: string;
  providerRunId: string | null;
  itemId: string | null;
  nodeId: string | null;
  rootNodeId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  attemptId: string | null;
  generation: number | null;
  nativeRef: { driver: string; nativeId: string; strength: string } | null;
  /** Actual node-side edges, including contradictions with a stable item row. */
  nodeEvidence?: { threadId: string | null; providerRunId: string | null; rootNodeId: string | null;
    providerThreadId: string | null; providerTurnId: string | null; nativeRef: NativeToolSource["nativeRef"] };
  /** Retain unsupported projected item kinds so an established identity cannot disappear. */
  type: string;
  status: string;
  /** Volatile native node lifecycle, separate from immutable node origin evidence. */
  nodeStatus?: string;
  toolName: string | null;
  toolSource: unknown;
  input?: unknown;
  output?: unknown;
  exitCode?: number;
  outputIndicatesFailure?: boolean;
  fileChange?: NativeFileChange;
  /** Only the adapter's stable, source-matched real detail reads set this. */
  detailObserved?: boolean;
  payloadAvailability?: Record<string, NativePayloadAvailability>;
  resultMetadata?: { startedAt?: string; completedAt?: string };
  updatedAt: string | null;
  sequence: number;
  complete: boolean;
  issues: string[];
}
export interface ProviderRun { id: string; userMessageId: string; inputText: string | null; status: string; queueHeld?: boolean }
export interface ProviderEmission {
  id: string;
  runId: string | null;
  activityId: string | null;
  body: string;
  /** Missing/invalid declaration holds visibly. Ordinary prose has no finish default. */
  disposition: Disposition | null;
  receipts: { id: string; digest: string }[];
  final: boolean;
  complete: boolean;
}
export interface ProviderActivity { id: string; runId: string | null; status: string; requestIds: string[] | null;
  /** Original source-shaped child evidence; latestTerminal fields are never substituted for it. */
  originalChild?: { item: unknown; child: unknown };
}
export interface ProviderQuestion { id: string; runId: string | null; status: string; mode: "live" | "message" | "not_resumable"; kind: string }
export interface ProviderSnapshot {
  threadId: string;
  /** Monotone committed thread sequence. Earlier observations cannot revoke known work. */
  sequence: number;
  complete: boolean;
  idle: boolean;
  runs: ProviderRun[];
  emissions: ProviderEmission[];
  activities: ProviderActivity[];
  questions: ProviderQuestion[];
  /** Includes queues, attempts, provider turns, nodes, descendants and context transfers. */
  pending: string[];
  /** Exact pending root-turn/attempt relations. Other nodes/turns remain separate native work. */
  rootWork?: { key: string; runId: string }[];
  /** Explicit terminal observations for exact keys; absence from a roster is never settlement. */
  settled?: string[];
  issues: string[];
  toolSources?: NativeToolSource[];
}
export type CommandEvidence =
  | { kind: "accepted"; evidence: string }
  | { kind: "rejected"; evidence: string }
  | { kind: "absent"; evidence: string }
  | { kind: "unknown"; evidence: string };
export interface ProviderAdapter {
  contract(): Promise<ProviderContract>;
  inspect(threadId: string): Promise<ProviderSnapshot>;
  lookup(wireJSON: string): Promise<CommandEvidence>;
  /** The adapter must enforce its atomic-idle contract for initial starts. */
  send(wireJSON: string, target: TransportTarget, frozen?: FrozenTransport): Promise<CommandEvidence>;
  detail?(threadId: string, itemId: string): Promise<NativeToolSource>;
}

const ids = z.array(z.string().min(1)).refine((v) => new Set(v).size === v.length);
export const dispositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), requestIds: ids.min(1) }).strict(),
  z.object({ kind: z.literal("yield") }).strict(),
  z.object({ kind: z.literal("silent") }).strict(),
  z.object({ kind: z.literal("progress"), requestIds: ids, milestone: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("error"), requestIds: ids }).strict(),
]);
/** Exact structured declaration, not prose/citation parsing. Slice 4 may offer this through a tool. */
const outputSchema = z.object({
  schema: z.literal("backroom.output.v1"), body: z.string(), disposition: dispositionSchema,
  receipts: z.array(z.object({ id: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).default([]),
}).strict().refine((v) => v.disposition.kind !== "silent" || v.body === "");
export function decodeOutput(text: string): { body: string; disposition: Disposition; receipts: { id: string; digest: string }[] } | null {
  try {
    const v = outputSchema.parse(JSON.parse(text));
    const d = v.disposition;
    const disposition: Disposition = d.kind === "progress" ? { kind: d.kind, requestIds: d.requestIds, ...(d.milestone === undefined ? {} : { milestone: d.milestone }) } : d;
    return { body: v.body, disposition, receipts: v.receipts };
  } catch { return null; }
}

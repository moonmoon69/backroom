import type { NativeToolSource } from "./provider.ts";
import type { ClaimOutcome, Disposition } from "./types.ts";

/** Secret hash only. The host provisions the bearer through trusted tool transport. */
export interface RunCapability {
  id: string;
  tokenHash: string;
  seatId: string;
  threadId: string;
  runId: string;
  generation: number;
  server: string;
  environmentId: string;
  serverVersion: string;
  contract: string;
  activityId?: string;
  nativeRunId?: string;
}
export type OperationIntent = {
  schema: "backroom.operation.v1";
  operation: "own_run_view" | "consume_tool_result" | "finish";
  clientId: string;
  nonce: string;
  originRunId: string;
} & (
  | { operation: "own_run_view"; offset?: number }
  | { operation: "consume_tool_result"; toolRefs: ToolRef[] }
  | { operation: "finish"; toolRefs: ToolRef[]; body: string; disposition: Disposition }
);
export interface ToolRef { itemId: string; digest: string; requestIds: string[] }
/** Offsets address the original ordered list, including entries whose detail is summarized. */
export interface ViewPage { offset: number; nextOffset: number; total: number }
export interface ToolView {
  itemId: string; digest: string; status: string; closed?: boolean; closureKey?: string;
  outcome?: "done" | "failed"; availability?: Record<string, unknown>; limitations?: string[];
  page?: ViewPage;
  originalEvidenceRef?: { kind: "tool.closed"; threadId: string; providerRunId: string; generation: number; itemIdField: "itemId" };
  availabilitySummary?: {
    mode: "top_level_and_counts"; fieldCount: number;
    statusCounts: Record<"complete" | "partial" | "omitted" | "unavailable", number>;
    /** The original field map is retained in the referenced tool.closed record. */
    detailsRef: { kind: "tool.closed"; refField: "originalEvidenceRef" };
  };
}
export interface ToolResultRecord {
  key: string;
  runId: string;
  requestIds: string[];
  source: NativeToolSource;
  digest: string;
  through: number;
}
export interface LocalOperationPacket {
  capabilityId: string;
  intent: OperationIntent;
  intentJSON: string;
  source: NativeToolSource;
  aliases?: NativeToolSource[];
  tools: { ref: ToolRef; source: NativeToolSource }[];
  view: ToolView[];
  activities?: DeclaredActivityView[];
  sequence: number;
  /** Host-collected final source metadata, rechecked under the writer lock. */
  sourceCheckpointDigest: string;
}
export interface OperationReceipt {
  key: string;
  capabilityId: string;
  seatId: string;
  threadId: string;
  runId: string;
  generation: number;
  clientId: string;
  intentJSON: string;
  intentDigest: string;
  packet: LocalOperationPacket;
  result: { recorded: true; operation: OperationIntent["operation"]; tools: string[]; claims: ClaimOutcome[]; view: LocalOperationPacket["view"]; activities?: DeclaredActivityView[] };
  resultDigest: string;
  responseJSON: string;
}
export interface OperationBinding {
  key: string;
  receiptKey: string;
  source: NativeToolSource;
  confirmed: boolean;
  receiptKind?: "activity";
}
export type ActivityV1Intent = {
  schema: "backroom.activity.v1"; clientId: string; nonce: string; originRunId: string; activityId: string;
} & (
  | { operation: "register_activity"; requestIds: string[]; activityGeneration: number; nativeId: string | null }
  | { operation: "record_activity_result"; activityGeneration: number; toolRef: ToolRef; body: string;
      disposition: Disposition; completion: "done" | "failed" }
);
export interface ActivityPacket {
  capabilityId: string; intent: ActivityIntent; intentJSON: string; source: NativeToolSource;
  resultSource: NativeToolSource | null; sequence: number;
  originalSource?: NativeToolSource | null;
  aliases?: NativeToolSource[];
  sourceCheckpointDigest: string;
}
export interface ActivityReceipt { provenance?: "member_declared"; key: string; capabilityId: string; intentJSON: string; packet: ActivityPacket; responseJSON: string }

export interface NativeHandle { namespace: "provider_item" | "process" | "task"; value: string }
export type ActivityV2Intent = {
  schema: "backroom.activity.v2"; provenance: "member_declared"; clientId: string; nonce: string;
  originRunId: string; activityId: string; activityGeneration: number;
} & (
  | { operation: "register_activity"; requestIds: string[]; nativeId: null }
  | { operation: "bind_activity"; registrationReceiptKey: string; nativeHandle: NativeHandle; originalSourceRef: { itemId: string } | null }
  | { operation: "record_activity_result"; bindingReceiptKey: string; completion: "done" | "failed"; body: string;
      resultRef: { itemId: string } | null; unavailableReason: string | null }
);
export type ActivityIntent = ActivityV1Intent | ActivityV2Intent;
/** Immutable declaration ownership, never a provider-certified launch receipt. */
export interface DeclaredRegistration {
  provenance: "member_declared"; registrationReceiptKey: string; capabilityId: string;
  seatId: string; threadId: string; environmentId: string; providerThreadId: string;
  runId: string; providerRunId: string; generation: number; requestIds: string[]; through: number;
  registeredAt: number; sourceSequenceFloor: number; limitations: string[];
  /** Store-collected foreign journal prefixes known at registration; never member input. */
  sourceHistoryHeads?: Record<string, number>;
}
export interface DeclaredBinding {
  provenance: "member_declared"; bindingReceiptKey: string; ownershipKey: string;
  nativeHandle: NativeHandle; originalSource: NativeToolSource | null;
  availability: "reference_available" | "reference_unavailable";
  correlation: "strong_native_reference" | "supporting_context_only" | "unverified";
  limitations: string[];
}
export interface DeclaredResult {
  provenance: "member_declared"; resultReceiptKey: string; bindingReceiptKey: string;
  completion: "done" | "failed"; body: string; originalSource: NativeToolSource | null;
  evidence: import("./result.ts").ToolClosureEvidence | null; unavailableReason: string | null; limitations: string[];
}
export interface ToolClosureRecord {
  key: string; runId: string; generation: number; requestIds: string[]; through: number;
  source: NativeToolSource; evidence: import("./result.ts").ToolClosureEvidence; sourceCheckpointDigest: string;
}

export interface DeclaredActivityView {
  activityId: string; status: string; provenance: "member_declared"; generation: number;
  registrationReceiptKey?: string; bindingReceiptKey?: string | null; resultReceiptKey?: string | null;
  nativeHandle?: NativeHandle | null; availability: string; correlation: string; unavailableReason?: string | null;
  originalResultRef?: { itemId: string | null; sourceKey: string } | null; limitations: string[];
  page?: ViewPage;
  detailSummary?: {
    mode: "original_record_reference"; omittedFields: string[];
    originalEvidenceRef: { kind: "activity.declaration"; keyField: "activityId" };
    unavailableReason: { present: boolean; utf8Bytes: number };
  };
}

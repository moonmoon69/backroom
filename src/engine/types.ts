import type { NativeToolSource, ReservedDispatchPolicy, ProviderActivity } from "./provider.ts";
import type { ActivityPacket, ActivityReceipt, LocalOperationPacket, OperationReceipt, OperationBinding, RunCapability, ToolResultRecord, ToolClosureRecord, DeclaredRegistration, DeclaredBinding, DeclaredResult } from "./operation-types.ts";
/** One room's append-only contract. IDs come from the caller, never aliases or clocks. */
export type SeatId = string;
export type Principal = SeatId | "$user" | "$system";
export type RequestId = string;
export type RunPhase = "prepared" | "sending" | "accepted" | "running" | "uncertain" | "rejected" | "terminal";
export type ControlPhase = "prepared" | "sending" | "uncertain" | "accepted" | "obsolete";
export type ActivityStatus = "pending" | "uncertain" | "done" | "failed";

export interface RequestContext {
  id: RequestId;
  rootId: RequestId;
  parentId: RequestId | null;
  owner: SeatId;
  returnTo: Principal;
  body: string;
  version: number;
  corrections: { eventId: string; seq: number; body: string }[];
}
export interface Request extends RequestContext {
  state: "open" | "answered" | "cancelled";
  answerId: string | null;
  live: { runId: string; providerRequestId: string } | null;
}
export interface Seat {
  id: SeatId;
  threadId: string;
  cursor: number;
  status: "active" | "stopping" | "retired";
  activeRunId: string | null;
}
export type InputIntent = "request" | "correction" | "result" | "cancel" | "retry" | "transfer" | "progress" | "error" | "attention";
export interface Input {
  eventId: string;
  seq: number;
  intent: InputIntent;
  body: string;
  requestIds: RequestId[];
  /** Required original content, not a notification or new reply obligation. */
  inherited: Input[];
}
export interface Envelope {
  base: number;
  through: number;
  inputs: Input[];
  openRequests: RequestContext[];
  /** Other room history can be rendered as optional context up to this bound. */
  contextThrough: number;
}
export interface SyncReceipt {
  id: string;
  digest: string;
  envelope: Envelope;
  confirmed: boolean;
}
export interface Run {
  id: string;
  seatId: SeatId;
  phase: RunPhase;
  envelope: Envelope;
  through: number;
  dispatchCommandId: string;
  dispatchMessageId: string;
  receipts: SyncReceipt[];
  failure: string | null;
  transport?: FrozenTransport;
  providerRunId?: string;
  nativeStatus?: string;
  queueHeld?: boolean;
}
/** Exact adapter command bytes and endpoint identity, journaled before any provider I/O. */
export interface FrozenTransport {
  wireJSON: string;
  digest: string;
  environmentId: string;
  serverVersion: string;
  contract: string;
  attempts: number;
  dispatchPolicy?: ReservedDispatchPolicy;
}
export type TransportTarget = { kind: "run" | "control"; id: string };
/** Non-waking, rebuildable provider uncertainty. It cannot manufacture work. */
export interface ProviderHold {
  key: string;
  seatId: string;
  runId: string | null;
  code: string;
  detail: string;
  held: boolean;
  /** Fixed causal sets never depend on the latest run or current open-request roster. */
  scope?: "dispatch" | "work" | "reseat";
  requestIds?: RequestId[];
}
/** Highest trusted full snapshot, scoped to one immutable seat/thread and provider origin. */
export interface ProviderObservation {
  seatId: SeatId;
  threadId: string;
  environmentId: string;
  serverVersion: string;
  contract: string;
  sequence: number;
  /** Known native work retains its identity until explicit settlement or exact root association. */
  pending: string[];
  sources?: NativeToolSource[];
  activities?: ProviderActivity[];
}
export interface Activity {
  id: string;
  seatId: SeatId;
  runId: string;
  requestIds: RequestId[];
  through: number;
  status: ActivityStatus;
  generation?: number;
  declaration?: { registration: DeclaredRegistration; binding?: DeclaredBinding; result?: DeclaredResult };
  nativeSource?: { providerRunId: string; generation: number; nativeId: string | null };
}
export interface Control {
  id: string;
  runId: string;
  requestId: RequestId;
  kind: "runtime_reply" | "interrupt";
  commandId: string;
  phase: ControlPhase;
  body: string;
  author: Principal;
  transport?: FrozenTransport;
}
export interface Subscription {
  seatId: SeatId;
  requestId: RequestId;
  milestones: string[];
}
export interface ClaimOutcome {
  requestId: RequestId;
  outcome: "answered" | "already_answered" | "late" | "superseded" | "pending_activity";
  returnTo: Principal;
}
export type Association = { kind: "run" | "activity"; id: string } | { kind: "orphan" } | { kind: "user" };
/** There is deliberately no prose/normal-final completion default. */
export type Disposition =
  | { kind: "answer"; requestIds: RequestId[] }
  | { kind: "progress"; requestIds: RequestId[]; milestone?: string }
  | { kind: "error"; requestIds: RequestId[] }
  | { kind: "yield" }
  | { kind: "silent" };

export type EventData =
  | { kind: "board.capability"; capability: RunCapability }
  | { kind: "activity.operation_receipt"; receipt: ActivityReceipt }
  | { kind: "activity.native_bound"; activityId: string; nativeId: string; generation: number }
  | { kind: "board.operation_receipt"; receipt: OperationReceipt }
  | { kind: "board.operation_binding"; binding: OperationBinding }
  | { kind: "tool.closed"; closure: ToolClosureRecord }
  | { kind: "activity.declared_bound"; activityId: string; binding: DeclaredBinding }
  | { kind: "activity.declared_result"; activityId: string; result: DeclaredResult }
  | { kind: "tool.result"; result: ToolResultRecord }
  | { kind: "provider.conflict"; seatId: string; runId: string; source: NativeToolSource; code: string }
  | { kind: "transport.frozen"; target: TransportTarget; transport: FrozenTransport }
  | { kind: "transport.attempt"; target: TransportTarget; attempt: number; evidence: string }
  | { kind: "provider.bound"; runId: string; providerRunId: string; evidence: string }
  | { kind: "provider.status"; runId: string; providerRunId: string; status: string; queueHeld: boolean; sequence: number }
  | { kind: "provider.hold"; hold: ProviderHold }
  | { kind: "provider.observed"; observation: ProviderObservation }
  | { kind: "seat.created"; seatId: SeatId; threadId: string; orchestrator: boolean }
  | { kind: "request"; request: RequestContext; live: Request["live"]; author: Principal; recipients: Principal[] }
  | { kind: "correction"; requestId: RequestId; body: string; author: Principal; recipients: Principal[] }
  | { kind: "cancel"; requestId: RequestId; applied: boolean; author: Principal; recipients: Principal[] }
  | { kind: "note" | "progress"; body: string; requestIds: RequestId[]; author: Principal; recipients: Principal[]; milestone: string | null }
  | { kind: "output"; body: string; author: Principal; association: Association; disposition: Disposition; claims: ClaimOutcome[]; recipients: Principal[]; sourceKey: string }
  | { kind: "notice"; intent: "error" | "attention"; body: string; requestIds: RequestId[]; author: Principal; recipients: Principal[]; causeId: string }
  | { kind: "run.prepared"; run: Run }
  | { kind: "run.phase"; runId: string; phase: Exclude<RunPhase, "prepared" | "terminal">; evidence: string }
  | { kind: "sync.offered"; runId: string; receipt: SyncReceipt }
  | { kind: "sync.confirmed"; runId: string; receiptId: string; evidence: string }
  | { kind: "run.ended"; runId: string; through: number; failure: string | null; consumed: boolean }
  | { kind: "activity.started"; activity: Activity }
  | { kind: "activity.status"; activityId: string; status: ActivityStatus; evidence: string; provenance?: "member_declared" }
  | { kind: "subscription"; subscription: Subscription; enabled: boolean }
  | { kind: "control.prepared"; control: Control; recipients: Principal[] }
  | { kind: "control.phase"; controlId: string; phase: Exclude<ControlPhase, "prepared">; evidence: string }
  | { kind: "retry"; runId: string; author: Principal; recipients: Principal[]; inherited: Input[]; requestIds: RequestId[]; body: string }
  | { kind: "transfer"; oldSeatId: SeatId; newSeatId: SeatId; threadId: string; cutoff: number; owned: RequestId[]; awaited: RequestId[]; inherited: Input[]; author: Principal; recipients: Principal[]; body: string; evidence: string }
  | { kind: "delivery.blocked"; seatId: SeatId; eventId: string; requiredBytes: number };

export interface RoomEvent {
  id: string;
  seq: number;
  commandKey: string;
  data: EventData;
}
/** All of these indices are disposable folds of RoomEvent[], never writable work. */
export interface Projection {
  events: readonly RoomEvent[];
  seats: Map<SeatId, Seat>;
  requests: Map<RequestId, Request>;
  runs: Map<string, Run>;
  activities: Map<string, Activity>;
  controls: Map<string, Control>;
  subscriptions: Subscription[];
  sourceKeys: Map<string, string>;
  commandKeys: Set<string>;
  blocked: Map<SeatId, string>;
  orchestrator: SeatId | null;
  providerHolds: Map<string, ProviderHold>;
  providerObservations: Map<SeatId, ProviderObservation>;
  capabilities: Map<string, RunCapability>;
  activityReceipts: Map<string, ActivityReceipt>;
  operationReceipts: Map<string, OperationReceipt>;
  operationBindings: Map<string, OperationBinding>;
  toolResults: Map<string, ToolResultRecord>;
  toolClosures: Map<string, ToolClosureRecord>;
}

interface CommandBase { id: string; actor: Principal }
export type Command = CommandBase & (
  | { type: "close_tool"; runId: string; source: NativeToolSource; sequence: number; sourceCheckpointDigest: string }
  | { type: "authorize_run"; capability: RunCapability }
  | { type: "activity_bind"; activityId: string; nativeId: string; generation: number; sequence: number }
  | { type: "local_operation"; packet: LocalOperationPacket }
  | { type: "activity_operation"; packet: ActivityPacket }
  | { type: "bind_operation"; receiptKey: string; source: NativeToolSource; confirmed: boolean }
  | { type: "source_conflict"; seatId: string; runId: string; source: NativeToolSource; code: string }
  | { type: "freeze_transport"; target: TransportTarget; transport: Omit<FrozenTransport, "attempts"> }
  | { type: "transport_attempt"; target: TransportTarget; expectedAttempts: number; evidence: string }
  | { type: "bind_provider"; runId: string; providerRunId: string; evidence: string }
  | { type: "provider_status"; runId: string; providerRunId: string; status: string; queueHeld: boolean; sequence: number }
  | { type: "observe_end"; runId: string; sourceKey: string; failure: string | null; evidence: string }
  | { type: "provider_hold"; hold: ProviderHold }
  | { type: "observe_provider"; observation: Omit<ProviderObservation, "pending">; pending: string[]; settled: string[] }
  | { type: "seat"; seatId: SeatId; threadId: string; orchestrator?: boolean }
  | { type: "request"; to: SeatId; body: string; parentId?: RequestId; live?: { runId: string; providerRequestId: string } }
  | { type: "correct"; requestId: RequestId; body: string }
  | { type: "cancel"; requestId: RequestId }
  | { type: "user_answer"; requestId: RequestId; body: string }
  | { type: "post"; intent: "note" | "progress"; body: string; requestIds?: RequestId[]; milestone?: string }
  | { type: "subscribe"; requestId: RequestId; milestones: string[]; enabled: boolean }
  | { type: "reserve"; seatId: SeatId; runId: string; dispatchCommandId: string; dispatchMessageId: string; maxBytes: number }
  | { type: "phase"; runId: string; phase: Exclude<RunPhase, "prepared" | "terminal">; evidence: string }
  | { type: "sync"; runId: string; receiptId: string; maxBytes: number }
  | { type: "confirm_sync"; runId: string; receiptId: string; digest: string; evidence: string }
  | { type: "output"; author: Principal; sourceKey: string; association: Association; body: string; disposition: Disposition; terminal?: boolean; activityCompletion?: "done" | "failed"; receipts?: { id: string; digest: string }[] }
  | { type: "activity_start"; activityId: string; runId: string; requestIds: RequestId[]; status: "pending" | "uncertain"; generation?: number; nativeSource?: Activity["nativeSource"]; declaration?: Activity["declaration"] }
  | { type: "activity_status"; activityId: string; status: ActivityStatus; evidence: string }
  | { type: "runtime_reply"; requestId: RequestId; body: string; commandId: string }
  | { type: "control_phase"; controlId: string; phase: Exclude<ControlPhase, "prepared">; evidence: string }
  | { type: "retry"; runId: string; body: string }
  | { type: "transfer"; oldSeatId: SeatId; newSeatId: SeatId; threadId: string; owned: RequestId[]; awaited: RequestId[]; body: string; evidence: string }
);
export type Selection = { kind: "idle" } | { kind: "blocked"; eventId: string; requiredBytes: number } | { kind: "ready"; envelope: Envelope };
/** Storage must append the entire batch only when its room head equals expectedSeq. */
export interface Decision {
  expectedSeq: number;
  events: RoomEvent[];
  outcome: "appended" | "duplicate" | "idle" | "blocked";
}

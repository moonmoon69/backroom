/** One room's append-only contract. IDs come from the caller, never aliases or clocks. */
export type SeatId = string;
export type Principal = SeatId | "$user" | "$system";
export type RequestId = string;
export type RunPhase = "prepared" | "sending" | "accepted" | "running" | "uncertain" | "rejected" | "terminal";
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
}
export interface Seat {
  id: SeatId;
  threadId: string;
  cursor: number;
  status: "active" | "retired";
  activeRunId: string | null;
}
export type InputIntent = "request" | "correction" | "result" | "cancel" | "retry" | "transfer" | "progress" | "error" | "attention" | "keep-alive";
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
  /** The T3 run that carries it, set by the `phase` that records T3 taking it (for spend and links). */
  providerRunId?: string;
}
export interface Activity {
  id: string;
  seatId: SeatId;
  runId: string;
  requestIds: RequestId[];
  through: number;
  status: ActivityStatus;
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
export type Association = { kind: "run" | "activity"; id: string } | { kind: "orphan" };
/** The engine has no prose default: the host names the disposition of every output it imports. */
export type Disposition =
  | { kind: "answer"; requestIds: RequestId[] }
  | { kind: "progress"; requestIds: RequestId[]; milestone?: string }
  | { kind: "error"; requestIds: RequestId[] }
  | { kind: "yield" }
  | { kind: "silent" };

export type EventData =
  | { kind: "seat.created"; seatId: SeatId; threadId: string; orchestrator: boolean }
  | { kind: "seat.retired"; seatId: SeatId; author: Principal; evidence: string }
  | { kind: "orchestrator.set"; seatId: SeatId | null; author: Principal }
  | { kind: "request"; request: RequestContext; author: Principal; recipients: Principal[] }
  | { kind: "correction"; requestId: RequestId; body: string; author: Principal; recipients: Principal[] }
  | { kind: "cancel"; requestId: RequestId; applied: boolean; author: Principal; recipients: Principal[] }
  | { kind: "note" | "progress"; body: string; requestIds: RequestId[]; author: Principal; recipients: Principal[]; milestone: string | null }
  | { kind: "output"; body: string; author: Principal; association: Association; disposition: Disposition; claims: ClaimOutcome[]; recipients: Principal[]; sourceKey: string }
  | { kind: "notice"; intent: "error" | "attention" | "keep-alive"; body: string; requestIds: RequestId[]; author: Principal; recipients: Principal[]; causeId: string }
  | { kind: "run.prepared"; run: Run }
  | { kind: "run.phase"; runId: string; phase: Exclude<RunPhase, "prepared" | "terminal">; evidence: string; providerRunId?: string }
  | { kind: "sync.offered"; runId: string; receipt: SyncReceipt }
  | { kind: "sync.confirmed"; runId: string; receiptId: string; evidence: string }
  | { kind: "run.ended"; runId: string; through: number; failure: string | null; consumed: boolean }
  | { kind: "activity.started"; activity: Activity }
  | { kind: "activity.status"; activityId: string; status: ActivityStatus; evidence: string }
  | { kind: "subscription"; subscription: Subscription; enabled: boolean }
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
  subscriptions: Subscription[];
  sourceKeys: Map<string, string>;
  commandKeys: Set<string>;
  blocked: Map<SeatId, string>;
  orchestrator: SeatId | null;
}

interface CommandBase { id: string; actor: Principal }
export type Command = CommandBase & (
  | { type: "seat"; seatId: SeatId; threadId: string; orchestrator?: boolean }
  | { type: "retire"; seatId: SeatId; evidence: string }
  | { type: "designate"; seatId: SeatId | null }
  | { type: "request"; to: SeatId; body: string; parentId?: RequestId }
  | { type: "correct"; requestId: RequestId; body: string }
  | { type: "cancel"; requestId: RequestId }
  | { type: "post"; intent: "note" | "progress"; body: string; requestIds?: RequestId[]; milestone?: string }
  | { type: "subscribe"; requestId: RequestId; milestones: string[]; enabled: boolean }
  | { type: "reserve"; seatId: SeatId; runId: string; dispatchCommandId: string; dispatchMessageId: string; maxBytes: number }
  | { type: "phase"; runId: string; phase: Exclude<RunPhase, "prepared" | "terminal">; evidence: string; providerRunId?: string }
  | { type: "sync"; runId: string; receiptId: string; maxBytes: number }
  | { type: "confirm_sync"; runId: string; receiptId: string; digest: string; evidence: string }
  | { type: "output"; author: Principal; sourceKey: string; association: Association; body: string; disposition: Disposition; terminal?: boolean; activityCompletion?: "done" | "failed" }
  | { type: "observe_end"; runId: string; sourceKey: string; failure: string | null; evidence: string }
  | { type: "activity_start"; activityId: string; runId: string; requestIds: RequestId[]; status: "pending" | "uncertain" }
  | { type: "activity_status"; activityId: string; status: ActivityStatus; evidence: string }
  | { type: "retry"; runId: string; body: string }
  | { type: "keep_alive"; seatId: SeatId; body: string }
  | { type: "blocked"; seatId: SeatId; state: string; requestIds: RequestId[]; body: string }
  | { type: "transfer"; oldSeatId: SeatId; newSeatId: SeatId; threadId: string; owned: RequestId[]; awaited: RequestId[]; body: string; evidence: string }
);
export type Selection = { kind: "idle" } | { kind: "blocked"; eventId: string; requiredBytes: number } | { kind: "ready"; envelope: Envelope };
/** Storage must append the entire batch only when its room head equals expectedSeq. */
export interface Decision {
  expectedSeq: number;
  events: RoomEvent[];
  outcome: "appended" | "duplicate" | "idle" | "blocked";
}

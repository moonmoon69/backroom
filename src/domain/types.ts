/**
 * Domain records for Backroom: the minimal records a room needs.
 * T3 identities (project, thread, message, turn, command) are stored as opaque strings.
 */

import type { Look } from "./look.ts";

export type RoomId = string;
export type ParticipantId = string;
export type BindingId = string;
export type RunId = string;
export type EventId = string;

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: unknown }> | undefined;
}

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";

export interface Room {
  id: RoomId;
  projectId: string;
  environmentId: string | null;
  title: string;
  /** Next room event sequence to assign. Events are 1-based and dense per room. */
  nextSequence: number;
  /** The room's agents get browsers: started for their work and described in their briefings. */
  browserEnabled: boolean;
  /** Browser the room's agents use unless their work calls for another; null means "general" (when it exists). */
  defaultBrowserId: string | null;
  /** Browsers the room's agents may use; null means all of them. */
  allowedBrowserIds: string[] | null;
  /**
   * The room's Consigliere, when it has one: the seated member the user talks to, who hands the work to the others
   * and reports back. A mark on a member; it carries no model or preset of its own.
   */
  consigliereId: ParticipantId | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A shared Chrome on this machine, named by purpose ("general", "backroom-testing"). Its profile (logins, tabs) and
 * ports live under data/browsers/<id>; the process is managed by RoomBrowsers. Any room may use any browser.
 */
export interface Browser {
  id: string;
  /** Slug agents use to name it: lowercase letters, digits and dashes. */
  name: string;
  /** What it is for and which logins it holds, written for agents. */
  description: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Browsers for a thread outside rooms: the choices a room makes for its agents (on or off, a default, the ones it may
 * use), made for the thread's one agent. A thread without a record has browsers off, like a new room.
 */
export interface ThreadBrowsers {
  threadId: string;
  browserEnabled: boolean;
  /** Its default; null means "general" (when it exists), as for a room. */
  defaultBrowserId: string | null;
  /** Browsers it may use; null means all of them. */
  allowedBrowserIds: string[] | null;
  updatedAt: string;
}

/**
 * What a project's new rooms start with: the same choices (on or off, a default, the ones they may use), copied into
 * each room made in the project, which then decides for itself. A project without a record gives its new rooms browsers
 * off, with no default and every browser, as before.
 */
export interface ProjectBrowsers {
  /** The T3 project's id. */
  projectId: string;
  browserEnabled: boolean;
  /** Its new rooms' default; null means "general" (when it exists), as for a room. */
  defaultBrowserId: string | null;
  /** Browsers its new rooms may use; null means all of them. */
  allowedBrowserIds: string[] | null;
  updatedAt: string;
}

/** The fallback default browser, created with the table. */
export const GENERAL_BROWSER_ID = "general";

/**
 * A seated crew member: a room-local alias for one T3 thread. The alias is what you type after @, what you say,
 * and what the tile shows; dictation forms are derived from it ("sol2" answers to "sol two"). The alias exists only
 * inside its room. The thread's model, options, and permission mode belong to T3: the room mirrors them from the
 * thread and can change them through T3, but never holds a competing copy. The role (a named set of rules) is
 * assigned in the room and can change without touching the thread.
 */
export interface Participant {
  id: ParticipantId;
  roomId: RoomId;
  alias: string;
  /** Mirror of the bound thread's current configuration in T3, refreshed each tick by the engine host. */
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** Generation of the current binding. */
  bindingGeneration: number;
  /** Set when the participant was removed from the room; kept for attribution of past events. */
  retiredAt: string | null;
  /** The crew member (preset) it was seated as, when there is one: it wears that preset's look in the pixel skin. */
  presetId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A participant's settings under a name: seated in a room (one new thread each time) or used to start a thread.
 * The name is the alias it takes in a room, with a number added when the room already has that alias.
 */
export interface Preset {
  id: string;
  name: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  /** Where its threads work: the project folder, or a new worktree from the project's default branch. */
  workspaceMode: "local" | "worktree";
  /** Its pixel look, every part named: the parts chosen, the rest their stable defaults (domain/look.ts). */
  look: Look;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBinding {
  id: BindingId;
  participantId: ParticipantId;
  generation: number;
  threadId: string;
  /** Highest room sequence that has been delivered to this binding. */
  deliveredCursor: number;
  bootstrapDeliveredAt: string | null;
  createdAt: string;
  retiredAt: string | null;
}

/**
 * What rooms.sqlite's events table holds. The room's board is its journal (data/board.sqlite); the service writes only
 * "system" notes here now. The other kinds are the rows the old runtime's timeline left in a database from before the
 * engine: the user's messages and notes, members' replies, turns typed in T3 ("t3.turn") and notes typed into a running
 * turn ("t3.message"), and what members sent each other with T3's tools ("member.message").
 */
export type RoomEventKind =
  | "user.message"
  | "note"
  | "assistant.reply"
  | "t3.turn"
  | "t3.message"
  | "member.message"
  | "system";

/**
 * The kinds that are posts: what was said, by the user, a member or in T3, as the board and the page list it. Only
 * posts take a post number; system notes are the room's bookkeeping and take none.
 */
export const POST_KINDS: ReadonlySet<RoomEventKind> = new Set<RoomEventKind>(["user.message", "note", "assistant.reply", "t3.turn", "t3.message", "member.message"]);

export type Speaker =
  | { type: "user" }
  | { type: "participant"; participantId: ParticipantId; bindingId: BindingId }
  /** member.message: a sender whose thread is not a member of the room, named by its thread's title. */
  | { type: "outside"; threadId: string; title: string }
  | { type: "system" };

export interface ArtifactRef {
  path?: string;
  kind?: string;
  additions?: number;
  deletions?: number;
  branch?: string;
  commit?: string;
  note?: string;
}

export interface RoomEvent {
  id: EventId;
  roomId: RoomId;
  /** Its place in the room's log of everything that happens (posts, system notes): ordering only. */
  sequence: number;
  /**
   * A post's number, as the page, the board and replies cite it ("#51"); null for events that are not posts. Posts
   * made before posts were numbered on their own keep their sequence as their number; later ones count on from the
   * room's highest post number, so they run without gaps.
   */
  postNumber: number | null;
  kind: RoomEventKind;
  speaker: Speaker;
  text: string;
  artifacts: ArtifactRef[];
  /** Images the user attached to this message (user.message events). */
  attachmentIds: string[];
  /** assistant.reply and t3.turn: the participant's earlier messages in the same turn (progress notes between tool calls). */
  progress: Array<{ text: string; at: string }>;
  /** t3.turn: the prompt typed in T3 that started the turn. */
  prompt: string | null;
  /** member.message: the member whose thread the message arrived in. */
  to: ParticipantId | null;
  /** t3.turn: how the turn ended, from the T3 run's status. Null on other kinds and on turns recorded before this existed. */
  outcome: "completed" | "interrupted" | "failed" | null;
  /** Source identity for deduplicating imported T3 content: the thread, the message, and the T3 run it belongs to. */
  sourceRef: { threadId: string; messageId: string; t3RunId: string | null } | null;
  createdAt: string;
}

/** An image the user attached in the room. Bytes live in SQLite; T3 receives them inline with the turn. */
export interface Attachment {
  id: string;
  roomId: RoomId;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

/** What T3 accepts on a turn (PROVIDER_SEND_TURN_* limits in T3's contracts). */
export const ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export interface NativeRequest {
  participantId: ParticipantId;
  threadId: string;
  requestId: string;
  kind: "approval" | "user-input";
  payload: unknown;
  createdAt: string;
}

export type { RoomBrowserStatus } from "../browser/roomBrowsers.ts";

/** A browser as the UI lists it: the record, its process state, and the rooms using it as their default. */
export interface BrowserListItem extends Browser {
  status: RoomBrowserStatus;
  usedBy: Array<{ roomId: string; title: string }>;
  /** Profile size on disk (logins, history, cache), only on the single-browser read. */
  profileBytes?: number | null;
}
import type { RoomBrowserStatus } from "../browser/roomBrowsers.ts";

export interface ParticipantStatus {
  /**
   * The thread's status in T3: idle before its first run, otherwise its active run's status (preparing, queued,
   * starting, running, waiting) or how its latest run ended (completed, interrupted, failed, cancelled, rolled_back).
   */
  status: "idle" | "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back" | "unknown";
  /** True when T3 was reachable but no longer has the bound thread (deleted in T3). */
  threadMissing: boolean;
  /** True when the thread is running a run the room did not dispatch. */
  externalActivity: boolean;
  pendingApprovals: boolean;
  pendingUserInput: boolean;
  activeRunId: RunId | null;
  /**
   * Work T3 reports as still running after the run settled: "working" while subagents or commands run (the agent
   * wakes itself when they finish), "monitoring" when only monitors remain, null when nothing runs in the background.
   */
  background: "working" | "monitoring" | null;
}

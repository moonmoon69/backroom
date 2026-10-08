/**
 * Reseating: a member hands its work to a fresh seat of the same saved crew member, so the work carries on from a
 * checkpoint the member wrote instead of from a context the harness compacted. The Consigliere asks for it with
 * `rooms-board reseat <alias>`; nothing starts one on its own (the context meter is information only).
 *
 *   1. The member is sent a task to write its checkpoint post (RoomService.reseatParticipant). It is queued like any
 *      task, so it runs after the work in hand, at a commit boundary, never mid-edit.
 *   2. When that post has landed and the member is idle, a fresh seat is made in the same folder, its first task
 *      carries the checkpoint, the member's pending tasks move to it, the Consigliere's mark moves to it when it was
 *      the member's, and the old seat leaves the room (RoomService.advanceReseats, run on every scheduler tick).
 *
 * What is in progress is kept in kv under reseat:<roomId>, so a restart carries on where it stopped.
 *
 * With the engine runtime (ROOMS_ENGINE=1) the same steps run on the journal instead (src/app/engineSeats.ts): the
 * checkpoint is a request, the handover one transfer event; the texts and the record for that path are at the end.
 */
import type { Repos } from "../db/repos.ts";

export const RESEAT_KEY_PREFIX = "reseat:";
export const reseatKey = (roomId: string): string => `${RESEAT_KEY_PREFIX}${roomId}`;

export interface Reseat {
  /** The member being reseated. */
  participantId: string;
  /** Who asked: the Consigliere (the same member, when he reseats himself). */
  by: string;
  /** What the fresh seat carries on with, as the Consigliere put it. */
  plan: string | null;
  /** The post that asked for the checkpoint, and the task it made. */
  requestEventId: string;
  checkpointTaskId: string;
  /** Ids chosen for the fresh seat before T3 is asked, so a retry after a restart asks for the same thread. */
  seat: { participantId: string; threadId: string; commandId: string };
  /** "checkpoint": waiting for the post; "seated": the fresh seat exists; "handed": its first task and the member's tasks are on it. */
  stage: "checkpoint" | "seated" | "handed";
  requestedAt: string;
}

export function readReseats(repos: Repos, roomId: string): Reseat[] {
  try {
    const list = JSON.parse(repos.getKv(reseatKey(roomId)) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as Reseat[]) : [];
  } catch {
    return [];
  }
}

export function writeReseats(repos: Repos, roomId: string, list: Reseat[]): void {
  if (list.length === 0) repos.deleteKv(reseatKey(roomId));
  else repos.setKv(reseatKey(roomId), JSON.stringify(list));
}

/** The task the member being reseated is sent: its checkpoint, for a reader who has none of its context. */
export function checkpointInstruction(input: { consigliere: boolean; plan: string | null }): string {
  return [
    `Reseat: a fresh seat of the same crew member takes over ${input.consigliere ? "as this room's Consigliere" : "your work"} from a clean context, and you leave the room once it has.`,
    "Stop at a commit boundary: finish or undo the edit in progress, commit what is done (or say exactly what is left uncommitted), and start nothing new.",
    "Then write your checkpoint as your reply to this task. It is the post the fresh seat reads first, so write it for a reader who has none of your context:",
    "- the decisions made and why;",
    "- the dead ends: what was tried and did not work, and why;",
    input.consigliere
      ? "- what is in flight: each member's task and what you are waiting for, what the user asked for and was last told;"
      : "- the state of the code: folder, branch, last commit, and what is uncommitted;",
    "- the exact next step, and what comes after it.",
    "Point at files, commits and post numbers rather than pasting them.",
    // The room state is what every fresh seat is given first (rooms-board state); the checkpoint adds what it lacks.
    ...(input.consigliere ? ["Before you write it, bring the room state up to date with `rooms-board state \"<text>\"`: the fresh seat is given it first."] : []),
    ...(input.plan ? [`What the fresh seat will carry on with: ${input.plan}`] : []),
  ].join("\n");
}

/** The fresh seat's first task: the checkpoint is above it in full (it is the result of the task this one waited on). */
export function takeoverInstruction(input: { from: string; consigliere: boolean; checkpointPost: string; plan: string | null; reportTo: string | null }): string {
  const lines = input.consigliere
    ? [
        `You take over as this room's Consigliere from @${input.from}, who was reseated so the room carries on from a clean context, and has left it. The members have been told you are the Consigliere now.`,
        `@${input.from}'s checkpoint is post ${input.checkpointPost}, above in full: the decisions and why, the dead ends, what is in flight and the next step.`,
      ]
    : [
        `You take over @${input.from}'s work: @${input.from} was reseated so the work carries on from a clean context, and has left the room. Its pending tasks are yours now.`,
        `Its checkpoint is post ${input.checkpointPost}, above in full: the decisions and why, the dead ends, the state of the code and the next step. You work in the same folder.`,
      ];
  if (input.plan) lines.push(`What to carry on with: ${input.plan}`);
  lines.push(
    input.consigliere
      ? "Read the posts it points at with `rooms-board read`, and what came after with `rooms-board index`, then carry on from the next step it names."
      : "Check it against `git log` and `git status`, read the posts it points at with `rooms-board read`, then carry on from the next step it names.",
  );
  if (input.reportTo) lines.push(`Your answer goes to @${input.reportTo}, as @${input.from}'s would have.`);
  return lines.join("\n");
}

// ---------- the engine runtime (ROOMS_ENGINE=1, stage 4/5 plan; src/app/engineSeats.ts) ----------
//
// The journal holds every fact of an engine reseat: the checkpoint request and its answer, the transfer to the fresh
// seat and the takeover request. What is kept here is only the app's plan for the next step: who asked, the plan text,
// and the IDs chosen for the fresh member before T3 is asked, so a retry after a restart asks for the same thread.

export const ENGINE_RESEAT_KEY_PREFIX = "engine.reseat:";
export const engineReseatKey = (roomId: string): string => `${ENGINE_RESEAT_KEY_PREFIX}${roomId}`;

export interface EngineReseat {
  /** The member being reseated, and its seat in the journal (its binding ID). */
  participantId: string;
  seatId: string;
  /** Who asked: the Consigliere (the same member, when he reseats himself). */
  by: string;
  plan: string | null;
  /** The checkpoint request: `reseat:<uuid>` (src/runtime/work.ts answers it alone). */
  requestId: string;
  /** The fresh member, chosen before T3 is asked. */
  fresh: { participantId: string; threadId: string; commandId: string };
  /** "checkpoint": waiting for the answer and an idle seat; "seated": the fresh member exists, the transfer is next. */
  stage: "checkpoint" | "seated";
  requestedAt: string;
}

export function readEngineReseats(repos: Repos, roomId: string): EngineReseat[] {
  try {
    const list = JSON.parse(repos.getKv(engineReseatKey(roomId)) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as EngineReseat[]) : [];
  } catch {
    return [];
  }
}

export function writeEngineReseats(repos: Repos, roomId: string, list: EngineReseat[]): void {
  if (list.length === 0) repos.deleteKv(engineReseatKey(roomId));
  else repos.setKv(engineReseatKey(roomId), JSON.stringify(list));
}

/** The checkpoint request's body on the engine. Its turn answers this request only; the rest goes to the fresh seat. */
export function engineCheckpointInstruction(input: { consigliere: boolean; plan: string | null; by: string | null }): string {
  return [
    `Reseat${input.by ? `, asked by @${input.by}` : ""}: a fresh seat of the same crew member takes over ${input.consigliere ? "as this room's Consigliere" : "your work"} from a clean context, and you leave the room once it has.`,
    "Stop at a commit boundary: finish or undo the edit in progress, commit what is done (or say exactly what is left uncommitted), and start nothing new.",
    "Then write your checkpoint as your final reply. This turn's reply answers this request only: your other open requests stay open and go to the fresh seat, with the posts for you that you have not been shown yet. Whatever else this briefing brings you is not acted on now: say in the checkpoint what it changes (the fresh seat is pointed at each such post by number).",
    "The checkpoint is the post the fresh seat reads first, so write it for a reader who has none of your context:",
    "- the decisions made and why;",
    "- the dead ends: what was tried and did not work, and why;",
    input.consigliere
      ? "- what is in flight: each member's request and what you are waiting for, what the user asked for and was last told;"
      : "- the state of the code: folder, branch, last commit, and what is uncommitted;",
    "- the exact next step, and what comes after it.",
    "Point at files, commits and post numbers rather than pasting them.",
    ...(input.consigliere ? ["Before you write it, bring the room state up to date with `rooms-board state \"<text>\"`: the fresh seat is given it first."] : []),
    ...(input.plan ? [`What the fresh seat will carry on with: ${input.plan}`] : []),
  ].join("\n");
}

/** The handover's body (the transfer event): the takeover, then the checkpoint in full. */
export function engineTakeoverInstruction(input: { from: string; consigliere: boolean; plan: string | null; checkpointNumber: number | null; checkpoint: string; alsoRead?: string[] }): string {
  const post = input.checkpointNumber === null ? "its checkpoint" : `its checkpoint (post #${input.checkpointNumber})`;
  return [
    input.consigliere
      ? `You take over as this room's Consigliere from @${input.from}, who was reseated so the room carries on from a clean context, and has left it. The requests the user and the members sent him are yours now, and every post for him that he had not seen comes with this handover.`
      : `You take over @${input.from}'s work: @${input.from} was reseated so the work carries on from a clean context, and has left the room. Its open requests are yours now, with who asked each, and every post for it that it had not seen comes with this handover.`,
    ...(input.plan ? [`What to carry on with: ${input.plan}`] : []),
    ...(input.alsoRead?.length
      ? [`@${input.from}'s checkpoint turn also brought these posts, which it read but did not act on; read each with \`rooms-board read <number>\`: ${input.alsoRead.join("; ")}.`]
      : []),
    "Your final reply answers every request handed over to you.",
    input.consigliere
      ? "Read the posts the checkpoint points at with `rooms-board read`, and what came after with `rooms-board index`, then carry on from the next step it names."
      : "Check it against `git log` and `git status`, read the posts it points at with `rooms-board read`, then carry on from the next step it names. You work in the same folder.",
    "",
    `@${input.from}'s ${post.replace(/^its /, "")}, in full:`,
    "",
    input.checkpoint,
  ].join("\n");
}

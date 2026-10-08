/**
 * Reseating: a member hands its work to a fresh seat of the same saved crew member, so the work carries on from a
 * checkpoint the member wrote instead of from a context the harness compacted. The Consigliere asks for it with
 * `rooms-board reseat <alias>`; nothing starts one on its own (the context meter is information only). The steps run on
 * the room's journal (src/app/engineSeats.ts): the checkpoint is a request, the handover one transfer event.
 */
import type { Repos } from "../db/repos.ts";

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

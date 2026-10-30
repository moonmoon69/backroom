/** What a room member is doing, from its T3 thread as the page reads it: the Members panel's label, the motion of its card, what runs. */
import { isRunActive, type Desk, type ParticipantStatus } from "./types.ts";
import { memberState, queueHeld as heldQueue, type MemberState } from "../../src/domain/memberState.ts";

/**
 * Between turns but not done, as T3 reports it: background work or monitoring left running after the turn, which the
 * agent wakes itself from when it finishes. Null mid-turn, or with nothing left running.
 */
export function betweenTurns(status: ParticipantStatus | undefined, desk?: Desk | null): "working" | "monitoring" | null {
  if (!status || isRunActive(status.status)) return null;
  return desk?.backgroundLiveness ?? status.background ?? null;
}

/** T3 holds the member's queue and runs nothing: what it was sent waits in that queue, room messages included. */
export function queueHeld(status: Pick<ParticipantStatus, "status"> | undefined, desk: Pick<Desk, "queue"> | null | undefined): boolean {
  return heldQueue(status?.status ?? "unknown", desk?.queue);
}

/**
 * The member's state (src/domain/memberState.ts) from its status and, when the page has it, its desk: what runs, its
 * queue, its plan. Not read yet (a member seated a moment ago, before T3's thread list was read for it): ready.
 */
export function memberActivity(status: ParticipantStatus | undefined, desk?: Desk | null, now = Date.now()): MemberState {
  return memberState(
    {
      status: status?.status ?? "unknown",
      missing: status?.threadMissing ?? false,
      approval: status?.pendingApprovals ?? false,
      secret: status?.pendingSecret ?? false,
      input: status?.pendingUserInput ?? false,
      paused: status?.paused ?? null,
      queue: desk?.queue ?? null,
      ownRun: Boolean(status?.activeRunId),
      external: status?.externalActivity ?? false,
      background: betweenTurns(status, desk),
      jobs: desk?.backgroundTasks ?? [],
      planReady: desk?.interactionMode === "plan" && desk.proposedPlan !== null && !desk.proposedPlan.implementedAt,
    },
    now,
  );
}

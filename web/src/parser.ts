/**
 * The server's composer parser (src/parser/explicit.ts), bundled into the UI so the plan and the in-text
 * highlighting follow every keystroke without a round trip. The server parses again on its own endpoint;
 * both read the same rules. Assigning the result to the client Draft type keeps types.ts honest.
 *
 * Decision D2: /after, /hold and the waits a message implies are refused with the hint the server gives, so the composer
 * shows them before anything is sent.
 */
import { parseExplicit, type ParticipantRef } from "../../src/parser/explicit.ts";
import { isActiveParticipant, isRunActive, type Draft, type RoomSnapshot } from "./types.ts";

export function parseDraft(text: string, snapshot: Pick<RoomSnapshot, "participants" | "participantStatus"> & { room?: Pick<RoomSnapshot["room"], "consigliereId"> }): Draft {
  const participants: ParticipantRef[] = snapshot.participants.filter(isActiveParticipant).map((p) => {
    const status = snapshot.participantStatus[p.id];
    return {
      id: p.id,
      alias: p.alias,
      // The same notion of "busy" alias pools use (@sol → a free member of sol1, sol2, …): a run, or T3 in a turn.
      busy: Boolean(status && (status.activeRunId !== null || status.externalActivity || isRunActive(status.status) || status.threadMissing)),
    };
  });
  // In a room that has a Consigliere, what addresses nobody is for him, and @all leaves him out.
  const draft: Draft = parseExplicit(text, participants, { consigliereId: snapshot.room?.consigliereId ?? null });
  return draft;
}

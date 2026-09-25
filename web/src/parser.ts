/**
 * The server's composer parser (src/parser/explicit.ts), bundled into the UI so the plan and the in-text
 * highlighting follow every keystroke without a round trip. The server parses again on its own endpoint;
 * both read the same rules. Assigning the result to the client Draft type keeps types.ts honest.
 */
import { parseExplicit, type ParticipantRef } from "../../src/parser/explicit.ts";
import { isActiveParticipant, type Draft, type RoomSnapshot, type TaskState } from "./types.ts";

/** Same notion of "busy" the server uses for alias pools (@sol → a free member of sol1, sol2, …). */
const BUSY_STATES: ReadonlySet<TaskState> = new Set(["dispatching", "running", "needs_input", "queued"]);

export function parseDraft(text: string, snapshot: Pick<RoomSnapshot, "participants" | "tasks" | "roles" | "participantStatus">): Draft {
  const busy = new Set(snapshot.tasks.filter((t) => BUSY_STATES.has(t.state)).map((t) => t.participantId));
  const participants: ParticipantRef[] = snapshot.participants.filter(isActiveParticipant).map((p) => {
    const status = snapshot.participantStatus[p.id];
    return {
      id: p.id,
      alias: p.alias,
      busy: busy.has(p.id) || Boolean(status && (status.externalActivity || status.activeRunId !== null || status.threadMissing)),
    };
  });
  const roles = snapshot.roles.map((r) => ({ id: r.id, name: r.name }));
  const draft: Draft = parseExplicit(text, participants, snapshot.tasks, roles);
  return draft;
}

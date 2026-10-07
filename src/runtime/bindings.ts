/**
 * Seats are participant bindings: a seat's ID is its binding's ID and its thread the binding's thread, so a reseat (a
 * new binding on a fresh thread) is a new seat. This is the briefing source the app gives the host: the room, the
 * member and the room's members from rooms.sqlite. Workspaces and browsers stay out of the engine briefing until L4b
 * seats members through the engine.
 */
import { CONSIGLIERE_RULES_KEY } from "../app/consigliere.ts";
import { readRoomState } from "../app/roomState.ts";
import { agentKey } from "../browser/catalog.ts";
import type { Repos } from "../db/repos.ts";
import type { BriefingSource } from "./render.ts";

export function bindingSource(repos: Repos, options: { boardCommand?: string } = {}): BriefingSource {
  const member = (seatId: string) => {
    const binding = repos.getBinding(seatId);
    return binding ? repos.getParticipant(binding.participantId) : null;
  };
  return {
    standing(roomId, seatId) {
      const participant = member(seatId);
      const room = repos.getRoom(roomId);
      if (!participant || !room) throw new Error(`seat ${seatId} is not a member's binding in room ${roomId}`);
      return {
        room,
        participant,
        participantsById: new Map(repos.listParticipants(roomId).map((p) => [p.id, p])),
        board: { command: options.boardCommand ?? "rooms-board", as: agentKey(participant.alias, roomId) },
        consigliereRules: repos.getKv(CONSIGLIERE_RULES_KEY),
        roomState: readRoomState(repos, roomId),
        browsers: null,
        workspaces: null,
      };
    },
    alias: (_roomId, seatId) => member(seatId)?.alias ?? null,
  };
}

/**
 * Seats are participant bindings: a seat's ID is its binding's ID and its thread the binding's thread, so a reseat (a
 * new binding on a fresh thread) is a new seat. This is the briefing source the app gives the host: the room, the
 * member and the room's members from rooms.sqlite. Workspaces and browsers stay out of the engine briefing until L4b
 * seats members through the engine.
 */
import type { T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { openRequests } from "../adapter/types.ts";
import { CONSIGLIERE_RULES_KEY } from "../app/consigliere.ts";
import { readRoomState } from "../app/roomState.ts";
import { requestPayload } from "../app/threadView.ts";
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

/**
 * Approvals and questions stay off the journal, on the native-requests path the app already has (plan §6): the open ones
 * T3 lists for a seat's thread are mirrored into native_requests, where the user answers them and the status bar shows
 * them, and the rest are resolved. The same rows and rules as the old scheduler's observe pass.
 */
export function nativeRequestMirror(repos: Repos, notify: (roomId: string) => void) {
  return async (at: { roomId: string; seatId: string; threadId: string }, shell: T3ThreadShell, detail: () => Promise<T3ThreadDetail | null>): Promise<void> => {
    const binding = repos.getBinding(at.seatId);
    if (!binding) return;
    const existing = repos.listOpenNativeRequests([binding.participantId]);
    if (!shell.pendingRequest && existing.length === 0) return;
    const loaded = shell.pendingRequest ? await detail() : null;
    if (shell.pendingRequest && !loaded) return;
    const open = loaded ? openRequests(loaded) : [];
    const ids = new Set(open.map((request) => request.id));
    let changed = false;
    for (const row of existing) {
      if (ids.has(row.requestId)) continue;
      repos.resolveNativeRequest(row.threadId, row.requestId);
      changed = true;
    }
    for (const request of open) {
      if (repos.upsertNativeRequest({ participantId: binding.participantId, threadId: at.threadId, requestId: request.id, kind: request.type, payload: requestPayload(request), createdAt: request.createdAt })) changed = true;
    }
    if (changed) notify(at.roomId);
  };
}

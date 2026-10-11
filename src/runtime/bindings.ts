/**
 * Seats are participant bindings: a seat's ID is its binding's ID and its thread the binding's thread, so a reseat (a
 * new binding on a fresh thread) is a new seat. This is the briefing source the app gives the host: the room, the
 * member and the room's members from rooms.sqlite, where each member works (T3 and git), the room's browsers, the
 * user's saved crew (the Consigliere's section), the engine's wording of the standing facts and the Consigliere's rules
 * (L4b), and which envelope seats a member.
 */
import type { T3Adapter, T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { openRequests } from "../adapter/types.ts";
import { CONSIGLIERE_RULES_KEY, engineConsigliereRules, engineSeatFacts } from "../app/consigliere.ts";
import { readRoomState } from "../app/roomState.ts";
import { requestPayload } from "../app/threadView.ts";
import type { BrowsersBriefing } from "../briefing/assemble.ts";
import { agentKey, browsersForRoom, effectiveBrowser } from "../browser/catalog.ts";
import type { BrowserBriefing } from "../browser/roomBrowsers.ts";
import type { Repos } from "../db/repos.ts";
import type { Participant, Room } from "../domain/types.ts";
import { roomWorkspaces } from "../git/workspaces.ts";
import type { BriefingSource } from "./render.ts";
import { SEAT_BRIEFING } from "./work.ts";
export { MOVED, RESEAT_OFF, SEAT_BRIEFING, backroomRequest } from "./work.ts";

/** The room browsers, as the server has them: starting the room's default for a briefing, and whether others run. */
export interface BriefingBrowsers {
  briefingFor(browser: { id: string; name: string; description: string }): Promise<BrowserBriefing | null>;
  status?(browserId: string): { state: string };
}

export interface BindingSourceOptions {
  /** How agents run rooms-board; named in briefings. */
  boardCommand?: string;
  /** Where every member works is read through T3 (and git); without it the section is left out. */
  adapter?: T3Adapter;
  /** The room browsers, when this service may start them. */
  browsers?: BriefingBrowsers | null;
  /** How agents run rooms-browser; named in briefings. */
  browserCommand?: string;
  /** The images a user message came with (L4a, src/app/engineMessages.ts). */
  images?: BriefingSource["images"];
  log?: (message: string, detail?: unknown) => void;
}

/** The browsers section for one agent: the room's allowed browsers, its default started, the agent's own key. */
export async function browsersBriefing(repos: Repos, room: Room, participant: Participant, options: BindingSourceOptions): Promise<BrowsersBriefing | null> {
  const manager = options.browsers;
  const defaultBrowser = effectiveBrowser(repos, room);
  if (!manager || !defaultBrowser) return null;
  const started = await manager.briefingFor(defaultBrowser);
  if (!started) return null;
  return {
    command: options.browserCommand ?? "rooms-browser",
    as: agentKey(participant.alias, room.id),
    started,
    browsers: browsersForRoom(repos, room).map((browser) => ({
      name: browser.name,
      description: browser.description,
      isDefault: browser.id === defaultBrowser.id,
      running: browser.id === defaultBrowser.id || manager.status?.(browser.id).state === "running",
    })),
  };
}

export function bindingSource(repos: Repos, options: BindingSourceOptions = {}): BriefingSource {
  const member = (seatId: string) => {
    const binding = repos.getBinding(seatId);
    return binding ? repos.getParticipant(binding.participantId) : null;
  };
  return {
    async standing(roomId, seatId) {
      const participant = member(seatId);
      const room = repos.getRoom(roomId);
      if (!participant || !room) throw new Error(`seat ${seatId} is not a member's binding in room ${roomId}`);
      // Where everyone works and the browsers never hold up work: unreadable, they are left out.
      const workspaces = options.adapter
        ? await roomWorkspaces(options.adapter, repos, roomId).catch((error: unknown) => {
          options.log?.("workspaces unreadable", (error as Error).message);
          return null;
        })
        : null;
      const browsers = room.browserEnabled
        ? await browsersBriefing(repos, room, participant, options).catch((error: unknown) => {
          options.log?.("browsers unavailable", (error as Error).message);
          return null;
        })
        : null;
      return {
        room,
        participant,
        participantsById: new Map(repos.listParticipants(roomId).map((p) => [p.id, p])),
        board: { command: options.boardCommand ?? "rooms-board", as: agentKey(participant.alias, roomId) },
        consigliereRules: engineConsigliereRules(repos.getKv(CONSIGLIERE_RULES_KEY)),
        seatFacts: engineSeatFacts,
        crew: repos.listPresets(),
        roomState: readRoomState(repos, roomId),
        browsers,
        workspaces,
      };
    },
    alias: (_roomId, seatId) => member(seatId)?.alias ?? null,
    seatBriefing: (_roomId, _seatId, envelope) => envelope.inputs.some((input) => input.intent === "request" && input.requestIds.some((id) => id.startsWith(SEAT_BRIEFING))),
    // The images a user message came with (L4a, src/app/engineMessages.ts).
    ...(options.images ? { images: options.images } : {}),
  };
}

/**
 * Approvals and questions stay off the journal, on the native-requests path the app already has (plan §6): the open ones
 * T3 lists for a seat's thread are mirrored into native_requests, where the user answers them and the status bar shows
 * them, and the rest are resolved.
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

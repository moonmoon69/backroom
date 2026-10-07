/**
 * The room state: a room's curated memory, which outlives its threads. The Consigliere keeps it current at milestones
 * with `rooms-board state "<text>"` (the user's standing decisions, the plan's status, who holds what, open questions),
 * and every thread's first briefing carries it, so a fresh seat, a new Consigliere among them, starts from it instead of
 * from a transcript. One text per room, in the kv table.
 */
import type { Repos } from "../db/repos.ts";

/** Longer than this is refused: the state is a summary to keep current, not a log. */
export const ROOM_STATE_MAX_CHARS = 8_000;

export interface RoomState {
  text: string;
  /** The alias of the member who wrote it, as it was then. */
  by: string;
  at: string;
}

/** kv key of a room's state. */
export const roomStateKey = (roomId: string): string => `room.state:${roomId}`;

export function readRoomState(repos: Repos, roomId: string): RoomState | null {
  const raw = repos.getKv(roomStateKey(roomId));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as Partial<RoomState>;
    return typeof state.text === "string" && state.text.trim() ? { text: state.text, by: String(state.by ?? ""), at: String(state.at ?? "") } : null;
  } catch {
    return null;
  }
}

export function writeRoomState(repos: Repos, roomId: string, state: RoomState): void {
  repos.setKv(roomStateKey(roomId), JSON.stringify(state));
}

/** The state's first line, as a room's one-line blurb (the Overview's room tile): its markdown marks left out. */
export function roomStateLine(text: string, max = 300): string {
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  const line = first.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The state as the page reads it: with its first line, which the closed panel shows. */
export type RoomStateView = RoomState & { line: string };

export function roomStateView(repos: Repos, roomId: string): RoomStateView | null {
  const state = readRoomState(repos, roomId);
  return state ? { ...state, line: roomStateLine(state.text) } : null;
}

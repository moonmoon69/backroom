/**
 * The street (Settings → Look → Street) as a pure function of what Backroom already knows: projects in their sidebar
 * order become businesses along one block, their rooms and loose threads become lit windows, and nothing about the
 * street is stored. The social club is always the first lot and an empty shop to rent always the last. Which business
 * a project runs, and its colours, come from the project's id, so renaming a project changes only its sign.
 */
import type { RoomListItem, T3Project, T3ThreadShell } from "../types.ts";

/** Scene pixels. */
export const CLUB_W = 92;
export const LOT_W = 88;
export const RENT_W = 76;
/** A little brick between neighbours. */
export const GAP = 4;
export const WINDOWS_PER_FLOOR = 3;
/** Standard heights, in floors above the shop: a few sizes rather than a tower per room. */
export const MAX_FLOORS = 3;

export type Business = "diner" | "print" | "tailor" | "jazz" | "bakery" | "barber" | "pawn" | "laundry" | "pizza" | "deli";

export const BUSINESSES: Array<{ key: Business; word: string }> = [
  { key: "diner", word: "Diner" },
  { key: "print", word: "Print Shop" },
  { key: "tailor", word: "Tailor" },
  { key: "jazz", word: "Jazz Club" },
  { key: "bakery", word: "Bakery" },
  { key: "barber", word: "Barbershop" },
  { key: "pawn", word: "Pawn Shop" },
  { key: "laundry", word: "Laundromat" },
  { key: "pizza", word: "Pizzeria" },
  { key: "deli", word: "Deli" },
];

/** Façade colours: brick, its mortar and shadow, the trim, and the awning's two stripes. */
export interface Facade {
  brick: string;
  mortar: string;
  shade: string;
  trim: string;
  awning: string;
  stripe: string;
}

export const FACADES: Facade[] = [
  { brick: "#8a3b2c", mortar: "#6c2d22", shade: "#5a241b", trim: "#d9cfb4", awning: "#2f5d46", stripe: "#e8dfc4" },
  { brick: "#7a4a36", mortar: "#5f392a", shade: "#4b2d21", trim: "#e2d6b8", awning: "#8a2f2f", stripe: "#f0e6cc" },
  { brick: "#5d4a44", mortar: "#4a3a35", shade: "#3a2e2a", trim: "#cfc4a8", awning: "#b58b2a", stripe: "#f3e9c9" },
  { brick: "#9a5a3a", mortar: "#7c472d", shade: "#633823", trim: "#efe4c8", awning: "#34506e", stripe: "#e9e1cb" },
  { brick: "#6e3a3a", mortar: "#582e2e", shade: "#452424", trim: "#d8ccae", awning: "#4d6b3a", stripe: "#efe6c9" },
  { brick: "#7d6a55", mortar: "#665644", shade: "#524436", trim: "#e6dcc2", awning: "#7a3350", stripe: "#f2e7cf" },
];

/** What a window shows, most pressing first. */
export type WindowState = "needs" | "failed" | "working" | "background" | "idle" | "dark";

export interface StreetWindow {
  kind: "room" | "thread";
  id: string;
  title: string;
  state: WindowState;
  /** A few words for the hover and for screen readers: "2 working", "needs you", "turn failed". */
  label: string;
  /** Finished replies nobody has looked at yet. */
  unseen: number;
  /** Seated members (rooms); 1 for a thread on its own. */
  members: number;
}

export interface Lot {
  kind: "club" | "business" | "rent";
  /** Left edge and width, in scene pixels along the street. */
  x: number;
  width: number;
  project: { id: string; title: string; workspaceRoot: string | null } | null;
  business: (typeof BUSINESSES)[number] | null;
  facade: Facade;
  /** Floors above the shop: 1 to MAX_FLOORS. */
  floors: number;
  /** Rooms and loose threads that have a window, in their order along the floors (top floor first). */
  windows: StreetWindow[];
  /** The ones past the building's windows: listed in the lobby directory only. */
  hidden: StreetWindow[];
  /** Threads T3 has settled: done for now, in the directory. */
  settled: T3ThreadShell[];
  needs: number;
  working: number;
  unseen: number;
  /** Details that follow from the id: a water tower on the roof, a fire escape, a street lamp after the lot. */
  waterTower: boolean;
  fireEscape: boolean;
  lamp: boolean;
  seed: number;
}

export interface Street {
  lots: Lot[];
  width: number;
}

export function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

const RANK: Record<WindowState, number> = { needs: 0, failed: 1, working: 2, background: 3, idle: 4, dark: 5 };

export function roomWindow(room: RoomListItem): StreetWindow {
  const unseen = room.news?.unseen ?? 0;
  const working = Math.max(room.working, room.activity?.turn ?? 0);
  const needs = room.activity?.needsInput ?? 0;
  const failed = unseen > 0 && room.news?.latest?.kind === "failed";
  const background = (room.activity?.background ?? 0) + (room.activity?.monitoring ?? 0);
  const state: WindowState =
    needs > 0 ? "needs" : failed ? "failed" : working > 0 ? "working" : background > 0 ? "background" : room.participantCount > 0 ? "idle" : "dark";
  const parts = [
    needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : null,
    failed ? "a turn failed" : null,
    working > 0 ? `${working} working` : null,
    state === "background" ? "background work" : null,
    unseen > 0 && !failed ? `${unseen} new repl${unseen === 1 ? "y" : "ies"}` : null,
    state === "idle" ? `${room.participantCount} at the table` : null,
    state === "dark" ? "nobody seated" : null,
  ].filter(Boolean);
  return { kind: "room", id: room.id, title: room.title, state, label: parts.join(" · "), unseen, members: room.participantCount };
}

export function threadWindow(thread: T3ThreadShell): StreetWindow {
  const status = thread.session?.status;
  const unseen = thread.news ? 1 : 0;
  const state: WindowState =
    thread.hasPendingApprovals || thread.hasPendingUserInput
      ? "needs"
      : thread.news?.state === "error" || status === "error"
        ? "failed"
        : status === "running" || status === "starting"
          ? "working"
          : thread.backgroundLiveness
            ? "background"
            : "idle";
  const label =
    state === "needs"
      ? thread.hasPendingApprovals
        ? "needs your approval"
        : "has a question for you"
      : state === "failed"
        ? "its turn failed"
        : state === "working"
          ? "working"
          : state === "background"
            ? thread.backgroundLiveness === "monitoring"
              ? "monitoring"
              : "background work"
            : unseen
              ? "new reply"
              : "idle";
  return { kind: "thread", id: thread.id, title: thread.title, state, label, unseen, members: 1 };
}

const lastActive = (thread: T3ThreadShell): string => thread.latestUserMessageAt ?? thread.updatedAt;

/**
 * Up to `capacity` windows, keeping the given order, but never leaving out one that needs you or failed while a quiet
 * one has a window.
 */
function pickWindows(all: StreetWindow[], capacity: number): { shown: StreetWindow[]; hidden: StreetWindow[] } {
  if (all.length <= capacity) return { shown: all, hidden: [] };
  const byUrgency = all.map((w, index) => ({ w, index })).sort((a, b) => RANK[a.w.state] - RANK[b.w.state] || a.index - b.index);
  const keep = new Set(byUrgency.slice(0, capacity).map((entry) => entry.index));
  return { shown: all.filter((_, i) => keep.has(i)), hidden: all.filter((_, i) => !keep.has(i)) };
}

function businessLot(
  x: number,
  project: { id: string; title: string; workspaceRoot: string | null },
  rooms: RoomListItem[],
  threads: T3ThreadShell[],
): Lot {
  const seed = hashOf(project.id);
  const loose = threads.filter((t) => !t.boundToRoom && !t.deletedAt && !t.archivedAt);
  const active = loose.filter((t) => !t.settledAt).sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
  const settled = loose.filter((t) => t.settledAt).sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
  const all = [...rooms.map(roomWindow), ...active.map(threadWindow)];
  const floors = Math.min(MAX_FLOORS, Math.max(1, Math.ceil(all.length / WINDOWS_PER_FLOOR)));
  const { shown, hidden } = pickWindows(all, floors * WINDOWS_PER_FLOOR);
  return {
    kind: "business",
    x,
    width: LOT_W,
    project,
    business: BUSINESSES[seed % BUSINESSES.length]!,
    facade: FACADES[(seed >>> 5) % FACADES.length]!,
    floors,
    windows: shown,
    hidden,
    settled,
    needs: all.filter((w) => w.state === "needs").length,
    working: all.filter((w) => w.state === "working").length,
    unseen: all.reduce((sum, w) => sum + w.unseen, 0),
    waterTower: floors === MAX_FLOORS || ((seed >>> 9) & 3) === 0,
    fireEscape: floors >= 2 && ((seed >>> 11) & 1) === 1,
    lamp: ((seed >>> 13) & 1) === 1,
    seed,
  };
}

const PLAIN: Facade = { brick: "#3f4a3f", mortar: "#334033", shade: "#283228", trim: "#d8cfae", awning: "#2b3a2f", stripe: "#c9b98a" };

/**
 * The block: the social club, then a business per project in the sidebar's order (rooms of a project T3 no longer
 * lists get a business of their own at the end), then the shop to rent.
 */
export function layoutStreet(projects: T3Project[] | null, rooms: RoomListItem[], threads: T3ThreadShell[]): Street {
  const lots: Lot[] = [];
  const base = { business: null, windows: [], hidden: [], settled: [], needs: 0, working: 0, unseen: 0, waterTower: false, fireEscape: false, project: null };
  lots.push({ ...base, kind: "club", x: 0, width: CLUB_W, facade: PLAIN, floors: 2, lamp: true, seed: 0 });
  let x = CLUB_W + GAP;
  const known = new Set((projects ?? []).map((p) => p.id));
  const listed: Array<{ id: string; title: string; workspaceRoot: string | null }> = (projects ?? []).map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot }));
  for (const room of rooms) {
    if (!known.has(room.projectId)) {
      known.add(room.projectId);
      listed.push({ id: room.projectId, title: projects ? "Unknown project" : "", workspaceRoot: null });
    }
  }
  for (const project of listed) {
    lots.push(
      businessLot(
        x,
        project,
        rooms.filter((r) => r.projectId === project.id),
        threads.filter((t) => t.projectId === project.id),
      ),
    );
    x += LOT_W + GAP;
  }
  lots.push({ ...base, kind: "rent", x, width: RENT_W, facade: FACADES[2]!, floors: 1, lamp: false, seed: 1 });
  return { lots, width: x + RENT_W };
}

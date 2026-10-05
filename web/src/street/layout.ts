/**
 * The street (Settings → Look → Street) as a pure function of what Backroom already knows: projects in their sidebar
 * order become businesses along one block, their rooms and loose threads become lit windows, and nothing about the
 * street is stored. The social club is always the first lot and an empty shop to rent always the last. What a building
 * looks like (its trade, walls, roof, which side its door is on) comes from the project's id, so renaming a project
 * changes only its sign and reordering the sidebar only moves it; no two businesses share a trade while there are
 * trades left.
 */
import { isRunActive, pendingKind, type RoomListItem, type T3Project, type T3ThreadShell } from "../types.ts";

/** Scene pixels: six 16-pixel tiles to a building, an alley between neighbours. */
export const CLUB_W = 96;
export const LOT_W = 96;
export const RENT_W = 80;
export const GAP = 8;
export const WINDOWS_PER_FLOOR = 3;
/** Standard heights, in floors above the shop: a few sizes rather than a tower per room. */
export const MAX_FLOORS = 3;

export type Business = "diner" | "print" | "tailor" | "jazz" | "bakery" | "barber" | "pawn" | "laundry" | "pizza" | "deli" | "books" | "florist";

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
  { key: "books", word: "Bookshop" },
  { key: "florist", word: "Florist" },
];

export type Material = "brick" | "stone" | "clapboard";
export type Roof = "flat" | "mansard" | "gable";

/** A building's walls: what they are made of, their three tones (and mortar), the trim, and the awning's stripes. */
export interface Facade {
  material: Material;
  base: string;
  light: string;
  dark: string;
  mortar: string;
  trim: string;
  awning: string;
  stripe: string;
}

export const FACADES: Facade[] = [
  { material: "brick", base: "#9a4632", light: "#b25a40", dark: "#7a3526", mortar: "#5e2a1f", trim: "#dcd2b4", awning: "#2f6a4a", stripe: "#ece2c6" },
  { material: "brick", base: "#7e4c38", light: "#95604a", dark: "#643a2a", mortar: "#4a2b20", trim: "#e2d6b8", awning: "#9a3030", stripe: "#f2e8ce" },
  { material: "stone", base: "#b8a584", light: "#cdbc9a", dark: "#98876a", mortar: "#7e6f56", trim: "#efe6cf", awning: "#34507a", stripe: "#ece4ce" },
  { material: "clapboard", base: "#4f7a6a", light: "#64907e", dark: "#3c5f52", mortar: "#2c463c", trim: "#eee6cf", awning: "#b8862a", stripe: "#f4ead0" },
  { material: "brick", base: "#6e4a5a", light: "#855c6e", dark: "#573a48", mortar: "#3e2834", trim: "#dcd0b6", awning: "#4d6b3a", stripe: "#efe6c9" },
  { material: "stone", base: "#8c7a6c", light: "#a39080", dark: "#716256", mortar: "#5a4d44", trim: "#e6dcc2", awning: "#7a3350", stripe: "#f2e7cf" },
  { material: "clapboard", base: "#6a7aa0", light: "#8090b6", dark: "#55638a", mortar: "#3e486a", trim: "#eee8d6", awning: "#a0402e", stripe: "#f4ecd6" },
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
  roof: Roof;
  /** Which side of the shop front the door is on. */
  door: "left" | "right";
  /** A cat sits on this building's step. */
  cat: boolean;
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
  const status = thread.status;
  const pending = pendingKind(thread);
  const unseen = thread.news ? 1 : 0;
  const state: WindowState =
    pending
      ? "needs"
      : thread.news?.state === "error" || status === "failed"
        ? "failed"
        : isRunActive(status)
          ? "working"
          : thread.backgroundLiveness
            ? "background"
            : "idle";
  const label =
    state === "needs"
      ? pending === "approval"
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

const ROOFS: Roof[] = ["flat", "mansard", "gable", "flat"];

/**
 * A trade for each project: the one its id points to, or the next one no other business has. Settled in the order of
 * the projects' ids, not the sidebar's, so moving a building along the street never changes what it sells.
 */
export function assignTrades(projectIds: string[]): Map<string, (typeof BUSINESSES)[number]> {
  const out = new Map<string, (typeof BUSINESSES)[number]>();
  const taken = new Set<number>();
  for (const id of [...projectIds].sort()) {
    const first = hashOf(id) % BUSINESSES.length;
    let pick = first;
    for (let step = 0; step < BUSINESSES.length; step++) {
      const candidate = (first + step) % BUSINESSES.length;
      if (!taken.has(candidate)) {
        pick = candidate;
        break;
      }
    }
    taken.add(pick);
    if (taken.size === BUSINESSES.length) taken.clear();
    out.set(id, BUSINESSES[pick]!);
  }
  return out;
}

function businessLot(
  x: number,
  project: { id: string; title: string; workspaceRoot: string | null },
  business: (typeof BUSINESSES)[number],
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
    business,
    facade: FACADES[(seed >>> 5) % FACADES.length]!,
    roof: ROOFS[(seed >>> 17) % ROOFS.length]!,
    door: ((seed >>> 21) & 1) === 1 ? "left" : "right",
    cat: (seed >>> 23) % 5 === 0,
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

const CLUB: Facade = { material: "clapboard", base: "#2f5a44", light: "#3e6e55", dark: "#244634", mortar: "#183025", trim: "#d4b25a", awning: "#1f4232", stripe: "#d4b25a" };
const EMPTY: Facade = { material: "brick", base: "#6a5a50", light: "#7e6c60", dark: "#554840", mortar: "#40362f", trim: "#b8ad96", awning: "#5a5048", stripe: "#8a8070" };

/**
 * The block: the social club, then a business per project in the sidebar's order (rooms of a project T3 no longer
 * lists get a business of their own at the end), then the shop to rent.
 */
export function layoutStreet(projects: T3Project[] | null, rooms: RoomListItem[], threads: T3ThreadShell[]): Street {
  const lots: Lot[] = [];
  const base = { business: null, windows: [], hidden: [], settled: [], needs: 0, working: 0, unseen: 0, waterTower: false, fireEscape: false, project: null, door: "right" as const, cat: false };
  lots.push({ ...base, kind: "club", x: 0, width: CLUB_W, facade: CLUB, roof: "flat", floors: 2, lamp: true, seed: 0 });
  let x = CLUB_W + GAP;
  const known = new Set((projects ?? []).map((p) => p.id));
  const listed: Array<{ id: string; title: string; workspaceRoot: string | null }> = (projects ?? []).map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot }));
  for (const room of rooms) {
    if (!known.has(room.projectId)) {
      known.add(room.projectId);
      listed.push({ id: room.projectId, title: projects ? "Unknown project" : "", workspaceRoot: null });
    }
  }
  const trades = assignTrades(listed.map((p) => p.id));
  for (const project of listed) {
    lots.push(
      businessLot(
        x,
        project,
        trades.get(project.id)!,
        rooms.filter((r) => r.projectId === project.id),
        threads.filter((t) => t.projectId === project.id),
      ),
    );
    x += LOT_W + GAP;
  }
  lots.push({ ...base, kind: "rent", x, width: RENT_W, facade: EMPTY, roof: "flat", floors: 1, lamp: false, seed: 1 });
  return { lots, width: x + RENT_W };
}

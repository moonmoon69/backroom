/**
 * Inside the street's buildings (Settings → Look → Street), drawn like a SNES interior at 256×144 scene pixels, seen
 * from a little above. A room's back room: the boss at the head of a long table under the lamp, the crew on both sides
 * of it (the far side facing us, the near side from behind, their screens lit towards us), and the same four things in
 * every back room: the noticeboard (tasks), the ledger (the books), the telephone (the room's browser) and the filing
 * cabinet (git); the door leads back out to the street. A thread on its own is an office: one member at a desk.
 *
 * Walls, floor and rug are repeating tiles; light is dithered (the sun through the blinds by day, the lamp's pool at
 * night). The room is drawn once; the people and what they hold are drawn every frame from `Actor`s, which the live
 * state decides (BackRoomScene.tsx, ThreadScene.tsx).
 */
import { cycle, dither, fillWith, pattern, rect, tile, type Ctx } from "./pixels.ts";
import {
  BASE_PALETTE,
  capyBackSprite,
  capySprite,
  CIGAR,
  CIGAR_PALETTE,
  ENVELOPE,
  ENVELOPE_PALETTE,
  EYES,
  GLASS,
  GLASS_PALETTE,
  GLYPHS,
  LAPTOP,
  LAPTOP_FRONT,
  LAPTOP_FRONT_PALETTE,
  LAPTOP_PALETTE,
  NEWSPAPER,
  NEWSPAPER_PALETTE,
  PAW,
  SHEET,
  SHEET_PALETTE,
  sprite,
  type Grid,
} from "./sprites.ts";

export const SCENE_W = 256;
export const SCENE_H = 144;
/** The table's far edge: the far side's shoulders go under it. */
export const TABLE_TOP = 70;
const TABLE_FRONT = 102;
const TABLE_X0 = 40;
const TABLE_X1 = 216;
const WALL_H = 46;
const BOSS_X = 128;

/** What a member does at the table. */
export type Pose = "work" | "read" | "idle" | "sleep" | "away";
/** What floats over a member's head. */
export type Mark = "!" | "?" | "x" | "typing" | "z" | null;

export interface Actor {
  id: string;
  alias: string;
  colour: string;
  hat: string;
  pose: Pose;
  mark: Mark;
  /** Subagents at work beside them, drawn as small capybaras on the table (three at most). */
  subagents: number;
  /** Shakes a little: the last turn failed. */
  dizzy: boolean;
}

/** Something crossing the room: an assignment to a member, or an answer back to the boss. */
export interface Flight {
  kind: "envelope" | "sheet";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
}

export interface Seat {
  x: number;
  /** Top of the sprite. */
  y: number;
  /** Seen from behind, at the near side of the table. */
  near: boolean;
}

const FAR_SEATS = [-32, 32, -60, 60, -88, 88];
const NEAR_SEATS = [-20, 20, -52, 52, -84, 84];
/** Who sits where: the first two either side of the boss, then the near side, and on outwards. */
const ORDER: Array<["far" | "near", number]> = [
  ["far", 0],
  ["far", 1],
  ["near", 0],
  ["near", 1],
  ["far", 2],
  ["far", 3],
  ["near", 2],
  ["near", 3],
  ["far", 4],
  ["far", 5],
  ["near", 4],
  ["near", 5],
];

export function seatOf(index: number): Seat {
  const [side, k] = ORDER[index % ORDER.length]!;
  return side === "far" ? { x: BOSS_X + FAR_SEATS[k]!, y: TABLE_TOP - 20, near: false } : { x: BOSS_X + NEAR_SEATS[k]!, y: TABLE_FRONT - 10, near: true };
}

export const BOSS_SEAT: Seat = { x: BOSS_X, y: TABLE_TOP - 22, near: false };
export const MAX_SEATS = ORDER.length;

/** Where the room's things are, for the words and buttons laid over them. */
export const OBJECTS = {
  door: { x: 8, y: 4, w: 24, h: 42 },
  phone: { x: 36, y: 10, w: 12, h: 24 },
  board: { x: 52, y: 6, w: 32, h: 24 },
  cabinet: { x: 160, y: 16, w: 22, h: 32 },
  ledger: { x: 119, y: 76, w: 18, h: 9 },
} as const;

/** A steady per-member number from its id, to put members' blinks and sips out of step. */
export function seedOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

const K = "#17120e";

function stamp(ctx: Ctx, key: string, grid: Grid, palette: Record<string, string>, x: number, y: number) {
  ctx.drawImage(sprite(key, grid, palette), Math.round(x), Math.round(y));
}

// ---- palettes: by day the window lights the room, at night the lamp ----

interface Palette {
  wall: string;
  motif: string;
  wallShade: string;
  panel: string;
  panelLight: string;
  panelDark: string;
  plankA: string;
  plankB: string;
  seam: string;
  grain: string;
  rug: string;
  rugDark: string;
  rugBorder: string;
  rugMotif: string;
  top: string;
  topGrain: string;
  topEdge: string;
  face: string;
  leather: string;
  leatherLight: string;
  leatherDark: string;
}

const DAY: Palette = {
  wall: "#4e6a5c",
  motif: "#5c7a6a",
  wallShade: "#405848",
  panel: "#6e4a2e",
  panelLight: "#86603c",
  panelDark: "#553820",
  plankA: "#8a5e3a",
  plankB: "#7c5434",
  seam: "#58391f",
  grain: "#9a6c46",
  rug: "#8a2f2a",
  rugDark: "#6e2420",
  rugBorder: "#c9a24a",
  rugMotif: "#a8463a",
  top: "#6e4428",
  topGrain: "#7c4e30",
  topEdge: "#946440",
  face: "#4a2c18",
  leather: "#5e2e26",
  leatherLight: "#74402e",
  leatherDark: "#40201a",
};

const NIGHT: Palette = {
  wall: "#28362f",
  motif: "#304238",
  wallShade: "#1e2a24",
  panel: "#4a3020",
  panelLight: "#5c3e28",
  panelDark: "#382418",
  plankA: "#5a3c24",
  plankB: "#50351f",
  seam: "#3a2414",
  grain: "#664630",
  rug: "#6a2420",
  rugDark: "#521c18",
  rugBorder: "#a8843a",
  rugMotif: "#80342c",
  top: "#5b3a22",
  topGrain: "#664228",
  topEdge: "#7a5232",
  face: "#3a2415",
  leather: "#4d2620",
  leatherLight: "#5e3028",
  leatherDark: "#33170f",
};

const paletteOf = (night: boolean) => (night ? NIGHT : DAY);

function wallpaper(p: Palette, key: string) {
  return tile(key, 16, 16, (put) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) put(x, y, p.wall);
    // A small damask diamond, and faint stripes.
    for (const [x, y] of [
      [8, 3],
      [7, 4],
      [9, 4],
      [6, 5],
      [10, 5],
      [7, 6],
      [9, 6],
      [8, 7],
      [8, 5],
      [0, 11],
      [1, 12],
      [15, 12],
      [0, 13],
    ] as const)
      put(x, y, p.motif);
    for (let y = 0; y < 16; y++) put(4, y, p.wallShade);
  });
}

function planks(p: Palette, key: string) {
  return tile(key, 16, 8, (put) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) put(x, y, y < 4 ? p.plankA : p.plankB);
    for (let x = 0; x < 16; x++) {
      put(x, 3, p.seam);
      put(x, 7, p.seam);
    }
    for (let y = 0; y < 3; y++) put(11, y, p.seam);
    for (let y = 4; y < 7; y++) put(3, y, p.seam);
    for (const [x, y] of [
      [2, 1],
      [3, 1],
      [7, 2],
      [13, 1],
      [6, 5],
      [7, 5],
      [12, 6],
    ] as const)
      put(x, y, p.grain);
  });
}

// ---- the room, drawn once ----

/** A high-backed leather chair seen from the front, `w` wide, from `top` down to `bottom`. */
function chair(ctx: Ctx, p: Palette, cx: number, top: number, bottom: number, w: number) {
  const x = cx - Math.floor(w / 2);
  const h = bottom - top;
  rect(ctx, x + 2, top, w - 4, 1, K);
  rect(ctx, x + 1, top + 1, w - 2, 1, K);
  rect(ctx, x, top + 2, w, h - 2, K);
  rect(ctx, x + 2, top + 1, w - 4, 1, p.leatherLight);
  rect(ctx, x + 1, top + 2, w - 2, h - 2, p.leather);
  rect(ctx, x + 2, top + 2, 1, h - 2, p.leatherLight);
  for (let row = 0; row * 5 + 5 < h - 2; row++) {
    const offset = row % 2 === 0 ? 4 : 7;
    for (let bx = x + offset; bx < x + w - 3; bx += 6) rect(ctx, bx, top + 4 + row * 5, 1, 1, p.leatherDark);
  }
}

function door(ctx: Ctx) {
  const { x, y, w, h } = OBJECTS.door;
  rect(ctx, x, y, w, h, K);
  rect(ctx, x + 1, y + 1, w - 2, h - 1, "#2a1e15");
  rect(ctx, x + 3, y + 3, w - 6, h - 3, "#4a3322");
  rect(ctx, x + 3, y + 3, 1, h - 3, "#5a4030");
  rect(ctx, x + 5, y + 5, w - 10, 12, "#3e2a1c");
  rect(ctx, x + 5, y + 21, w - 10, 17, "#3e2a1c");
  rect(ctx, x + w - 7, y + 20, 2, 2, "#d9b44a");
}

function noticeboard(ctx: Ctx) {
  const { x, y, w, h } = OBJECTS.board;
  rect(ctx, x, y, w, h, K);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, "#5a3d24");
  rect(ctx, x + 1, y + 1, w - 2, 1, "#74502e");
  rect(ctx, x + 3, y + 3, w - 6, h - 6, "#b08a5a");
  for (let i = 0; i < 24; i++) rect(ctx, x + 4 + ((i * 7) % (w - 8)), y + 4 + ((i * 5) % (h - 8)), 1, 1, "#9c7648");
}

function wallPhone(ctx: Ctx) {
  const { x, y } = OBJECTS.phone;
  rect(ctx, x + 2, y + 6, 8, 12, "#1b1b1d");
  rect(ctx, x + 3, y + 7, 6, 1, "#34343a");
  rect(ctx, x + 1, y + 3, 10, 3, "#101012");
  rect(ctx, x, y + 2, 2, 3, "#101012");
  rect(ctx, x + 10, y + 2, 2, 3, "#101012");
  rect(ctx, x + 4, y + 10, 4, 4, "#c9c2b0");
  rect(ctx, x + 5, y + 11, 2, 2, "#1b1b1d");
  for (let i = 0; i < 5; i++) rect(ctx, x + 3 + (i % 2), y + 18 + i, 1, 1, "#101012");
}

function filingCabinet(ctx: Ctx) {
  const { x, y, w, h } = OBJECTS.cabinet;
  dither(ctx, x + 2, y + h, w, 2, "#000000");
  rect(ctx, x, y, w, h, K);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, "#59625a");
  rect(ctx, x + 1, y + 1, w - 2, 1, "#7a847a");
  for (let i = 0; i < 3; i++) {
    const dy = y + 2 + i * 10;
    rect(ctx, x + 2, dy, w - 4, 9, "#6a746b");
    rect(ctx, x + 2, dy + 8, w - 4, 1, "#4a524b");
    rect(ctx, x + 8, dy + 2, 6, 3, "#e8e2cc");
    rect(ctx, x + 8, dy + 6, 6, 1, "#c9c2b0");
  }
}

function windowBlinds(ctx: Ctx, night: boolean) {
  rect(ctx, 196, 4, 44, 32, K);
  rect(ctx, 197, 5, 42, 30, "#3b2f24");
  for (let y = 7; y < 33; y += 3) {
    rect(ctx, 199, y, 38, 2, night ? "#7a7868" : "#fbf5e2");
    rect(ctx, 199, y + 2, 38, 1, night ? "#2a2c3a" : "#ffe9a8");
  }
  rect(ctx, 217, 7, 1, 26, "#8a8370");
  rect(ctx, 194, 36, 48, 2, "#6e4a2e");
}

function lamp(ctx: Ctx, night: boolean) {
  rect(ctx, BOSS_X, 0, 1, 5, "#0d0d0d");
  rect(ctx, BOSS_X - 4, 5, 9, 1, K);
  for (let i = 0; i < 6; i++) {
    const half = 5 + i * 1.2;
    rect(ctx, Math.round(BOSS_X - half), 6 + i, Math.round(half * 2) + 1, 1, i === 0 ? "#2f6a51" : "#24503d");
  }
  rect(ctx, BOSS_X - 11, 12, 23, 1, "#c9a24a");
  rect(ctx, BOSS_X - 3, 13, 7, 1, night ? "#ffe3a8" : "#9a927e");
}

function rug(ctx: Ctx, p: Palette) {
  const x = 24;
  const y = 62;
  const w = 208;
  const h = 76;
  rect(ctx, x, y, w, h, p.rugDark);
  rect(ctx, x + 2, y + 2, w - 4, h - 4, p.rugBorder);
  rect(ctx, x + 4, y + 4, w - 8, h - 8, p.rugDark);
  rect(ctx, x + 6, y + 6, w - 12, h - 12, p.rug);
  for (let yy = y + 10; yy < y + h - 8; yy += 8) for (let xx = x + 10 + ((yy / 8) % 2) * 4; xx < x + w - 10; xx += 8) rect(ctx, xx, yy, 2, 2, p.rugMotif);
  for (let yy = y + 1; yy < y + h; yy += 2) {
    rect(ctx, x - 3, yy, 3, 1, "#c9b28a");
    rect(ctx, x + w, yy, 3, 1, "#c9b28a");
  }
}

/** The room without anyone in it: wall and its things, window, floor, rug and the chairs of the far side and the boss. */
export function drawRoom(seats: number, night: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext("2d")!;
  const p = paletteOf(night);
  const wallKey = `room-wall:${night}`;
  fillWith(ctx, pattern(ctx, wallKey, () => wallpaper(p, wallKey)), 0, 0, SCENE_W, 34);
  rect(ctx, 0, 0, SCENE_W, 2, p.wallShade);
  // Picture rail, wainscot panels, skirting.
  rect(ctx, 0, 33, SCENE_W, 2, p.panelLight);
  rect(ctx, 0, 35, SCENE_W, 9, p.panel);
  for (let x = 4; x < SCENE_W; x += 24) {
    rect(ctx, x, 37, 20, 1, p.panelDark);
    rect(ctx, x, 37, 1, 5, p.panelDark);
    rect(ctx, x, 42, 20, 1, p.panelLight);
    rect(ctx, x + 19, 37, 1, 6, p.panelLight);
  }
  rect(ctx, 0, 44, SCENE_W, 2, K);
  const floorKey = `room-floor:${night}`;
  fillWith(ctx, pattern(ctx, floorKey, () => planks(p, floorKey)), 0, WALL_H, SCENE_W, SCENE_H - WALL_H);
  dither(ctx, 0, WALL_H, SCENE_W, 2, "#000000");
  door(ctx);
  wallPhone(ctx);
  noticeboard(ctx);
  filingCabinet(ctx);
  windowBlinds(ctx, night);
  rug(ctx, p);
  if (!night) {
    // The sun through the blinds, across the floor.
    for (let y = 38; y < SCENE_H; y += 1) {
      const along = (y - 38) / (SCENE_H - 38);
      const left = Math.round(197 + (120 - 197) * along);
      const right = Math.round(239 + (180 - 239) * along);
      if (y % 3 !== 1) dither(ctx, left, y, right - left, 1, "#f6dca0");
    }
  }
  lamp(ctx, night);
  chair(ctx, p, BOSS_X, TABLE_TOP - 36, TABLE_TOP, 34);
  for (let i = 0; i < Math.min(seats, MAX_SEATS); i++) {
    const seat = seatOf(i);
    if (!seat.near) chair(ctx, p, seat.x, TABLE_TOP - 15, TABLE_TOP, 26);
  }
  return canvas;
}

/** The table on its own, to lay over the far side's shoulders. */
export function drawTable(night: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext("2d")!;
  const p = paletteOf(night);
  dither(ctx, TABLE_X0 - 2, TABLE_FRONT + 6, TABLE_X1 - TABLE_X0 + 4, 8, "#000000");
  for (const x of [TABLE_X0 + 4, TABLE_X1 - 9]) rect(ctx, x, TABLE_FRONT + 6, 5, 12, p.face);
  rect(ctx, TABLE_X0 - 1, TABLE_TOP, TABLE_X1 - TABLE_X0 + 2, TABLE_FRONT - TABLE_TOP, K);
  rect(ctx, TABLE_X0, TABLE_TOP + 1, TABLE_X1 - TABLE_X0, TABLE_FRONT - TABLE_TOP - 1, p.top);
  rect(ctx, TABLE_X0, TABLE_TOP + 1, TABLE_X1 - TABLE_X0, 1, p.topEdge);
  for (let y = TABLE_TOP + 4; y < TABLE_FRONT - 2; y += 4) {
    const offset = (y * 37) % 60;
    for (let x = TABLE_X0 + offset; x < TABLE_X1 - 20; x += 70) rect(ctx, x, y, 40, 1, p.topGrain);
  }
  rect(ctx, TABLE_X0, TABLE_FRONT - 1, TABLE_X1 - TABLE_X0, 1, p.topEdge);
  rect(ctx, TABLE_X0 - 1, TABLE_FRONT, TABLE_X1 - TABLE_X0 + 2, 6, K);
  rect(ctx, TABLE_X0, TABLE_FRONT, TABLE_X1 - TABLE_X0, 5, p.face);
  rect(ctx, TABLE_X0, TABLE_FRONT + 2, TABLE_X1 - TABLE_X0, 1, p.leatherDark);
  return canvas;
}

// ---- the people, every frame ----

const MINI: Grid = ["..KKK..", ".KHHHK.", "KhhhhhK", ".KFEFK.", ".KDdDK.", "..KKK.."];

function closeEyes(ctx: Ctx, x: number, y: number) {
  for (const eye of EYES) {
    rect(ctx, x + eye.x, y + eye.y, 1, 2, BASE_PALETTE.F!);
    rect(ctx, x + eye.x - 1, y + eye.y + 1, 2, 1, BASE_PALETTE.d!);
  }
}

function bubble(ctx: Ctx, cx: number, top: number, mark: Exclude<Mark, "z" | null>, t: number, seed: number) {
  const bob = mark === "typing" ? 0 : Math.round(Math.sin(t / 180 + seed * 6) * 1);
  const x = cx - 5;
  const y = top + bob;
  rect(ctx, x + 1, y, 9, 1, K);
  rect(ctx, x, y + 1, 11, 7, K);
  rect(ctx, x + 1, y + 8, 9, 1, K);
  rect(ctx, x + 1, y + 1, 9, 7, "#f7f3e6");
  rect(ctx, x + 4, y + 9, 3, 1, K);
  rect(ctx, x + 5, y + 10, 1, 1, K);
  rect(ctx, x + 4, y + 8, 3, 1, "#f7f3e6");
  if (mark === "typing") {
    const active = Math.floor(cycle(t, 900, seed) * 3);
    for (let i = 0; i < 3; i++) rect(ctx, x + 2 + i * 3, y + (i === active ? 3 : 4), 1, 1, "#4a4f58");
    return;
  }
  const colour = mark === "?" ? "#6e56cf" : "#e5484d";
  GLYPHS[mark]!.forEach((row, gy) => {
    for (let gx = 0; gx < row.length; gx++) if (row[gx] === "X") rect(ctx, x + 4 + gx, y + 2 + gy, 1, 1, colour);
  });
}

function sleepyZ(ctx: Ctx, cx: number, top: number, t: number, seed: number) {
  for (let i = 0; i < 2; i++) {
    const p = cycle(t + i * 1400, 2800, seed);
    const x = cx + 4 + Math.round(p * 6);
    const y = top + 2 - Math.round(p * 10);
    if (p > 0.75) continue;
    GLYPHS.z!.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === "X") rect(ctx, x + gx, y + gy, 1, 1, "#c9d1e0");
    });
  }
}

/** A member at the far side of a table whose top is at `top`: body, then (after the table) what is in their paws. */
function drawFar(ctx: Ctx, actor: Actor, seat: Seat, t: number, layer: "body" | "front", top: number) {
  const seed = seedOf(actor.id);
  const shake = actor.dizzy && cycle(t, 2600, seed) < 0.12 ? (Math.floor(t / 60) % 2 === 0 ? -1 : 1) : 0;
  const nod = actor.pose === "sleep" && cycle(t, 3000, seed) > 0.5 ? 1 : 0;
  const x = seat.x - 11 + shake;
  const y = seat.y + nod;
  if (layer === "body") {
    if (actor.pose === "away") {
      if (Math.floor(t / 90) % 3 === 0) return;
      ctx.drawImage(capySprite(actor.colour, false, actor.hat, "#8a92a8"), x, y - 2 + (cycle(t, 1400, seed) < 0.5 ? 0 : 1));
      return;
    }
    ctx.drawImage(capySprite(actor.colour, false, actor.hat), x, y);
    const blink = actor.pose !== "read" && cycle(t, 4200, seed) < 0.035;
    if (actor.pose === "sleep" || blink) closeEyes(ctx, x, y);
    return;
  }
  if (actor.pose === "work") {
    const tick = Math.floor(t / 110 + seed * 7);
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x - 12, top + (tick % 2 === 0 ? 0 : 1));
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x + 7, top + (tick % 2 === 0 ? 1 : 0));
    stamp(ctx, "laptop", LAPTOP, LAPTOP_PALETTE, seat.x - 6, top - 2);
    // The screen's light spilling over the lid.
    if (Math.floor(t / 140 + seed * 5) % 4 !== 0) rect(ctx, seat.x - 4, top - 3, 8, 1, "#9ad0ff");
    for (let i = 0; i < Math.min(actor.subagents, 3); i++) {
      const hop = cycle(t, 700, seed + i * 0.31) < 0.3 ? 1 : 0;
      stamp(ctx, "mini", MINI, BASE_PALETTE, seat.x - 10 + i * 7, top + 12 - hop);
    }
  } else if (actor.pose === "read") {
    const bob = cycle(t, 3000, seed) < 0.5 ? 0 : 1;
    stamp(ctx, "paper", NEWSPAPER, NEWSPAPER_PALETTE, seat.x - 8, seat.y + 11 + bob);
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x - 12, seat.y + 16 + bob);
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x + 7, seat.y + 16 + bob);
  } else if (actor.pose === "idle" || actor.pose === "sleep") {
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x - 10, top + 1);
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x + 5, top + 1);
    const sipping = actor.pose === "idle" && cycle(t, 11000, seed) < 0.12;
    if (sipping) stamp(ctx, "glass", GLASS, GLASS_PALETTE, seat.x + 2, seat.y + 13);
    else stamp(ctx, "glass", GLASS, GLASS_PALETTE, seat.x + 9, top + 5);
  }
}

/** A member at the near side, seen from behind: what is on the table beyond them, then them, then their chair. */
function drawNear(ctx: Ctx, actor: Actor, seat: Seat, t: number, p: Palette) {
  const seed = seedOf(actor.id);
  const x = seat.x - 11;
  const nod = actor.pose === "sleep" ? 2 : 0;
  const tableY = TABLE_FRONT - 22;
  if (actor.pose === "work") {
    stamp(ctx, "laptop-front", LAPTOP_FRONT, LAPTOP_FRONT_PALETTE, seat.x - 7, tableY);
    // The code on the screen scrolls.
    const line = Math.floor(t / 300 + seed * 9) % 5;
    rect(ctx, seat.x - 4 + (line % 3), tableY + 3 + line, 4 + (line % 2) * 2, 1, "#c8ffd8");
    for (let i = 0; i < Math.min(actor.subagents, 3); i++) {
      const hop = cycle(t, 700, seed + i * 0.31) < 0.3 ? 1 : 0;
      stamp(ctx, "mini", MINI, BASE_PALETTE, seat.x + 8 + (i % 2) * 7, tableY + 2 + Math.floor(i / 2) * 7 - hop);
    }
  } else if (actor.pose === "idle") {
    stamp(ctx, "glass", GLASS, GLASS_PALETTE, seat.x + 7, tableY + 6);
  } else if (actor.pose === "read") {
    stamp(ctx, "paper", NEWSPAPER, NEWSPAPER_PALETTE, seat.x - 8, seat.y - 6 + (cycle(t, 3000, seed) < 0.5 ? 0 : 1));
  }
  if (actor.pose === "away") {
    if (Math.floor(t / 90) % 3 !== 0) ctx.drawImage(capyBackSprite(actor.colour, actor.hat, "#8a92a8"), x, seat.y);
  } else {
    ctx.drawImage(capyBackSprite(actor.colour, actor.hat), x, seat.y + nod);
    if (actor.pose === "work") {
      const tick = Math.floor(t / 110 + seed * 7);
      stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x - 13, seat.y + 8 + (tick % 2));
      stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x + 8, seat.y + 8 + ((tick + 1) % 2));
    }
  }
  // The chair's back, in front of them.
  const top = seat.y + 15;
  rect(ctx, x, top, 22, 14, K);
  rect(ctx, x + 1, top + 1, 20, 12, p.leather);
  rect(ctx, x + 1, top + 1, 20, 1, p.leatherLight);
  for (let bx = x + 4; bx < x + 20; bx += 6) rect(ctx, bx, top + 5, 1, 1, p.leatherDark);
  rect(ctx, x + 2, top + 14, 2, 4, K);
  rect(ctx, x + 18, top + 14, 2, 4, K);
}

function drawMarks(ctx: Ctx, actor: Actor, seat: Seat, t: number) {
  const seed = seedOf(actor.id);
  if (actor.mark === "z") sleepyZ(ctx, seat.x, seat.y - 4, t, seed);
  else if (actor.mark) bubble(ctx, seat.x, seat.y - 13, actor.mark, t, seed);
}

/** Smoke from the boss's cigar: a few pixels rising and thinning. */
function smoke(ctx: Ctx, x: number, y: number, t: number) {
  for (let i = 0; i < 6; i++) {
    const p = cycle(t + i * 520, 3120, 0);
    if (p > 0.8 || (p > 0.5 && i % 2)) continue;
    rect(ctx, Math.round(x + Math.sin(p * 6 + i) * 2 + p * 3), Math.round(y - p * 26), p > 0.4 ? 2 : 1, 1, p > 0.4 ? "#8a8a90" : "#b4b4ba");
  }
}

function dust(ctx: Ctx, t: number) {
  for (let i = 0; i < 12; i++) {
    const s = seedOf(`mote${i}`);
    const along = cycle(t, 16000 + s * 9000, s);
    const across = (s * 7) % 1;
    const y = 40 + along * 100;
    const left = 197 + (120 - 197) * along;
    const right = 239 + (180 - 239) * along;
    const x = left + (right - left) * across + Math.sin(t / 1500 + i) * 2;
    if (cycle(t, 1400, s) < 0.5) rect(ctx, Math.round(x), Math.round(y), 1, 1, "#fff4d0");
  }
}

const CLOCK: Grid = ["...KKKKK...", "..KFFFFFK..", ".KFWWWWWFK.", "KFWWWWWWWFK", "KFWWWWWWWFK", "KFWWWWWWWFK", "KFWWWWWWWFK", "KFWWWWWWWFK", ".KFWWWWWFK.", "..KFFFFFK..", "...KKKKK..."];

function clock(ctx: Ctx, now: Date, cx: number, cy: number) {
  ctx.drawImage(sprite("clock", CLOCK, { K, F: "#a8843a", W: "#efe6cf" }), cx - 5, cy - 5);
  const hand = (turns: number, length: number) => {
    const angle = turns * Math.PI * 2 - Math.PI / 2;
    for (let r = 0; r <= length; r += 0.5) rect(ctx, Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r), 1, 1, K);
  };
  hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12, 2.5);
  hand(now.getMinutes() / 60, 3.5);
}

/** The cards pinned on the board: one per open task (six at most), a yellow one with a "!" when a task needs you. */
function boardCards(ctx: Ctx, open: number, alert: boolean) {
  const { x, y } = OBJECTS.board;
  for (let i = 0; i < Math.min(6, open); i++) {
    const cx = x + 5 + (i % 3) * 8;
    const cy = y + 5 + Math.floor(i / 3) * 8 + (i % 2);
    const urgent = alert && i === 0;
    rect(ctx, cx, cy, 7, 6, urgent ? "#f4d35e" : "#f1ebdd");
    if (urgent) {
      rect(ctx, cx + 3, cy + 1, 1, 2, "#c0302a");
      rect(ctx, cx + 3, cy + 4, 1, 1, "#c0302a");
    } else {
      rect(ctx, cx + 1, cy + 2, 5, 1, "#8f897a");
      rect(ctx, cx + 1, cy + 4, 4, 1, "#8f897a");
    }
    rect(ctx, cx + 3, cy - 1, 1, 1, urgent ? "#c0302a" : "#3f7a4a");
  }
}

/** The room's books, in front of the boss. */
function ledger(ctx: Ctx) {
  const { x, y, w, h } = OBJECTS.ledger;
  dither(ctx, x + 1, y + h, w - 1, 2, "#000000");
  rect(ctx, x - 1, y - 1, w + 2, h + 2, K);
  rect(ctx, x, y, w, h, "#1f4d3a");
  rect(ctx, x + w - 2, y + 1, 2, h - 1, "#efe6c9");
  rect(ctx, x, y + 3, w - 2, 1, "#c9a24a");
  rect(ctx, x, y, w, 1, "#2f6a51");
}

function flight(ctx: Ctx, f: Flight, t: number) {
  const p = Math.min(1, Math.max(0, (t - f.start) / f.duration));
  const x = f.fromX + (f.toX - f.fromX) * p;
  const y = f.fromY + (f.toY - f.fromY) * p - Math.sin(p * Math.PI) * 22;
  if (f.kind === "envelope") stamp(ctx, "envelope", ENVELOPE, ENVELOPE_PALETTE, x - 4, y - 2);
  else stamp(ctx, "sheet", SHEET, SHEET_PALETTE, x - 3, y - 3);
}

export interface Frame {
  room: HTMLCanvasElement;
  table: HTMLCanvasElement;
  actors: Actor[];
  boss: { colour: string; mark: Mark };
  flights: Flight[];
  /** Open tasks on the noticeboard, and whether one needs you. */
  tasks: { open: number; alert: boolean };
  night: boolean;
  t: number;
  now: Date;
  motion: boolean;
}

export function drawFrame(ctx: Ctx, frame: Frame) {
  const { actors, t, night } = frame;
  const p = paletteOf(night);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame.room, 0, 0);
  clock(ctx, frame.now, 96, 18);
  boardCards(ctx, frame.tasks.open, frame.tasks.alert);
  const seats = actors.map((_, i) => seatOf(i));
  // The far side and the boss: bodies, then the table over their shoulders, then their paws and things.
  ctx.drawImage(capySprite(frame.boss.colour, true), BOSS_SEAT.x - 11, BOSS_SEAT.y);
  actors.forEach((actor, i) => !seats[i]!.near && drawFar(ctx, actor, seats[i]!, t, "body", TABLE_TOP));
  ctx.drawImage(frame.table, 0, 0);
  stamp(ctx, "paw", PAW, BASE_PALETTE, BOSS_X - 10, TABLE_TOP + 1);
  stamp(ctx, "paw", PAW, BASE_PALETTE, BOSS_X + 5, TABLE_TOP + 1);
  stamp(ctx, "glass", GLASS, GLASS_PALETTE, BOSS_X + 11, TABLE_TOP + 5);
  stamp(ctx, "cigar", CIGAR, CIGAR_PALETTE, BOSS_X - 19, TABLE_TOP + 6);
  ledger(ctx);
  if (frame.motion) smoke(ctx, BOSS_X - 12, TABLE_TOP + 5, t);
  actors.forEach((actor, i) => !seats[i]!.near && drawFar(ctx, actor, seats[i]!, t, "front", TABLE_TOP));
  // The near side, in front of the table.
  actors.forEach((actor, i) => seats[i]!.near && drawNear(ctx, actor, seats[i]!, t, p));
  if (frame.motion && !night) dust(ctx, t);
  for (const f of frame.flights) flight(ctx, f, t);
  if (frame.boss.mark && frame.boss.mark !== "z") bubble(ctx, BOSS_X, BOSS_SEAT.y - 13, frame.boss.mark, t, 0);
  actors.forEach((actor, i) => drawMarks(ctx, actor, seats[i]!, t));
}

// ---- a thread on its own: an office with one desk ----

export const OFFICE_W = 256;
export const OFFICE_H = 76;
const DESK_TOP = 50;
export const OFFICE_SEAT: Seat = { x: 128, y: DESK_TOP - 20, near: false };
export const OFFICE_DOOR = { x: 8, y: 4, w: 24, h: 42 } as const;

const BOOKS: Grid = ["KKKKKKKKKKKKKKKK", "KRBGYRBKGYRBGYRK", "KRBGYRBKGYRBGYRK", "KRBGYRBKGYRBGYRK", "KKKKKKKKKKKKKKKK", "KGYRBGYRBKGYRBGK", "KGYRBGYRBKGYRBGK", "KGYRBGYRBKGYRBGK", "KKKKKKKKKKKKKKKK"];

export interface OfficeFrame {
  actor: Actor;
  night: boolean;
  t: number;
  now: Date;
  motion: boolean;
}

const officeCache = new Map<string, HTMLCanvasElement>();

function officeRoom(night: boolean): HTMLCanvasElement {
  const key = `office:${night}`;
  let canvas = officeCache.get(key);
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.width = OFFICE_W;
  canvas.height = OFFICE_H;
  const ctx = canvas.getContext("2d")!;
  const p = paletteOf(night);
  const wallKey = `room-wall:${night}`;
  fillWith(ctx, pattern(ctx, wallKey, () => wallpaper(p, wallKey)), 0, 0, OFFICE_W, 34);
  rect(ctx, 0, 33, OFFICE_W, 2, p.panelLight);
  rect(ctx, 0, 35, OFFICE_W, 9, p.panel);
  rect(ctx, 0, 44, OFFICE_W, 2, K);
  const floorKey = `room-floor:${night}`;
  fillWith(ctx, pattern(ctx, floorKey, () => planks(p, floorKey)), 0, WALL_H, OFFICE_W, OFFICE_H - WALL_H);
  dither(ctx, 0, WALL_H, OFFICE_W, 2, "#000000");
  door(ctx);
  windowBlinds(ctx, night);
  // A bookcase and a plant.
  rect(ctx, 150, 10, 34, 36, K);
  rect(ctx, 151, 11, 32, 34, "#5a3d24");
  const books = { K: "#2a1a10", R: "#8a2f2a", B: "#34507a", G: "#3f6a44", Y: "#b8963a" };
  ctx.drawImage(sprite("books", BOOKS, books), 159, 14);
  ctx.drawImage(sprite("books", BOOKS, books), 159, 26);
  rect(ctx, 152, 24, 30, 1, "#74502e");
  rect(ctx, 152, 36, 30, 1, "#74502e");
  rect(ctx, 60, 30, 10, 12, "#8a4e2e");
  rect(ctx, 58, 18, 14, 12, "#3f6a44");
  rect(ctx, 61, 14, 8, 6, "#4f8a54");
  chair(ctx, p, 128, DESK_TOP - 15, DESK_TOP, 26);
  if (!night) {
    for (let y = 38; y < OFFICE_H; y++) {
      const along = (y - 38) / (OFFICE_H - 38);
      const left = Math.round(197 + (160 - 197) * along);
      const right = Math.round(239 + (210 - 239) * along);
      if (y % 3 !== 1) dither(ctx, left, y, right - left, 1, "#f6dca0");
    }
  }
  officeCache.set(key, canvas);
  return canvas;
}

function desk(ctx: Ctx, p: Palette, night: boolean) {
  const x0 = 92;
  const x1 = 164;
  dither(ctx, x0 - 2, DESK_TOP + 18, x1 - x0 + 4, 4, "#000000");
  rect(ctx, x0 - 1, DESK_TOP, x1 - x0 + 2, 12, K);
  rect(ctx, x0, DESK_TOP + 1, x1 - x0, 10, p.top);
  rect(ctx, x0, DESK_TOP + 1, x1 - x0, 1, p.topEdge);
  rect(ctx, x0 - 1, DESK_TOP + 11, x1 - x0 + 2, 9, K);
  rect(ctx, x0, DESK_TOP + 11, x1 - x0, 8, p.face);
  rect(ctx, x0 + 4, DESK_TOP + 13, 20, 4, p.leatherDark);
  rect(ctx, x1 - 24, DESK_TOP + 13, 20, 4, p.leatherDark);
  // The desk lamp.
  rect(ctx, x1 - 12, DESK_TOP - 7, 8, 3, "#2f6a4a");
  rect(ctx, x1 - 9, DESK_TOP - 4, 2, 5, "#c9a24a");
  if (night) dither(ctx, x1 - 16, DESK_TOP + 1, 16, 5, "#b89060");
}

export function drawOffice(ctx: Ctx, frame: OfficeFrame) {
  const { actor, t, night } = frame;
  const p = paletteOf(night);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(officeRoom(night), 0, 0);
  clock(ctx, frame.now, 96, 18);
  drawFar(ctx, actor, OFFICE_SEAT, t, "body", DESK_TOP);
  desk(ctx, p, night);
  drawFar(ctx, actor, OFFICE_SEAT, t, "front", DESK_TOP);
  if (frame.motion && !night) dust(ctx, t);
  drawMarks(ctx, actor, OFFICE_SEAT, t);
}

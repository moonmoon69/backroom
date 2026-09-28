/**
 * A room's back room on the street (Settings → Look → Street), drawn at 256×144 scene pixels. The boss at the head of
 * the table under the lamp, the crew seated either side, the near side of the table in the dark for anyone past six.
 * The same four things in every back room: the noticeboard (tasks), the ledger (the books), the telephone (the room's
 * browser) and the filing cabinet (git); the door leads back out to the street. The room itself is drawn once; the
 * people and what they hold are drawn every frame from `Actor`s, which the room's live state decides (BackRoomScene.tsx).
 * Day is the light theme: daylight through the blinds, the lamp off.
 */
import {
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
  LAPTOP_PALETTE,
  NEWSPAPER,
  NEWSPAPER_PALETTE,
  PAW,
  BASE_PALETTE,
  SHEET,
  SHEET_PALETTE,
  sprite,
  type Grid,
} from "./sprites.ts";

export const SCENE_W = 256;
export const SCENE_H = 144;
/** The table's far edge: the crew's shoulders go under it. */
export const TABLE_TOP = 84;
const TABLE_FRONT = 106;
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

const FAR_SEATS = [-34, 34, -64, 64, -94, 94];
const NEAR_SEATS = [-48, 48, -96, 96, 0];

/** Where the n-th crew member sits: six along the far side, then the near side. */
export function seatOf(index: number): Seat {
  if (index < FAR_SEATS.length) return { x: BOSS_X + FAR_SEATS[index]!, y: TABLE_TOP - 20, near: false };
  const near = NEAR_SEATS[(index - FAR_SEATS.length) % NEAR_SEATS.length]!;
  return { x: BOSS_X + near, y: 110, near: true };
}

export const BOSS_SEAT: Seat = { x: BOSS_X, y: TABLE_TOP - 22, near: false };
export const MAX_SEATS = FAR_SEATS.length + NEAR_SEATS.length;

/** A steady per-member number from its id, to put members' blinks and sips out of step. */
export function seedOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

type Ctx = CanvasRenderingContext2D;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w, h);
}

function stamp(ctx: Ctx, key: string, grid: Grid, palette: Record<string, string>, x: number, y: number) {
  ctx.drawImage(sprite(key, grid, palette), Math.round(x), Math.round(y));
}

// ---- the room, drawn once ----

/** A high-backed leather chair, `w` wide, from `top` down to the table. */
function chair(ctx: Ctx, cx: number, top: number, w: number) {
  const x = cx - Math.floor(w / 2);
  const h = TABLE_TOP - top;
  rect(ctx, x + 2, top, w - 4, 1, "#17120e");
  rect(ctx, x + 1, top + 1, w - 2, 1, "#17120e");
  rect(ctx, x, top + 2, w, h - 2, "#17120e");
  rect(ctx, x + 2, top + 1, w - 4, 1, "#5e3028");
  rect(ctx, x + 1, top + 2, w - 2, h - 2, "#4d2620");
  rect(ctx, x + 2, top + 2, 1, h - 2, "#5e3028");
  for (let row = 0; row * 5 + 5 < h - 2; row++) {
    const offset = row % 2 === 0 ? 4 : 7;
    for (let bx = x + offset; bx < x + w - 3; bx += 6) rect(ctx, bx, top + 4 + row * 5, 1, 1, "#33170f");
  }
}

function wall(ctx: Ctx, night: boolean) {
  rect(ctx, 0, 0, SCENE_W, 54, night ? "#22252b" : "#4b544e");
  for (let x = 0; x < SCENE_W; x += 8) {
    rect(ctx, x, 2, 1, 38, night ? "#1d2025" : "#434b45");
    rect(ctx, x + 4, 2, 2, 38, night ? "#262a30" : "#525b55");
  }
  rect(ctx, 0, 0, SCENE_W, 2, night ? "#15171a" : "#353b37");
  // Chair rail, wainscot panels, skirting.
  rect(ctx, 0, 40, SCENE_W, 2, "#3a2d22");
  rect(ctx, 0, 42, SCENE_W, 10, "#2d231c");
  for (let x = 4; x < SCENE_W; x += 24) {
    rect(ctx, x, 44, 20, 1, "#231a14");
    rect(ctx, x, 44, 1, 6, "#231a14");
    rect(ctx, x, 50, 20, 1, "#3a2d22");
    rect(ctx, x + 19, 44, 1, 7, "#3a2d22");
  }
  rect(ctx, 0, 52, SCENE_W, 2, "#17120e");
}

function door(ctx: Ctx) {
  rect(ctx, 8, 8, 24, 46, "#17120e");
  rect(ctx, 9, 9, 22, 45, "#2a1e15");
  rect(ctx, 11, 11, 18, 43, "#3e2c1f");
  rect(ctx, 13, 13, 14, 14, "#35261b");
  rect(ctx, 13, 30, 14, 20, "#35261b");
  rect(ctx, 13, 13, 14, 1, "#2a1e15");
  rect(ctx, 13, 30, 14, 1, "#2a1e15");
  rect(ctx, 26, 30, 2, 2, "#c9a24a");
  rect(ctx, 26, 30, 1, 1, "#f0d27a");
}

/** Where the room's things are, for the words and buttons laid over them. */
export const OBJECTS = {
  door: { x: 8, y: 8, w: 24, h: 46 },
  phone: { x: 34, y: 14, w: 12, h: 24 },
  board: { x: 48, y: 10, w: 32, h: 26 },
  cabinet: { x: 160, y: 22, w: 22, h: 36 },
  ledger: { x: 119, y: 95, w: 18, h: 10 },
} as const;

function noticeboard(ctx: Ctx) {
  const { x, y, w, h } = OBJECTS.board;
  rect(ctx, x, y, w, h, "#17120e");
  rect(ctx, x + 1, y + 1, w - 2, h - 2, "#5a3d24");
  rect(ctx, x + 3, y + 3, w - 6, h - 6, "#b08a5a");
  for (let i = 0; i < 24; i++) rect(ctx, x + 4 + ((i * 7) % (w - 8)), y + 4 + ((i * 5) % (h - 8)), 1, 1, "#9c7648");
}

/** The cards pinned on the board: one per open task (six at most), a yellow one with a "!" when a task needs you. */
function boardCards(ctx: Ctx, open: number, alert: boolean) {
  const { x, y } = OBJECTS.board;
  const cards = Math.min(6, open);
  for (let i = 0; i < cards; i++) {
    const cx = x + 5 + (i % 3) * 8;
    const cy = y + 5 + Math.floor(i / 3) * 9 + (i % 2);
    const urgent = alert && i === 0;
    rect(ctx, cx, cy, 7, 7, urgent ? "#f4d35e" : "#f1ebdd");
    if (urgent) {
      rect(ctx, cx + 3, cy + 1, 1, 3, "#c0302a");
      rect(ctx, cx + 3, cy + 5, 1, 1, "#c0302a");
    } else {
      rect(ctx, cx + 1, cy + 2, 5, 1, "#8f897a");
      rect(ctx, cx + 1, cy + 4, 4, 1, "#8f897a");
    }
    rect(ctx, cx + 3, cy - 1, 1, 1, urgent ? "#c0302a" : "#3f7a4a");
  }
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
  rect(ctx, x, y, w, h, "#17120e");
  rect(ctx, x + 1, y + 1, w - 2, h - 2, "#59625a");
  for (let i = 0; i < 3; i++) {
    const dy = y + 2 + i * 11;
    rect(ctx, x + 2, dy, w - 4, 10, "#6a746b");
    rect(ctx, x + 2, dy + 9, w - 4, 1, "#4a524b");
    rect(ctx, x + 8, dy + 2, 6, 3, "#e8e2cc");
    rect(ctx, x + 8, dy + 6, 6, 1, "#c9c2b0");
  }
}

/** The room's books, in front of the boss. */
function ledger(ctx: Ctx) {
  const { x, y, w, h } = OBJECTS.ledger;
  rect(ctx, x + 1, y + h - 1, w - 1, 2, "rgba(0,0,0,0.35)");
  rect(ctx, x, y, w, h, "#1f4d3a");
  rect(ctx, x + w - 2, y + 1, 2, h - 1, "#efe6c9");
  rect(ctx, x, y + 3, w - 2, 1, "#c9a24a");
  rect(ctx, x, y, w, 1, "#2f6a51");
}

function windowBlinds(ctx: Ctx, night: boolean) {
  rect(ctx, 196, 5, 44, 36, "#17120e");
  rect(ctx, 197, 6, 42, 34, "#3b2f24");
  for (let y = 8; y < 38; y += 3) {
    rect(ctx, 199, y, 38, 2, night ? "#cfc7ad" : "#fbf5e2");
    rect(ctx, 199, y + 2, 38, 1, night ? "#6d6758" : "#ffe9a8");
  }
  rect(ctx, 217, 8, 1, 30, "#8a8370");
}

function floor(ctx: Ctx, night: boolean) {
  const tones = night ? ["#2e2118", "#33251b", "#2b1f16"] : ["#5a4230", "#634935", "#553e2d"];
  for (let y = 54, row = 0; y < SCENE_H; y += 7, row++) {
    rect(ctx, 0, y, SCENE_W, 7, tones[row % 3]!);
    rect(ctx, 0, y, SCENE_W, 1, "#3a2a1f");
    for (let x = (row * 37) % 45; x < SCENE_W; x += 45) rect(ctx, x, y + 1, 1, 6, "#1f160f");
  }
}

function rug(ctx: Ctx) {
  rect(ctx, 14, 96, 228, 46, "#4a1d1d");
  rect(ctx, 17, 99, 222, 40, "#6e2b2b");
  rect(ctx, 20, 102, 216, 34, "#5f2525");
  for (let y = 106; y < 134; y += 8) for (let x = 26 + (y % 16 === 10 ? 4 : 0); x < 232; x += 8) rect(ctx, x, y, 2, 2, "#7d3a2f");
  for (let y = 97; y < 141; y += 2) {
    rect(ctx, 11, y, 3, 1, "#c9b28a");
    rect(ctx, 242, y, 3, 1, "#c9b28a");
  }
}

function lamp(ctx: Ctx, night: boolean) {
  rect(ctx, BOSS_X, 0, 1, 5, "#0d0d0d");
  rect(ctx, BOSS_X - 4, 5, 9, 1, "#17120e");
  for (let i = 0; i < 6; i++) {
    const half = 5 + i * 1.2;
    rect(ctx, Math.round(BOSS_X - half), 6 + i, Math.round(half * 2) + 1, 1, i === 0 ? "#2f6a51" : "#24503d");
  }
  rect(ctx, BOSS_X - 11, 12, 23, 1, "#c9a24a");
  rect(ctx, BOSS_X - 3, 13, 7, 1, night ? "#ffe3a8" : "#9a927e");
}

function table(ctx: Ctx) {
  // Shadow and legs under it.
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.fillRect(22, 113, 212, 14);
  for (const x of [28, 224]) rect(ctx, x, 113, 5, 16, "#2e1d12");
  // Top.
  rect(ctx, 23, TABLE_TOP, 210, TABLE_FRONT - TABLE_TOP, "#5b3a22");
  rect(ctx, 22, TABLE_TOP + 1, 212, TABLE_FRONT - TABLE_TOP - 1, "#5b3a22");
  rect(ctx, 23, TABLE_TOP, 210, 1, "#3f2716");
  rect(ctx, 23, TABLE_TOP + 1, 210, 1, "#6f4a2e");
  for (const [y, from, to] of [
    [88, 30, 110],
    [88, 140, 220],
    [92, 44, 96],
    [93, 120, 200],
    [97, 26, 80],
    [98, 150, 226],
    [101, 60, 170],
  ] as const) {
    rect(ctx, from, y, to - from, 1, "#664228");
  }
  rect(ctx, 22, TABLE_FRONT - 1, 212, 1, "#6f4a2e");
  // Front face.
  rect(ctx, 22, TABLE_FRONT, 212, 7, "#3a2415");
  rect(ctx, 22, TABLE_FRONT + 3, 212, 1, "#321f12");
  rect(ctx, 22, TABLE_FRONT + 7, 212, 1, "#17120e");
}

/** The room without anyone in it: wall and its things, window, floor, rug and the empty chairs for `seats` crew. */
export function drawRoom(seats: number, night: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext("2d")!;
  wall(ctx, night);
  door(ctx);
  wallPhone(ctx);
  noticeboard(ctx);
  filingCabinet(ctx);
  windowBlinds(ctx, night);
  floor(ctx, night);
  rug(ctx);
  // The window's light across the floor: faint at night, the sun by day.
  ctx.fillStyle = night ? "rgba(255,236,200,0.05)" : "rgba(255,240,200,0.13)";
  ctx.beginPath();
  ctx.moveTo(197, 40);
  ctx.lineTo(239, 40);
  ctx.lineTo(176, SCENE_H);
  ctx.lineTo(112, SCENE_H);
  ctx.closePath();
  ctx.fill();
  lamp(ctx, night);
  chair(ctx, BOSS_X, TABLE_TOP - 36, 34);
  for (let i = 0; i < Math.min(seats, FAR_SEATS.length); i++) chair(ctx, seatOf(i).x, TABLE_TOP - 15, 26);
  return canvas;
}

/** The table on its own, to lay over the members' shoulders. */
export function drawTable(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  table(canvas.getContext("2d")!);
  return canvas;
}

// ---- the people, every frame ----

const MINI: Grid = ["..KKK..", ".KHHHK.", "KhhhhhK", ".KFEFK.", ".KDdDK.", "..KKK.."];

/** 0..1 through a repeating cycle of `period` ms, shifted by the member's seed. */
function cycle(t: number, period: number, seed: number): number {
  return (((t + seed * period) % period) + period) % period / period;
}

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
  rect(ctx, x + 1, y, 9, 1, "#17120e");
  rect(ctx, x, y + 1, 11, 7, "#17120e");
  rect(ctx, x + 1, y + 8, 9, 1, "#17120e");
  rect(ctx, x + 1, y + 1, 9, 7, "#f7f3e6");
  rect(ctx, x + 4, y + 9, 3, 1, "#17120e");
  rect(ctx, x + 5, y + 10, 1, 1, "#17120e");
  rect(ctx, x + 4, y + 8, 3, 1, "#f7f3e6");
  if (mark === "typing") {
    const active = Math.floor(cycle(t, 900, seed) * 3);
    for (let i = 0; i < 3; i++) rect(ctx, x + 2 + i * 3, y + (i === active ? 3 : 4), 1, 1, "#4a4f58");
    return;
  }
  const colour = mark === "!" ? "#e5484d" : mark === "?" ? "#6e56cf" : "#e5484d";
  const glyph = GLYPHS[mark]!;
  glyph.forEach((row, gy) => {
    for (let gx = 0; gx < row.length; gx++) if (row[gx] === "X") rect(ctx, x + 4 + gx, y + 2 + gy, 1, 1, colour);
  });
}

function sleepyZ(ctx: Ctx, cx: number, top: number, t: number, seed: number) {
  for (let i = 0; i < 2; i++) {
    const p = cycle(t + i * 1400, 2800, seed);
    const x = cx + 4 + Math.round(p * 6);
    const y = top + 2 - Math.round(p * 10);
    ctx.globalAlpha = 1 - p;
    GLYPHS.z!.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === "X") rect(ctx, x + gx, y + gy, 1, 1, "#c9d1e0");
    });
  }
  ctx.globalAlpha = 1;
}

/** A crew member at the far side of the table: body, then (after the table) what is in their paws. */
function drawMember(ctx: Ctx, actor: Actor, seat: Seat, t: number, layer: "body" | "front") {
  const seed = seedOf(actor.id);
  const shake = actor.dizzy && cycle(t, 2600, seed) < 0.12 ? (Math.floor(t / 60) % 2 === 0 ? -1 : 1) : 0;
  const nod = actor.pose === "sleep" && cycle(t, 3000, seed) > 0.5 ? 1 : 0;
  const x = seat.x - 11 + shake;
  const y = seat.y + nod;
  if (layer === "body") {
    if (actor.pose === "away") {
      ctx.globalAlpha = 0.18 + 0.06 * Math.sin(t / 500 + seed * 6);
      ctx.drawImage(capySprite(actor.colour, false, actor.hat, "#c9d1e0"), x, y - 2 + Math.round(Math.sin(t / 700) * 1.5));
      ctx.globalAlpha = 1;
      return;
    }
    ctx.drawImage(capySprite(actor.colour, false, actor.hat), x, y);
    const blink = actor.pose !== "read" && cycle(t, 4200, seed) < 0.035;
    if (actor.pose === "sleep" || blink) closeEyes(ctx, x, y);
    if (actor.pose === "work") {
      // The screen's light on the face.
      ctx.fillStyle = `rgba(150,205,255,${0.1 + 0.05 * Math.sin(t / 90 + seed * 9)})`;
      ctx.fillRect(x + 5, y + 8, 12, 9);
    }
    return;
  }
  const top = TABLE_TOP;
  if (actor.pose === "work") {
    const tick = Math.floor(t / 110 + seed * 7);
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x - 12, top + (tick % 2 === 0 ? 0 : 1));
    stamp(ctx, "paw", PAW, BASE_PALETTE, seat.x + 7, top + (tick % 2 === 0 ? 1 : 0));
    stamp(ctx, "laptop", LAPTOP, LAPTOP_PALETTE, seat.x - 6, top - 2);
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

function drawMarks(ctx: Ctx, actor: Actor, seat: Seat, t: number) {
  const seed = seedOf(actor.id);
  if (actor.mark === "z") sleepyZ(ctx, seat.x, seat.y - 4, t, seed);
  else if (actor.mark) bubble(ctx, seat.x, seat.y - 13, actor.mark, t, seed);
}

/** Smoke from the boss's cigar: a few puffs rising and thinning. */
function smoke(ctx: Ctx, x: number, y: number, t: number) {
  for (let i = 0; i < 6; i++) {
    const p = cycle(t + i * 520, 3120, 0);
    ctx.fillStyle = `rgba(190,190,190,${0.45 * (1 - p)})`;
    const size = p > 0.5 ? 2 : 1;
    ctx.fillRect(Math.round(x + Math.sin(p * 6 + i) * 2 + p * 3), Math.round(y - p * 26), size, size);
  }
}

function dust(ctx: Ctx, t: number) {
  for (let i = 0; i < 14; i++) {
    const s = seedOf(`mote${i}`);
    const p = cycle(t, 16000 + s * 9000, s);
    const along = p;
    const across = (s * 7) % 1;
    const y = 42 + along * 100;
    const left = 197 + (112 - 197) * along;
    const right = 239 + (176 - 239) * along;
    const x = left + (right - left) * across + Math.sin(t / 1500 + i) * 2;
    ctx.fillStyle = `rgba(255,240,210,${0.25 + 0.2 * Math.sin(t / 700 + i)})`;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }
}

function clock(ctx: Ctx, now: Date) {
  const cx = 92;
  const cy = 20;
  ctx.fillStyle = "#7c6128";
  ctx.beginPath();
  ctx.arc(cx + 0.5, cy + 0.5, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8e0c8";
  ctx.beginPath();
  ctx.arc(cx + 0.5, cy + 0.5, 5.5, 0, Math.PI * 2);
  ctx.fill();
  const hand = (turns: number, length: number) => {
    const angle = turns * Math.PI * 2 - Math.PI / 2;
    for (let r = 0; r <= length; r += 0.5) rect(ctx, Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r), 1, 1, "#17120e");
  };
  hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12, 3);
  hand(now.getMinutes() / 60, 4.5);
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
  const { actors, t } = frame;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame.room, 0, 0);
  clock(ctx, frame.now);
  boardCards(ctx, frame.tasks.open, frame.tasks.alert);
  const seats = actors.map((_, i) => seatOf(i));
  // The far side: bodies, then the table over their shoulders, then their paws and things.
  ctx.drawImage(capySprite(frame.boss.colour, true), BOSS_SEAT.x - 11, BOSS_SEAT.y);
  actors.forEach((actor, i) => !seats[i]!.near && drawMember(ctx, actor, seats[i]!, t, "body"));
  ctx.drawImage(frame.table, 0, 0);
  stamp(ctx, "paw", PAW, BASE_PALETTE, BOSS_X - 10, TABLE_TOP + 1);
  stamp(ctx, "paw", PAW, BASE_PALETTE, BOSS_X + 5, TABLE_TOP + 1);
  stamp(ctx, "glass", GLASS, GLASS_PALETTE, BOSS_X + 11, TABLE_TOP + 6);
  stamp(ctx, "cigar", CIGAR, CIGAR_PALETTE, BOSS_X - 17, TABLE_TOP + 8);
  ledger(ctx);
  if (frame.motion) smoke(ctx, BOSS_X - 10, TABLE_TOP + 7, t);
  actors.forEach((actor, i) => !seats[i]!.near && drawMember(ctx, actor, seats[i]!, t, "front"));
  // The near side, in the dark, seen from behind.
  actors.forEach((actor, i) => {
    const seat = seats[i]!;
    if (!seat.near || actor.pose === "away") return;
    ctx.drawImage(capySprite(actor.colour, false, actor.hat, "#0c0d10"), seat.x - 11, seat.y);
  });
  // At night the lamp's warm pool, then the dark closing in at the edges; by day only a little shade in the corners.
  if (frame.night) {
    const light = ctx.createRadialGradient(BOSS_X, 92, 6, BOSS_X, 92, 130);
    light.addColorStop(0, "rgba(255,210,140,0.16)");
    light.addColorStop(1, "rgba(255,210,140,0)");
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  }
  const dark = ctx.createRadialGradient(BOSS_X, 84, 70, BOSS_X, 84, 175);
  dark.addColorStop(0, "rgba(0,0,0,0)");
  dark.addColorStop(1, frame.night ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.22)");
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  if (frame.motion) dust(ctx, t);
  for (const f of frame.flights) flight(ctx, f, t);
  if (frame.boss.mark && frame.boss.mark !== "z") bubble(ctx, BOSS_X, BOSS_SEAT.y - 13, frame.boss.mark, t, 0);
  actors.forEach((actor, i) => drawMarks(ctx, actor, seats[i]!, t));
}

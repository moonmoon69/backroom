/**
 * The street drawn in pixels, side-on: sky and a skyline behind, the block's buildings, the sidewalk and the road.
 * Everything is drawn in street coordinates (x along the block, y down from the top of the view), from the lots that
 * layout.ts makes; words (signs, numbers, labels) are laid over it in the DOM by StreetView.tsx.
 *
 * Night is the dark theme and day the light one. At night, surfaces lit only by the sky are toned down towards blue
 * and what gives light (lit windows, lamps) keeps its own colour.
 */
import { GAP, hashOf, WINDOWS_PER_FLOOR, type Business, type Facade, type Lot, type Street, type StreetWindow } from "./layout.ts";

export const SHOP_H = 44;
export const FLOOR_H = 28;
export const CORNICE_H = 6;
export const SIDEWALK_H = 12;
export const ROAD_H = 18;
/** What lies under the buildings: sidewalk and road. */
export const BELOW = SIDEWALK_H + ROAD_H;
/** The shortest view that fits the tallest building with a little sky. */
export const MIN_VIEW_H = CORNICE_H + SHOP_H + 3 * FLOOR_H + BELOW + 28;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const groundOf = (viewH: number) => viewH - BELOW;

export function buildingTop(lot: Lot, ground: number): number {
  return ground - SHOP_H - lot.floors * FLOOR_H - CORNICE_H;
}

const WINDOW_X = [10, 36, 62];

/** Window i fills the first floor above the shop first, then the floors above it. */
export function windowRect(lot: Lot, index: number, ground: number): Rect {
  const floor = Math.floor(index / WINDOWS_PER_FLOOR);
  const col = index % WINDOWS_PER_FLOOR;
  const top = ground - SHOP_H - (floor + 1) * FLOOR_H;
  return { x: lot.x + (WINDOW_X[col] ?? 10) + (lot.kind === "club" ? 2 : 0), y: top + 6, w: 16, h: 18 };
}

export const signRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + 5, y: ground - SHOP_H + 2, w: lot.width - 10, h: 10 });
export const doorRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + lot.width - 32, y: ground - 26, w: 16, h: 26 });
export const displayRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + 6, y: ground - 25, w: lot.width - 44, h: 21 });
export const plateRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + lot.width - 13, y: ground - 22, w: 8, h: 10 });
export const mailboxRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + 2, y: ground - 5, w: 8, h: 12 });
export const boardRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + 28, y: ground - 3, w: 18, h: 12 });
/** The club's street lamp: clicking it turns day into night and back. */
export const clubLampRect = (lot: Lot, ground: number): Rect => ({ x: lot.x - 3, y: ground - 62, w: 9, h: 71 });

type Ctx = CanvasRenderingContext2D;

// ---- colour ----

function parse(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${((c(ar, br) << 16) | (c(ag, bg) << 8) | c(ab, bb)).toString(16).padStart(6, "0")}`;
}

const toneCache = new Map<string, string>();
/** A surface lit only by the sky: as it is by day, towards night blue at night. */
function toned(night: boolean): (hex: string) => string {
  if (!night) return (hex) => hex;
  return (hex) => {
    let out = toneCache.get(hex);
    if (!out) {
      out = mix(hex, "#0b1224", 0.56);
      toneCache.set(hex, out);
    }
    return out;
  };
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function cycle(t: number, period: number, seed: number): number {
  return ((((t + seed * period) % period) + period) % period) / period;
}

// ---- sky and skyline ----

interface Tower {
  x: number;
  w: number;
  h: number;
  seed: number;
}

function towers(span: number, minW: number, maxW: number, minH: number, maxH: number, salt: number): Tower[] {
  const list: Tower[] = [];
  let x = 0;
  let i = 0;
  while (x < span) {
    const seed = hashOf(`${salt}:${i++}`);
    const w = minW + (seed % (maxW - minW + 1));
    const h = minH + ((seed >>> 8) % (maxH - minH + 1));
    list.push({ x, w, h, seed });
    x += w + ((seed >>> 16) % 4);
  }
  return list;
}

const FAR = towers(720, 12, 26, 34, 96, 1);
const NEAR = towers(900, 20, 38, 44, 112, 2);
const STARS = Array.from({ length: 48 }, (_, i) => {
  const s = hashOf(`star${i}`);
  return { x: s % 997, y: (s >>> 10) % 120, big: (s >>> 20) % 7 === 0 };
});

function skyline(ctx: Ctx, list: Tower[], span: number, offset: number, viewW: number, ground: number, body: string, lit: string | null, t: number) {
  const start = -(((offset % span) + span) % span);
  for (let base = start; base < viewW; base += span) {
    for (const tower of list) {
      const x = base + tower.x;
      if (x + tower.w < 0 || x > viewW) continue;
      const top = ground - tower.h;
      rect(ctx, x, top, tower.w, tower.h, body);
      if (tower.seed % 5 === 0) rect(ctx, x + Math.floor(tower.w / 2) - 1, top - 8, 2, 8, body);
      if (tower.seed % 7 === 1) rect(ctx, x + 2, top - 3, tower.w - 4, 3, body);
      if (!lit) continue;
      for (let wy = top + 4; wy < ground - 6; wy += 5) {
        for (let wx = x + 2; wx < x + tower.w - 2; wx += 4) {
          const on = hashOf(`${tower.seed}:${wx - x}:${wy - top}`) % 9 === 0;
          if (!on) continue;
          const flicker = hashOf(`${tower.seed}:${wy}`) % 23 === 0 && cycle(t, 5000, tower.seed % 13) < 0.3;
          if (!flicker) rect(ctx, wx, wy, 1, 2, lit);
        }
      }
    }
  }
}

function sky(ctx: Ctx, viewW: number, ground: number, camX: number, night: boolean, t: number) {
  const gradient = ctx.createLinearGradient(0, 0, 0, ground);
  gradient.addColorStop(0, night ? "#070b16" : "#86bfe6");
  gradient.addColorStop(1, night ? "#1b2640" : "#dcefff");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, viewW, ground);
  if (night) {
    for (const star of STARS) {
      const x = (((star.x - camX * 0.05) % viewW) + viewW) % viewW;
      if (star.y > ground - 60) continue;
      const twinkle = cycle(t, 3000, star.x % 17) < 0.1 ? 0.4 : 1;
      ctx.globalAlpha = twinkle;
      rect(ctx, x, star.y, 1, 1, "#e8e6d8");
      if (star.big) rect(ctx, x, star.y + 1, 1, 1, "#9aa2b8");
      ctx.globalAlpha = 1;
    }
    // The moon.
    const mx = viewW - 34;
    ctx.fillStyle = "#efe8cf";
    ctx.beginPath();
    ctx.arc(mx, 20, 6, 0, Math.PI * 2);
    ctx.fill();
    rect(ctx, mx - 2, 18, 2, 2, "#d6ceb2");
    rect(ctx, mx + 2, 22, 1, 1, "#d6ceb2");
  } else {
    const sx = viewW - 38;
    ctx.fillStyle = "rgba(255,244,190,0.35)";
    ctx.beginPath();
    ctx.arc(sx, 22, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff4bf";
    ctx.beginPath();
    ctx.arc(sx, 22, 6, 0, Math.PI * 2);
    ctx.fill();
    // A few clouds drifting.
    for (let i = 0; i < 4; i++) {
      const s = hashOf(`cloud${i}`);
      const span = viewW + 80;
      const x = ((((s % 600) - camX * 0.08 + t / 900) % span) + span) % span - 40;
      const y = 10 + ((s >>> 9) % 34);
      rect(ctx, x, y, 22, 4, "#f4f9ff");
      rect(ctx, x + 4, y - 3, 12, 3, "#f4f9ff");
      rect(ctx, x + 2, y + 4, 18, 1, "#d8e8f5");
    }
  }
  skyline(ctx, FAR, 720, camX * 0.25, viewW, ground - 8, night ? "#121a2c" : "#b3c6d6", night ? "#c9a95e" : null, t);
  skyline(ctx, NEAR, 900, camX * 0.5, viewW, ground - 2, night ? "#0d1321" : "#98adbd", night ? "#e2bd6a" : null, t);
}

// ---- windows ----

function silhouette(ctx: Ctx, x: number, y: number, colour: string) {
  // A hat, a head, shoulders.
  rect(ctx, x + 1, y, 4, 2, colour);
  rect(ctx, x, y + 2, 6, 1, colour);
  rect(ctx, x + 1, y + 3, 4, 2, colour);
  rect(ctx, x, y + 5, 6, 3, colour);
}

function drawWindow(ctx: Ctx, w: StreetWindow, r: Rect, trim: string, night: boolean, tone: (hex: string) => string, t: number, seed: number) {
  const gx = r.x + 1;
  const gy = r.y + 1;
  const gw = r.w - 2;
  const gh = r.h - 2;
  // Lintel and sill.
  rect(ctx, r.x - 1, r.y - 2, r.w + 2, 2, tone(trim));
  rect(ctx, r.x - 1, r.y + r.h, r.w + 2, 2, tone(trim));
  rect(ctx, r.x, r.y, r.w, r.h, "#15110e");
  const lit = w.state === "working" || w.state === "background" || w.state === "needs";
  if (lit) {
    const g = ctx.createLinearGradient(0, gy, 0, gy + gh);
    g.addColorStop(0, night ? "#ffd58a" : "#e2b983");
    g.addColorStop(1, night ? "#d98a3c" : "#b8844f");
    ctx.fillStyle = g;
    ctx.fillRect(gx, gy, gw, gh);
    // Blinds pulled up.
    for (let i = 0; i < 2; i++) rect(ctx, gx, gy + i * 2, gw, 1, night ? "#e9d3a4" : "#efe3c6");
  } else if (w.state === "dark") {
    rect(ctx, gx, gy, gw, gh, night ? "#11172a" : "#7890a2");
    // Blinds down.
    for (let y = gy; y < gy + gh; y += 2) rect(ctx, gx, y, gw, 1, night ? "#1b2236" : "#d5cbb0");
  } else {
    // Idle or failed: a dim room, blinds half down.
    rect(ctx, gx, gy, gw, gh, night ? "#5b3d22" : "#4d433a");
    for (let y = gy; y < gy + Math.floor(gh / 2); y += 2) rect(ctx, gx, y, gw, 1, night ? "#8a6a44" : "#dcd2b6");
  }
  if (!night && w.state !== "dark") {
    // A glint on the glass by day.
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 5; i++) rect(ctx, gx + gw - 2 - i, gy + gh - 7 + i, 1, 1, "#ffffff");
    ctx.globalAlpha = 1;
  }
  // Who is in there.
  const figure = night ? "#2a1a10" : "#2f261f";
  const bottom = gy + gh - 8;
  if (w.state !== "dark") {
    if (w.kind === "thread") {
      const bob = w.state === "working" && cycle(t, 700, seed) < 0.5 ? 1 : 0;
      silhouette(ctx, gx + 2, bottom + bob, figure);
      // A desk lamp beside them.
      rect(ctx, gx + 10, bottom + 2, 3, 1, "#2f5d46");
      rect(ctx, gx + 11, bottom + 3, 1, 5, figure);
    } else {
      const people = Math.min(3, Math.max(1, w.members));
      for (let i = 0; i < people; i++) {
        const bob = w.state === "working" && cycle(t + i * 230, 650, seed) < 0.5 ? 1 : 0;
        silhouette(ctx, gx + (people === 1 ? 4 : i * 4 + (people === 2 ? 2 : 0)), bottom + 1 + bob - (i % 2), figure);
      }
    }
  }
  if (w.state === "needs") {
    // A card with a "!" in the window.
    const bob = cycle(t, 1200, seed) < 0.5 ? 0 : 1;
    const cx = gx + gw - 7;
    const cy = gy + 3 + bob;
    rect(ctx, cx, cy, 6, 8, "#fbf6e6");
    rect(ctx, cx + 2, cy + 1, 2, 4, "#d9342b");
    rect(ctx, cx + 2, cy + 6, 2, 1, "#d9342b");
    if (night && cycle(t, 1400, seed) < 0.5) {
      ctx.fillStyle = "rgba(255,170,60,0.25)";
      ctx.fillRect(gx, gy, gw, gh);
    }
  }
  if (w.state === "failed") {
    // A CLOSED sign hanging crooked.
    const cx = gx + 1;
    const cy = gy + 6;
    rect(ctx, cx + 2, gy + 1, 1, 5, "#8a8070");
    rect(ctx, cx + 10, gy + 1, 1, 6, "#8a8070");
    rect(ctx, cx, cy, 7, 5, "#f1ebdd");
    rect(ctx, cx + 7, cy + 1, 6, 5, "#f1ebdd");
    for (let i = 0; i < 5; i++) rect(ctx, cx + 1 + i * 2 + (i > 2 ? 1 : 0), cy + 2 + (i > 2 ? 1 : 0), 1, 2, "#c0302a");
  }
  if (w.unseen > 0 && w.state !== "failed") {
    // A letter on the sill.
    rect(ctx, r.x + r.w - 7, r.y + r.h - 2, 6, 4, "#fbf6e6");
    rect(ctx, r.x + r.w - 7, r.y + r.h - 2, 6, 1, "#b7ad8e");
    rect(ctx, r.x + r.w - 5, r.y + r.h - 1, 2, 1, "#b7ad8e");
  }
  // Frame bars.
  rect(ctx, gx + Math.floor(gw / 2), gy, 1, gh, "#15110e");
}

// ---- the shop window: what each business shows ----

function shopProps(ctx: Ctx, business: Business, r: Rect, tone: (hex: string) => string, lit: boolean) {
  const c = (hex: string) => (lit ? hex : tone(hex));
  const floor = r.y + r.h - 2;
  switch (business) {
    case "diner":
      rect(ctx, r.x + 2, floor - 5, r.w - 4, 2, c("#c8c2b5"));
      for (let x = r.x + 5; x < r.x + r.w - 4; x += 7) {
        rect(ctx, x, floor - 9, 4, 2, c("#c0302a"));
        rect(ctx, x + 1, floor - 7, 2, 2, c("#8a8a8a"));
      }
      rect(ctx, r.x + r.w - 10, floor - 14, 7, 2, c("#e9d8a6"));
      rect(ctx, r.x + r.w - 8, floor - 16, 3, 2, c("#b8632e"));
      break;
    case "print":
      rect(ctx, r.x + 4, floor - 12, 14, 12, c("#2f3338"));
      rect(ctx, r.x + 6, floor - 10, 10, 3, c("#5a6068"));
      rect(ctx, r.x + 20, floor - 8, 6, 8, c("#6b6f75"));
      for (let i = 0; i < 4; i++) rect(ctx, r.x + 28, floor - 2 - i * 2, 10, 1, c("#f1ecde"));
      break;
    case "tailor":
      for (const dx of [6, 22]) {
        rect(ctx, r.x + dx + 3, floor - 17, 4, 2, c("#c9b28a"));
        rect(ctx, r.x + dx, floor - 15, 10, 9, c(dx === 6 ? "#2d3350" : "#4a3a2a"));
        rect(ctx, r.x + dx + 4, floor - 15, 2, 6, c("#e9e3d3"));
        rect(ctx, r.x + dx + 4, floor - 6, 2, 6, c("#6b5a44"));
      }
      rect(ctx, r.x + 36, floor - 4, 5, 4, c("#b58b2a"));
      break;
    case "jazz":
      rect(ctx, r.x + 8, floor - 16, 2, 12, c("#d9a73a"));
      rect(ctx, r.x + 6, floor - 5, 6, 3, c("#d9a73a"));
      rect(ctx, r.x + 10, floor - 16, 3, 1, c("#d9a73a"));
      rect(ctx, r.x + 20, floor - 15, 1, 5, c("#e9e3d3"));
      rect(ctx, r.x + 18, floor - 11, 3, 2, c("#e9e3d3"));
      rect(ctx, r.x + 28, floor - 12, 1, 5, c("#e9e3d3"));
      rect(ctx, r.x + 26, floor - 8, 3, 2, c("#e9e3d3"));
      rect(ctx, r.x + 30, floor - 3, 8, 3, c("#6a1f24"));
      break;
    case "bakery":
      rect(ctx, r.x + 5, floor - 6, 12, 6, c("#f3e3c3"));
      rect(ctx, r.x + 7, floor - 10, 8, 4, c("#f7ecd6"));
      rect(ctx, r.x + 9, floor - 12, 4, 2, c("#d94f6a"));
      for (let x = r.x + 21; x < r.x + r.w - 6; x += 6) rect(ctx, x, floor - 4, 5, 3, c("#c98a3a"));
      rect(ctx, r.x + 20, floor - 1, r.w - 24, 1, c("#8a6a44"));
      break;
    case "barber":
      rect(ctx, r.x + 8, floor - 10, 10, 6, c("#8a2f2f"));
      rect(ctx, r.x + 10, floor - 14, 6, 4, c("#8a2f2f"));
      rect(ctx, r.x + 12, floor - 4, 2, 4, c("#9a9a9a"));
      rect(ctx, r.x + 26, floor - 16, 8, 10, c("#b9c7cf"));
      rect(ctx, r.x + 27, floor - 15, 6, 8, c("#dfe8ee"));
      break;
    case "pawn":
      rect(ctx, r.x + 6, floor - 14, 3, 10, c("#8a5a32"));
      rect(ctx, r.x + 4, floor - 6, 7, 6, c("#b8742f"));
      rect(ctx, r.x + 6, floor - 4, 3, 2, c("#2a1a10"));
      for (let i = 0; i < 3; i++) rect(ctx, r.x + 18 + i * 5, floor - 3, 3, 3, c("#d9b44a"));
      rect(ctx, r.x + 34, floor - 10, 6, 6, c("#e9e3d3"));
      rect(ctx, r.x + 36, floor - 8, 1, 3, c("#2a1a10"));
      break;
    case "laundry":
      for (const dx of [4, 20]) {
        rect(ctx, r.x + dx, floor - 13, 13, 13, c("#dcdcd6"));
        rect(ctx, r.x + dx + 3, floor - 10, 7, 7, c("#6f8ca0"));
        rect(ctx, r.x + dx + 4, floor - 9, 3, 2, c("#b7cbd8"));
      }
      break;
    case "pizza":
      rect(ctx, r.x + 6, floor - 8, 14, 7, c("#e0a44a"));
      rect(ctx, r.x + 7, floor - 7, 12, 5, c("#d9573a"));
      for (const [dx, dy] of [
        [9, -6],
        [14, -5],
        [11, -4],
      ] as const)
        rect(ctx, r.x + dx, floor + dy, 2, 1, c("#8a1f1f"));
      rect(ctx, r.x + 24, floor - 15, 2, 15, c("#8a5a32"));
      rect(ctx, r.x + 22, floor - 17, 6, 3, c("#b8894e"));
      break;
    case "deli":
      for (let i = 0; i < 4; i++) {
        rect(ctx, r.x + 6 + i * 6, r.y + 2, 1, 3, c("#8a8070"));
        rect(ctx, r.x + 5 + i * 6, r.y + 5, 3, 7, c(i % 2 ? "#8a2f2f" : "#a0432f"));
      }
      rect(ctx, r.x + 30, floor - 5, 9, 5, c("#e9c35a"));
      rect(ctx, r.x + 31, floor - 4, 7, 1, c("#f6dc86"));
      break;
  }
}

// ---- buildings ----

function brickWall(ctx: Ctx, x: number, y: number, w: number, h: number, facade: Facade, tone: (hex: string) => string) {
  rect(ctx, x, y, w, h, tone(facade.brick));
  for (let row = 0, yy = y + 2; yy < y + h; yy += 3, row++) {
    rect(ctx, x, yy, w, 1, tone(facade.mortar));
    for (let xx = x + (row % 2 ? 3 : 0); xx < x + w; xx += 6) rect(ctx, xx, yy - 2, 1, 2, tone(facade.mortar));
  }
  // Shade at the right edge and outline.
  rect(ctx, x + w - 2, y, 2, h, tone(facade.shade));
  rect(ctx, x, y, 1, h, tone(facade.shade));
}

function cornice(ctx: Ctx, x: number, y: number, w: number, facade: Facade, tone: (hex: string) => string) {
  rect(ctx, x - 1, y, w + 2, 4, tone(facade.trim));
  for (let xx = x; xx < x + w; xx += 3) rect(ctx, xx, y + 4, 2, 1, tone(facade.trim));
  rect(ctx, x - 1, y + 3, w + 2, 1, tone(mix(facade.trim, "#000000", 0.25)));
  rect(ctx, x, y + 5, w, 1, tone(facade.shade));
}

function awning(ctx: Ctx, x: number, y: number, w: number, facade: Facade, tone: (hex: string) => string) {
  for (let xx = 0; xx < w; xx++) {
    const colour = Math.floor(xx / 4) % 2 === 0 ? facade.awning : facade.stripe;
    rect(ctx, x + xx, y, 1, 6, tone(colour));
    if (xx % 4 === 1 || xx % 4 === 2) rect(ctx, x + xx, y + 6, 1, 1, tone(colour));
  }
  rect(ctx, x, y, w, 1, tone(mix(facade.awning, "#000000", 0.35)));
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x, y + 7, w, 2);
}

function door(ctx: Ctx, r: Rect, facade: Facade, tone: (hex: string) => string, night: boolean, lit: boolean) {
  rect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 2, tone(facade.trim));
  rect(ctx, r.x, r.y, r.w, r.h, tone("#2a1b12"));
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 1, tone("#4a2f1d"));
  // The glass in the door: warm when someone is at work inside.
  rect(ctx, r.x + 3, r.y + 3, r.w - 6, 9, lit && night ? "#f4c77a" : lit ? "#d9b27c" : tone("#6d8596"));
  rect(ctx, r.x + 3 + Math.floor((r.w - 6) / 2), r.y + 3, 1, 9, tone("#2a1b12"));
  rect(ctx, r.x + 3, r.y + 15, r.w - 6, 1, tone("#3a2416"));
  rect(ctx, r.x + r.w - 4, r.y + 15, 2, 2, "#c9a24a");
  // The step.
  rect(ctx, r.x - 3, r.y + r.h - 1, r.w + 6, 2, tone("#8a857c"));
}

function plate(ctx: Ctx, r: Rect, tone: (hex: string) => string, alert: boolean) {
  rect(ctx, r.x, r.y, r.w, r.h, tone("#8a6a2a"));
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, tone("#c9a24a"));
  for (let i = 0; i < 3; i++) rect(ctx, r.x + 2, r.y + 2 + i * 2, r.w - 4, 1, tone("#6a5020"));
  if (alert) rect(ctx, r.x + r.w - 3, r.y - 2, 3, 3, "#d9342b");
}

function mailbox(ctx: Ctx, r: Rect, tone: (hex: string) => string, flag: boolean) {
  rect(ctx, r.x + 1, r.y + r.h - 3, 2, 3, tone("#1d2c4f"));
  rect(ctx, r.x + r.w - 3, r.y + r.h - 3, 2, 3, tone("#1d2c4f"));
  rect(ctx, r.x, r.y + 2, r.w, r.h - 5, tone("#2b4b8c"));
  rect(ctx, r.x + 1, r.y, r.w - 2, 2, tone("#2b4b8c"));
  rect(ctx, r.x + 2, r.y + 3, r.w - 4, 1, tone("#101a33"));
  if (flag) {
    rect(ctx, r.x + r.w, r.y - 4, 1, 7, "#8a8070");
    rect(ctx, r.x + r.w + 1, r.y - 4, 3, 3, "#d9342b");
  }
}

function chalkboard(ctx: Ctx, r: Rect, tone: (hex: string) => string) {
  rect(ctx, r.x + 1, r.y + r.h - 2, 2, 2, tone("#6b4a2a"));
  rect(ctx, r.x + r.w - 3, r.y + r.h - 2, 2, 2, tone("#6b4a2a"));
  rect(ctx, r.x, r.y, r.w, r.h - 2, tone("#6b4a2a"));
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 4, tone("#1f2a24"));
}

function lampPost(ctx: Ctx, x: number, ground: number, night: boolean, tone: (hex: string) => string, double = false) {
  const top = ground - 60;
  rect(ctx, x, top + 4, 2, ground + 8 - top - 4, tone("#1d2226"));
  rect(ctx, x - 1, ground + 6, 4, 3, tone("#1d2226"));
  const heads = double ? [x - 4, x + 4] : [x];
  if (double) rect(ctx, x - 3, top + 4, 8, 1, tone("#1d2226"));
  for (const hx of heads) {
    rect(ctx, hx - 1, top, 4, 1, tone("#1d2226"));
    rect(ctx, hx - 1, top + 1, 4, 3, night ? "#ffe6a8" : tone("#e8e2cc"));
    if (night) {
      ctx.fillStyle = "rgba(255,221,150,0.10)";
      ctx.beginPath();
      ctx.moveTo(hx - 1, top + 4);
      ctx.lineTo(hx + 3, top + 4);
      ctx.lineTo(hx + 16, ground + 9);
      ctx.lineTo(hx - 14, ground + 9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,221,150,0.18)";
      ctx.beginPath();
      ctx.arc(hx + 1, top + 2, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function waterTower(ctx: Ctx, x: number, roof: number, tone: (hex: string) => string) {
  rect(ctx, x + 2, roof - 6, 1, 6, tone("#2a2a2a"));
  rect(ctx, x + 11, roof - 6, 1, 6, tone("#2a2a2a"));
  rect(ctx, x + 2, roof - 4, 10, 1, tone("#2a2a2a"));
  rect(ctx, x, roof - 18, 14, 12, tone("#7a5a3a"));
  for (let xx = x + 2; xx < x + 14; xx += 3) rect(ctx, xx, roof - 18, 1, 12, tone("#65482e"));
  rect(ctx, x, roof - 14, 14, 1, tone("#3a3a3a"));
  rect(ctx, x, roof - 9, 14, 1, tone("#3a3a3a"));
  rect(ctx, x - 1, roof - 21, 16, 3, tone("#4a3a2a"));
  rect(ctx, x + 2, roof - 23, 10, 2, tone("#4a3a2a"));
  rect(ctx, x + 6, roof - 25, 2, 2, tone("#4a3a2a"));
}

function fireEscape(ctx: Ctx, lot: Lot, ground: number, tone: (hex: string) => string) {
  const iron = tone("#1a1c1f");
  const x = lot.x + 58;
  for (let floor = 0; floor < lot.floors; floor++) {
    const y = ground - SHOP_H - floor * FLOOR_H - 2;
    rect(ctx, x, y, 24, 1, iron);
    rect(ctx, x, y - 5, 24, 1, iron);
    for (let xx = x; xx <= x + 24; xx += 4) rect(ctx, xx, y - 5, 1, 5, iron);
    if (floor < lot.floors - 1) {
      for (let i = 0; i < FLOOR_H - 4; i++) rect(ctx, x + 3 + Math.floor(i * 0.7), y - 1 - i, 2, 1, iron);
    }
  }
}

function business(ctx: Ctx, lot: Lot, ground: number, night: boolean, t: number) {
  const tone = toned(night);
  const top = buildingTop(lot, ground);
  const { facade } = lot;
  brickWall(ctx, lot.x, top, lot.width, ground - top, facade, tone);
  cornice(ctx, lot.x, top, lot.width, facade, tone);
  if (lot.waterTower) waterTower(ctx, lot.x + 58 - (lot.seed % 30), top, tone);
  // Upper floors: a window for each room and thread; the rest stay dark.
  const slots = lot.floors * WINDOWS_PER_FLOOR;
  for (let i = 0; i < slots; i++) {
    const w: StreetWindow = lot.windows[i] ?? { kind: "room", id: "", title: "", state: "dark", label: "", unseen: 0, members: 0 };
    drawWindow(ctx, w, windowRect(lot, i, ground), facade.trim, night, tone, t, (lot.seed % 97) / 97 + i * 0.13);
  }
  if (lot.fireEscape) fireEscape(ctx, lot, ground, tone);
  // The shop: sign board, awning, window, door, the lobby directory.
  rect(ctx, lot.x, ground - SHOP_H, lot.width, SHOP_H, tone(facade.shade));
  const sign = signRect(lot, ground);
  rect(ctx, sign.x - 1, sign.y - 1, sign.w + 2, sign.h + 2, tone(facade.trim));
  rect(ctx, sign.x, sign.y, sign.w, sign.h, tone("#1d1a17"));
  awning(ctx, lot.x + 4, ground - SHOP_H + 13, lot.width - 8, facade, tone);
  const shop = displayRect(lot, ground);
  const lit = lot.working > 0 || lot.windows.some((w) => w.state === "working" || w.state === "background");
  rect(ctx, shop.x - 1, shop.y - 1, shop.w + 2, shop.h + 2, tone(facade.trim));
  const inside = night ? (lot.windows.length > 0 ? "#6b4a2a" : "#1d2130") : "#8aa3b3";
  rect(ctx, shop.x, shop.y, shop.w, shop.h, night ? inside : tone(inside));
  if (lot.business) shopProps(ctx, lot.business.key, shop, tone, night && lot.windows.length > 0);
  if (!night) {
    ctx.globalAlpha = 0.3;
    for (let i = 0; i < 9; i++) rect(ctx, shop.x + shop.w - 4 - i * 2, shop.y + 2 + i * 2, 2, 1, "#ffffff");
    ctx.globalAlpha = 1;
  }
  rect(ctx, shop.x, shop.y + shop.h, shop.w, 4, tone(facade.trim));
  door(ctx, doorRect(lot, ground), facade, tone, night, lit);
  plate(ctx, plateRect(lot, ground), tone, lot.hidden.some((w) => w.state === "needs"));
  if (lot.business?.key === "barber") {
    // The barber's pole beside the door.
    const px = lot.x + lot.width - 35;
    rect(ctx, px, ground - 24, 3, 14, "#f1ebdd");
    for (let i = 0; i < 5; i++) rect(ctx, px, ground - 24 + ((i * 3 + Math.floor(t / 250)) % 14), 3, 1, "#c0302a");
  }
  if (lot.business?.key === "pawn") {
    const px = lot.x + lot.width - 36;
    rect(ctx, px, ground - 30, 5, 1, tone("#6a5020"));
    for (const [dx, dy] of [
      [-1, 1],
      [3, 1],
      [1, 4],
    ] as const)
      rect(ctx, px + dx, ground - 30 + dy, 3, 3, tone("#d9b44a"));
  }
  mailbox(ctx, mailboxRect(lot, ground), tone, lot.unseen > 0);
  chalkboard(ctx, boardRect(lot, ground), tone);
}

function club(ctx: Ctx, lot: Lot, ground: number, night: boolean, crew: number, t: number) {
  const tone = toned(night);
  const top = buildingTop(lot, ground);
  const green: Facade = { ...lot.facade, brick: "#2f4a3a", mortar: "#294033", shade: "#1f3328", trim: "#c9a24a", awning: "#1f3a2b", stripe: "#c9a24a" };
  brickWall(ctx, lot.x, top, lot.width, ground - top, green, tone);
  cornice(ctx, lot.x, top, lot.width, green, tone);
  for (let i = 0; i < lot.floors * WINDOWS_PER_FLOOR; i++) {
    const w: StreetWindow = { kind: "room", id: "", title: "", state: i < Math.ceil(crew / 2) ? "idle" : "dark", label: "", unseen: 0, members: Math.min(2, crew - i * 2) };
    drawWindow(ctx, w, windowRect(lot, i, ground), green.trim, night, tone, t, i * 0.2);
  }
  rect(ctx, lot.x, ground - SHOP_H, lot.width, SHOP_H, tone(green.shade));
  const sign = signRect(lot, ground);
  rect(ctx, sign.x - 1, sign.y - 1, sign.w + 2, sign.h + 2, tone(green.trim));
  rect(ctx, sign.x, sign.y, sign.w, sign.h, tone("#13241b"));
  awning(ctx, lot.x + 4, ground - SHOP_H + 13, lot.width - 8, green, tone);
  const shop = displayRect(lot, ground);
  rect(ctx, shop.x - 1, shop.y - 1, shop.w + 2, shop.h + 2, tone(green.trim));
  rect(ctx, shop.x, shop.y, shop.w, shop.h, night ? "#5a3a22" : tone("#3a2a22"));
  // Velvet curtains drawn back, and the club's books on a board inside.
  rect(ctx, shop.x, shop.y, 5, shop.h, tone("#6a1f24"));
  rect(ctx, shop.x + shop.w - 5, shop.y, 5, shop.h, tone("#6a1f24"));
  rect(ctx, shop.x + 7, shop.y + 3, shop.w - 14, shop.h - 7, tone("#6b4a2a"));
  rect(ctx, shop.x + 8, shop.y + 4, shop.w - 16, shop.h - 9, tone("#1f2a24"));
  rect(ctx, shop.x, shop.y + shop.h, shop.w, 4, tone(green.trim));
  door(ctx, doorRect(lot, ground), green, tone, night, true);
}

function rent(ctx: Ctx, lot: Lot, ground: number, night: boolean) {
  const tone = toned(night);
  const top = buildingTop(lot, ground);
  brickWall(ctx, lot.x, top, lot.width, ground - top, lot.facade, tone);
  cornice(ctx, lot.x, top, lot.width, lot.facade, tone);
  for (let i = 0; i < WINDOWS_PER_FLOOR; i++) {
    const r = windowRect(lot, i, ground);
    const shifted = { ...r, x: r.x - 4 };
    drawWindow(ctx, { kind: "room", id: "", title: "", state: "dark", label: "", unseen: 0, members: 0 }, shifted, lot.facade.trim, night, tone, 0, 0);
  }
  rect(ctx, lot.x, ground - SHOP_H, lot.width, SHOP_H, tone(lot.facade.shade));
  const sign = signRect(lot, ground);
  rect(ctx, sign.x, sign.y, sign.w, sign.h, tone("#6b5a44"));
  const shop = displayRect(lot, ground);
  rect(ctx, shop.x, shop.y, shop.w, shop.h, tone("#2a2622"));
  // Boards across the empty window, and a paper sign.
  for (let i = 0; i < 3; i++) rect(ctx, shop.x - 1, shop.y + 3 + i * 7, shop.w + 2, 3, tone("#9a7a4e"));
  rect(ctx, shop.x + 8, shop.y + 5, 16, 11, "#f1ebdd");
  rect(ctx, shop.x + 10, shop.y + 8, 12, 1, "#c0302a");
  rect(ctx, shop.x + 10, shop.y + 11, 9, 1, "#8a8070");
  door(ctx, doorRect(lot, ground), lot.facade, tone, night, false);
}

/** Buildings past both ends of the block, so the street does not stop at the edge. */
function filler(ctx: Ctx, x: number, w: number, index: number, ground: number, night: boolean) {
  const tone = toned(night);
  const seed = hashOf(`filler${index}`);
  const floors = 1 + (seed % 3);
  const top = ground - SHOP_H - floors * FLOOR_H - CORNICE_H;
  const facade: Facade = { brick: "#4f3f3a", mortar: "#43352f", shade: "#382c27", trim: "#9f9784", awning: "#3a3a3a", stripe: "#6a6a6a" };
  brickWall(ctx, x, top, w, ground - top, facade, (hex) => mix(tone(hex), "#000000", 0.25));
  cornice(ctx, x, top, w, facade, (hex) => mix(tone(hex), "#000000", 0.25));
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < 3; c++) {
      const on = night && hashOf(`${seed}:${f}:${c}`) % 4 === 0;
      rect(ctx, x + 8 + c * 22, ground - SHOP_H - (f + 1) * FLOOR_H + 6, 12, 16, on ? "#9a6a3a" : mix(tone("#3a4452"), "#000000", 0.3));
    }
  }
  rect(ctx, x, ground - SHOP_H, w, SHOP_H, mix(tone("#2a2522"), "#000000", 0.2));
  rect(ctx, x + 6, ground - 26, w - 12, 20, mix(tone("#1f2226"), "#000000", 0.2));
}

function street(ctx: Ctx, x0: number, x1: number, ground: number, viewH: number, night: boolean, lamps: number[]) {
  const tone = toned(night);
  rect(ctx, x0, ground, x1 - x0, SIDEWALK_H, tone("#8f8a82"));
  rect(ctx, x0, ground, x1 - x0, 1, tone("#6a655d"));
  for (let x = Math.floor(x0 / 14) * 14; x < x1; x += 14) rect(ctx, x, ground + 1, 1, SIDEWALK_H - 3, tone("#7a756d"));
  rect(ctx, x0, ground + SIDEWALK_H - 2, x1 - x0, 1, tone("#b9b4a8"));
  rect(ctx, x0, ground + SIDEWALK_H - 1, x1 - x0, 1, tone("#5a564f"));
  const road = ground + SIDEWALK_H;
  rect(ctx, x0, road, x1 - x0, viewH - road, tone("#4a4d53"));
  const lane = road + Math.floor((viewH - road) / 2);
  for (let x = Math.floor(x0 / 22) * 22; x < x1; x += 22) rect(ctx, x, lane, 9, 1, tone("#d8c46a"));
  if (night) {
    // Puddles under the lamps, with the light in them.
    for (const lx of lamps) {
      if (lx < x0 - 20 || lx > x1 + 20) continue;
      rect(ctx, lx - 8, road + 3, 20, 3, "#23262c");
      ctx.fillStyle = "rgba(255,214,140,0.35)";
      for (let i = 0; i < 4; i++) ctx.fillRect(lx - 2 + i * 2, road + 3 + (i % 2), 1, 2);
    }
  }
}

function car(ctx: Ctx, x: number, ground: number, seed: number, night: boolean) {
  const tone = toned(night);
  const body = tone(["#2d3350", "#5a1f24", "#2f4a3a", "#1d1d1f", "#6b5a3e"][seed % 5]!);
  const y = ground + SIDEWALK_H - 4;
  rect(ctx, x + 2, y + 8, 26, 2, "rgba(0,0,0,0.35)");
  rect(ctx, x, y + 3, 30, 6, body);
  rect(ctx, x + 7, y - 1, 15, 4, body);
  rect(ctx, x + 9, y, 5, 3, tone("#8aa3b3"));
  rect(ctx, x + 15, y, 5, 3, tone("#8aa3b3"));
  rect(ctx, x + 1, y + 5, 28, 1, tone("#c9c2b0"));
  for (const wx of [x + 4, x + 21]) {
    rect(ctx, wx, y + 7, 5, 4, "#111111");
    rect(ctx, wx + 2, y + 8, 1, 2, tone("#8a8a8a"));
  }
  rect(ctx, x + 29, y + 4, 1, 2, night ? "#ffe6a8" : tone("#e8e2cc"));
}

export interface StreetFrame {
  street: Street;
  camX: number;
  viewW: number;
  viewH: number;
  night: boolean;
  /** Crew waiting at the club (presets), for its windows. */
  crew: number;
  t: number;
}

/** Where the street lamps stand: between lots that have one. */
export function lampsOf(street: Street): number[] {
  return street.lots.filter((lot) => lot.lamp && lot.kind === "business").map((lot) => lot.x + lot.width + Math.floor(GAP / 2) - 1);
}

export function drawStreet(ctx: Ctx, frame: StreetFrame) {
  const { street: block, viewW, viewH, night, t } = frame;
  const camX = Math.round(frame.camX);
  const ground = groundOf(viewH);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  sky(ctx, viewW, ground, camX, night, t);
  ctx.setTransform(1, 0, 0, 1, -camX, 0);
  const x0 = camX - 4;
  const x1 = camX + viewW + 4;
  // Past both ends of the block.
  for (let i = 1, x = -84; x + 84 > x0; i++, x -= 84) filler(ctx, x, 80, -i, ground, night);
  for (let i = 1, x = block.width + GAP; x < x1; i++, x += 84) filler(ctx, x, 80, i, ground, night);
  const lamps = lampsOf(block);
  street(ctx, x0, x1, ground, viewH, night, lamps);
  for (const lot of block.lots) {
    if (lot.x + lot.width < x0 - 30 || lot.x > x1 + 30) continue;
    if (lot.kind === "business") business(ctx, lot, ground, night, t);
    else if (lot.kind === "club") club(ctx, lot, ground, night, frame.crew, t);
    else rent(ctx, lot, ground, night);
  }
  // Lamps and a parked car here and there, in front of the buildings.
  const clubLot = block.lots[0];
  if (clubLot) lampPost(ctx, clubLot.x + 1, ground, night, toned(night), true);
  for (const lx of lamps) if (lx > x0 - 20 && lx < x1 + 20) lampPost(ctx, lx, ground, night, toned(night));
  for (const lot of block.lots) {
    if (lot.kind !== "business" || (lot.seed >>> 15) % 3 !== 0) continue;
    if (lot.x + lot.width < x0 || lot.x > x1) continue;
    car(ctx, lot.x + 48, ground, lot.seed, night);
  }
  if (night) {
    // Lit windows spill a little light.
    ctx.globalCompositeOperation = "lighter";
    for (const lot of block.lots) {
      if (lot.x + lot.width < x0 || lot.x > x1) continue;
      lot.windows.forEach((w, i) => {
        if (w.state !== "working" && w.state !== "background" && w.state !== "needs") return;
        const r = windowRect(lot, i, ground);
        ctx.fillStyle = "rgba(255,180,90,0.07)";
        ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      });
    }
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

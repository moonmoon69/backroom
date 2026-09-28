/**
 * The street in the manner of a SNES town: a low native resolution scaled up in whole pixels, walls, pavement, road
 * and roofs built from repeating 16-pixel tiles, shading and light by dithering rather than gradients, and small
 * hand-placed sprites. Seen from a little above: each building's roof, then its front straight on (so signs and
 * windows read flat), then the pavement and the road in front. Drawn in street coordinates (x along the block, y down
 * from the top of the view) from the lots layout.ts makes; the words over it are StreetView.tsx's.
 *
 * Night is the dark theme and day the light one. At night everything lit only by the sky is toned towards night
 * blue; what gives light (lit windows, lamps, the moon) keeps its own colour.
 */
import { GAP, hashOf, WINDOWS_PER_FLOOR, type Business, type Facade, type Lot, type Street, type StreetWindow } from "./layout.ts";
import { cycle, dither, fillWith, mix, pattern, rect, tile, toned, type Ctx, type Tone } from "./pixels.ts";
import { sprite, type Grid } from "./sprites.ts";

export const SHOP_H = 40;
export const FLOOR_H = 28;
export const CORNICE_H = 6;
/** The roof, seen from above, over the front. */
export const ROOF_H = 16;
const TOWER_H = 18;
const SIDEWALK_H = 22;
const CURB_H = 4;
const ROAD_H = 32;
const FAR_CURB_H = 6;
/** What lies in front of the buildings: pavement, kerb, road, the far kerb. */
export const BELOW = SIDEWALK_H + CURB_H + ROAD_H + FAR_CURB_H;

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

function heightOf(lot: Lot): number {
  return SHOP_H + lot.floors * FLOOR_H + CORNICE_H + ROOF_H + (lot.waterTower || lot.kind === "club" ? TOWER_H : 0);
}

/** The view height that fits this street's tallest building with a strip of sky: the scale follows the street. */
export function neededHeight(street: Street): number {
  return Math.max(...street.lots.map(heightOf)) + BELOW + 12;
}

const windowColumns = (lot: Lot) => (lot.width >= 96 ? [12, 40, 68] : [8, 32, 56]);

/** Window i fills the first floor above the shop first, then the floors above it. */
export function windowRect(lot: Lot, index: number, ground: number): Rect {
  const floor = Math.floor(index / WINDOWS_PER_FLOOR);
  const col = index % WINDOWS_PER_FLOOR;
  const top = ground - SHOP_H - (floor + 1) * FLOOR_H;
  return { x: lot.x + (windowColumns(lot)[col] ?? 12), y: top + 5, w: 16, h: 18 };
}

interface Shop {
  door: Rect;
  plate: Rect;
  display: Rect;
  emblem: Rect;
}

/** The shop front: the door on its side, the directory plate beside it, the trade's sign hanging past it, the window. */
function shopOf(lot: Lot, ground: number): Shop {
  const { x, width: w } = lot;
  const right = lot.door === "right";
  const door = { x: right ? x + w - 30 : x + 14, y: ground - 24, w: 16, h: 24 };
  const plate = { x: right ? door.x - 10 : door.x + door.w + 2, y: ground - 20, w: 8, h: 10 };
  const display = right ? { x: x + 5, y: ground - 22, w: plate.x - 3 - (x + 5), h: 19 } : { x: plate.x + plate.w + 3, y: ground - 22, w: x + w - 5 - (plate.x + plate.w + 3), h: 19 };
  const emblem = { x: right ? x + w - 13 : x + 1, y: ground - 26, w: 12, h: 12 };
  return { door, plate, display, emblem };
}

export const signRect = (lot: Lot, ground: number): Rect => ({ x: lot.x + 5, y: ground - SHOP_H + 3, w: lot.width - 10, h: 10 });
export const doorRect = (lot: Lot, ground: number): Rect => shopOf(lot, ground).door;
export const displayRect = (lot: Lot, ground: number): Rect => shopOf(lot, ground).display;
export const plateRect = (lot: Lot, ground: number): Rect => shopOf(lot, ground).plate;
export const mailboxRect = (lot: Lot, ground: number): Rect => ({ x: lot.door === "right" ? lot.x + 3 : lot.x + lot.width - 13, y: ground + 7, w: 10, h: 12 });
export function boardRect(lot: Lot, ground: number): Rect {
  const display = displayRect(lot, ground);
  return { x: Math.round(display.x + display.w / 2 - 9), y: ground + 4, w: 18, h: 13 };
}
/** The club's street lamp: clicking it turns day into night and back. */
export const clubLampRect = (lot: Lot, ground: number): Rect => ({ x: lot.x - 5, y: ground - 40, w: 12, h: 62 });

function wallTile(facade: Facade, tone: Tone, key: string): HTMLCanvasElement {
  const base = tone(facade.base);
  const light = tone(facade.light);
  const dark = tone(facade.dark);
  const mortar = tone(facade.mortar);
  if (facade.material === "brick") {
    return tile(key, 16, 8, (put) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) put(x, y, base);
      const bricks: Array<[number, number, number]> = [
        [0, 0, 7],
        [8, 0, 7],
        [-4, 4, 7],
        [4, 4, 7],
        [12, 4, 7],
      ];
      bricks.forEach(([bx, by, bw], i) => {
        const face = i % 3 === 1 ? light : i % 3 === 2 ? dark : base;
        for (let y = by; y < by + 3; y++) for (let x = bx; x < bx + bw; x++) put((x + 16) % 16, y, face);
        put((bx + 16) % 16, by, light);
        put((bx + bw - 1 + 16) % 16, by + 2, dark);
      });
      for (let x = 0; x < 16; x++) {
        put(x, 3, mortar);
        put(x, 7, mortar);
      }
      for (const [x, y] of [
        [7, 0],
        [7, 1],
        [7, 2],
        [15, 0],
        [15, 1],
        [15, 2],
        [3, 4],
        [3, 5],
        [3, 6],
        [11, 4],
        [11, 5],
        [11, 6],
      ] as const)
        put(x, y, mortar);
    });
  }
  if (facade.material === "stone") {
    return tile(key, 16, 8, (put) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) put(x, y, base);
      for (let x = 0; x < 16; x++) {
        put(x, 0, light);
        put(x, 7, mortar);
      }
      for (let y = 0; y < 8; y++) put(15, y, mortar);
      for (const [x, y] of [
        [3, 3],
        [9, 5],
        [12, 2],
        [6, 6],
      ] as const)
        put(x, y, dark);
    });
  }
  return tile(key, 16, 4, (put) => {
    for (let x = 0; x < 16; x++) {
      put(x, 0, light);
      put(x, 1, base);
      put(x, 2, base);
      put(x, 3, dark);
    }
    put(9, 1, dark);
  });
}

function slabTile(tone: Tone, key: string) {
  return tile(key, 16, 8, (put) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) put(x, y, tone("#b9b4a8"));
    for (let x = 0; x < 16; x++) put(x, 7, tone("#9a958a"));
    for (let y = 0; y < 8; y++) put(15, y, tone("#9a958a"));
    for (let x = 0; x < 15; x++) put(x, 0, tone("#c9c5ba"));
    put(5, 3, tone("#a8a398"));
    put(11, 5, tone("#a8a398"));
  });
}

function asphaltTile(tone: Tone, key: string) {
  return tile(key, 8, 8, (put) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) put(x, y, tone(((x * 3 + y * 5) % 7 === 0) ? "#5a5d63" : (x + y) % 2 ? "#4b4e54" : "#474a50"));
    put(2, 5, tone("#6a6d72"));
  });
}

function roofTile(kind: "tar" | "slate" | "clay", tone: Tone, key: string) {
  if (kind === "tar") {
    return tile(key, 8, 8, (put) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) put(x, y, tone((x + y * 3) % 5 === 0 ? "#5a5a60" : (x + y) % 2 ? "#3e3e46" : "#44444c"));
    });
  }
  const [base, dark, light] = kind === "slate" ? ["#4a5670", "#36405a", "#5e6c88"] : ["#a4553a", "#7e3e2a", "#bd6a4c"];
  return tile(key, 8, 6, (put) => {
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) put(x, y, tone(base));
    for (let x = 0; x < 8; x++) {
      put(x, 0, tone(light));
      put(x, 5, tone(dark));
    }
    put(3, 4, tone(dark));
    put(7, 4, tone(dark));
    put(3, 3, tone(dark));
    put(7, 3, tone(dark));
  });
}

// ---- sprites ----

const K = "#1a1410";
const EMBLEMS: Record<Business, { grid: Grid; palette: Record<string, string> }> = {
  diner: {
    grid: ["...w.w....", "....w.w...", "...w.w....", "..........", ".KKKKKKK..", ".KWWWWWKKK", ".KWWWWWK.K", ".KWWWWWKKK", "..KWWWK...", "...KKK...."],
    palette: { K, W: "#f4efe2", w: "#b9c3d0" },
  },
  print: {
    grid: [".KKKKKKK..", ".KWWWWWKK.", ".KWbbbWWK.", ".KWWWWWWK.", ".KWbbbbWK.", ".KWWWWWWK.", ".KWbbWbWK.", ".KWWWWWWK.", ".KKKKKKKK.", ".........."],
    palette: { K, W: "#f4efe2", b: "#3a4a7a" },
  },
  tailor: {
    grid: ["..KK..KK..", ".KSSKKSSK.", "KSSSWWSSSK", "KSSSWRSSSK", "KSSSWWSSSK", "KSSSWWSSSK", "KSSSSSSSSK", "KSSSSSSSSK", ".KKKKKKKK.", ".........."],
    palette: { K, S: "#3d4a78", W: "#f4efe2", R: "#b8322a" },
  },
  jazz: {
    grid: ["......KK..", "......KGK.", "......KG..", "......KG..", "......KG..", "..KK..KG..", ".KGGKKGK..", ".KGgGGK...", "..KKKK....", ".........."],
    palette: { K, G: "#e0b040", g: "#fff0a0" },
  },
  bakery: {
    grid: ["..........", "...KKKK...", "..KBBBBK..", ".KBbBbBBK.", "KBBBBBBBBK", "KBbBBbBBbK", ".KBBBBBBK.", "..KKKKKK..", "..........", ".........."],
    palette: { K, B: "#d8963e", b: "#f2c070" },
  },
  barber: {
    grid: ["KK......KK", "KWK....KWK", ".KWK..KWK.", "..KWKKWK..", "...KWWK...", "...KRRK...", "..KRKKRK..", ".KRK..KRK.", ".KRK..KRK.", "..K....K.."],
    palette: { K, W: "#dfe6ee", R: "#c0302a" },
  },
  pawn: {
    grid: ["....KK....", "...KGGK...", "...KGgK...", "....KK....", ".KK....KK.", "KGGK..KGGK", "KGgK..KGgK", ".KK....KK.", "..........", ".........."],
    palette: { K, G: "#d9b44a", g: "#fff0a0" },
  },
  laundry: {
    grid: ["KKKKKKKKKK", "KWWWWWbWbK", "KKKKKKKKKK", "KWWKKKKWWK", "KWKbbbbKWK", "KWKbwbbKWK", "KWKbbbbKWK", "KWWKKKKWWK", "KWWWWWWWWK", "KKKKKKKKKK"],
    palette: { K, W: "#eef1f4", b: "#5a8ab8", w: "#cfe2f2" },
  },
  pizza: {
    grid: ["KKKKKKKKKK", "KCCCCCCCCK", ".KYRYYRYK.", ".KYYYYYYK.", "..KYRYYK..", "..KYYYYK..", "...KYRK...", "...KYYK...", "....KK....", ".........."],
    palette: { K, C: "#c8863e", Y: "#f2d060", R: "#b8322a" },
  },
  deli: {
    grid: ["....K.....", "....K.....", "...KRK....", "..KRrRK...", "..KRRrK...", "..KRrRK...", "..KRRRK...", "..KRrRK...", "...KRK....", "....K....."],
    palette: { K, R: "#9a2f2a", r: "#e8c8b0" },
  },
  books: {
    grid: ["..........", ".KKKKKKKK.", ".KRRRRRRK.", ".KKKKKKKK.", "KKKKKKKKK.", "KBBBBBBBK.", "KKKKKKKKK.", ".KKKKKKKKK", ".KGGGGGGGK", ".KKKKKKKKK"],
    palette: { K, R: "#b8322a", B: "#3a5a9a", G: "#3f7a4a" },
  },
  florist: {
    grid: ["...KKK....", "..KPPPK...", "..KPYPK...", "..KPPPK...", "...KKK.K..", "....K.KgK.", "...KgKK...", "..KKKKKK..", "..KTTTTK..", "...KKKK..."],
    palette: { K, P: "#e0609a", Y: "#f6d860", g: "#4a9a4a", T: "#b8643a" },
  },
};

const MOON: Grid = ["....MMM....", "..MMMMMMM..", ".MMMMMMmMM.", ".MMcMMMMMM.", "MMMMMMMMMmM", "MMMMMcMMMmM", "MMMMMMMMMmM", ".MMMMMMMmM.", ".MMcMMMmmM.", "..MMMMmmm..", "....MMm...."];
const SUN: Grid = ["....y.y....", ".y..SSS..y.", "...SSSSS...", "y.SSsSSSS.y", "..SSSSSSS..", "y.SSSSSSS.y", "...SSSSS...", ".y..SSS..y.", "....y.y...."];
const CLOUD: Grid = [".......WWWW.............", ".....WWWWWWWW...WWW.....", "...WWWWWWWWWWWWWWWWWW...", ".WWWWWWWWWWWWWWWWWWWWWW.", "WWWWWWWWWWWWWWWWWWWWWWWW", "cccccWWWWWWWWWWWWWWccccc", "..cccccccccccccccccccc.."];
const MAILBOX: Grid = ["..KKKKKK..", ".KbbbbbbK.", "KBbbbbbbBK", "KBKKKKKKBK", "KBBBBBBBBK", "KBBBBBBBBK", "KBBwwwwBBK", "KBBBBBBBBK", "KBBBBBBBBK", ".KKKKKKKK.", ".KK....KK.", ".K......K."];
const HYDRANT: Grid = ["..KK..", ".KrRK.", "KKRRKK", "KRRRRK", ".KRRK.", ".KRRK.", ".KRRK.", "KKKKKK"];
const CAT: Grid[] = [
  ["K.K.....", "KKK.....", "KYK.....", ".KKK....", ".KKKK...", ".KKKKK.K", ".KKKKKKK"],
  ["K.K.....", "KKK.....", "KYK.....", ".KKK...K", ".KKKK..K", ".KKKKK.K", ".KKKKKKK"],
];

function stampSprite(ctx: Ctx, key: string, grid: Grid, palette: Record<string, string>, tone: Tone, night: boolean, x: number, y: number) {
  const toned: Record<string, string> = {};
  for (const [k, v] of Object.entries(palette)) toned[k] = tone(v);
  ctx.drawImage(sprite(`${key}:${night ? "n" : "d"}`, grid, toned), Math.round(x), Math.round(y));
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

const FAR = towers(720, 12, 26, 30, 90, 1);
const NEAR = towers(900, 20, 38, 40, 104, 2);
const STARS = Array.from({ length: 56 }, (_, i) => {
  const s = hashOf(`star${i}`);
  return { x: s % 997, y: (s >>> 10) % 150, big: (s >>> 20) % 7 === 0 };
});

const SKY_NIGHT = ["#080c24", "#0e1434", "#141c44", "#1c2654", "#253062"];
const SKY_DAY = ["#4a7fd8", "#5a8ee0", "#6f9fe8", "#88b2f0", "#a4c6f6"];

const skyCache = new Map<string, HTMLCanvasElement>();
/** Bands of colour with dithered seams, as a SNES sky. */
function skyCanvas(viewW: number, ground: number, night: boolean): HTMLCanvasElement {
  const key = `${viewW}:${ground}:${night}`;
  let canvas = skyCache.get(key);
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.width = viewW;
  canvas.height = Math.max(1, ground);
  const ctx = canvas.getContext("2d")!;
  const bands = night ? SKY_NIGHT : SKY_DAY;
  const band = Math.ceil(ground / bands.length);
  bands.forEach((colour, i) => {
    rect(ctx, 0, i * band, viewW, band, colour);
    const next = bands[i + 1];
    if (next) dither(ctx, 0, (i + 1) * band - 3, viewW, 3, next);
  });
  if (skyCache.size > 12) skyCache.clear();
  skyCache.set(key, canvas);
  return canvas;
}

function skyline(ctx: Ctx, list: Tower[], span: number, offset: number, viewW: number, base: number, body: string, edge: string, lit: string | null, t: number) {
  const start = -(((offset % span) + span) % span);
  for (let origin = start; origin < viewW; origin += span) {
    for (const tower of list) {
      const x = origin + tower.x;
      if (x + tower.w < 0 || x > viewW) continue;
      const top = base - tower.h;
      rect(ctx, x, top, tower.w, tower.h, body);
      rect(ctx, x, top, tower.w, 1, edge);
      if (tower.seed % 5 === 0) {
        rect(ctx, x + Math.floor(tower.w / 2) - 1, top - 8, 2, 8, body);
        rect(ctx, x + Math.floor(tower.w / 2) - 1, top - 8, 2, 1, edge);
      }
      if (tower.seed % 7 === 1) rect(ctx, x + 2, top - 3, tower.w - 4, 3, body);
      if (!lit) continue;
      for (let wy = top + 4; wy < base - 6; wy += 5) {
        for (let wx = x + 2; wx < x + tower.w - 2; wx += 4) {
          if (hashOf(`${tower.seed}:${wx - x}:${wy - top}`) % 8 !== 0) continue;
          const flicker = hashOf(`${tower.seed}:${wy}`) % 23 === 0 && cycle(t, 5000, tower.seed % 13) < 0.3;
          if (!flicker) rect(ctx, wx, wy, 1, 2, lit);
        }
      }
    }
  }
}

function sky(ctx: Ctx, viewW: number, ground: number, camX: number, night: boolean, t: number) {
  ctx.drawImage(skyCanvas(viewW, ground, night), 0, 0);
  if (night) {
    for (const star of STARS) {
      const x = (((star.x - camX * 0.05) % viewW) + viewW) % viewW;
      if (star.y > ground - 70) continue;
      if (cycle(t, 3000, star.x % 17) < 0.08) continue;
      rect(ctx, x, star.y, 1, 1, star.big ? "#fff8e0" : "#b8bed8");
      if (star.big) {
        rect(ctx, x - 1, star.y, 1, 1, "#6a7098");
        rect(ctx, x + 1, star.y, 1, 1, "#6a7098");
      }
    }
    ctx.drawImage(sprite("moon", MOON, { M: "#f4ecc8", m: "#d4c89e", c: "#c8bc92" }), viewW - 36, 10);
  } else {
    ctx.drawImage(sprite("sun", SUN, { S: "#fff2a8", s: "#ffffff", y: "#ffe070" }), viewW - 38, 10);
    for (let i = 0; i < 4; i++) {
      const s = hashOf(`cloud${i}`);
      const span = viewW + 80;
      const x = ((((s % 600) - camX * 0.08 + t / 900) % span) + span) % span - 40;
      ctx.drawImage(sprite("cloud", CLOUD, { W: "#f6faff", c: "#c8dcf4" }), Math.round(x), 8 + ((s >>> 9) % 36));
    }
  }
  skyline(ctx, FAR, 720, camX * 0.25, viewW, ground - ROOF_H - 10, night ? "#141c3c" : "#9fb8d8", night ? "#1e2850" : "#b4c8e2", night ? "#c9a95e" : null, t);
  skyline(ctx, NEAR, 900, camX * 0.5, viewW, ground - 6, night ? "#0f1630" : "#8aa2c0", night ? "#1a2246" : "#9fb4cc", night ? "#e2bd6a" : null, t);
}

// ---- windows ----

function silhouette(ctx: Ctx, x: number, y: number, colour: string) {
  rect(ctx, x + 1, y, 4, 2, colour);
  rect(ctx, x, y + 2, 6, 1, colour);
  rect(ctx, x + 1, y + 3, 4, 2, colour);
  rect(ctx, x, y + 5, 6, 3, colour);
}

const DARK_WINDOW: StreetWindow = { kind: "room", id: "", title: "", state: "dark", label: "", unseen: 0, members: 0 };

function drawWindow(ctx: Ctx, w: StreetWindow, r: Rect, facade: Facade, night: boolean, tone: Tone, t: number, seed: number) {
  const gx = r.x + 1;
  const gy = r.y + 1;
  const gw = r.w - 2;
  const gh = r.h - 2;
  // Lintel with its keystone, the sill with its top in the light, their shadows.
  rect(ctx, r.x - 2, r.y - 3, r.w + 4, 3, tone(facade.trim));
  rect(ctx, r.x + r.w / 2 - 2, r.y - 4, 4, 4, tone(facade.trim));
  rect(ctx, r.x - 2, r.y - 1, r.w + 4, 1, tone(mix(facade.trim, "#000000", 0.3)));
  rect(ctx, r.x, r.y, r.w, r.h, K);
  const lit = w.state === "working" || w.state === "background" || w.state === "needs";
  if (lit) {
    const warm = night ? ["#ffe6a0", "#ffc860", "#e8963a"] : ["#f0d6a0", "#e2b474", "#c8904e"];
    rect(ctx, gx, gy, gw, gh, warm[1]!);
    rect(ctx, gx, gy, gw, 4, warm[0]!);
    dither(ctx, gx, gy + 4, gw, 2, warm[0]!);
    rect(ctx, gx, gy + gh - 4, gw, 4, warm[2]!);
    dither(ctx, gx, gy + gh - 6, gw, 2, warm[2]!);
    for (let i = 0; i < 2; i++) rect(ctx, gx, gy + i * 2, gw, 1, night ? "#f4e2b0" : "#fbf2dc");
  } else if (w.state === "dark") {
    rect(ctx, gx, gy, gw, gh, night ? "#141a36" : "#6a88a8");
    for (let y = gy; y < gy + gh; y += 2) rect(ctx, gx, y, gw, 1, night ? "#1e2648" : "#d8cfb4");
  } else {
    rect(ctx, gx, gy, gw, gh, night ? "#6a4424" : "#4d433a");
    dither(ctx, gx, gy + gh - 5, gw, 5, night ? "#8a5a2e" : "#3a322c");
    for (let y = gy; y < gy + Math.floor(gh / 2); y += 2) rect(ctx, gx, y, gw, 1, night ? "#9a7446" : "#e0d6ba");
  }
  if (!night && w.state !== "dark") {
    rect(ctx, gx + gw - 3, gy + gh - 7, 1, 1, "#ffffff");
    rect(ctx, gx + gw - 4, gy + gh - 6, 1, 1, "#ffffff");
    rect(ctx, gx + gw - 5, gy + gh - 5, 1, 1, "#ffffff");
  }
  const figure = night ? "#2a1a10" : "#2f261f";
  const bottom = gy + gh - 8;
  if (w.state !== "dark") {
    if (w.kind === "thread") {
      const bob = w.state === "working" && cycle(t, 700, seed) < 0.5 ? 1 : 0;
      silhouette(ctx, gx + 2, bottom + bob, figure);
      rect(ctx, gx + 9, bottom + 1, 4, 2, "#2f6a4a");
      rect(ctx, gx + 11, bottom + 3, 1, 5, figure);
      if (night && lit) dither(ctx, gx + 8, bottom + 3, 6, 3, "#fff0b0");
    } else {
      const people = Math.min(3, Math.max(1, w.members));
      for (let i = 0; i < people; i++) {
        const bob = w.state === "working" && cycle(t + i * 230, 650, seed) < 0.5 ? 1 : 0;
        silhouette(ctx, gx + (people === 1 ? 4 : i * 4 + (people === 2 ? 2 : 0)), bottom + 1 + bob - (i % 2), figure);
      }
    }
  }
  if (w.state === "needs") {
    const bob = cycle(t, 1200, seed) < 0.5 ? 0 : 1;
    const cx = gx + gw - 7;
    const cy = gy + 3 + bob;
    rect(ctx, cx - 1, cy - 1, 8, 10, K);
    rect(ctx, cx, cy, 6, 8, "#fbf6e6");
    rect(ctx, cx + 2, cy + 1, 2, 4, "#d9342b");
    rect(ctx, cx + 2, cy + 6, 2, 1, "#d9342b");
    if (night && cycle(t, 1400, seed) < 0.5) dither(ctx, gx, gy, gw, gh, "#ffb040");
  }
  if (w.state === "failed") {
    const cx = gx + 1;
    const cy = gy + 6;
    rect(ctx, cx + 2, gy + 1, 1, 5, "#8a8070");
    rect(ctx, cx + 10, gy + 1, 1, 6, "#8a8070");
    rect(ctx, cx - 1, cy - 1, 9, 7, K);
    rect(ctx, cx + 6, cy, 8, 7, K);
    rect(ctx, cx, cy, 7, 5, "#f1ebdd");
    rect(ctx, cx + 7, cy + 1, 6, 5, "#f1ebdd");
    for (let i = 0; i < 5; i++) rect(ctx, cx + 1 + i * 2 + (i > 2 ? 1 : 0), cy + 2 + (i > 2 ? 1 : 0), 1, 2, "#c0302a");
  }
  // Mullion, then the sill (top face in the light) and its shadow.
  rect(ctx, gx + Math.floor(gw / 2), gy, 1, gh, K);
  rect(ctx, r.x - 2, r.y + r.h, r.w + 4, 1, tone(mix(facade.trim, "#ffffff", 0.35)));
  rect(ctx, r.x - 2, r.y + r.h + 1, r.w + 4, 2, tone(facade.trim));
  dither(ctx, r.x - 1, r.y + r.h + 3, r.w + 2, 2, tone(facade.mortar));
  if (w.unseen > 0 && w.state !== "failed") {
    rect(ctx, r.x + r.w - 8, r.y + r.h - 3, 7, 5, K);
    rect(ctx, r.x + r.w - 7, r.y + r.h - 2, 5, 3, "#fbf6e6");
    rect(ctx, r.x + r.w - 6, r.y + r.h - 2, 3, 1, "#b7ad8e");
  }
}

// ---- the shop window: what each business shows ----

function shopProps(ctx: Ctx, business: Business, r: Rect, tone: Tone, lit: boolean) {
  const c = (hex: string) => (lit ? hex : tone(hex));
  const floor = r.y + r.h - 2;
  const mid = r.x + Math.floor(r.w / 2);
  switch (business) {
    case "diner":
      rect(ctx, r.x + 2, floor - 5, r.w - 4, 2, c("#c8c2b5"));
      for (let x = r.x + 4; x < r.x + r.w - 4; x += 7) {
        rect(ctx, x, floor - 9, 4, 2, c("#c0302a"));
        rect(ctx, x + 1, floor - 7, 2, 2, c("#8a8a8a"));
      }
      rect(ctx, mid - 4, floor - 15, 7, 2, c("#e9d8a6"));
      rect(ctx, mid - 2, floor - 17, 3, 2, c("#b8632e"));
      break;
    case "print":
      rect(ctx, r.x + 4, floor - 12, 14, 12, c("#2f3338"));
      rect(ctx, r.x + 6, floor - 10, 10, 3, c("#5a6068"));
      rect(ctx, r.x + 20, floor - 8, 6, 8, c("#6b6f75"));
      for (let i = 0; i < 4; i++) rect(ctx, r.x + 29, floor - 2 - i * 2, Math.min(12, r.w - 31), 1, c("#f1ecde"));
      break;
    case "tailor":
      for (const dx of [6, 24]) {
        rect(ctx, r.x + dx + 3, floor - 17, 4, 2, c("#c9b28a"));
        rect(ctx, r.x + dx, floor - 15, 10, 9, c(dx === 6 ? "#2d3350" : "#4a3a2a"));
        rect(ctx, r.x + dx + 4, floor - 15, 2, 6, c("#e9e3d3"));
        rect(ctx, r.x + dx + 4, floor - 6, 2, 6, c("#6b5a44"));
      }
      break;
    case "jazz":
      rect(ctx, r.x + 8, floor - 16, 2, 12, c("#d9a73a"));
      rect(ctx, r.x + 6, floor - 5, 6, 3, c("#d9a73a"));
      rect(ctx, r.x + 10, floor - 16, 3, 1, c("#d9a73a"));
      rect(ctx, r.x + 20, floor - 15, 1, 5, c("#e9e3d3"));
      rect(ctx, r.x + 18, floor - 11, 3, 2, c("#e9e3d3"));
      rect(ctx, r.x + 28, floor - 12, 1, 5, c("#e9e3d3"));
      rect(ctx, r.x + 26, floor - 8, 3, 2, c("#e9e3d3"));
      rect(ctx, r.x + 32, floor - 3, Math.min(10, r.w - 34), 3, c("#6a1f24"));
      break;
    case "bakery":
      rect(ctx, r.x + 5, floor - 6, 12, 6, c("#f3e3c3"));
      rect(ctx, r.x + 7, floor - 10, 8, 4, c("#f7ecd6"));
      rect(ctx, r.x + 9, floor - 12, 4, 2, c("#d94f6a"));
      for (let x = r.x + 21; x < r.x + r.w - 6; x += 6) rect(ctx, x, floor - 4, 5, 3, c("#c98a3a"));
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
      for (let i = 0; i < 3; i++) rect(ctx, r.x + 18 + i * 5, floor - 3, 3, 3, c("#d9b44a"));
      rect(ctx, r.x + 34, floor - 10, 6, 6, c("#e9e3d3"));
      break;
    case "laundry":
      for (const dx of [4, 22]) {
        rect(ctx, r.x + dx, floor - 13, 13, 13, c("#dcdcd6"));
        rect(ctx, r.x + dx + 3, floor - 10, 7, 7, c("#6f8ca0"));
        rect(ctx, r.x + dx + 4, floor - 9, 3, 2, c("#b7cbd8"));
      }
      break;
    case "pizza":
      rect(ctx, r.x + 6, floor - 8, 14, 7, c("#e0a44a"));
      rect(ctx, r.x + 7, floor - 7, 12, 5, c("#d9573a"));
      rect(ctx, r.x + 24, floor - 15, 2, 15, c("#8a5a32"));
      rect(ctx, r.x + 22, floor - 17, 6, 3, c("#b8894e"));
      break;
    case "deli":
      for (let i = 0; i < 4; i++) {
        rect(ctx, r.x + 6 + i * 6, r.y + 2, 1, 3, c("#8a8070"));
        rect(ctx, r.x + 5 + i * 6, r.y + 5, 3, 7, c(i % 2 ? "#8a2f2f" : "#a0432f"));
      }
      rect(ctx, r.x + 30, floor - 5, 9, 5, c("#e9c35a"));
      break;
    case "books":
      for (let i = 0; i < 3; i++) {
        rect(ctx, r.x + 3, floor - 5 - i * 6, r.w - 6, 1, c("#6b4a2a"));
        for (let x = r.x + 4; x < r.x + r.w - 5; x += 3) rect(ctx, x, floor - 10 - i * 6 + ((x * 7) % 3), 2, 5 - ((x * 7) % 3), c(["#b8322a", "#3a5a9a", "#3f7a4a", "#d9b44a"][(x + i) % 4]!));
      }
      break;
    case "florist":
      for (let x = r.x + 5; x < r.x + r.w - 6; x += 9) {
        rect(ctx, x, floor - 5, 6, 5, c("#b8643a"));
        rect(ctx, x + 2, floor - 9, 1, 4, c("#4a9a4a"));
        rect(ctx, x + 1, floor - 12, 4, 3, c(["#e0609a", "#f6d860", "#e05a4a", "#b46ae0"][(x >> 3) % 4]!));
      }
      break;
  }
}

// ---- buildings ----

function wall(ctx: Ctx, lot: Lot, top: number, ground: number, night: boolean, tone: Tone) {
  const key = `wall:${lot.facade.material}:${lot.facade.base}:${night}`;
  fillWith(
    ctx,
    pattern(ctx, key, () => wallTile(lot.facade, tone, key)),
    lot.x,
    top,
    lot.width,
    ground - top,
  );
  // Corner piers.
  rect(ctx, lot.x, top, 2, ground - top, tone(lot.facade.dark));
  rect(ctx, lot.x + lot.width - 2, top, 2, ground - top, tone(lot.facade.dark));
}

function cornice(ctx: Ctx, x: number, y: number, w: number, facade: Facade, tone: Tone) {
  rect(ctx, x - 1, y, w + 2, 1, tone(mix(facade.trim, "#ffffff", 0.3)));
  rect(ctx, x - 1, y + 1, w + 2, 3, tone(facade.trim));
  for (let xx = x; xx < x + w; xx += 3) rect(ctx, xx, y + 4, 2, 1, tone(facade.trim));
  dither(ctx, x, y + 5, w, 2, tone(facade.mortar));
}

function roof(ctx: Ctx, lot: Lot, top: number, night: boolean, tone: Tone) {
  const x = lot.x;
  const w = lot.width;
  const y = top - ROOF_H;
  if (lot.roof === "flat") {
    const key = `tar:${night}`;
    fillWith(
      ctx,
      pattern(ctx, key, () => roofTile("tar", tone, key)),
      x + 2,
      y + 3,
      w - 4,
      ROOF_H - 3,
    );
    rect(ctx, x, y + 2, w, 1, tone("#2a2a30"));
    rect(ctx, x, y + 3, 2, ROOF_H - 3, tone(lot.facade.trim));
    rect(ctx, x + w - 2, y + 3, 2, ROOF_H - 3, tone(lot.facade.trim));
    // A chimney and a vent.
    const cx = x + 10 + (lot.seed % 24);
    rect(ctx, cx, y - 4, 7, 10, tone(lot.facade.dark));
    rect(ctx, cx - 1, y - 5, 9, 2, tone(lot.facade.trim));
    rect(ctx, x + w - 22, y + 6, 6, 4, tone("#8a8a90"));
    rect(ctx, x + w - 22, y + 6, 6, 1, tone("#b4b4ba"));
  } else {
    const kind = lot.roof === "mansard" ? "slate" : "clay";
    const key = `${kind}:${night}`;
    const inset = lot.roof === "gable" ? 4 : 0;
    fillWith(
      ctx,
      pattern(ctx, key, () => roofTile(kind, tone, key)),
      x + inset,
      y + 2,
      w - inset * 2,
      ROOF_H - 2,
    );
    rect(ctx, x + inset, y + 1, w - inset * 2, 2, tone(lot.roof === "gable" ? "#6a3222" : "#2a3246"));
    if (lot.roof === "mansard") {
      // Dormers.
      for (const dx of [18, w - 30]) {
        rect(ctx, x + dx - 1, y + 1, 14, 3, tone(lot.facade.trim));
        rect(ctx, x + dx, y + 4, 12, 10, tone(lot.facade.trim));
        rect(ctx, x + dx + 2, y + 6, 8, 7, night ? "#141a36" : "#6a88a8");
        rect(ctx, x + dx + 6, y + 6, 1, 7, K);
      }
    }
  }
  // The front edge where roof meets wall.
  rect(ctx, x - 1, top - 1, w + 2, 1, tone("#1e1a18"));
}

function waterTower(ctx: Ctx, x: number, roofY: number, tone: Tone) {
  rect(ctx, x + 2, roofY - 6, 1, 8, tone("#2a2a2a"));
  rect(ctx, x + 11, roofY - 6, 1, 8, tone("#2a2a2a"));
  rect(ctx, x + 2, roofY - 3, 10, 1, tone("#2a2a2a"));
  rect(ctx, x, roofY - 18, 14, 12, tone("#8a6440"));
  for (let xx = x + 2; xx < x + 14; xx += 3) rect(ctx, xx, roofY - 18, 1, 12, tone("#6e4e30"));
  rect(ctx, x, roofY - 18, 1, 12, tone("#a07a52"));
  rect(ctx, x, roofY - 14, 14, 1, tone("#3a3a3a"));
  rect(ctx, x, roofY - 9, 14, 1, tone("#3a3a3a"));
  rect(ctx, x - 1, roofY - 21, 16, 3, tone("#5a4430"));
  rect(ctx, x + 2, roofY - 23, 10, 2, tone("#5a4430"));
  rect(ctx, x + 6, roofY - 25, 2, 2, tone("#5a4430"));
}

function fireEscape(ctx: Ctx, lot: Lot, ground: number, tone: Tone) {
  const iron = tone("#1a1c22");
  const light = tone("#4a4e5a");
  const x = lot.door === "right" ? lot.x + 60 : lot.x + 8;
  for (let floor = 0; floor < lot.floors; floor++) {
    const y = ground - SHOP_H - floor * FLOOR_H - 2;
    rect(ctx, x, y - 1, 28, 1, light);
    rect(ctx, x, y, 28, 2, iron);
    rect(ctx, x, y - 6, 28, 1, iron);
    for (let xx = x; xx <= x + 28; xx += 4) rect(ctx, xx, y - 6, 1, 6, iron);
    if (floor < lot.floors - 1) for (let i = 0; i < FLOOR_H - 5; i++) rect(ctx, x + 4 + Math.floor(i * 0.7), y - 2 - i, 2, 1, iron);
  }
}

function awning(ctx: Ctx, x: number, y: number, w: number, facade: Facade, tone: Tone) {
  // Its top slopes towards us: a lighter back edge, the stripes, a scalloped hem, its shadow.
  for (let xx = 0; xx < w; xx++) {
    const stripe = Math.floor(xx / 4) % 2 === 0 ? facade.awning : facade.stripe;
    rect(ctx, x + xx, y, 1, 5, tone(stripe));
    rect(ctx, x + xx, y, 1, 1, tone(mix(stripe, "#ffffff", 0.25)));
    if (xx % 4 === 1 || xx % 4 === 2) rect(ctx, x + xx, y + 5, 1, 1, tone(stripe));
  }
  rect(ctx, x - 1, y - 1, w + 2, 1, K);
  dither(ctx, x, y + 6, w, 3, "#000000");
}

function door(ctx: Ctx, r: Rect, facade: Facade, tone: Tone, night: boolean, lit: boolean) {
  rect(ctx, r.x - 2, r.y - 3, r.w + 4, r.h + 3, tone(facade.trim));
  rect(ctx, r.x, r.y, r.w, r.h, K);
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 1, tone("#5a3a24"));
  rect(ctx, r.x + 1, r.y + 1, 1, r.h - 1, tone("#6e4a30"));
  rect(ctx, r.x + 3, r.y + 3, r.w - 6, 8, lit ? (night ? "#ffd27a" : "#e8c48a") : night ? "#141a36" : tone("#6a88a8"));
  rect(ctx, r.x + 3 + Math.floor((r.w - 6) / 2), r.y + 3, 1, 8, K);
  rect(ctx, r.x + 3, r.y + 14, r.w - 6, 7, tone("#4a2f1d"));
  rect(ctx, r.x + r.w - 4, r.y + 13, 2, 2, "#d9b44a");
  // The step, its top in the light.
  rect(ctx, r.x - 3, r.y + r.h, r.w + 6, 1, tone("#d6d1c4"));
  rect(ctx, r.x - 3, r.y + r.h + 1, r.w + 6, 2, tone("#9a958a"));
}

function plate(ctx: Ctx, r: Rect, tone: Tone, alert: boolean) {
  rect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, K);
  rect(ctx, r.x, r.y, r.w, r.h, tone("#c9a24a"));
  rect(ctx, r.x, r.y, r.w, 1, tone("#f0d27a"));
  for (let i = 0; i < 3; i++) rect(ctx, r.x + 2, r.y + 3 + i * 2, r.w - 4, 1, tone("#6a5020"));
  if (alert) {
    rect(ctx, r.x + r.w - 2, r.y - 3, 4, 4, K);
    rect(ctx, r.x + r.w - 1, r.y - 2, 2, 2, "#ff5040");
  }
}

function emblem(ctx: Ctx, lot: Lot, r: Rect, tone: Tone, night: boolean) {
  if (!lot.business) return;
  // The iron arm from the wall, the hanging board, the trade's picture on it.
  rect(ctx, r.x, r.y - 2, r.w, 1, tone("#1a1c22"));
  rect(ctx, lot.door === "left" ? r.x : r.x + r.w - 1, r.y - 4, 1, 3, tone("#1a1c22"));
  rect(ctx, r.x + 2, r.y - 1, 1, 1, tone("#1a1c22"));
  rect(ctx, r.x + r.w - 3, r.y - 1, 1, 1, tone("#1a1c22"));
  rect(ctx, r.x, r.y, r.w, r.h, K);
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, tone("#efe3c0"));
  const art = EMBLEMS[lot.business.key];
  stampSprite(ctx, `emblem:${lot.business.key}`, art.grid, art.palette, tone, night, r.x + 1, r.y + 1);
}

function mailbox(ctx: Ctx, r: Rect, tone: Tone, night: boolean, flag: boolean) {
  stampSprite(ctx, "mailbox", MAILBOX, { K, B: "#2b4b8c", b: "#4a6ab0", w: "#e8e2cc" }, tone, night, r.x, r.y);
  if (flag) {
    rect(ctx, r.x + r.w, r.y - 3, 1, 7, K);
    rect(ctx, r.x + r.w + 1, r.y - 3, 3, 3, "#e03a30");
  }
}

function chalkboard(ctx: Ctx, r: Rect, tone: Tone) {
  rect(ctx, r.x + 1, r.y + r.h - 2, 2, 2, tone("#6b4a2a"));
  rect(ctx, r.x + r.w - 3, r.y + r.h - 2, 2, 2, tone("#6b4a2a"));
  rect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h, K);
  rect(ctx, r.x, r.y, r.w, r.h - 2, tone("#7a5530"));
  rect(ctx, r.x, r.y, r.w, 1, tone("#a07a4a"));
  rect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 4, tone("#22302a"));
}

function lampPost(ctx: Ctx, x: number, ground: number, night: boolean, tone: Tone, t: number, double = false) {
  const base = ground + SIDEWALK_H - 2;
  const top = ground - 36;
  if (night) {
    // A pool of warm light on the pavement.
    for (let i = 0; i < 4; i++) dither(ctx, x - 14 + i * 3, base - 9 + i * 2, 30 - i * 6, 2, "#8a8274");
  }
  rect(ctx, x, top + 4, 2, base - top - 4, tone("#1d2230"));
  rect(ctx, x, top + 4, 1, base - top - 4, tone("#3a4258"));
  rect(ctx, x - 2, base - 3, 6, 3, tone("#1d2230"));
  const heads = double ? [x - 5, x + 5] : [x];
  if (double) rect(ctx, x - 5, top + 3, 12, 1, tone("#1d2230"));
  for (const hx of heads) {
    rect(ctx, hx - 2, top - 1, 6, 1, tone("#1d2230"));
    rect(ctx, hx - 2, top, 6, 4, K);
    rect(ctx, hx - 1, top + 1, 4, 3, night ? (cycle(t, 4000, hx % 7) < 0.02 ? "#e0c070" : "#fff2b8") : tone("#e8e2cc"));
    if (night) {
      // A few pixels of glow around the glass.
      rect(ctx, hx - 3, top + 1, 1, 3, "#6a6450");
      rect(ctx, hx + 4, top + 1, 1, 3, "#6a6450");
      rect(ctx, hx - 1, top + 4, 4, 1, "#8a8060");
    }
  }
}

function car(ctx: Ctx, x: number, ground: number, seed: number, night: boolean, tone: Tone) {
  const body = ["#2d3a68", "#7a2a2a", "#2f5a44", "#2a2a30", "#8a6a3e"][seed % 5]!;
  const y = ground + SIDEWALK_H + CURB_H + 3;
  dither(ctx, x + 1, y + 13, 30, 2, "#000000");
  // Seen from a little above: the roof and bonnet, then the side.
  rect(ctx, x, y + 5, 32, 8, K);
  rect(ctx, x + 1, y + 6, 30, 6, tone(body));
  rect(ctx, x + 1, y + 6, 30, 1, tone(mix(body, "#ffffff", 0.3)));
  rect(ctx, x + 8, y, 16, 6, K);
  rect(ctx, x + 9, y + 1, 14, 5, tone(mix(body, "#ffffff", 0.15)));
  rect(ctx, x + 10, y + 3, 5, 2, tone("#9ab8d0"));
  rect(ctx, x + 17, y + 3, 5, 2, tone("#9ab8d0"));
  rect(ctx, x + 2, y + 9, 28, 1, tone("#d0c8b0"));
  for (const wx of [x + 4, x + 22]) {
    rect(ctx, wx, y + 11, 6, 4, K);
    rect(ctx, wx + 2, y + 12, 2, 2, tone("#8a8a8a"));
  }
  rect(ctx, x + 31, y + 7, 1, 2, night ? "#fff2b8" : tone("#e8e2cc"));
}

function business(ctx: Ctx, lot: Lot, ground: number, night: boolean, t: number) {
  const tone = toned(night);
  const top = buildingTop(lot, ground);
  const { facade } = lot;
  roof(ctx, lot, top, night, tone);
  if (lot.waterTower) waterTower(ctx, lot.x + (lot.door === "right" ? 12 : lot.width - 26), top - ROOF_H + 4, tone);
  wall(ctx, lot, top, ground, night, tone);
  cornice(ctx, lot.x, top, lot.width, facade, tone);
  const slots = lot.floors * WINDOWS_PER_FLOOR;
  for (let i = 0; i < slots; i++) drawWindow(ctx, lot.windows[i] ?? DARK_WINDOW, windowRect(lot, i, ground), facade, night, tone, t, (lot.seed % 97) / 97 + i * 0.13);
  if (lot.fireEscape) fireEscape(ctx, lot, ground, tone);
  // The shop: a belt course, the sign board, the awning, the window, the door, the plate, the hanging sign.
  const shop = shopOf(lot, ground);
  rect(ctx, lot.x, ground - SHOP_H, lot.width, 2, tone(facade.trim));
  const sign = signRect(lot, ground);
  rect(ctx, sign.x - 1, sign.y - 1, sign.w + 2, sign.h + 2, K);
  rect(ctx, sign.x, sign.y, sign.w, sign.h, tone("#1d1a24"));
  rect(ctx, sign.x, sign.y, sign.w, 1, tone("#3a3644"));
  const lit = lot.working > 0 || lot.windows.some((w) => w.state === "working" || w.state === "background");
  const d = shop.display;
  awning(ctx, d.x - 2, ground - 27, d.w + 4, facade, tone);
  rect(ctx, d.x - 2, d.y - 1, d.w + 4, d.h + 2, K);
  const inside = night ? (lot.windows.length > 0 ? "#7a5030" : "#1a2040") : "#86a0b8";
  rect(ctx, d.x, d.y, d.w, d.h, night ? inside : tone(inside));
  if (night && lot.windows.length > 0) dither(ctx, d.x, d.y, d.w, 5, "#b87a40");
  if (lot.business) shopProps(ctx, lot.business.key, d, tone, night && lot.windows.length > 0);
  if (!night) for (let i = 0; i < 7; i++) rect(ctx, d.x + d.w - 5 - i * 2, d.y + 2 + i * 2, 2, 1, "#e8f2fa");
  rect(ctx, d.x - 2, d.y + d.h, d.w + 4, 1, tone(mix(facade.trim, "#ffffff", 0.3)));
  rect(ctx, d.x - 2, d.y + d.h + 1, d.w + 4, 2, tone(facade.trim));
  door(ctx, shop.door, facade, tone, night, lit);
  plate(ctx, shop.plate, tone, lot.hidden.some((w) => w.state === "needs"));
  emblem(ctx, lot, shop.emblem, tone, night);
  if (night && lit) for (let i = 0; i < 3; i++) dither(ctx, d.x + 4 + i * 4, ground + 2 + i * 2, d.w - 8 - i * 8, 2, "#8a7658");
}

function club(ctx: Ctx, lot: Lot, ground: number, night: boolean, crew: number, t: number) {
  const tone = toned(night);
  const top = buildingTop(lot, ground);
  roof(ctx, lot, top, night, tone);
  // A flag on the roof: the club's colours.
  const fx = lot.x + lot.width - 20;
  const fy = top - ROOF_H - 14;
  rect(ctx, fx, fy, 1, 20, tone("#2a2a30"));
  const wave = Math.floor(t / 400) % 2;
  rect(ctx, fx + 1, fy + wave, 9, 3, tone("#2f6a4a"));
  rect(ctx, fx + 1, fy + 3 + wave, 9, 2, tone("#d4b25a"));
  wall(ctx, lot, top, ground, night, tone);
  cornice(ctx, lot.x, top, lot.width, lot.facade, tone);
  for (let i = 0; i < lot.floors * WINDOWS_PER_FLOOR; i++) {
    const w: StreetWindow = { kind: "room", id: "", title: "", state: i < Math.ceil(crew / 2) ? "idle" : "dark", label: "", unseen: 0, members: Math.min(2, crew - i * 2) };
    drawWindow(ctx, w, windowRect(lot, i, ground), lot.facade, night, tone, t, i * 0.2);
  }
  const shop = shopOf(lot, ground);
  rect(ctx, lot.x, ground - SHOP_H, lot.width, 2, tone(lot.facade.trim));
  const sign = signRect(lot, ground);
  rect(ctx, sign.x - 1, sign.y - 1, sign.w + 2, sign.h + 2, K);
  rect(ctx, sign.x, sign.y, sign.w, sign.h, tone("#10241a"));
  const d = shop.display;
  awning(ctx, d.x - 2, ground - 27, d.w + 4, lot.facade, tone);
  rect(ctx, d.x - 2, d.y - 1, d.w + 4, d.h + 2, K);
  rect(ctx, d.x, d.y, d.w, d.h, night ? "#6a4228" : tone("#3a2a22"));
  rect(ctx, d.x, d.y, 5, d.h, tone("#7a2228"));
  rect(ctx, d.x + d.w - 5, d.y, 5, d.h, tone("#7a2228"));
  rect(ctx, d.x + 7, d.y + 3, d.w - 14, d.h - 6, tone("#7a5530"));
  rect(ctx, d.x + 8, d.y + 4, d.w - 16, d.h - 8, tone("#22302a"));
  rect(ctx, d.x - 2, d.y + d.h + 1, d.w + 4, 2, tone(lot.facade.trim));
  door(ctx, shop.door, lot.facade, tone, night, true);
}

function rent(ctx: Ctx, lot: Lot, ground: number, night: boolean) {
  const tone = toned(night);
  const top = buildingTop(lot, ground);
  roof(ctx, lot, top, night, tone);
  wall(ctx, lot, top, ground, night, tone);
  cornice(ctx, lot.x, top, lot.width, lot.facade, tone);
  for (let i = 0; i < WINDOWS_PER_FLOOR; i++) drawWindow(ctx, DARK_WINDOW, windowRect(lot, i, ground), lot.facade, night, tone, 0, 0);
  const shop = shopOf(lot, ground);
  rect(ctx, lot.x, ground - SHOP_H, lot.width, 2, tone(lot.facade.trim));
  const sign = signRect(lot, ground);
  rect(ctx, sign.x - 1, sign.y - 1, sign.w + 2, sign.h + 2, K);
  rect(ctx, sign.x, sign.y, sign.w, sign.h, tone("#8a7456"));
  const d = shop.display;
  rect(ctx, d.x - 2, d.y - 1, d.w + 4, d.h + 2, K);
  rect(ctx, d.x, d.y, d.w, d.h, tone("#2a2622"));
  for (let i = 0; i < 3; i++) {
    rect(ctx, d.x - 2, d.y + 2 + i * 6, d.w + 4, 3, tone("#a0804e"));
    rect(ctx, d.x - 2, d.y + 2 + i * 6, d.w + 4, 1, tone("#c49e66"));
  }
  rect(ctx, d.x + 6, d.y + 5, 14, 10, "#f1ebdd");
  rect(ctx, d.x + 8, d.y + 8, 10, 1, "#c0302a");
  rect(ctx, d.x + 8, d.y + 11, 7, 1, "#8a8070");
  door(ctx, shop.door, lot.facade, tone, night, false);
}

/** Buildings past both ends of the block, so the street does not stop at the edge. */
function filler(ctx: Ctx, x: number, w: number, index: number, ground: number, night: boolean) {
  const seed = hashOf(`filler${index}`);
  const base = toned(night);
  const tone: Tone = (hex) => mix(base(hex), "#000000", 0.28);
  const facade: Facade = { material: (["brick", "stone", "clapboard"] as const)[seed % 3]!, base: "#6a5048", light: "#7a5e54", dark: "#56403a", mortar: "#40302b", trim: "#a89f8a", awning: "#3a3a3a", stripe: "#6a6a6a" };
  const floors = 1 + (seed % 3);
  const lot = { x, width: w, floors, facade, roof: (["flat", "mansard", "gable"] as const)[(seed >>> 4) % 3], seed, door: "right", waterTower: false } as unknown as Lot;
  const top = ground - SHOP_H - floors * FLOOR_H - CORNICE_H;
  roof(ctx, lot, top, night, tone);
  const key = `filler:${facade.material}:${night}`;
  fillWith(
    ctx,
    pattern(ctx, key, () => wallTile(facade, tone, key)),
    x,
    top,
    w,
    ground - top,
  );
  cornice(ctx, x, top, w, facade, tone);
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < 3; c++) {
      const on = night && hashOf(`${seed}:${f}:${c}`) % 4 === 0;
      const wx = x + 12 + c * 28;
      const wy = ground - SHOP_H - (f + 1) * FLOOR_H + 5;
      rect(ctx, wx, wy, 16, 18, K);
      rect(ctx, wx + 1, wy + 1, 14, 16, on ? "#b07a3e" : tone("#4a5a70"));
    }
  }
  rect(ctx, x, ground - SHOP_H, w, SHOP_H, tone("#3a302c"));
  rect(ctx, x + 6, ground - 24, w - 12, 20, K);
  rect(ctx, x + 7, ground - 23, w - 14, 18, tone("#2a3040"));
}

function streetFloor(ctx: Ctx, x0: number, x1: number, ground: number, viewH: number, night: boolean) {
  const tone = toned(night);
  const slabKey = `slab:${night}`;
  fillWith(
    ctx,
    pattern(ctx, slabKey, () => slabTile(tone, slabKey)),
    x0,
    ground,
    x1 - x0,
    SIDEWALK_H,
  );
  // The buildings' shadow along their foot.
  dither(ctx, x0, ground, x1 - x0, 3, tone("#6a655d"));
  const curb = ground + SIDEWALK_H;
  rect(ctx, x0, curb, x1 - x0, 1, tone("#e0dbcf"));
  rect(ctx, x0, curb + 1, x1 - x0, 2, tone("#a8a296"));
  rect(ctx, x0, curb + 3, x1 - x0, 1, tone("#6a655d"));
  const road = curb + CURB_H;
  const roadKey = `asphalt:${night}`;
  fillWith(
    ctx,
    pattern(ctx, roadKey, () => asphaltTile(tone, roadKey)),
    x0,
    road,
    x1 - x0,
    ROAD_H,
  );
  const lane = road + Math.floor(ROAD_H / 2);
  for (let x = Math.floor(x0 / 24) * 24; x < x1; x += 24) {
    rect(ctx, x, lane, 12, 2, tone("#e8d070"));
    rect(ctx, x, lane + 2, 12, 1, tone("#a8943e"));
  }
  // A manhole cover here and there.
  for (let x = Math.floor(x0 / 160) * 160 + 70; x < x1; x += 160) {
    rect(ctx, x, road + ROAD_H - 8, 10, 4, tone("#3a3c42"));
    rect(ctx, x + 1, road + ROAD_H - 7, 8, 2, tone("#5a5c62"));
  }
  const far = road + ROAD_H;
  rect(ctx, x0, far, x1 - x0, 1, tone("#6a655d"));
  rect(ctx, x0, far + 1, x1 - x0, 2, tone("#a8a296"));
  const farKey = `slab:${night}`;
  fillWith(
    ctx,
    pattern(ctx, farKey, () => slabTile(tone, farKey)),
    x0,
    far + 3,
    x1 - x0,
    Math.max(0, viewH - far - 3),
  );
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
  const tone = toned(night);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  sky(ctx, viewW, ground, camX, night, t);
  ctx.setTransform(1, 0, 0, 1, -camX, 0);
  const x0 = camX - 4;
  const x1 = camX + viewW + 4;
  for (let i = 1, x = -104; x + 104 > x0; i++, x -= 104) filler(ctx, x, 96, -i, ground, night);
  for (let i = 1, x = block.width + GAP; x < x1; i++, x += 104) filler(ctx, x, 96, i, ground, night);
  // The alleys between buildings.
  for (const lot of block.lots) {
    const ax = lot.x + lot.width;
    if (ax > x1 || ax + GAP < x0) continue;
    rect(ctx, ax, ground - SHOP_H - 20, GAP, SHOP_H + 20, tone("#1a1820"));
    dither(ctx, ax, ground - SHOP_H - 20, GAP, 6, tone("#2a2830"));
  }
  streetFloor(ctx, x0, x1, ground, viewH, night);
  for (const lot of block.lots) {
    if (lot.x + lot.width < x0 - 30 || lot.x > x1 + 30) continue;
    if (lot.kind === "business") business(ctx, lot, ground, night, t);
    else if (lot.kind === "club") club(ctx, lot, ground, night, frame.crew, t);
    else rent(ctx, lot, ground, night);
  }
  // On the pavement and the road, in front of everything: lamps, mailboxes, boards, hydrants, a cat, parked cars.
  const lamps = lampsOf(block);
  const clubLot = block.lots[0];
  if (clubLot) lampPost(ctx, clubLot.x + 1, ground, night, tone, t, true);
  for (const lx of lamps) if (lx > x0 - 30 && lx < x1 + 30) lampPost(ctx, lx, ground, night, tone, t);
  for (const lot of block.lots) {
    if (lot.kind !== "business" || lot.x + lot.width < x0 - 10 || lot.x > x1 + 10) continue;
    mailbox(ctx, mailboxRect(lot, ground), tone, night, lot.unseen > 0);
    chalkboard(ctx, boardRect(lot, ground), tone);
    if ((lot.seed >>> 7) % 4 === 0) stampSprite(ctx, "hydrant", HYDRANT, { K, R: "#c0302a", r: "#e8584a" }, tone, night, lot.x + lot.width - 4, ground + 12);
    if (lot.cat) {
      const shop = shopOf(lot, ground);
      const frameIndex = cycle(t, 2400, lot.seed % 11) < 0.15 ? 1 : 0;
      const cx = lot.door === "right" ? shop.door.x - 10 : shop.door.x + shop.door.w + 2;
      stampSprite(ctx, `cat${frameIndex}`, CAT[frameIndex]!, { K: "#1a1a22", Y: night ? "#f6e060" : "#c8b040" }, (hex) => hex, night, cx, ground + 1);
    }
    if ((lot.seed >>> 15) % 3 === 0) car(ctx, lot.x + 50, ground, lot.seed, night, tone);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Original 16×22 pixel villagers: animal-crossing-ish silhouettes, not copies of anyone's characters. */

export const SPECIES = ["cat", "bear", "bird", "rabbit", "frog", "pup"] as const;
export type Species = (typeof SPECIES)[number];
export type Accessory = "none" | "bow" | "flower" | "scarf" | "glasses";
export type VillagerMotion = "idle" | "working" | "monitoring" | "needs" | "error";

export interface VillagerLook {
  species: Species;
  accessory: Accessory;
  fur: string;
  furDark: string;
  cloth: string;
  clothDark: string;
  accent: string;
  hat: string;
}

const FURS = ["#f2c4a0", "#c48a5a", "#efe6d2", "#8fbe7a", "#d9a0c4", "#7aa0c8", "#e8d07a", "#b8a090", "#e07a6a", "#9bb07a"];
const CLOTHS = ["#e85d4c", "#3d9a6a", "#f0c02e", "#6b5ce7", "#2a9d8f", "#e76f51", "#4d8fd6", "#c45c26", "#d4537e", "#5c7cfa"];
const ACCENTS = ["#ffd6e0", "#b8f0c8", "#ffe08a", "#c5b4ff", "#9ee7dc"];
const HATS = ["#3a2415", "#5c3317", "#2c3d5a", "#6b2d3c", "#1f4d3a"];
const ACCESSORIES: Accessory[] = ["none", "bow", "flower", "scarf", "glasses", "none"];

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pick<T>(list: readonly T[], h: number, salt: number): T {
  return list[(h + salt) % list.length] as T;
}

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, ((n >> 16) & 255) + amount));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amount));
  const b = Math.min(255, Math.max(0, (n & 255) + amount));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function lookFor(alias: string): VillagerLook {
  const h = hashString(alias.toLowerCase());
  const fur = pick(FURS, h, 3);
  const cloth = pick(CLOTHS, h, 11);
  return {
    species: pick(SPECIES, h, 0),
    accessory: pick(ACCESSORIES, h, 19),
    fur,
    furDark: shade(fur, -36),
    cloth,
    clothDark: shade(cloth, -40),
    accent: pick(ACCENTS, h, 29),
    hat: pick(HATS, h, 41),
  };
}

const INK = "#2a1810";
const WHITE = "#fff6e8";
const PINK = "#f4a8a0";
const EYE = "#1a120c";
const BEAK = "#e8a040";
const GLASS = "#9fd7e8";

const W = 16;
const H = 22;

type Plot = (x: number, y: number, color: string) => void;

function oval(plot: Plot, cx: number, cy: number, rx: number, ry: number, color: string): void {
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  for (let y = -ry; y <= ry; y++) {
    for (let x = -rx; x <= rx; x++) {
      if (x * x * ry2 + y * y * rx2 <= rx2 * ry2) plot(cx + x, cy + y, color);
    }
  }
}

function blob(plot: Plot, cx: number, cy: number, rx: number, ry: number, fill: string): void {
  oval(plot, cx, cy, rx + 1, ry + 1, INK);
  oval(plot, cx, cy, rx, ry, fill);
}

function triUp(plot: Plot, cx: number, top: number, h: number, color: string): void {
  for (let row = 0; row < h; row++) {
    const half = Math.max(0, Math.round((row / (h - 1)) * 2));
    for (let col = -half; col <= half; col++) plot(cx + col, top + row, color);
  }
}

function hline(plot: Plot, x: number, y: number, w: number, color: string): void {
  for (let i = 0; i < w; i++) plot(x + i, y, color);
}

function fill(plot: Plot, x: number, y: number, w: number, h: number, color: string): void {
  for (let row = 0; row < h; row++) hline(plot, x, y + row, w, color);
}

function body(plot: Plot, look: VillagerLook): void {
  blob(plot, 8, 16, 5, 4, look.cloth);
  oval(plot, 8, 17, 4, 3, look.clothDark);
  // feet
  fill(plot, 4, 20, 3, 2, look.furDark);
  fill(plot, 9, 20, 3, 2, look.furDark);
  plot(4, 20, INK);
  plot(6, 20, INK);
  plot(9, 20, INK);
  plot(11, 20, INK);
  hline(plot, 4, 21, 3, INK);
  hline(plot, 9, 21, 3, INK);
}

function eyes(plot: Plot, lx: number, rx: number, y: number, blink: boolean, look: VillagerLook): void {
  if (blink) {
    hline(plot, lx - 1, y, 3, look.furDark);
    hline(plot, rx - 1, y, 3, look.furDark);
    return;
  }
  fill(plot, lx - 1, y - 1, 3, 3, WHITE);
  fill(plot, rx - 1, y - 1, 3, 3, WHITE);
  plot(lx, y, EYE);
  plot(rx, y, EYE);
  plot(lx - 1, y + 1, PINK);
  plot(rx + 1, y + 1, PINK);
}

function glasses(plot: Plot, y: number): void {
  fill(plot, 3, y - 1, 4, 4, GLASS);
  fill(plot, 9, y - 1, 4, 4, GLASS);
  hline(plot, 3, y - 1, 4, INK);
  hline(plot, 3, y + 2, 4, INK);
  hline(plot, 9, y - 1, 4, INK);
  hline(plot, 9, y + 2, 4, INK);
  plot(3, y, INK);
  plot(6, y, INK);
  plot(9, y, INK);
  plot(12, y, INK);
  hline(plot, 7, y, 2, INK);
}

function accessory(plot: Plot, look: VillagerLook, headTop: number): void {
  if (look.accessory === "bow") {
    fill(plot, 6, headTop - 1, 4, 2, look.accent);
    plot(5, headTop, look.accent);
    plot(10, headTop, look.accent);
    plot(7, headTop, INK);
    plot(8, headTop, INK);
  } else if (look.accessory === "flower") {
    plot(12, headTop + 1, look.accent);
    plot(13, headTop, look.accent);
    plot(14, headTop + 1, look.accent);
    plot(13, headTop + 1, "#f0c02e");
  } else if (look.accessory === "scarf") {
    hline(plot, 4, 13, 8, look.accent);
    fill(plot, 10, 14, 2, 4, look.accent);
  }
}

function catHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  triUp(plot, 4, 0, 5, INK);
  triUp(plot, 4, 1, 4, look.fur);
  triUp(plot, 12, 0, 5, INK);
  triUp(plot, 12, 1, 4, look.fur);
  plot(4, 2, PINK);
  plot(12, 2, PINK);
  blob(plot, 8, 8, 6, 5, look.fur);
  oval(plot, 8, 10, 5, 3, look.furDark);
  eyes(plot, 5, 11, 8, blink, look);
  plot(8, 10, INK);
  plot(7, 11, INK);
  plot(9, 11, INK);
}

function bearHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  oval(plot, 3, 4, 3, 3, INK);
  oval(plot, 3, 4, 2, 2, look.fur);
  oval(plot, 13, 4, 3, 3, INK);
  oval(plot, 13, 4, 2, 2, look.fur);
  blob(plot, 8, 9, 6, 5, look.fur);
  oval(plot, 8, 11, 4, 3, look.furDark);
  eyes(plot, 5, 11, 8, blink, look);
  oval(plot, 8, 12, 3, 2, look.furDark);
  plot(8, 11, INK);
}

function birdHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  triUp(plot, 8, 0, 4, look.accent);
  blob(plot, 8, 8, 5, 5, look.fur);
  eyes(plot, 6, 10, 7, blink, look);
  fill(plot, 11, 9, 4, 2, BEAK);
  plot(14, 9, INK);
  plot(14, 10, INK);
  hline(plot, 11, 8, 3, INK);
  hline(plot, 11, 11, 3, INK);
}

function rabbitHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  fill(plot, 4, 0, 3, 8, INK);
  fill(plot, 5, 1, 1, 7, look.fur);
  fill(plot, 9, 0, 3, 8, INK);
  fill(plot, 10, 1, 1, 7, look.fur);
  plot(5, 3, PINK);
  plot(10, 3, PINK);
  blob(plot, 8, 10, 5, 4, look.fur);
  eyes(plot, 5, 11, 9, blink, look);
  plot(8, 11, INK);
}

function frogHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  blob(plot, 8, 8, 7, 5, look.fur);
  oval(plot, 4, 5, 3, 3, INK);
  oval(plot, 4, 5, 2, 2, look.fur);
  oval(plot, 12, 5, 3, 3, INK);
  oval(plot, 12, 5, 2, 2, look.fur);
  eyes(plot, 4, 12, 5, blink, look);
  hline(plot, 5, 11, 6, INK);
  plot(5, 10, INK);
  plot(10, 10, INK);
}

function pupHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  fill(plot, 1, 5, 4, 3, INK);
  fill(plot, 2, 6, 3, 2, look.furDark);
  fill(plot, 11, 5, 4, 3, INK);
  fill(plot, 11, 6, 3, 2, look.furDark);
  blob(plot, 8, 9, 6, 5, look.fur);
  oval(plot, 5, 8, 2, 2, look.furDark);
  eyes(plot, 5, 11, 8, blink, look);
  oval(plot, 8, 12, 3, 2, look.furDark);
  plot(8, 11, INK);
}

const HEADS: Record<Species, (plot: Plot, look: VillagerLook, blink: boolean) => void> = {
  cat: catHead,
  bear: bearHead,
  bird: birdHead,
  rabbit: rabbitHead,
  frog: frogHead,
  pup: pupHead,
};

export const BOSS_LOOK: VillagerLook = {
  species: "bear",
  accessory: "glasses",
  fur: "#f0c8a8",
  furDark: "#d09a78",
  cloth: "#3a2415",
  clothDark: "#24160d",
  accent: "#c45c26",
  hat: "#2a1810",
};

function bossHead(plot: Plot, look: VillagerLook, blink: boolean): void {
  fill(plot, 3, 1, 10, 3, look.hat);
  hline(plot, 1, 4, 14, look.hat);
  hline(plot, 1, 4, 14, INK);
  blob(plot, 8, 9, 5, 5, look.fur);
  glasses(plot, 8);
  eyes(plot, 5, 11, 8, blink, look);
  hline(plot, 6, 12, 4, look.furDark);
}

export function drawVillager(
  ctx: CanvasRenderingContext2D,
  look: VillagerLook,
  opts: { blink: boolean; boss?: boolean | undefined; ghost?: boolean | undefined },
): void {
  const pixels = new Array<string | null>(W * H).fill(null);
  const plot: Plot = (x, y, color) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    pixels[y * W + x] = color;
  };
  body(plot, look);
  if (opts.boss) bossHead(plot, look, opts.blink);
  else HEADS[look.species](plot, look, opts.blink);
  if (!opts.boss) accessory(plot, look, 1);
  if (look.accessory === "glasses" && !opts.boss) glasses(plot, 8);

  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const color = pixels[y * W + x];
      if (!color) continue;
      ctx.globalAlpha = opts.ghost ? 0.35 : 1;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

export function memberSeats(count: number): Array<{ x: number; y: number; depth: number }> {
  if (count <= 0) return [];
  // South is reserved for you (the boss). Members take the rest of the ellipse.
  const reserved = Math.PI / 2;
  const gap = 0.85;
  const available = Math.PI * 2 - gap;
  return Array.from({ length: count }, (_, i) => {
    const a = reserved + gap / 2 + (available * (i + 0.5)) / count;
    const x = 50 + 38 * Math.cos(a);
    const y = 54 + 26 * Math.sin(a);
    return { x, y, depth: y };
  });
}

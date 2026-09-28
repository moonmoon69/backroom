/**
 * Pixel helpers shared by the street (art.ts) and the rooms (backroomScene.ts): colours toned for night, whole-pixel
 * rectangles, repeating tiles as canvas patterns, and dithering, the SNES way to shade and to light.
 */

export type Ctx = CanvasRenderingContext2D;
export type Tone = (hex: string) => string;

// ---- colour ----

export function parse(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${((c(ar, br) << 16) | (c(ag, bg) << 8) | c(ab, bb)).toString(16).padStart(6, "0")}`;
}

const toneCache = new Map<string, string>();
/** A surface lit only by the sky: as it is by day, towards night blue at night. */
export function toned(night: boolean): Tone {
  if (!night) return (hex) => hex;
  return (hex) => {
    let out = toneCache.get(hex);
    if (!out) {
      out = mix(hex, "#0e1438", 0.55);
      toneCache.set(hex, out);
    }
    return out;
  };
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

export function cycle(t: number, period: number, seed: number): number {
  return ((((t + seed * period) % period) + period) % period) / period;
}

// ---- tiles and dither, as canvas patterns anchored to the scene ----

const tileCache = new Map<string, HTMLCanvasElement>();
const patternCache = new WeakMap<Ctx, Map<string, CanvasPattern>>();

export function tile(key: string, w: number, h: number, paint: (put: (x: number, y: number, colour: string) => void) => void): HTMLCanvasElement {
  let canvas = tileCache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d")!;
    paint((x, y, colour) => {
      c.fillStyle = colour;
      c.fillRect(x, y, 1, 1);
    });
    tileCache.set(key, canvas);
  }
  return canvas;
}

export function pattern(ctx: Ctx, key: string, make: () => HTMLCanvasElement): CanvasPattern {
  let map = patternCache.get(ctx);
  if (!map) {
    map = new Map();
    patternCache.set(ctx, map);
  }
  let p = map.get(key);
  if (!p) {
    p = ctx.createPattern(make(), "repeat")!;
    map.set(key, p);
  }
  return p;
}

export function fillWith(ctx: Ctx, p: CanvasPattern, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = p;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

/** Half the pixels, checkerboard: the SNES way to shade and to light. */
export function dither(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string) {
  if (w <= 0 || h <= 0) return;
  fillWith(
    ctx,
    pattern(ctx, `dither:${colour}`, () => tile(`dither:${colour}`, 2, 2, (put) => (put(0, 0, colour), put(1, 1, colour)))),
    x,
    y,
    w,
    h,
  );
}

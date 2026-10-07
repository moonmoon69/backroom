/**
 * The pixel skin's people: the street's capybara crew, head and shoulders, 16 × 16, drawn from a look's named parts
 * (src/domain/look.ts): hat and its colour and band, fur, eyes, brows, glasses, whiskers, neckwear and its colour,
 * outfit and its colour, accessory. Drawn as an SVG of whole squares with crisp edges (MemberMark.tsx, LookSprite), so
 * each sprite pixel lands on whole device pixels wherever it sits; pixel.css sizes it to a whole number of device pixels
 * per sprite pixel (16px in chips, 32px in rows and beside a speaker, larger in the look picker).
 *
 * One mark is not a part: the pocket square is always the harness's colour, so no look loses the sign of what the
 * member runs on. Nothing else is added: a crew member is drawn as configured wherever it is drawn.
 *
 * Rows: 0–4 the hat (or ears), 5–11 the face, 12 the collar, 13–15 the outfit.
 */
import { LOOK_PARTS, type Look } from "../../../src/domain/look.ts";

/** The hat band and tie of each harness, in its logo's colour where it has one. */
export const HARNESS_COLOUR: Record<string, string> = {
  claudeAgent: "#d97757",
  codex: "#10a37f",
  cursor: "#8fb4ff",
  grok: "#e6e6e6",
  opencode: "#f2c14e",
  antigravity: "#4f8cf7",
};
export const SPARE_COLOURS = ["#c65d7b", "#6cc3c1", "#b48ede", "#e0a458", "#8cc084", "#d4d4aa"];

/** A steady number in [0, 1) from an id. */
export function seedOf(id: string, salt = ""): number {
  const key = salt + id;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** Darken or lighten a hex colour: amount -1..1. */
export function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 0xff;
    const next = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, "0")}`;
}

/** The colour a part's option draws; "auto" (and anything without a colour) the harness's. */
function colourOf(part: string, option: string, harness: string): string {
  return LOOK_PARTS.find((p) => p.key === part)?.options.find((o) => o.key === option)?.colour ?? harness;
}

// ---- the parts as rows; "." leaves the pixel as it was ----

const HATS: Record<string, readonly string[]> = {
  fedora: ["......KKKK......", "....KKHHLHKK....", "....KHHHHHhK....", "....KBBBBBBK....", "..KKHHHHHHHHKK.."],
  bowler: ["......KKKK......", ".....KHHLHK.....", "....KHHHHHhK....", "....KBBBBBBK....", "...KKKKKKKKKK..."],
  tophat: ["....KKKKKKKK....", "....KHHHLHHK....", "....KHHHHHhK....", "....KBBBBBBK....", "..KKKKKKKKKKKK.."],
  cap: ["................", ".....KKKKKK.....", "....KHHLHHHK....", "....KBBBBBBK....", "....KKKKKKKKHHHK"],
  beret: ["................", "......KKKKK.....", "....KKHHHLHHK...", "...KHHHHHHHHHK..", "....KBBBBBBK...."],
  boater: ["................", "....KKKKKKKK....", "....KHHHHHHK....", "....KBBBBBBK....", ".KKHHHHHHHHHHKK."],
  beanie: [".......KK.......", "......KLLK......", "....KKHHHHKK....", "...KHHHhHhHHK...", "...KBBBBBBBBK..."],
  none: ["................", "................", "................", "...KKK....KKK...", "...KFKKKKKKFK..."],
};

const FACE = [
  "...KFFFFFFFFK...",
  "..KFFEFFFFEFFK..",
  "..KFFFFFFFFFFK..",
  "..KFFDDDDDDFFK..",
  "..KFFDdDDdDFFK..",
  "..KFFDDDDDDFFK..",
  "...KFFFFFFFFK...",
];

/** Collar and outfit, without neckwear: rows 12–15. */
const OUTFITS: Record<string, readonly string[]> = {
  suit: ["....KKWWWWKK....", "..KSSSWWWWSSSK..", ".KSSSSSWWSSSSSK.", ".KSSSSSSSSSSSSK."],
  vest: ["....KKWWWWKK....", "..KWWSWWWWSWWK..", ".KWWWSSWWSSWWWK.", ".KWWWSSSSSSWWWK."],
  turtleneck: ["....KKSSSSKK....", "..KSSSSSSSSSSK..", ".KSSSSSSSSSSSSK.", ".KSSSSSSSSSSSSK."],
};

const drawings = new Map<string, readonly LookPath[]>();

/** One colour of a drawn look: its squares as one SVG path of whole-pixel runs. */
export interface LookPath {
  fill: string;
  d: string;
}

/** The member's mark as SVG paths, one per colour, on a 16 × 16 grid: the look's parts and the harness's pocket square. */
export function lookPaths(look: Look, harness: string): readonly LookPath[] {
  const key = `${JSON.stringify(look)}|${harness}`;
  const hit = drawings.get(key);
  if (hit) return hit;

  const grid: string[][] = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => "."));
  const row = (y: number, pattern: string) => {
    for (let x = 0; x < 16; x++) if (pattern[x] !== ".") grid[y]![x] = pattern[x]!;
  };
  const put = (x: number, y: number, letter: string) => {
    grid[y]![x] = letter;
  };

  (HATS[look.hat ?? "fedora"] ?? HATS.fedora!).forEach((pattern, y) => row(y, pattern));
  FACE.forEach((pattern, y) => row(5 + y, pattern));
  const outfit = look.outfit ?? "suit";
  (OUTFITS[outfit] ?? OUTFITS.suit!).forEach((pattern, y) => row(12 + y, pattern));

  // Neckwear: none with a turtleneck.
  const neckwear = outfit === "turtleneck" ? "none" : (look.neckwear ?? "tie");
  if (neckwear === "tie") {
    for (const y of [12, 13, 14, 15]) {
      put(7, y, "T");
      put(8, y, "T");
    }
  } else if (neckwear === "bowtie") {
    row(12, "....KTTttTTK....");
  }

  // Eyes, then brows above them.
  const eyes = look.eyes ?? "dots";
  if (eyes === "wide") {
    put(5, 7, "E");
    put(10, 7, "E");
  } else if (eyes === "sleepy") {
    put(4, 6, "E");
    put(11, 6, "E");
  } else if (eyes === "wink") {
    put(11, 6, "E");
  }
  if (look.brows === "bushy") row(5, "....MMM..MMM....");

  // Glasses: dark shades cover everything around the eyes.
  if (look.glasses === "shades") {
    row(6, "....GgGGGGgG....");
    row(7, "....GGG..GGG....");
  } else if (look.glasses === "round") {
    row(6, "....g.gggg.g....");
  } else if (look.glasses === "monocle") {
    put(10, 5, "g");
    put(9, 6, "g");
    put(11, 6, "g");
    put(10, 7, "g");
    put(12, 8, "g");
    put(12, 9, "g");
  }

  const whiskers = look.whiskers ?? "none";
  if (whiskers === "whiskers") {
    row(8, "ww............ww");
    row(9, ".ww..........ww.");
  } else if (whiskers === "moustache") {
    row(10, "....MMMMMMMM....");
  }

  const accessory = look.accessory ?? "none";
  if (accessory === "cigar") {
    row(10, "..........CCCCe.");
    put(15, 9, "a");
  } else if (accessory === "flower") {
    put(4, 13, "R");
    put(5, 13, "R");
    put(4, 14, "r");
  }

  // The harness's pocket square: on every outfit, whatever the look.
  put(10, 14, "P");
  put(11, 14, "P");

  const fur = colourOf("fur", look.fur ?? "sandy", "#b98150");
  const hat = colourOf("hatColour", look.hatColour ?? "charcoal", "#4a4f58");
  const tie = colourOf("neckwearColour", look.neckwearColour ?? "auto", harness);
  const palette: Record<string, string> = {
    K: "#17120e",
    F: fur,
    D: shade(fur, -0.3),
    d: shade(fur, -0.62),
    E: "#120d0a",
    M: shade(fur, -0.7),
    w: "#efe8d6",
    W: "#ece6d6",
    S: colourOf("outfitColour", look.outfitColour ?? "charcoal", "#33363d"),
    H: hat,
    h: shade(hat, -0.35),
    L: shade(hat, 0.25),
    B: colourOf("band", look.band ?? "auto", harness),
    T: tie,
    t: shade(tie, -0.35),
    G: "#0b0b0d",
    g: look.glasses === "shades" ? "#8a93a4" : "#c9d2de",
    C: "#7a4a26",
    e: "#ff8a3a",
    a: "#b9b2a6",
    R: "#d8394a",
    r: "#f2c14e",
    P: harness,
  };

  // Each colour's squares, merged into horizontal runs.
  const byColour = new Map<string, string>();
  grid.forEach((cells, y) => {
    let x = 0;
    while (x < 16) {
      const colour = palette[cells[x]!];
      if (!colour) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < 16 && palette[cells[x + run]!] === colour) run += 1;
      byColour.set(colour, `${byColour.get(colour) ?? ""}M${x} ${y}h${run}v1h-${run}z`);
      x += run;
    }
  });
  const paths = [...byColour.entries()].map(([fill, d]) => ({ fill, d }));
  drawings.set(key, paths);
  return paths;
}

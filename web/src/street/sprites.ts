/**
 * The back room's pixel art: sprites written as rows of palette letters ("." is transparent), drawn once per colour
 * into small canvases and stamped from there. Everything is sized in scene pixels; the scene scales them up whole.
 */

export type Grid = readonly string[];

/** Shared colours. "B" (hat band) and "T" (tie) take the member's colour, "t" a darker shade of it. */
export const BASE_PALETTE: Record<string, string> = {
  K: "#17120e",
  H: "#4a4f58",
  h: "#33373e",
  L: "#646a75",
  F: "#b98150",
  f: "#94643a",
  D: "#7a4e2c",
  d: "#4f311b",
  E: "#120d0a",
  S: "#33363d",
  s: "#25272c",
  W: "#ece6d6",
  G: "#0b0b0d",
  g: "#6a7384",
};

/** A crew member seated at the table, facing us: fedora, capybara face, suit. Rows 20+ sit under the table. */
export const CAPY: Grid = [
  "........KKKKKK........",
  "......KKHLLHHHKK......",
  ".....KHHHLHHhHHHK.....",
  ".....KHHHHHHhHHHK.....",
  ".....KBBBBBBBBBBK.....",
  "..KHHHHHHHHHHHHHHHHK..",
  ".KhhhhhhhhhhhhhhhhhhK.",
  "..KKKFFFFFFFFFFFFKKK..",
  "....KFFFFFFFFFFFFK....",
  "...KFFFEFFFFFFEFFFK...",
  "...KFFFEFFFFFFEFFFK...",
  "...KFFFFDDDDDDFFFFK...",
  "...KFFFDDDDDDDDFFFK...",
  "...KFFDDdDDDDdDDFFK...",
  "...KFFDDDDDDDDDDFFK...",
  "....KFFDDDddDDDFFK....",
  ".....KKFFFFFFFFKK.....",
  "..KKSSSSWWTTWWSSSSKK..",
  ".KSSSSSSWWTTWWSSSSSSK.",
  "KSSsSSSSSWTTWSSSSSsSSK",
  "KSSsSSSSSSTTSSSSSSsSSK",
  "KSSsSSSSSSTTSSSSSSsSSK",
  "KSSsSSSSSSSSSSSSSSsSSK",
  "KSSsSSSSSSSSSSSSSSsSSK",
];

/** The boss: the same capybara behind dark glasses. */
export const BOSS: Grid = CAPY.map((row, index) => {
  if (index === 9) return "...KGGGGGGKKGGGGGGK...";
  if (index === 10) return "...KFGgGGGFFGgGGGFK...";
  return row;
});

/** Where a crew member's eyes are, to close them (blinks, sleep). */
export const EYES = [
  { x: 7, y: 9 },
  { x: 14, y: 9 },
];

/** A paw resting on the table. */
export const PAW: Grid = [".KKK.", "KFFFK", "KfFfK", ".KKK."];

/** The back of an open laptop's lid. */
export const LAPTOP: Grid = [
  "KKKKKKKKKKKK",
  "KaaaaaaaaaaK",
  "KAAAAAAAAAAK",
  "KAAAAAAAAAAK",
  "KAAAAcAAAAAK",
  "KAAAAAAAAAAK",
  "KAAAAAAAAAAK",
  "KKKKKKKKKKKK",
  ".KbbbbbbbbK.",
];
export const LAPTOP_PALETTE = { K: "#17120e", A: "#8b929c", a: "#a9b0ba", c: "#d4d8de", b: "#5c626b" };

/** A newspaper held up to read. */
export const NEWSPAPER: Grid = [
  "KKKKKKKKKKKKKKKK",
  "KPPPPPPPPPPPPPPK",
  "KPnnnnnnnnnnnnPK",
  "KPPPPPPPPPPPPPPK",
  "KPllllPPllllllPK",
  "KPPPPPPPPPPPPPPK",
  "KPllllPPllllPPPK",
  "KPPPPPPPPPPPPPPK",
  "KPlllPPPlllllPPK",
  "KPPPPPPPPPPPPPPK",
  "KKKKKKKKKKKKKKKK",
];
export const NEWSPAPER_PALETTE = { K: "#17120e", P: "#d8d2c0", n: "#3a342c", l: "#8f897a" };

/** A glass of whisky. */
export const GLASS: Grid = ["KKKKK", "KwwwK", "KwwwK", "KrrrK", "KRRRK", "KKKKK"];
export const GLASS_PALETTE = { K: "#1d2226", w: "#7d949e", r: "#d08a2c", R: "#a5621a" };

/** The boss's cigar. */
export const CIGAR: Grid = ["KKKKKKKo", "KccccCCe", "KKKKKKKo"];
export const CIGAR_PALETTE = { K: "#2a1a10", c: "#8a5a32", C: "#6d4526", e: "#ff8a3a", o: "#9a9a9a" };

/** A sealed envelope: a new assignment on its way. */
export const ENVELOPE: Grid = ["KKKKKKKKK", "KWWdWdWWK", "KWWWdWWWK", "KWWWWWWWK", "KKKKKKKKK"];
export const ENVELOPE_PALETTE = { K: "#17120e", W: "#f2ecd9", d: "#b3a88a" };

/** A sheet of paper: a finished answer going back to the boss. */
export const SHEET: Grid = ["KKKKKK", "KWWWWK", "KWllWK", "KWWWWK", "KWllWK", "KKKKKK"];
export const SHEET_PALETTE = { K: "#17120e", W: "#f7f3e6", l: "#9b957f" };

/** 3×5 glyphs for the bubbles over heads. */
export const GLYPHS: Record<string, Grid> = {
  "!": [".X.", ".X.", ".X.", "...", ".X."],
  "?": ["XX.", "..X", ".X.", "...", ".X."],
  x: ["...", "X.X", ".X.", "X.X", "..."],
  z: ["XXX", "..X", ".X.", "X..", "XXX"],
};

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

const cache = new Map<string, HTMLCanvasElement>();

/**
 * The grid drawn in the palette, as a canvas to stamp with drawImage. `silhouette` fills every pixel with one colour
 * (the members at the near side of the table, seen from behind in the dark).
 */
export function sprite(key: string, grid: Grid, palette: Record<string, string>, silhouette?: string): HTMLCanvasElement {
  const id = `${key}|${silhouette ?? ""}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(...grid.map((row) => row.length));
  canvas.height = grid.length;
  const ctx = canvas.getContext("2d")!;
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const letter = row[x]!;
      if (letter === ".") continue;
      const colour = silhouette ?? palette[letter];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  cache.set(id, canvas);
  return canvas;
}

/** Felt for the hats, so two members on the same harness still look like two people. */
export const HATS = ["#4a4f58", "#5a4636", "#3d4a5c", "#5e5e5e", "#6b5a3e", "#4b3f52"];

/** A capybara in the member's colour (hat band and tie) and hat. */
export function capySprite(colour: string, boss: boolean, hat = HATS[0]!, silhouette?: string): HTMLCanvasElement {
  const palette = { ...BASE_PALETTE, B: colour, T: boss ? "#15161a" : colour, H: hat, h: shade(hat, -0.3), L: shade(hat, 0.18) };
  return sprite(`${boss ? "boss" : "capy"}:${colour}:${hat}`, boss ? BOSS : CAPY, palette, silhouette);
}

/** A crew member at the near side of the table, seen from behind: the hat and its band, the back of the head, the suit. */
export const CAPY_BACK: Grid = [
  "........KKKKKK........",
  "......KKHLLHHHKK......",
  ".....KHHHLHHHHHHK.....",
  ".....KHHHHHHHHhHK.....",
  ".....KBBBBBBBBBBK.....",
  "..KHHHHHHHHHHHHHHHHK..",
  ".KhhhhhhhhhhhhhhhhhhK.",
  "..KKKFFFFFFFFFFFFKKK..",
  "...KfFFFFFFFFFFFFFfK..",
  "...KfFFFFFFFFFFFFFfK..",
  "...KffFFFFFFFFFFFffK..",
  "....KffFFFFFFFFFffK...",
  ".....KKffffffffKK.....",
  "..KKSSSSSWWWWSSSSSKK..",
  ".KSSSSSSSSSSSSSSSSSSK.",
  "KSSsSSSSSSSSSSSSSSsSSK",
  "KSSsSSSSSSsSSSSSSSsSSK",
  "KSSsSSSSSSsSSSSSSSsSSK",
  "KSSsSSSSSSsSSSSSSSsSSK",
  "KSSsSSSSSSsSSSSSSSsSSK",
];

/** The same capybara from behind, in the member's colour and hat. */
export function capyBackSprite(colour: string, hat = HATS[0]!, silhouette?: string): HTMLCanvasElement {
  const palette = { ...BASE_PALETTE, B: colour, H: hat, h: shade(hat, -0.3), L: shade(hat, 0.18) };
  return sprite(`capyback:${colour}:${hat}`, CAPY_BACK, palette, silhouette);
}

/** An open laptop seen from the screen side, lit. */
export const LAPTOP_FRONT: Grid = [
  "KKKKKKKKKKKKKK",
  "KAAAAAAAAAAAAK",
  "KAssssssssssAK",
  "KAsggsssssssAK",
  "KAsssgggsssAAK",
  "KAsggsssssssAK",
  "KAssssgggsssAK",
  "KAssssssssssAK",
  "KKKKKKKKKKKKKK",
  "KbbbbbbbbbbbbK",
];
export const LAPTOP_FRONT_PALETTE = { K: "#17120e", A: "#8b929c", s: "#1c3a5a", g: "#7fe0a0", b: "#5c626b" };

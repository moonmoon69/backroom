/**
 * The pixel skin's icons: 8 × 8 grids with one-pixel strokes, drawn at 2× (16px) in the text colour, so they sit on
 * the same 2px unit as every frame. components/icons.tsx draws one of these in place of the line drawing while the
 * look is pixel; an icon without a grid here keeps its line drawing. "X" is a pixel, "." is empty.
 */

export const PIXEL_ICONS: Record<string, readonly string[]> = {
  plus: ["........", "...X....", "...X....", ".XXXXX..", "...X....", "...X....", "........", "........"],
  close: ["........", ".X...X..", "..X.X...", "...X....", "..X.X...", ".X...X..", "........", "........"],
  more: ["........", "........", "........", ".X.X.X..", "........", "........", "........", "........"],
  // Points right; the chevron's class turns it down, up or left in whole quarter turns.
  chevron: ["........", "..X.....", "..XX....", "..XXX...", "..XX....", "..X.....", "........", "........"],
  folder: ["........", "XXX.....", "X..XXXX.", "X.....X.", "X.....X.", "XXXXXXX.", "........", "........"],
  "up-folder": ["..X.....", ".XX.....", "XXXXXX..", ".XX..X..", "..X..X..", ".....X..", "........", "........"],
  speaker: ["...X....", "..XX.X..", "XXXX..X.", "XXXX..X.", "..XX.X..", "...X....", "........", "........"],
  copy: ["XXXXX...", "X...X...", "X.XXXXX.", "X.X...X.", "XXX...X.", "..X...X.", "..XXXXX.", "........"],
  check: ["........", "......X.", ".....X..", "X...X...", ".X.X....", "..X.....", "........", "........"],
  update: ["...X....", "..XXX...", ".X.X.X..", "...X....", "...X....", ".XXXXX..", "........", "........"],
  settings: ["....X...", "XXXXXXX.", "....X...", "........", "..X.....", "XXXXXXX.", "..X.....", "........"],
  bell: ["...X....", "..X.X...", ".X...X..", ".X...X..", ".X...X..", "XXXXXXX.", "...X....", "........"],
  "bell-off": ["X..X....", ".XX.X...", ".XX..X..", ".X.X.X..", ".X..XX..", "XXXXXXX.", "...X..X.", "........"],
  stop: ["........", ".XXXXX..", ".XXXXX..", ".XXXXX..", ".XXXXX..", ".XXXXX..", "........", "........"],
  people: ["........", ".XX..XX.", ".XX..XX.", "........", "XXXX.XXX", "XXXX.XXX", "........", "........"],
  "person-plus": ["........", ".XX.....", ".XX...X.", ".....XXX", "XXXX..X.", "XXXX....", "........", "........"],
  branch: [".X......", ".X...X..", ".X...X..", ".X..X...", ".X.X....", ".XX.....", "XXX.....", "........"],
  globe: ["..XXX...", ".X.X.X..", "XXXXXXX.", "X..X..X.", "XXXXXXX.", ".X.X.X..", "..XXX...", "........"],
  image: ["XXXXXXX.", "X.....X.", "X.X...X.", "X...X.X.", "X..XXXX.", "XXXXXXX.", "........", "........"],
  note: ["XXXXX...", "X...XX..", "X.XX.XX.", "X.....X.", "X.XXX.X.", "XXXXXXX.", "........", "........"],
  monitor: ["XXXXXXX.", "X.....X.", "X.....X.", "X.....X.", "XXXXXXX.", "...X....", ".XXXXX..", "........"],
  grid: ["XXX.XXX.", "XXX.XXX.", "XXX.XXX.", "........", "XXX.XXX.", "XXX.XXX.", "XXX.XXX.", "........"],
  sun: ["...X....", ".X...X..", "..XXX...", "X.XXX.X.", "..XXX...", ".X...X..", "...X....", "........"],
  moon: ["...XX...", "..XX....", ".XX.....", ".XX.....", ".XX.....", "..XX..X.", "...XXX..", "........"],
  star: ["...X....", "..X.X...", "XXX.XXX.", ".X...X..", "..X.X...", ".X.X.X..", "XX...XX.", "........"],
  "star-filled": ["...X....", "...X....", "XXXXXXX.", ".XXXXX..", "..XXX...", ".XX.XX..", "XX...XX.", "........"],
  search: [".XXX....", "X...X...", "X...X...", "X...X...", ".XXXX...", "....XX..", ".....XX.", "........"],
  refresh: ["..XXX.X.", ".X...XX.", "X...XXX.", "X.......", "X.....X.", ".X...X..", "..XXX...", "........"],
  heart: ["........", ".XX.XX..", "XXXXXXX.", "XXXXXXX.", ".XXXXX..", "..XXX...", "...X....", "........"],
};

/**
 * Small marks, on the badges' 5 × 5 grid at 2× (10px): the same 2px stroke as the 8 × 8 icons, for slots too small
 * for 16px (a pill's chevron, a thumbnail's ×, a tag's branch) and for marks set in a line of text in place of a
 * typed character (the reply arrow, an arrow between names, a check, the disclosure triangle).
 */
export const PIXEL_GLYPHS: Record<string, readonly string[]> = {
  star: ["..X..", "XXXXX", ".XXX.", ".X.X.", "X...X"],
  // Points right; turned in whole quarter turns like the 8 × 8 chevron.
  chevron: [".X...", ".XX..", ".XXX.", ".XX..", ".X..."],
  close: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
  branch: [".X...", ".X..X", ".X.X.", ".XX..", ".X..."],
  // A typed "↩", "→", "↻", "✓" and "↓", drawn.
  reply: ["...X.", "...X.", ".X.X.", "XXXX.", ".X..."],
  arrow: ["..X..", "...X.", "XXXXX", "...X.", "..X.."],
  again: [".XXX.", "X...X", "X..XX", "X....", ".XXX."],
  check: ["....X", "...X.", "X.X..", ".X...", "....."],
  down: ["..X..", "..X..", "X.X.X", ".XXX.", "..X.."],
};

const paths = new Map<readonly string[], string>();

/** The grid as one SVG path of whole-pixel runs. */
export function pixelPath(grid: readonly string[]): string {
  const hit = paths.get(grid);
  if (hit) return hit;
  let d = "";
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "X") {
        x += 1;
        continue;
      }
      let run = 1;
      while (row[x + run] === "X") run += 1;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  });
  paths.set(grid, d);
  return d;
}

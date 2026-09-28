/**
 * The Astra look (Settings → Look → Astra): Astra's clubhouse, drawn at 480×320 with integer coordinates; CSS scales
 * the pixels. The scenery is Astra's (prototypes/astra-clubhouse/clubhouse.js); who sits where, whose screen is on and
 * what is pinned to the noticeboard come from the room (see AstraLook.tsx).
 */

export const CLUB_W = 480;
export const CLUB_H = 320;

export type Kind = "cat" | "fox" | "frog";

export interface Villager {
  colour: string;
  kind: Kind;
  /** Their desk's screen is on: a turn or its subagents are running. */
  working: boolean;
  /** Drawn faded: the member's thread was deleted in T3. */
  away: boolean;
}

/** Where a member sits (top-left of the character, 30×28) and what they sit at. */
export interface Spot {
  x: number;
  y: number;
  furniture: "desk-left" | "desk-right" | "armchair" | "cushion";
}

/** The two desks and the reading nook first, as Astra laid them out; then cushions on the rug and by the bookcase. */
export const SPOTS: Spot[] = [
  { x: 105, y: 155, furniture: "desk-left" },
  { x: 346, y: 155, furniture: "desk-right" },
  { x: 257, y: 208, furniture: "armchair" },
  { x: 178, y: 176, furniture: "cushion" },
  { x: 290, y: 150, furniture: "cushion" },
  { x: 112, y: 214, furniture: "cushion" },
];

export const PALETTE = ["#9eae94", "#cd9672", "#9eb56d", "#b7a3c9", "#d4b483", "#8fb3c2"];
export const KINDS: Kind[] = ["cat", "fox", "frog"];

type Ctx = CanvasRenderingContext2D;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w, h);
}

function box(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, border = "#77664e", size = 2) {
  rect(ctx, x, y, w, h, border);
  rect(ctx, x + size, y + size, w - size * 2, h - size * 2, fill);
}

function pixelText(ctx: Ctx, text: string, x: number, y: number, colour: string, size = 6) {
  ctx.fillStyle = colour;
  ctx.font = `${size}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

function plant(ctx: Ctx, x: number, y: number, size = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  rect(ctx, 4, 18, 13, 3, "#986647"); rect(ctx, 5, 21, 11, 10, "#c48d61"); rect(ctx, 7, 29, 7, 3, "#ac754b"); rect(ctx, 7, 22, 2, 6, "#dfaf7b");
  rect(ctx, 10, 3, 2, 16, "#4f6741"); rect(ctx, 0, 8, 9, 6, "#648452"); rect(ctx, 3, 12, 8, 4, "#577844"); rect(ctx, 12, 4, 9, 7, "#809e61"); rect(ctx, 13, 10, 5, 3, "#6f8b4e"); rect(ctx, 6, 0, 7, 6, "#78925a"); rect(ctx, 4, 1, 3, 3, "#92ac6a");
  ctx.restore();
}

function windowScene(ctx: Ctx, x: number, y: number, evening: boolean) {
  box(ctx, x - 3, y - 3, 55, 51, "#f3dbb0", "#b28c62");
  box(ctx, x, y, 49, 43, evening ? "#8292a0" : "#c5dbc4", "#eee4c5");
  rect(ctx, x + 2, y + 24, 45, 16, evening ? "#6e826f" : "#a5bd8b");
  rect(ctx, x + 6, y + 19, 7, 10, evening ? "#596f63" : "#829f71"); rect(ctx, x + 4, y + 23, 11, 8, evening ? "#596f63" : "#829f71");
  rect(ctx, x + 33, y + 16, 7, 16, evening ? "#677960" : "#90ad78"); rect(ctx, x + 30, y + 21, 13, 12, evening ? "#677960" : "#90ad78");
  rect(ctx, x + 10, y + 8, 14, 3, evening ? "#a9adad" : "#edf0d5"); rect(ctx, x + 14, y + 6, 7, 7, evening ? "#a9adad" : "#edf0d5");
  rect(ctx, x + 34, y + 6, 6, 6, evening ? "#f8e8bb" : "#f6ecb1");
  rect(ctx, x + 23, y, 3, 43, "#eee4c5"); rect(ctx, x, y + 21, 49, 3, "#eee4c5");
  rect(ctx, x - 6, y + 43, 61, 4, "#927452"); rect(ctx, x - 6, y + 43, 61, 1, "#efd0a0");
  rect(ctx, x - 7, y - 4, 6, 38, "#849172"); rect(ctx, x + 50, y - 4, 6, 38, "#849172"); rect(ctx, x - 5, y - 3, 2, 34, "#aab394"); rect(ctx, x + 51, y - 3, 2, 34, "#aab394");
}

function desk(ctx: Ctx, x: number, y: number, side: boolean, active: boolean) {
  rect(ctx, x + 3, y + 18, 70, 5, "#806c5060");
  rect(ctx, x + 6, y + 16, 5, 18, "#806142"); rect(ctx, x + 62, y + 16, 5, 18, "#806142");
  box(ctx, x, y, 74, 19, "#d4ad7b", "#916b47"); rect(ctx, x + 2, y + 2, 70, 2, "#edc994"); rect(ctx, x + 3, y + 17, 68, 3, "#b18256");
  box(ctx, x + 24, y - 17, 25, 20, "#454f48", "#55574b");
  rect(ctx, x + 26, y - 15, 21, 14, active ? "#aac8a1" : "#7e9588");
  rect(ctx, x + 29, y - 12, 10, 1, active ? "#537859" : "#62766a"); rect(ctx, x + 29, y - 9, 15, 1, active ? "#6c925e" : "#62766a"); rect(ctx, x + 29, y - 6, 7, 1, active ? "#537859" : "#62766a");
  rect(ctx, x + 34, y + 3, 5, 3, "#55594d"); rect(ctx, x + 30, y + 6, 13, 2, "#6b6c5a");
  box(ctx, x + 25, y + 10, 25, 5, "#eee1bc", "#b39e77", 1);
  for (let i = 0; i < 6; i++) rect(ctx, x + 27 + i * 3, y + 12, 1, 1, "#b2a581");
  rect(ctx, x + 10, y + 5, 6, 7, side ? "#dfb28d" : "#769274"); rect(ctx, x + 15, y + 6, 3, 4, side ? "#d29e74" : "#769274"); rect(ctx, x + 11, y + 5, 4, 2, "#73644d");
  rect(ctx, x + 57, y + 4, 9, 10, "#f0e2ba"); rect(ctx, x + 59, y + 7, 5, 1, "#b7ad89"); rect(ctx, x + 59, y + 10, 4, 1, "#b7ad89");
}

/** Astra's villager: a cat, a fox or a frog in the member's colour. */
export function character(ctx: Ctx, x: number, y: number, villager: Pick<Villager, "colour" | "kind">, seated = false) {
  const p = (dx: number, dy: number, w: number, h: number, colour: string) => rect(ctx, x + dx, y + dy, w, h, colour);
  const fur = villager.colour;
  const edge = villager.kind === "fox" ? "#85624b" : "#52644a";
  p(2, 25, 24, 3, "#555b452d");
  p(6, 17, 16, 9, edge); p(7, 18, 14, 7, villager.kind === "cat" ? "#708c83" : villager.kind === "fox" ? "#b58166" : "#a59e66");
  p(4, 19, 3, 5, fur); p(21, 19, 3, 5, fur); p(8, 25, 5, 3, edge); p(17, 25, 5, 3, edge);
  if (villager.kind !== "frog") {
    p(5, 1, 6, 7, edge); p(18, 1, 6, 7, edge); p(6, 2, 4, 6, fur); p(19, 2, 4, 6, fur); p(7, 3, 2, 3, "#dcae94"); p(20, 3, 2, 3, "#dcae94");
    p(4, 7, 21, 9, edge); p(6, 5, 17, 13, edge); p(5, 8, 19, 7, fur); p(7, 6, 15, 11, fur);
  } else {
    p(5, 3, 7, 8, edge); p(17, 3, 7, 8, edge); p(6, 4, 5, 7, fur); p(18, 4, 5, 7, fur);
    p(3, 9, 23, 7, edge); p(5, 8, 19, 10, edge); p(4, 10, 21, 5, fur); p(6, 9, 17, 8, fur);
  }
  p(9, 10, 2, 3, "#374437"); p(18, 10, 2, 3, "#374437");
  p(7, 14, 3, 2, "#d6ad91"); p(20, 14, 3, 2, "#d6ad91"); p(14, 13, 2, 2, "#6d6950");
  p(12, 16, 6, 1, "#e3d2a8"); p(12, 19, 5, 2, "#e7dac0");
  if (seated) {
    p(7, 24, 16, 3, "#8a6b4c"); p(8, 27, 3, 2, "#775c43"); p(20, 27, 3, 2, "#775c43");
  }
}

function shelf(ctx: Ctx, x: number, y: number) {
  rect(ctx, x + 2, y + 3, 43, 40, "#8b6c4c"); rect(ctx, x, y, 45, 41, "#b18b5f");
  rect(ctx, x + 3, y + 3, 39, 15, "#705b45"); rect(ctx, x + 3, y + 22, 39, 15, "#80684a");
  const colours = ["#889278", "#c69a7e", "#d7bd86", "#8d9c93", "#b4ad80", "#ab7862"];
  for (let i = 0; i < 6; i++) {
    rect(ctx, x + 5 + i * 5, y + 6 - (i % 3), 4, 12 + (i % 3), colours[i]!); rect(ctx, x + 6 + i * 5, y + 8, 2, 1, "#e0d0a3");
    rect(ctx, x + 8 + i * 5, y + 25, 4, 12, colours[5 - i]!);
  }
  rect(ctx, x, y + 18, 45, 3, "#cfaa78"); rect(ctx, x, y, 45, 2, "#d6b384"); rect(ctx, x, y + 38, 45, 3, "#d0a572");
}

/** A floor cushion for members past the two desks and the armchair, and a small laptop when they work. */
function cushion(ctx: Ctx, x: number, y: number, colour: string) {
  rect(ctx, x + 2, y + 24, 28, 6, "#806c5040");
  box(ctx, x + 1, y + 21, 28, 8, colour, "#8e855f", 1);
  rect(ctx, x + 3, y + 22, 24, 1, "#f1e6c6");
}

function laptop(ctx: Ctx, x: number, y: number, on: boolean) {
  box(ctx, x, y, 14, 9, on ? "#aac8a1" : "#7e9588", "#55574b", 1);
  rect(ctx, x - 1, y + 9, 16, 2, "#6b6c5a");
}

export interface ClubFrame {
  evening: boolean;
  villagers: Villager[];
  /** The noticeboard's cards, newest tasks last: true when that task is done. At most three are drawn. */
  pins: boolean[];
}

export function drawClubhouse(ctx: Ctx, frame: ClubFrame) {
  const { evening, villagers } = frame;
  const at = (i: number) => (i < villagers.length ? villagers[i]! : null);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  const grass = evening ? "#81957f" : "#bccb9e";
  rect(ctx, 0, 0, CLUB_W, CLUB_H, grass);
  // Deterministic texture, so scene updates never shuffle the environment.
  for (let i = 0; i < 135; i++) {
    const x = (i * 73 + 19) % 480;
    const y = (i * 47 + 11) % 320;
    rect(ctx, x, y, 2, 1, evening ? "#6f866c" : "#a4bb89");
    if (i % 4 === 0) {
      rect(ctx, x + 1, y - 2, 1, 3, evening ? "#788d70" : "#a1b982");
      rect(ctx, x + 3, y - 1, 1, 2, evening ? "#788d70" : "#a1b982");
    }
  }
  // Stepping stones and small garden flowers.
  for (const [x, y] of [[232, 285], [226, 301], [241, 315]] as const) {
    rect(ctx, x, y, 22, 7, "#a8b591"); rect(ctx, x + 2, y - 2, 18, 6, "#d8d8b7"); rect(ctx, x + 4, y - 2, 13, 1, "#eae3c0");
  }
  ([[35, 213], [440, 185], [80, 292], [398, 283], [27, 74], [429, 52]] as const).forEach(([x, y], i) => {
    rect(ctx, x, y, 1, 7, "#819457"); rect(ctx, x - 2, y - 1, 5, 3, i % 2 ? "#dfc984" : "#efe3bc"); rect(ctx, x, y - 2, 1, 5, "#edd59a");
  });
  // Floating cutaway footprint and wood floor.
  rect(ctx, 48, 267, 390, 13, "#5d6f4d30"); rect(ctx, 57, 279, 370, 4, "#5d6f4d20");
  box(ctx, 42, 99, 390, 174, "#b38b5c", "#766a4e", 3); rect(ctx, 48, 106, 378, 160, "#d3ae77");
  for (let row = 0; row < 11; row++) {
    const y = 109 + row * 14;
    rect(ctx, 49, y, 376, 1, "#b88e5b"); rect(ctx, 49, y + 1, 376, 1, "#dfbd88");
    for (let col = 0; col < 7; col++) {
      const x = 51 + col * 63 + (row % 2 ? 30 : 0);
      if (x < 424) {
        rect(ctx, x, y + 2, 1, 12, "#bc9562");
        rect(ctx, x + 9, y + 7, Math.min(16, 424 - x), 1, "#c8a16c");
      }
    }
  }
  // Rear and side walls.
  box(ctx, 42, 45, 390, 83, "#e2d9b3", "#8f8769", 3); rect(ctx, 46, 49, 382, 5, "#f1e6c6");
  for (let x = 50; x < 426; x += 16) {
    rect(ctx, x, 56, 1, 55, "#d7cda7"); rect(ctx, x + 7, 63, 2, 2, "#c9c8a1"); rect(ctx, x + 7, 87, 2, 2, "#c9c8a1");
  }
  rect(ctx, 45, 112, 384, 15, "#9fa585"); rect(ctx, 45, 111, 384, 3, "#b5b798"); rect(ctx, 45, 125, 384, 4, "#848866");
  for (let x = 50; x < 427; x += 13) rect(ctx, x, 115, 1, 10, "#939c7b");
  rect(ctx, 42, 46, 6, 220, "#9a9470"); rect(ctx, 42, 46, 3, 220, "#b4b28b"); rect(ctx, 426, 46, 6, 220, "#92916c"); rect(ctx, 426, 46, 3, 220, "#c2b993");
  windowScene(ctx, 79, 62, evening);
  windowScene(ctx, 323, 62, evening);
  // Central noticeboard with the room's latest tasks pinned: a green pin and a tick once done.
  box(ctx, 211, 65, 58, 44, "#b48b57", "#8e704a"); rect(ctx, 214, 68, 52, 37, "#c6a06c");
  const cards = [[218, 82, "#f0deb5"], [235, 85, "#dfe2be"], [252, 80, "#e7c6a3"]] as const;
  frame.pins.slice(-3).forEach((done, i) => {
    const [x, y, colour] = cards[i]!;
    rect(ctx, x, y, 12, 17, "#8d754f40"); rect(ctx, x - 1, y - 1, 12, 16, colour); rect(ctx, x + 4, y - 2, 2, 2, done ? "#688257" : "#b67350");
    rect(ctx, x + 1, y + 4, 7, 1, "#b4a782"); rect(ctx, x + 1, y + 7, 5, 1, "#b4a782");
    if (done) {
      rect(ctx, x + 2, y + 10, 2, 2, "#779164"); rect(ctx, x + 4, y + 8, 2, 4, "#779164");
    }
  });
  // Clock and plants on the back wall.
  box(ctx, 170, 63, 18, 18, "#eee2bd", "#9b8963"); rect(ctx, 173, 61, 12, 2, "#9b8963"); rect(ctx, 173, 81, 12, 2, "#9b8963"); rect(ctx, 178, 66, 1, 7, "#5d6552"); rect(ctx, 179, 72, 5, 1, "#5d6552");
  plant(ctx, 285, 80, 0.8); rect(ctx, 281, 106, 26, 3, "#a58256");
  // Woven rug, framed with pixels and a quiet diamond motif.
  rect(ctx, 173, 155, 145, 80, "#ac8d5e50"); rect(ctx, 170, 151, 145, 80, "#a4a986"); rect(ctx, 174, 155, 137, 72, "#c1c19a"); rect(ctx, 178, 159, 129, 64, "#aaae89");
  for (let x = 171; x < 315; x += 5) {
    rect(ctx, x, 149, 2, 2, "#c9c59e"); rect(ctx, x, 231, 2, 2, "#c9c59e");
  }
  for (let y = 163; y < 221; y += 5) rect(ctx, 180, y, 125, 1, "#b7b893");
  for (const [x, y] of [[191, 168], [290, 168], [191, 208], [290, 208]] as const) {
    rect(ctx, x, y, 3, 9, "#d4cfa8"); rect(ctx, x - 3, y + 3, 9, 3, "#d4cfa8");
  }
  const person = (i: number, seated: boolean) => {
    const villager = at(i);
    if (!villager) return;
    const spot = SPOTS[i]!;
    ctx.globalAlpha = villager.away ? 0.35 : 1;
    character(ctx, spot.x, spot.y, villager, seated);
    ctx.globalAlpha = 1;
  };
  // The two desks, their chairs and whoever sits there; an empty desk stays, dark.
  desk(ctx, 83, 142, false, Boolean(at(0)?.working));
  desk(ctx, 323, 142, true, Boolean(at(1)?.working));
  box(ctx, 106, 175, 27, 18, "#8a9a79", "#748267");
  box(ctx, 347, 175, 27, 18, "#b99371", "#907153");
  person(0, true);
  person(1, true);
  // Coffee table, notebook, tea, and a little flower.
  rect(ctx, 215, 185, 40, 5, "#7e705a40"); rect(ctx, 215, 187, 4, 10, "#997750"); rect(ctx, 249, 187, 4, 10, "#997750");
  box(ctx, 210, 170, 49, 20, "#d9b581", "#ad8858"); rect(ctx, 213, 172, 43, 2, "#edcd96");
  box(ctx, 219, 176, 16, 9, "#eee4be", "#b59b71", 1); rect(ctx, 226, 177, 1, 7, "#c7ba95"); rect(ctx, 221, 179, 3, 1, "#aaa88c");
  rect(ctx, 241, 177, 7, 7, "#e7dcc0"); rect(ctx, 242, 177, 5, 2, "#938261"); rect(ctx, 247, 179, 3, 3, "#e7dcc0");
  // The reading nook and side bookcase.
  shelf(ctx, 65, 207); plant(ctx, 60, 172, 0.85);
  box(ctx, 255, 211, 33, 19, "#b4a677", "#8e855f"); rect(ctx, 252, 218, 5, 17, "#b0a078"); rect(ctx, 287, 218, 5, 17, "#b0a078"); rect(ctx, 254, 232, 36, 3, "#8c7958");
  person(2, true);
  if (at(2)?.working) laptop(ctx, 265, 226, true);
  // Anyone past the first three, on cushions.
  for (let i = 3; i < Math.min(villagers.length, SPOTS.length); i++) {
    const spot = SPOTS[i]!;
    cushion(ctx, spot.x, spot.y, PALETTE[i % PALETTE.length]!);
    person(i, true);
    if (at(i)?.working) laptop(ctx, spot.x + 8, spot.y + 20, true);
  }
  // Side table, light, plant, and framed miniature.
  box(ctx, 362, 222, 40, 18, "#c49d6d", "#94734e"); rect(ctx, 366, 239, 4, 10, "#94734e"); rect(ctx, 394, 239, 4, 10, "#94734e"); plant(ctx, 373, 194, 0.8);
  rect(ctx, 391, 149, 3, 54, "#8f7c58"); rect(ctx, 382, 202, 21, 3, "#927e59"); rect(ctx, 383, 142, 18, 11, evening ? "#ffdb8a" : "#e5c996"); rect(ctx, 385, 138, 14, 5, "#f3ddb0"); rect(ctx, 381, 151, 22, 3, "#b39a67");
  if (evening) {
    rect(ctx, 375, 156, 35, 40, "#f6da7620"); rect(ctx, 379, 156, 27, 33, "#f6da7620");
  }
  // Framed print and a coat by the door.
  box(ctx, 147, 229, 18, 23, "#f0dfb0", "#89774f"); rect(ctx, 151, 237, 10, 10, "#a1ac74"); rect(ctx, 153, 235, 6, 6, "#98a56f"); rect(ctx, 155, 233, 3, 3, "#d9bf7d");
  rect(ctx, 325, 217, 3, 32, "#8a7758"); rect(ctx, 319, 247, 16, 3, "#8a7758"); rect(ctx, 318, 221, 18, 2, "#8a7758"); rect(ctx, 330, 223, 7, 15, "#8c9d85");
  // Open threshold and hand-lettered doormat.
  rect(ctx, 209, 263, 62, 8, "#b29468"); rect(ctx, 211, 263, 58, 2, "#dec395"); box(ctx, 215, 250, 50, 12, "#b49e6d", "#9f895c", 1); pixelText(ctx, "HELLO, FRIEND", 240, 258, "#695e46", 5);
  rect(ctx, 46, 266, 163, 7, "#a08053"); rect(ctx, 271, 266, 158, 7, "#a08053"); rect(ctx, 46, 266, 163, 2, "#d7b683"); rect(ctx, 271, 266, 158, 2, "#d7b683");
  if (evening) {
    rect(ctx, 46, 49, 381, 216, "#334b6225"); rect(ctx, 81, 105, 45, 24, "#dbdb8f12");
  }
}

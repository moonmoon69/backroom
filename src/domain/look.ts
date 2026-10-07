/**
 * A crew member's look in the pixel skin: the capybara's hat, fur, face, neckwear, outfit and accessory, each a part
 * chosen by name. A look is stored as named parts (never as a number), so adding a part or an option later changes no
 * one's existing look; a part a stored look lacks, or a name this version does not know, falls back to that part's
 * default, which is stable: seeded from the preset's (or the seat's) id and the part's name alone.
 *
 * Shared by the service (which stores the parts with the preset and fills in the defaults) and the UI (which draws them,
 * web/src/pixel/sprites.ts). One mark is not a part: the pocket square is always the harness's colour, so a look can
 * never lose the sign of what the member runs on. A crew member looks the same in every room and every view, as its
 * crew member (preset) is configured; nothing is added for a role (the Consigliere is marked by the star beside his name).
 */

export interface LookOption {
  /** The stored name; never renamed once shipped. */
  key: string;
  label: string;
  /** For colour parts: the colour drawn. "auto" parts draw the harness's colour. */
  colour?: string;
}

export interface LookPart {
  key: string;
  label: string;
  options: readonly LookOption[];
  /** The options a default is drawn from (all of them when absent); the first when `fixed`. */
  defaults?: readonly string[];
  fixed?: boolean;
}

/** Colours a tie, bow tie or hat band can take; "auto" is the harness's colour. */
const ACCENTS: readonly LookOption[] = [
  { key: "auto", label: "Harness colour" },
  { key: "red", label: "Red", colour: "#c23b3b" },
  { key: "gold", label: "Gold", colour: "#e0b040" },
  { key: "green", label: "Green", colour: "#3f9a52" },
  { key: "blue", label: "Blue", colour: "#3f6fd0" },
  { key: "purple", label: "Purple", colour: "#8a5ac8" },
  { key: "black", label: "Black", colour: "#15161a" },
  { key: "white", label: "White", colour: "#ece6d6" },
];

export const LOOK_PARTS: readonly LookPart[] = [
  {
    key: "hat",
    label: "Hat",
    options: [
      { key: "fedora", label: "Fedora" },
      { key: "bowler", label: "Bowler" },
      { key: "tophat", label: "Top hat" },
      { key: "cap", label: "Cap" },
      { key: "beret", label: "Beret" },
      { key: "boater", label: "Boater" },
      { key: "beanie", label: "Beanie" },
      { key: "none", label: "No hat" },
    ],
    defaults: ["fedora", "bowler", "tophat", "cap", "beret", "boater", "beanie"],
  },
  {
    key: "hatColour",
    label: "Hat colour",
    options: [
      { key: "charcoal", label: "Charcoal", colour: "#4a4f58" },
      { key: "brown", label: "Brown", colour: "#5a4636" },
      { key: "navy", label: "Navy", colour: "#33416e" },
      { key: "grey", label: "Grey", colour: "#6e7480" },
      { key: "black", label: "Black", colour: "#25262c" },
      { key: "plum", label: "Plum", colour: "#5a3f62" },
      { key: "red", label: "Red", colour: "#8c2f2f" },
      { key: "green", label: "Green", colour: "#3f5e3a" },
      { key: "straw", label: "Straw", colour: "#c9a35e" },
      { key: "cream", label: "Cream", colour: "#d8cba8" },
    ],
  },
  {
    key: "band",
    label: "Hat band",
    options: ACCENTS,
    fixed: true,
  },
  {
    key: "fur",
    label: "Fur",
    options: [
      { key: "sandy", label: "Sandy", colour: "#b98150" },
      { key: "brown", label: "Brown", colour: "#a06a3c" },
      { key: "golden", label: "Golden", colour: "#c9945e" },
      { key: "dark", label: "Dark", colour: "#7e5232" },
      { key: "grey", label: "Grey", colour: "#8f8478" },
      { key: "pale", label: "Pale", colour: "#d6ae80" },
    ],
  },
  {
    key: "eyes",
    label: "Eyes",
    options: [
      { key: "dots", label: "Dots" },
      { key: "wide", label: "Wide" },
      { key: "sleepy", label: "Sleepy" },
      { key: "wink", label: "Wink" },
    ],
    defaults: ["dots", "dots", "wide", "sleepy"],
  },
  {
    key: "glasses",
    label: "Glasses",
    options: [
      { key: "none", label: "None" },
      { key: "round", label: "Glasses" },
      { key: "monocle", label: "Monocle" },
      { key: "shades", label: "Dark sunglasses" },
    ],
    fixed: true,
  },
  {
    key: "brows",
    label: "Brows",
    options: [
      { key: "none", label: "None" },
      { key: "bushy", label: "Bushy" },
    ],
    fixed: true,
  },
  {
    key: "whiskers",
    label: "Whiskers",
    options: [
      { key: "none", label: "None" },
      { key: "whiskers", label: "Whiskers" },
      { key: "moustache", label: "Moustache" },
    ],
    fixed: true,
  },
  {
    key: "neckwear",
    label: "Neckwear",
    options: [
      { key: "tie", label: "Tie" },
      { key: "bowtie", label: "Bow tie" },
      { key: "none", label: "Open collar" },
    ],
    fixed: true,
  },
  {
    key: "neckwearColour",
    label: "Tie colour",
    options: ACCENTS,
    fixed: true,
  },
  {
    key: "outfit",
    label: "Outfit",
    options: [
      { key: "suit", label: "Suit" },
      { key: "vest", label: "Waistcoat" },
      { key: "turtleneck", label: "Turtleneck" },
    ],
    fixed: true,
  },
  {
    key: "outfitColour",
    label: "Outfit colour",
    options: [
      { key: "charcoal", label: "Charcoal", colour: "#33363d" },
      { key: "navy", label: "Navy", colour: "#2b3550" },
      { key: "brown", label: "Brown", colour: "#4a3a2c" },
      { key: "grey", label: "Grey", colour: "#6a6e78" },
      { key: "green", label: "Green", colour: "#2f4a3a" },
      { key: "burgundy", label: "Burgundy", colour: "#5a2a32" },
      { key: "cream", label: "Cream", colour: "#cfc6ae" },
      { key: "black", label: "Black", colour: "#1e1f24" },
    ],
    defaults: ["charcoal", "navy", "brown", "grey", "black"],
  },
  {
    key: "accessory",
    label: "Accessory",
    options: [
      { key: "none", label: "None" },
      { key: "cigar", label: "Cigar" },
      { key: "flower", label: "Lapel flower" },
    ],
    fixed: true,
  },
];

/** A look: part name → option name. Stored as given; read through resolveLook. */
export type Look = Record<string, string>;

/** A steady number in [0, 1) from an id and a salt (here, the part's name). */
export function lookSeed(id: string, salt: string): number {
  const key = `${salt}:${id}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** A part's default for this id: fixed parts take their first option, the rest a pick seeded by the id and the part. */
export function defaultPart(part: LookPart, id: string): string {
  if (part.fixed) return part.options[0]!.key;
  const pool = part.defaults ?? part.options.map((o) => o.key);
  return pool[Math.floor(lookSeed(id, part.key) * pool.length)]!;
}

/** Every part, named: the stored choice where it names a known option, else the part's stable default for `id`. */
export function resolveLook(id: string, stored: Look | null | undefined): Look {
  const look: Look = {};
  for (const part of LOOK_PARTS) {
    const chosen = stored?.[part.key];
    look[part.key] = chosen && part.options.some((o) => o.key === chosen) ? chosen : defaultPart(part, id);
  }
  return look;
}

/** A name as crew and seats share it: capitals and a seat's trailing number ("Opus2") aside. */
const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\d+$/, "");

/**
 * The look a seat (a room's member, a thread made from a crew member) or a crew member is drawn in: its crew member's,
 * the stored parts with that crew member's defaults, whichever room or view draws it. A seat that was not seated as a
 * crew member but bears one's name (added by hand, "Opus" or "Opus2") wears that crew member's look too; any other seat
 * has a look of its own from its own id. Every view draws through this, so one crew member is one drawing.
 */
export function seatLook(presets: readonly { id: string; name?: string; look?: Look | null }[], presetId: string | null | undefined, seed: string, name?: string): Look {
  const byName = !presetId && name ? presets.find((p) => p.name !== undefined && nameKey(p.name) === nameKey(name)) : undefined;
  const crew = presetId ?? byName?.id;
  if (crew) return resolveLook(crew, presets.find((p) => p.id === crew)?.look ?? null);
  return resolveLook(seed, null);
}

/** A random look for the picker's shuffle: every part, except that hat band and tie keep the harness's colour. */
export function shuffledLook(random: () => number = Math.random): Look {
  const look: Look = {};
  for (const part of LOOK_PARTS) {
    if (part.key === "band" || part.key === "neckwearColour") {
      look[part.key] = "auto";
      continue;
    }
    look[part.key] = part.options[Math.floor(random() * part.options.length)]!.key;
  }
  return look;
}

/** How many different looks the parts make: a hat's colour and band count only with a hat, a tie's colour only with a tie or bow tie. */
export function lookCount(): number {
  const count = (key: string) => LOOK_PARTS.find((p) => p.key === key)!.options.length;
  const hats = (count("hat") - 1) * count("hatColour") * count("band") + 1;
  const neck = (count("neckwear") - 1) * count("neckwearColour") + 1;
  let total = hats * neck;
  for (const part of LOOK_PARTS) if (!["hat", "hatColour", "band", "neckwear", "neckwearColour"].includes(part.key)) total *= part.options.length;
  return total;
}

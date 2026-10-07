import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * How Backroom is drawn. There is one UI, the overview (components/Overview.tsx), with what is opened from it in a
 * drawer over the page; the skin changes only how it is drawn. Plain is T3 Code's look; pixel is drawn like a SNES game
 * (pixel.css, MemberMark.tsx, pixel/): windows, wells and plates on a 2px unit, the crew as capybaras. Light and dark
 * (theme.ts) work in both. The pixel look comes in palettes: each is only a block of colour values in pixel.css.
 */
export type SkinChoice = "plain" | "pixel";

/** The pixel look's palettes, in the order Settings offers them; the first is the default. A palette is this entry plus its block of values in pixel.css. */
export const PALETTES = [
  { key: "slate", label: "Slate", hint: "Quiet slate by night, ivory by day" },
  { key: "blue", label: "Blue", hint: "Final Fantasy blue by night, paper on the day sky" },
] as const;
export type PaletteChoice = (typeof PALETTES)[number]["key"];

const KEY = "backroom.skin";
const PALETTE_KEY = "backroom.palette";
const SkinContext = createContext<[SkinChoice, (choice: SkinChoice) => void] | null>(null);
const PaletteContext = createContext<[PaletteChoice, (choice: PaletteChoice) => void] | null>(null);

export function readSkin(): SkinChoice {
  const stored = localStorage.getItem(KEY);
  // The Street look, and the room looks before it (Game, then Grok, Opus and Astra), are the pixel skin now; the
  // Desk and Overview looks, or nothing stored, the plain one.
  return stored === "pixel" || stored === "street" || stored === "game" || stored === "grok" || stored === "opus" || stored === "astra" ? "pixel" : "plain";
}

export function readPalette(): PaletteChoice {
  const stored = localStorage.getItem(PALETTE_KEY);
  return PALETTES.find((p) => p.key === stored)?.key ?? PALETTES[0].key;
}

export function applySkin(choice: SkinChoice): void {
  document.documentElement.setAttribute("data-skin", choice);
}

export function applyPalette(choice: PaletteChoice): void {
  document.documentElement.setAttribute("data-palette", choice);
}

export function SkinProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<SkinChoice>(() => readSkin());
  const [palette, setPalette] = useState<PaletteChoice>(() => readPalette());
  useEffect(() => applySkin(choice), [choice]);
  useEffect(() => applyPalette(palette), [palette]);
  const update = useCallback((next: SkinChoice) => {
    if (next === "plain") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    setChoice(next);
  }, []);
  const updatePalette = useCallback((next: PaletteChoice) => {
    if (next === PALETTES[0].key) localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, next);
    setPalette(next);
  }, []);
  return createElement(
    SkinContext.Provider,
    { value: [choice, update] },
    createElement(PaletteContext.Provider, { value: [palette, updatePalette] }, children),
  );
}

export function useSkin(): [SkinChoice, (choice: SkinChoice) => void] {
  const value = useContext(SkinContext);
  if (!value) throw new Error("useSkin must be used inside a SkinProvider");
  return value;
}

export function usePalette(): [PaletteChoice, (choice: PaletteChoice) => void] {
  const value = useContext(PaletteContext);
  if (!value) throw new Error("usePalette must be used inside a SkinProvider");
  return value;
}

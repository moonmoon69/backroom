import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Desk is the ordinary UI: sidebar, header, panels. Street replaces all of it with one block of Mulberry Street
 * (components/street/StreetMode.tsx). Overview opens on one page of every room and member (components/Overview.tsx)
 * and shows a room without the sidebar. Either way it is the same rooms and threads, and you can switch back and forth.
 */
export type SkinChoice = "desk" | "street" | "overview";

const KEY = "backroom.skin";
const SkinContext = createContext<[SkinChoice, (choice: SkinChoice) => void] | null>(null);

export function readSkin(): SkinChoice {
  const stored = localStorage.getItem(KEY);
  // The room looks that came before the street (Game, then Grok, Opus and Astra) open the street.
  if (stored === "overview") return "overview";
  return stored === "street" || stored === "game" || stored === "grok" || stored === "opus" || stored === "astra" ? "street" : "desk";
}

export function applySkin(choice: SkinChoice): void {
  const root = document.documentElement;
  if (choice === "desk") root.removeAttribute("data-skin");
  else root.setAttribute("data-skin", choice);
}

export function SkinProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<SkinChoice>(() => readSkin());
  useEffect(() => applySkin(choice), [choice]);
  const update = useCallback((next: SkinChoice) => {
    if (next === "desk") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    setChoice(next);
  }, []);
  return createElement(SkinContext.Provider, { value: [choice, update] }, children);
}

export function useSkin(): [SkinChoice, (choice: SkinChoice) => void] {
  const value = useContext(SkinContext);
  if (!value) throw new Error("useSkin must be used inside a SkinProvider");
  return value;
}

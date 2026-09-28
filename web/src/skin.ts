import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** Desk is the ordinary chat UI. Game is the pixel room: crew around a table, speech bubbles, dialogue box. */
export type SkinChoice = "desk" | "game";

const KEY = "backroom.skin";
const SkinContext = createContext<[SkinChoice, (choice: SkinChoice) => void] | null>(null);

export function readSkin(): SkinChoice {
  return localStorage.getItem(KEY) === "game" ? "game" : "desk";
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

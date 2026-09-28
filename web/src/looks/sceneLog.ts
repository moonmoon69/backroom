import { useEffect, useState } from "react";
import "./layout.css";

/** Grok's key, so "Hide log" carries over when you switch between the looks. */
const KEY = "backroom.gameDiary";

/**
 * Whether the room's conversation shows under a look's scene (the looks' Show log / Hide log), kept on this device.
 * While a scene is shown it sets data-game-diary on the root, which layout.css reads.
 */
export function useSceneLog(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) !== "min");
  useEffect(() => {
    document.documentElement.dataset.gameDiary = open ? "open" : "min";
    localStorage.setItem(KEY, open ? "open" : "min");
    return () => {
      delete document.documentElement.dataset.gameDiary;
    };
  }, [open]);
  return [open, setOpen];
}

/** Scroll the conversation to an event and make sure it shows. */
export function showInLog(sequence: number, openLog: (open: boolean) => void) {
  openLog(true);
  window.setTimeout(() => document.querySelector(`[data-sequence="${sequence}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
}

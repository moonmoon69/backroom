/**
 * Tells Backroom whether this page is in front of someone, the way T3's own window tells T3: on load, when it is shown,
 * hidden, focused or left, when it is used again after a pause, and every 25s while open. Backroom holds T3's client
 * lease for its pages, and T3 checks plan usage and its harnesses only while a client in view holds one.
 */
import { useEffect } from "react";
import { api } from "./api.ts";

const REPORT_MS = 25_000;
/** How long a click or key counts as recent use, as in T3 (a focused window counts anyway). */
const RECENT_MS = 45_000;

const pageId = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function usePresence(): void {
  useEffect(() => {
    let interactedAt: number | null = null;
    let beat: ReturnType<typeof setTimeout> | undefined;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const state = () => ({ pageId, visible: document.visibilityState === "visible", focused: document.hasFocus(), interactedAt });
    const report = () => {
      clearTimeout(soon);
      clearTimeout(beat);
      void api.presence(state()).catch(() => {});
      beat = setTimeout(report, REPORT_MS);
    };
    // Focus and visibility often change together; one report covers both.
    const changed = () => {
      clearTimeout(soon);
      soon = setTimeout(report, 250);
    };
    const used = () => {
      const now = Date.now();
      const lapsed = interactedAt === null || now - interactedAt > RECENT_MS;
      interactedAt = now;
      if (lapsed) changed();
    };
    // Closing the tab: say so, so the lease does not outlive it.
    const gone = () => navigator.sendBeacon?.("/api/t3/presence", new Blob([JSON.stringify({ pageId, closed: true })], { type: "application/json" }));
    const passive = { passive: true } as const;
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("focus", changed);
    window.addEventListener("blur", changed);
    window.addEventListener("pointerdown", used, passive);
    window.addEventListener("keydown", used, passive);
    window.addEventListener("wheel", used, passive);
    window.addEventListener("pagehide", gone);
    report();
    return () => {
      clearTimeout(soon);
      clearTimeout(beat);
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
      window.removeEventListener("pointerdown", used);
      window.removeEventListener("keydown", used);
      window.removeEventListener("wheel", used);
      window.removeEventListener("pagehide", gone);
    };
  }, []);
}

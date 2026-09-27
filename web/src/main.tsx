import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { contextReadout, fmtTokens } from "./components/deskFormat.ts";
import { applyTheme, readTheme } from "./theme.ts";
import { installViewportFit } from "./viewportFit.ts";
import "./styles.css";

// Settings kept in this browser under the old name are carried over once.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith("t3rooms.") && localStorage.getItem(`backroom.${key.slice("t3rooms.".length)}`) === null) {
    localStorage.setItem(`backroom.${key.slice("t3rooms.".length)}`, localStorage.getItem(key) ?? "");
  }
}

applyTheme(readTheme());
installViewportFit();

// Installable app: the service worker keeps the shell available offline and never touches /api.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Not fatal: the app works without it.
    });
  });
}

// Formatting helpers reachable from the console for quick checks (no app behaviour depends on this).
(window as unknown as { __backroom?: unknown }).__backroom = { fmtTokens, contextReadout };

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

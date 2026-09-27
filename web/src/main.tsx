import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { contextReadout, fmtTokens } from "./components/deskFormat.ts";
import { applyTheme, readTheme } from "./theme.ts";
import { installViewportFit } from "./viewportFit.ts";
import "./styles.css";

applyTheme(readTheme());
installViewportFit();

// Installable app: the service worker keeps the shell available offline, never touches /api, and shows the
// notifications of finished work (see news.ts).
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

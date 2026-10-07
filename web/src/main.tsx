import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { contextReadout, fmtTokens } from "./components/deskFormat.ts";
import { SkinProvider, applyPalette, applySkin, readPalette, readSkin } from "./skin.ts";
import { applyTheme, readTheme } from "./theme.ts";
import { installViewportFit } from "./viewportFit.ts";
import { installDevicePixels } from "./devicePixels.ts";
import "./styles.css";
import "./pixel.css";

applyTheme(readTheme());
applySkin(readSkin());
applyPalette(readPalette());
installViewportFit();
installDevicePixels();

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
    <ErrorBoundary header={null} onReset={() => {}} recovery={{ message: "Backroom could not display this page.", action: "Try again" }}>
      {/* Toasts render skin-aware icons too, so their provider must be inside the skin context. */}
      <SkinProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </SkinProvider>
    </ErrorBoundary>
  </StrictMode>,
);

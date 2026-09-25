import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { contextReadout, fmtTokens } from "./components/deskFormat.ts";
import { applyTheme, readTheme } from "./theme.ts";
import "./styles.css";

applyTheme(readTheme());

// Formatting helpers reachable from the console for quick checks (no app behaviour depends on this).
(window as unknown as { __t3rooms?: unknown }).__t3rooms = { fmtTokens, contextReadout };

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

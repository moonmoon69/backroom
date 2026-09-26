import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ThemeChoice } from "../theme.ts";
import type { StatusResponse } from "../types.ts";
import { ConnectionChip } from "./StatusStrip.tsx";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons.tsx";

const THEMES: Array<{ key: ThemeChoice; label: string; icon: ReactNode }> = [
  { key: "system", label: "System", icon: <MonitorIcon /> },
  { key: "light", label: "Light", icon: <SunIcon /> },
  { key: "dark", label: "Dark", icon: <MoonIcon /> },
];

/** App-wide controls at the foot of the sidebar: roles, the T3 connection, and the theme. */
export function AppControls({
  status,
  onOpenConnection,
  onOpenLibrary,
  rolesDisabled,
  theme,
  onTheme,
}: {
  status: StatusResponse | null;
  onOpenConnection: () => void;
  onOpenLibrary: () => void;
  rolesDisabled: boolean;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}) {
  return (
    <span className="app-controls">
      <button type="button" className="small ghost" onClick={onOpenLibrary} disabled={rolesDisabled} title="Roles: named sets of rules assigned to participants">
        Roles
      </button>
      <ConnectionChip status={status} onOpen={onOpenConnection} />
      <ThemeMenu theme={theme} onTheme={onTheme} />
    </span>
  );
}

function ThemeMenu({ theme, onTheme }: { theme: ThemeChoice; onTheme: (choice: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = THEMES.find((t) => t.key === theme) ?? THEMES[0]!;
  return (
    <span className="theme-menu" ref={wrapper}>
      <button
        type="button"
        className="small ghost icon-only"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
        title={`Theme: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        {current.icon}
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Theme">
          {THEMES.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={theme === option.key}
              className={theme === option.key ? "on" : ""}
              onClick={() => {
                onTheme(option.key);
                setOpen(false);
              }}
            >
              <span className="theme-icon" aria-hidden="true">
                {option.icon}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

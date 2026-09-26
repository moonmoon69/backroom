/**
 * The UI's icons: 16px line drawings with one stroke width, so every control reads the same whichever font the
 * browser has. Icon-only buttons carry an aria-label and a title (the hover name); icons themselves are hidden from
 * screen readers.
 */
import type { ReactNode } from "react";

function Icon({ children, className, strokeWidth = 1.3 }: { children: ReactNode; className?: string; strokeWidth?: number }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = () => (
  <Icon strokeWidth={1.5}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon strokeWidth={1.5}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon strokeWidth={1.5}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);

/** A chevron pointing right, down (an open disclosure, a dropdown) or up (an open dropdown). */
export const ChevronIcon = ({ dir = "right" }: { dir?: "right" | "down" | "up" }) => (
  <Icon className={`chevron chevron-${dir}`} strokeWidth={1.5}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);

/** A window with a side pane: hides and shows the sidebar. */
export const SidebarIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M6.25 3v10" />
  </Icon>
);

/** Two people: the members of a room. */
export const PeopleIcon = () => (
  <Icon>
    <circle cx="6" cy="5.25" r="2.25" />
    <path d="M1.75 13.25c0-2.4 1.9-4.25 4.25-4.25s4.25 1.85 4.25 4.25" />
    <path d="M10.25 3.1a2.25 2.25 0 0 1 0 4.3" />
    <path d="M11.9 9.35c1.45.55 2.35 2 2.35 3.9" />
  </Icon>
);

/** A person with a plus: seat a participant. */
export const PersonPlusIcon = () => (
  <Icon>
    <circle cx="6.25" cy="5.25" r="2.25" />
    <path d="M2 13.25c0-2.4 1.9-4.25 4.25-4.25 1.35 0 2.55.6 3.3 1.55" />
    <path d="M12.25 9.5v4M10.25 11.5h4" />
  </Icon>
);

/** A checklist: the room's tasks. */
export const TasksIcon = () => (
  <Icon>
    <path d="M1.9 3.9 3.2 5.2 5.5 2.8" />
    <path d="M1.9 9.4 3.2 10.7 5.5 8.3" />
    <path d="M7.75 4h6.5M7.75 9.5h6.5M7.75 13.5h6.5" />
  </Icon>
);

/** A branch leaving a line: the room's git (branches, worktrees, commits, uncommitted changes). */
export const BranchIcon = () => (
  <Icon>
    <path d="M4.5 2v7.75" />
    <circle cx="4.5" cy="12" r="2" />
    <circle cx="11.5" cy="4.5" r="2" />
    <path d="M11.5 6.5c0 3.1-2.5 5.25-5 5.5" />
  </Icon>
);

export const GlobeGlyph = () => (
  <Icon>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5" />
    <path d="M8 1.75c1.7 1.75 2.55 3.85 2.55 6.25S9.7 12.5 8 14.25C6.3 12.5 5.45 10.4 5.45 8S6.3 3.5 8 1.75z" />
  </Icon>
);

/** A picture: attach an image. */
export const ImageIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
    <circle cx="5.5" cy="6.25" r="1.1" />
    <path d="M14.25 10.5 10.5 7l-6.75 6.25" />
  </Icon>
);

/** A note with a folded corner: a room note (shared context, no task). */
export const NoteIcon = () => (
  <Icon>
    <path d="M2.75 3.25c0-.55.45-1 1-1h8.5c.55 0 1 .45 1 1v6.5l-4 4h-5.5c-.55 0-1-.45-1-1z" />
    <path d="M13.25 9.75h-3c-.55 0-1 .45-1 1v3" />
    <path d="M5.25 5.5h5.5M5.25 8h3.5" />
  </Icon>
);

export const MonitorIcon = () => (
  <Icon>
    <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
    <path d="M5.5 13.75h5M8 11v2.75" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M3.4 12.6l1.05-1.05M11.55 4.45l1.05-1.05" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z" />
  </Icon>
);

/**
 * The UI's icons: 16px line drawings with one stroke width, so every control reads the same whichever font the
 * browser has. Icon-only buttons carry an aria-label and a title (the hover name); icons themselves are hidden from
 * screen readers.
 */
import type { ReactNode } from "react";
import { PIXEL_GLYPHS, PIXEL_ICONS, pixelPath } from "../pixel/icons.ts";
import { useSkin } from "../skin.ts";

/**
 * In the pixel look, the icon's 8 × 8 grid (pixel/icons.ts) at 2×, or with `small` its 5 × 5 glyph at 2× (10px) where it
 * has one; otherwise, or without a grid, the line drawing.
 */
function Icon({ name, children, className, strokeWidth = 1.3, small = false }: { name: string; children: ReactNode; className?: string; strokeWidth?: number; small?: boolean }) {
  const [skin] = useSkin();
  const glyph = skin === "pixel" && small ? PIXEL_GLYPHS[name] : undefined;
  if (glyph) return <PixelGlyph grid={glyph} className={className} />;
  const grid = skin === "pixel" ? PIXEL_ICONS[name] : undefined;
  if (grid) return <PixelIcon16 grid={grid} className={className} />;
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

function PixelIcon16({ grid, className }: { grid: readonly string[]; className?: string | undefined }) {
  return (
    <svg className={`icon icon-pixel${className ? ` ${className}` : ""}`} width="16" height="16" viewBox="0 0 8 8" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d={pixelPath(grid)} />
    </svg>
  );
}

function PixelGlyph({ grid, className }: { grid: readonly string[]; className?: string | undefined }) {
  return (
    <svg className={`icon icon-pixel icon-glyph${className ? ` ${className}` : ""}`} width="10" height="10" viewBox="0 0 5 5" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d={pixelPath(grid)} />
    </svg>
  );
}

/**
 * A mark set in a line of text: the typed character (↩ → ↻ ✓ ↓), or in the pixel look its 5 × 5 glyph, so it is drawn
 * like every other mark and not by the font.
 */
export function Glyph({ name, text, className }: { name: "reply" | "arrow" | "again" | "check" | "down"; text: string; className?: string }) {
  const [skin] = useSkin();
  const grid = skin === "pixel" ? PIXEL_GLYPHS[name] : undefined;
  if (!grid) return <span className={className} aria-hidden="true">{text}</span>;
  return <PixelGlyph grid={grid} className={`glyph-inline${className ? ` ${className}` : ""}`} />;
}

export const PlusIcon = () => (
  <Icon name="plus" strokeWidth={1.5}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const CloseIcon = ({ small = false }: { small?: boolean }) => (
  <Icon name="close" strokeWidth={1.5} small={small}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon name="more">
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Icon>
);

/** A folder: one entry of the New project dialog's folder list. */
export const FolderIcon = () => (
  <Icon name="folder" strokeWidth={1.25}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" />
  </Icon>
);

/** A turned arrow: up one folder. */
export const UpFolderIcon = () => (
  <Icon name="up-folder" strokeWidth={1.25}>
    <path d="M13 12V8.5A2.5 2.5 0 0 0 10.5 6H3.5" />
    <path d="M6.5 3 3.5 6l3 3" />
  </Icon>
);

/** A loudspeaker: read aloud. */
export const SpeakerIcon = () => (
  <Icon name="speaker" strokeWidth={1.25}>
    <path d="M2.5 6.25h2.6L8.5 3.5v9L5.1 9.75H2.5z" />
    <path d="M10.75 5.75a3.2 3.2 0 0 1 0 4.5M12.6 4a5.75 5.75 0 0 1 0 8" />
  </Icon>
);

/** Two overlapping sheets: copy. */
export const CopyIcon = () => (
  <Icon name="copy" strokeWidth={1.25}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </Icon>
);

/** A tick: done (copied). */
export const CheckIcon = () => (
  <Icon name="check" strokeWidth={1.5}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Icon>
);

/** An arrow rising in a circle: updates. */
export const UpdateIcon = () => (
  <Icon name="update" strokeWidth={1.25}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 10.75v-5.5M5.75 7.5 8 5.25l2.25 2.25" />
  </Icon>
);

/** Two sliders: settings. */
export const SettingsIcon = () => (
  <Icon name="settings" strokeWidth={1.25}>
    <path d="M2.5 5h6.5M12.5 5h1M2.5 11h1M7 11h6.5" />
    <circle cx="10.75" cy="5" r="1.6" />
    <circle cx="5.25" cy="11" r="1.6" />
  </Icon>
);

/** A bell: notifications; struck through while they are off. */
export const BellIcon = ({ off = false }: { off?: boolean }) => (
  <Icon name={off ? "bell-off" : "bell"} strokeWidth={1.25}>
    <path d="M4 11.5V7.25a4 4 0 0 1 8 0v4.25l1 1H3z" />
    <path d="M6.75 14a1.35 1.35 0 0 0 2.5 0" />
    {off ? <path d="M2.5 2.5l11 11" /> : null}
  </Icon>
);

/** A square: stop. */
export const StopIcon = () => (
  <Icon name="stop" strokeWidth={1.25}>
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </Icon>
);

/** A chevron pointing right, down (an open disclosure, a dropdown) or up (an open dropdown). */
export const ChevronIcon = ({ dir = "right", small = false }: { dir?: "right" | "down" | "up" | "left"; small?: boolean }) => (
  <Icon name="chevron" className={`chevron chevron-${dir}`} strokeWidth={1.5} small={small}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);

/** Two people: the members of a room. */
export const PeopleIcon = () => (
  <Icon name="people">
    <circle cx="6" cy="5.25" r="2.25" />
    <path d="M1.75 13.25c0-2.4 1.9-4.25 4.25-4.25s4.25 1.85 4.25 4.25" />
    <path d="M10.25 3.1a2.25 2.25 0 0 1 0 4.3" />
    <path d="M11.9 9.35c1.45.55 2.35 2 2.35 3.9" />
  </Icon>
);

/** A person with a plus: seat a participant. */
export const PersonPlusIcon = () => (
  <Icon name="person-plus">
    <circle cx="6.25" cy="5.25" r="2.25" />
    <path d="M2 13.25c0-2.4 1.9-4.25 4.25-4.25 1.35 0 2.55.6 3.3 1.55" />
    <path d="M12.25 9.5v4M10.25 11.5h4" />
  </Icon>
);

/** A branch leaving a line: the room's git (branches, worktrees, commits, uncommitted changes). */
export const BranchIcon = ({ small = false }: { small?: boolean }) => (
  <Icon name="branch" small={small}>
    <path d="M4.5 2v7.75" />
    <circle cx="4.5" cy="12" r="2" />
    <circle cx="11.5" cy="4.5" r="2" />
    <path d="M11.5 6.5c0 3.1-2.5 5.25-5 5.5" />
  </Icon>
);

export const GlobeGlyph = () => (
  <Icon name="globe">
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5" />
    <path d="M8 1.75c1.7 1.75 2.55 3.85 2.55 6.25S9.7 12.5 8 14.25C6.3 12.5 5.45 10.4 5.45 8S6.3 3.5 8 1.75z" />
  </Icon>
);

/** A picture: attach an image. */
export const ImageIcon = () => (
  <Icon name="image">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
    <circle cx="5.5" cy="6.25" r="1.1" />
    <path d="M14.25 10.5 10.5 7l-6.75 6.25" />
  </Icon>
);

/** A note with a folded corner: a room note (shared context, no request). */
export const NoteIcon = () => (
  <Icon name="note">
    <path d="M2.75 3.25c0-.55.45-1 1-1h8.5c.55 0 1 .45 1 1v6.5l-4 4h-5.5c-.55 0-1-.45-1-1z" />
    <path d="M13.25 9.75h-3c-.55 0-1 .45-1 1v3" />
    <path d="M5.25 5.5h5.5M5.25 8h3.5" />
  </Icon>
);

export const MonitorIcon = () => (
  <Icon name="monitor">
    <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
    <path d="M5.5 13.75h5M8 11v2.75" />
  </Icon>
);

/** Four tiles: the plain look. */
export const GridIcon = () => {
  const [skin] = useSkin();
  if (skin === "pixel") return <PixelIcon16 grid={PIXEL_ICONS.grid!} />;
  return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
  );
};

/** A heart in whole pixels: the pixel look. In that look it is drawn on the icons' 8 × 8 grid like the rest. */
export const PixelIcon = () => {
  const [skin] = useSkin();
  if (skin === "pixel") return <PixelIcon16 grid={PIXEL_ICONS.heart!} />;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M3 3h3v1h1v1h2V4h1V3h3v1h1v4h-1v1h-1v1h-1v1h-1v1H9v1H7v-1H6v-1H5v-1H4V9H3V8H2V4h1Z" />
    </svg>
  );
};

export const SunIcon = () => (
  <Icon name="sun">
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M3.4 12.6l1.05-1.05M11.55 4.45l1.05-1.05" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon name="moon">
    <path d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z" />
  </Icon>
);

export const StarIcon = ({ filled = false }: { filled?: boolean }) => {
  const [skin] = useSkin();
  if (skin === "pixel") return <PixelIcon16 grid={PIXEL_ICONS[filled ? "star-filled" : "star"]!} />;
  return (
  <svg className="icon" width="16" height="16" viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" aria-hidden="true">
    <path d="M8 1.9l1.85 3.76 4.15.6-3 2.93.7 4.13L8 11.37l-3.7 1.95.7-4.13-3-2.93 4.15-.6z" />
  </svg>
  );
};

/**
 * The Consigliere's star beside a name: in the pixel look the badges' 5 × 5 glyph at 10px, its edges on whole device
 * pixels wherever the name puts it; otherwise the filled line star.
 */
export const StarMark = () => {
  const [skin] = useSkin();
  if (skin !== "pixel") return <StarIcon filled />;
  return <PixelGlyph grid={PIXEL_GLYPHS.star!} />;
};

export const SearchIcon = () => (
  <Icon name="search">
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 13.5 13.5" />
  </Icon>
);

/** A circular arrow: check again. */
export const RefreshIcon = () => (
  <Icon name="refresh">
    <path d="M12.9 6.4A5.2 5.2 0 1 0 13 9.5" />
    <path d="M13.2 3.2v3.3H9.9" />
  </Icon>
);

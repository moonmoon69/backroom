import type { CSSProperties } from "react";
import { useRoom } from "../context.tsx";
import type { Participant } from "../types.ts";

/** Stable identity hues, assigned by roster index: T3's project-monogram palette (Tailwind 400 shades). */
export const PARTICIPANT_PALETTE = [
  "oklch(70.7% 0.165 254.624)", // blue-400
  "oklch(75% 0.183 55.934)", // orange-400
  "oklch(79.2% 0.209 151.711)", // green-400
  "oklch(71.8% 0.202 349.761)", // pink-400
  "oklch(82.8% 0.189 84.429)", // amber-400
  "oklch(77.7% 0.152 181.912)", // teal-400
  "oklch(70.2% 0.183 293.541)", // violet-400
  "oklch(70.4% 0.191 22.216)", // red-400
];

export const participantColor = (index: number): string =>
  PARTICIPANT_PALETTE[((index % PARTICIPANT_PALETTE.length) + PARTICIPANT_PALETTE.length) % PARTICIPANT_PALETTE.length] as string;

/** Two-letter monogram: "sol2" -> "S2", "claude" -> "CL", "a" -> "A". */
export function monogramOf(alias: string): string {
  const clean = alias.replace(/[^a-z0-9]/gi, "");
  if (clean.length === 0) return "??";
  const digits = clean.match(/\d+$/);
  if (digits && clean.length > digits[0].length) return `${clean[0]}${digits[0].slice(-1)}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Serif monogram for room titles: first letters of the first two words. */
export function titleMonogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

export const identityStyle = (color: string): CSSProperties => ({ "--pc": color } as CSSProperties);

interface MonogramProps {
  participant: Pick<Participant, "id" | "alias">;
  size?: "xs" | "sm" | "md";
  /** Status tone for the ring (crew strip only). */
  ring?: string;
  pulse?: boolean;
}

/** Rounded-square avatar tinted with the participant's hue. */
export function Monogram({ participant, size = "sm", ring, pulse }: MonogramProps) {
  const { colorOf } = useRoom();
  const color = colorOf(participant.id);
  return (
    <span
      className={`avatar avatar-${size}${ring ? ` ring ring-${ring}` : ""}${pulse ? " pulse" : ""}`}
      style={identityStyle(color)}
      aria-hidden="true"
    >
      {monogramOf(participant.alias)}
    </span>
  );
}

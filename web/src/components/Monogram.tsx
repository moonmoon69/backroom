import type { CSSProperties } from "react";
import { useRoom } from "../context.tsx";
import type { Participant } from "../types.ts";
import { MemberMark } from "./MemberMark.tsx";

/**
 * Members share one quiet accent (the bars and tints that mark whose a row is); their harness's logo and their name
 * tell them apart, as in the overview's crew list. Names themselves are in the text colour.
 */
export const MEMBER_ACCENT = "var(--fg-muted)";

/** Two-letter monogram: "sol2" -> "S2", "claude" -> "CL", "a" -> "A". */
export function monogramOf(alias: string): string {
  const clean = alias.replace(/[^a-z0-9]/gi, "");
  if (clean.length === 0) return "??";
  const digits = clean.match(/\d+$/);
  if (digits && clean.length > digits[0].length) return `${clean[0]}${digits[0].slice(-1)}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export const identityStyle = (color: string): CSSProperties => ({ "--pc": color } as CSSProperties);

interface MonogramProps {
  participant: Pick<Participant, "id" | "alias"> & { modelSelection?: Participant["modelSelection"] };
  size?: "xs" | "sm" | "md";
  /** A tooltip: the member's name where the mark stands without it. */
  title?: string;
}

const LOGO_SIZE = { xs: 14, sm: 16, md: 16 } as const;

/**
 * A member's mark (MemberMark.tsx: the harness's logo, or the pixel look's capybara), bare, as the overview's crew
 * list shows it. Its status is said in words beside it. The alias's letters only when the member is not known here.
 */
export function Monogram({ participant, size = "sm", title }: MonogramProps) {
  const { participantById } = useRoom();
  const seated = participantById(participant.id);
  const selection = participant.modelSelection ?? seated?.modelSelection;
  return (
    <span className={`avatar avatar-${size}`} aria-hidden="true" title={title}>
      {selection ? (
        <MemberMark seed={participant.id} selection={selection} size={LOGO_SIZE[size]} presetId={seated?.presetId} name={participant.alias} />
      ) : (
        monogramOf(participant.alias)
      )}
    </span>
  );
}

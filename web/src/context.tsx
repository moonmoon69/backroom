import { createContext, useContext } from "react";
import type { CommandResult, DeskResponse, EngineSeatView, GitResponse, Participant, RoomCommand, RoomCosts, RoomSnapshot } from "./types.ts";

export interface RoomContextValue {
  snapshot: RoomSnapshot;
  /** Post a command; returns null when the server rejected it (a toast has been shown). */
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  refetch: () => void;
  participantById: (id: string) => Participant | undefined;
  aliasOf: (id: string) => string;
  /** The accent that marks a participant's rows: one quiet colour for everyone (MEMBER_ACCENT); logos tell them apart. */
  colorOf: (id: string) => string;
  /** A journal seat (a member's binding, current or past) and the member it is. */
  seatOf: (seatId: string) => { seat: EngineSeatView | undefined; participant: Participant | undefined };
  /** A journal principal as the page names it: "you" for the user, "Backroom" for the system, "@alias" for a seat. */
  nameOf: (principal: string) => string;
  /** Latest room desk (T3 thread views per participant), or null before the first fetch. */
  desk: DeskResponse | null;
  deskError: string | null;
  /** What the room's threads have used and its list-price value, per participant and per reply; null before the first read. */
  costs: RoomCosts | null;
  /** The room's git state: its working folders in brief, and the full view of the one the Git tab shows. */
  git: GitState;
}

export interface GitState {
  data: GitResponse | null;
  error: string | null;
  /** The folder the Git tab shows; null for the first of the room's folders. */
  path: string | null;
  setPath: (path: string | null) => void;
  /** How many commits the Git tab lists. */
  commits: number;
  showMoreCommits: () => void;
}

export const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) throw new Error("useRoom must be used inside a RoomContext provider");
  return value;
}

/** The seat → member lookups of a room snapshot: a seat is a binding, so a member's every seat maps to it. */
export function seatLookups(snapshot: RoomSnapshot, participantById: (id: string) => Participant | undefined): Pick<RoomContextValue, "seatOf" | "nameOf"> {
  const seats = new Map(snapshot.seats.map((seat) => [seat.seatId, seat]));
  const memberOfBinding = new Map(snapshot.bindings.map((binding) => [binding.id, binding.participantId]));
  const seatOf = (seatId: string) => {
    const seat = seats.get(seatId);
    const participantId = seat?.participantId ?? memberOfBinding.get(seatId) ?? null;
    return { seat, participant: participantId ? participantById(participantId) : undefined };
  };
  const nameOf = (principal: string): string => {
    if (principal === "$user") return "you";
    if (principal === "$system") return "Backroom";
    const { seat, participant } = seatOf(principal);
    const alias = participant?.alias ?? seat?.alias;
    return alias ? `@${alias}` : "a former seat";
  };
  return { seatOf, nameOf };
}

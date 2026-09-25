import { createContext, useContext } from "react";
import type { CommandResult, DeskResponse, Participant, PrerequisiteRef, RoomCommand, RoomSnapshot } from "./types.ts";

export interface FollowUpPrefill {
  /** Prerequisite task revisions preselected as after_all. */
  prerequisites: Array<PrerequisiteRef & { label: string }>;
  /** Monotonic token so the composer can detect a new prefill even with the same content. */
  nonce: number;
}

export interface RoomContextValue {
  snapshot: RoomSnapshot;
  /** Post a command; returns null when the server rejected it (a toast has been shown). */
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  refetch: () => void;
  participantById: (id: string) => Participant | undefined;
  aliasOf: (id: string) => string;
  /** Stable identity colour for a participant (by roster index). */
  colorOf: (id: string) => string;
  /** Prefill the composer with an after_all schedule on the given task revisions. */
  addFollowUp: (prerequisites: FollowUpPrefill["prerequisites"]) => void;
  /** Latest room desk (T3 thread views per participant), or null before the first fetch. */
  desk: DeskResponse | null;
  deskError: string | null;
}

export const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) throw new Error("useRoom must be used inside a RoomContext provider");
  return value;
}

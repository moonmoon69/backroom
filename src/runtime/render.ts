/**
 * The message T3 receives for a reserved run: L2's briefing rendered from the run's frozen envelope
 * (src/briefing/envelope.ts, as its interface note says). The host renders once, before the first send, and freezes
 * the text, the image references and the standing record in the journal (the run's `sending` phase); a resend sends
 * the same bytes. What only the app knows (the room, the member, a post's images) comes through `BriefingSource`.
 */
import type { T3ThreadDetail, TurnImage } from "../adapter/types.ts";
import type { StandingInput } from "../briefing/assemble.ts";
import { journalDirectory, relatedContext, renderEnvelopeBriefing, standingLost, type SeatStanding } from "../briefing/envelope.ts";
import type { Envelope, Projection } from "../engine/index.ts";
import { runRecords } from "./work.ts";

/** What the host needs from the app to brief a seat: rooms.sqlite's room and member, and the images posts came with. */
export interface BriefingSource {
  /** The standing part's input for a seat: its room, its member and the room's members. */
  standing(roomId: string, seatId: string): StandingInput | Promise<StandingInput>;
  /** How briefings name a seat (its alias); the seat ID when absent. */
  alias?(roomId: string, seatId: string): string | null;
  /** The images a post came with, by its journal event ID: their names go in the text, their bytes to T3. */
  images?(roomId: string, eventId: string): TurnImage[];
  /** True when the envelope carries the request that seats the member (its body is the seat facts; L4b). */
  seatBriefing?(roomId: string, seatId: string, envelope: Envelope): boolean;
}

export type ImageRefs = Array<{ eventId: string; names: string[] }>;

export interface Briefed {
  text: string;
  /** The images this message carries, by the post they came with: attached exactly, on every resend too. */
  images: ImageRefs;
  /** What the seat's thread holds of the standing sections once T3 has this message. */
  held: SeatStanding;
}

/**
 * The standing record a seat's thread holds: the one frozen with its latest run T3 recorded (a run that never reached
 * the agent does not count), unless the thread lost it since: a compaction after it, or a rollback past its carrier.
 */
export function seatStanding(p: Projection, seatId: string, thread: T3ThreadDetail | null): SeatStanding | null {
  const runs = [...runRecords(p).values()].filter((r) => r.seatId === seatId && r.t3 !== null && r.frozen?.held).sort((a, b) => b.reservedSeq - a.reservedSeq);
  const latest = runs[0];
  if (!latest) return null;
  const held = latest.frozen!.held!;
  return thread && standingLost(held, thread, latest.t3!.id) ? null : held;
}

export async function brief(source: BriefingSource, budgetChars: number, input: { roomId: string; seatId: string; runId: string; envelope: Envelope; projection: Projection; had: SeatStanding | null }): Promise<Briefed> {
  const { roomId, seatId, envelope, projection } = input;
  const events = projection.events;
  const directory = journalDirectory(events, {
    alias: (id) => source.alias?.(roomId, id) ?? id,
    attachments: (eventId) => (source.images?.(roomId, eventId) ?? []).map((image) => image.name),
  });
  const briefing = renderEnvelopeBriefing({
    ...(await source.standing(roomId, seatId)),
    envelope,
    directory,
    context: relatedContext(events, envelope, seatId),
    had: input.had,
    runId: input.runId,
    at: new Date().toISOString(),
    budgetChars,
    seatBriefing: source.seatBriefing?.(roomId, seatId, envelope) ?? false,
    orchestrator: projection.orchestrator === seatId,
  });
  return { text: briefing.text, images: briefing.images, held: briefing.held };
}

/** Exactly the images the briefing names as attached, in its order, with their bytes (two of one name are two). */
export function attachImages(source: BriefingSource, roomId: string, refs: ImageRefs): TurnImage[] {
  return refs.flatMap(({ eventId, names }) => {
    const pool = [...(source.images?.(roomId, eventId) ?? [])];
    return names.flatMap((name) => {
      const index = pool.findIndex((image) => image.name === name);
      return index < 0 ? [] : pool.splice(index, 1);
    });
  });
}

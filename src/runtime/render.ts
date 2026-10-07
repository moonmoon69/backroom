/**
 * How the host turns a reserved run's frozen envelope into the message T3 receives. The envelope briefing itself is
 * deliverable L2 (src/briefing/envelope.ts); until it merges the host renders through this interface with the plain
 * stub below. The renderer gets the frozen envelope and the projection, and returns the text and the images to send.
 */
import type { TurnImage } from "../adapter/types.ts";
import type { Envelope, Input, Projection } from "../engine/index.ts";

export interface BriefingInput {
  roomId: string;
  seatId: string;
  runId: string;
  envelope: Envelope;
  projection: Projection;
}

export interface RenderedBriefing {
  text: string;
  images: TurnImage[];
}

/**
 * `render` must not change anything: the host calls it once before a run's first send and freezes the text in the
 * journal (the run's `sending` phase), and may call it again only for the images of an identical resend. `delivered`
 * runs once T3 has recorded the message: that is where a renderer keeps what the seat now holds (L2's standing ledger).
 */
export interface BriefingRenderer {
  render(input: BriefingInput): RenderedBriefing | Promise<RenderedBriefing>;
  delivered?(input: BriefingInput, text: string): void;
}

/** Images that belong to an input (a request posted with pictures): looked up by the input's event ID. */
export type InputImages = (roomId: string, input: Input) => TurnImage[];

/** The stub: every input in full, oldest first, then the seat's open requests. Deterministic for a given envelope. */
export function plainRenderer(images: InputImages = () => []): BriefingRenderer {
  return {
    render({ roomId, seatId, envelope }) {
      const lines: string[] = [`[Backroom briefing for ${seatId}]`];
      const pictures: TurnImage[] = [];
      const add = (input: Input, depth: number) => {
        const ids = input.requestIds.length ? ` ${input.requestIds.map((id) => `#${id}`).join(" ")}` : "";
        lines.push(`${"  ".repeat(depth)}[${input.seq} ${input.intent}${ids}] ${input.body}`);
        pictures.push(...images(roomId, input));
        for (const inherited of input.inherited) add(inherited, depth + 1);
      };
      for (const input of envelope.inputs) add(input, 0);
      if (envelope.openRequests.length) {
        lines.push("Open requests:");
        for (const r of envelope.openRequests) lines.push(`- #${r.id} from ${r.returnTo}: ${r.body}`);
      }
      return { text: lines.join("\n"), images: pictures };
    },
  };
}

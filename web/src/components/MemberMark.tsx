import { seatLook, type Look } from "../../../src/domain/look.ts";
import { useSkin } from "../skin.ts";
import { HARNESS_COLOUR, lookPaths, seedOf, SPARE_COLOURS } from "../pixel/sprites.ts";
import type { ModelSelection, Preset } from "../types.ts";
import { useCatalog } from "./catalog.ts";
import { usePresets } from "./presets.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

/** The look someone wears: their crew member's in every room and view (src/domain/look.ts, seatLook). */
export function lookFor(presets: readonly Preset[], presetId: string | null | undefined, seed: string, name?: string): Look {
  return seatLook(presets, presetId, seed, name);
}

/**
 * A look drawn: the 16 × 16 sprite as squares with crisp edges, so each sprite pixel covers whole device pixels wherever
 * it lands (an image scaled with "pixelated" does not, at a ratio like 1.8, and gives one eye more pixels than the
 * other). The one drawing every view uses: a room's rows and chips, the crew, the look picker, the app's mark.
 */
export function LookSprite({ look, harness, className = "pixel-avatar", size = 16, title }: { look: Look; harness: string; className?: string; size?: number; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      {title ? <title>{title}</title> : null}
      {lookPaths(look, harness).map((path) => (
        <path key={path.fill} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}

/** The colour a harness is drawn in: its logo's, else a spare one fixed by its instance. */
export function harnessColour(driver: string | undefined, instanceId: string): string {
  return HARNESS_COLOUR[driver ?? ""] ?? HARNESS_COLOUR[instanceId] ?? SPARE_COLOURS[Math.floor(seedOf(instanceId) * SPARE_COLOURS.length)]!;
}

/**
 * Who someone is at a glance: a room member, a crew member, a thread's agent. In the plain look, the logo of the
 * harness its model runs on; in the pixel look, the capybara wearing its crew member's look (pixel/sprites.ts), with
 * the harness's colour on its pocket square (and on band and tie unless the look says otherwise), the same in every room
 * and view. The sprite is 16 × 16; pixel.css shows it at 16px or, where there is room, 32px.
 */
export function MemberMark({
  seed,
  selection,
  size = 14,
  presetId,
  name,
  look,
}: {
  seed: string;
  selection: ModelSelection;
  size?: number;
  /** The crew member it was seated as, whose look it wears. */
  presetId?: string | null | undefined;
  /** Its name: a seat not seated as a crew member wears the look of the crew member of that name, if there is one. */
  name?: string | undefined;
  /** A look to draw as given (the look picker's preview). */
  look?: Look;
}) {
  const [skin] = useSkin();
  const { presets } = usePresets();
  const entry = useCatalog()?.find((e) => e.instanceId === selection.instanceId && e.model === selection.model);
  if (skin !== "pixel") return <ProviderIcon driver={entry?.driver} instanceId={selection.instanceId} name={entry?.providerName ?? selection.instanceId} size={size} />;
  const drawn = look ?? lookFor(presets, presetId, seed, name);
  return <LookSprite look={drawn} harness={harnessColour(entry?.driver, selection.instanceId)} />;
}

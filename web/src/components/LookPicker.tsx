import { LOOK_PARTS, shuffledLook, type Look } from "../../../src/domain/look.ts";
import type { ModelSelection } from "../types.ts";
import { useCatalog } from "./catalog.ts";
import { harnessColour, LookSprite } from "./MemberMark.tsx";

/** Parts that mean nothing in the look as it stands: a hat's colour and band without a hat, a tie's colour without one. */
function idle(part: string, look: Look): boolean {
  if ((part === "hatColour" || part === "band") && look.hat === "none") return true;
  if (part === "neckwearColour" && (look.neckwear === "none" || look.outfit === "turtleneck")) return true;
  if (part === "neckwear" && look.outfit === "turtleneck") return true;
  return false;
}

/**
 * A crew member's look in the pixel skin, part by part (src/domain/look.ts), with the capybara as it will be drawn: large,
 * and at the 32px it has in a room: the same drawing every room shows (MemberMark). Shuffle draws a new look and keeps
 * the harness's colour on band and tie. The pocket square always shows the harness.
 */
export function LookPicker({ look, onLook, selection }: { look: Look; onLook: (look: Look) => void; selection: ModelSelection | null }) {
  const entry = useCatalog()?.find((e) => e.instanceId === selection?.instanceId && e.model === selection?.model);
  const harness = harnessColour(entry?.driver, selection?.instanceId ?? "");
  return (
    <div className="look-picker">
      <div className="look-preview">
        <LookSprite look={look} harness={harness} className="look-big" size={96} />
        {/* The sizes the rooms draw it at: 32px beside a reply and on a card, 16px in a chip. */}
        <span className="look-sizes">
          <LookSprite look={look} harness={harness} className="look-small" size={32} title="As in a room's rows and replies" />
          <LookSprite look={look} harness={harness} className="look-tiny" size={16} title="As in a chip" />
        </span>
        <button type="button" className="small" onClick={() => onLook(shuffledLook())} title="A new look; band and tie keep the harness's colour">
          Shuffle
        </button>
      </div>
      <div className="look-parts">
        {LOOK_PARTS.map((part) => {
          const value = look[part.key] ?? part.options[0]!.key;
          const option = part.options.find((o) => o.key === value);
          const swatch = part.options.some((o) => o.colour) || part.options.some((o) => o.key === "auto") ? (option?.colour ?? harness) : null;
          return (
            <label key={part.key} className={`look-part${idle(part.key, look) ? " idle" : ""}`}>
              <span>{part.label}</span>
              <span className="look-control">
                {swatch ? <span className="look-swatch" style={{ background: swatch }} aria-hidden="true" /> : null}
                <select value={value} disabled={idle(part.key, look)} onChange={(e) => onLook({ ...look, [part.key]: e.target.value })}>
                  {part.options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

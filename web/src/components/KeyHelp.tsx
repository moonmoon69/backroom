import { entryText, KEYS } from "../keyOrder.ts";
import { Dialog } from "./Dialog.tsx";

/**
 * The page's keys, in one place (keyOrder.ts, KEYS, which the key bar and README read too): by area, each place the
 * ring can be on with what each key does there. `?` opens it, Esc closes it and the focus goes back where it was.
 */
export function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard" onClose={onClose} manageFocus wide>
      <div className="key-help">
        {KEYS.map(({ area, places }) => (
          <section key={area} aria-label={area}>
            <h3>{area}</h3>
            <table>
              <tbody>
                {places.flatMap((place) =>
                  place.entries.map((entry, index) => (
                    <tr key={`${place.id}:${index}`} className={index === 0 ? "key-help-place" : undefined}>
                      {index === 0 ? (
                        <th scope="row" rowSpan={place.entries.length}>
                          {place.on}
                        </th>
                      ) : null}
                      <td className="key-help-keys">
                        {entry.keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </td>
                      <td>{entryText(entry)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </section>
        ))}
        <p className="muted hint">The bar at the foot of the page names the keys for what the ring is on. Arrows keep their own meaning in text fields, lists, menus and dialogs; Alt+← stays the browser&rsquo;s back.</p>
      </div>
    </Dialog>
  );
}

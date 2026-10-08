import { KEYS } from "../keyOrder.ts";
import { Dialog } from "./Dialog.tsx";

/** The page's keys, in one place (keyOrder.ts, KEYS): `?` opens it, Esc closes it and the focus goes back where it was. */
export function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard" onClose={onClose} manageFocus>
      <div className="key-help">
        {KEYS.map((group) => (
          <section key={group.where} aria-label={group.where}>
            <h3>{group.where}</h3>
            <dl>
              {group.entries.map((entry) => (
                <div key={entry.keys.join()} className="key-help-row">
                  <dt>
                    {entry.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{entry.what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="muted hint">Arrows keep their own meaning in text fields, lists, menus and dialogs; Alt+← stays the browser&rsquo;s back.</p>
      </div>
    </Dialog>
  );
}

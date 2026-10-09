import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { barEntries, type KeyEntry } from "../keyOrder.ts";
import { keyPlace, type PlaceNow } from "../keys.ts";
import { MOBILE_QUERY, useMediaQuery } from "../useMediaQuery.ts";

const same = (a: PlaceNow, b: PlaceNow): boolean => a.place === b.place && a.where === b.where && a.now.join() === b.now.join();

/**
 * One line at the foot of the page: on the left what the ring is on, in words, then the keys that do something there,
 * each named by what it does there (keyOrder.ts, KEYS: the same table as `?` and README), and `?` at the right end.
 * It follows the focus, and reads the page again each second for what changes under a still ring (a post answered).
 * Not on a phone (below 760px). At the document body, beside the dialogs and toasts: the page under an open dialog is
 * inert, and the bar still names the dialog's keys.
 */
export function KeyBar() {
  const phone = useMediaQuery(MOBILE_QUERY);
  const [here, setHere] = useState<PlaceNow | null>(null);
  useEffect(() => {
    if (phone) return;
    // After the event, so a focus moving from one element to the next is read where it lands.
    let timer = 0;
    const read = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setHere((last) => {
        const next = keyPlace();
        return last && same(last, next) ? last : next;
      }));
    };
    read();
    const events = ["focusin", "focusout", "keyup", "pointerup"] as const;
    for (const name of events) document.addEventListener(name, read, true);
    const poll = setInterval(read, 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      for (const name of events) document.removeEventListener(name, read, true);
    };
  }, [phone]);
  if (phone || !here) return null;
  const entries = barEntries(here.place, here.now);
  const help = entries.find((entry) => entry.keys.includes("?"));
  return createPortal(
    <div className="key-bar" role="note" aria-label="Keys here" data-place={here.place}>
      <span className="key-bar-where" title={here.where}>
        {here.where}
      </span>
      <span className="key-bar-keys">
        {entries
          .filter((entry) => entry !== help)
          .map((entry) => (
            <KeyChip key={entry.keys.join(" ")} entry={entry} />
          ))}
      </span>
      {help ? <KeyChip entry={help} end /> : null}
    </div>,
    document.body,
  );
}

function KeyChip({ entry, end = false }: { entry: KeyEntry; end?: boolean }) {
  return (
    <span className={`key-bar-key${end ? " key-bar-end" : ""}`}>
      {entry.keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
      <span className="key-bar-does">{entry.does}</span>
    </span>
  );
}

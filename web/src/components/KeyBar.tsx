import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { barDoes, barEntries, type KeyEntry } from "../keyOrder.ts";
import { keyPlace, type PlaceNow } from "../keys.ts";
import { MOBILE_QUERY, useMediaQuery } from "../useMediaQuery.ts";

const same = (a: PlaceNow, b: PlaceNow): boolean => a.place === b.place && a.where === b.where && a.name === b.name && a.now.join() === b.now.join();

/**
 * One line at the foot of the page: on the left what the ring is on, in words, then the keys that do something there,
 * each named by what it does there (keyOrder.ts, KEYS: the same table as `?`; in an action strip Enter is
 * named by the button the ring is on), and `?` at the right end.
 * Keys are drawn whole or not at all: those that do not fit the window are left out from the end of the line (the last
 * in KEY_RANK first); `?` stays.
 * It follows the focus, and reads the page again each second for what changes under a still ring (a post answered).
 * Not on a phone (below 760px). At the document body, beside the dialogs and toasts: the page under an open dialog is
 * inert, and the bar still names the dialog's keys.
 */
export function KeyBar() {
  const phone = useMediaQuery(MOBILE_QUERY);
  const [here, setHere] = useState<PlaceNow | null>(null);
  const keys = useRef<HTMLSpanElement>(null);
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
  // After each draw and each change of the bar's width: every key shown again, then those from the first that overflows
  // on left out. The count left out is on the line (data-left) for the rehearsal.
  useLayoutEffect(() => {
    const line = keys.current;
    if (!line) return;
    const fit = () => {
      const chips = [...line.children] as HTMLElement[];
      for (const chip of chips) chip.hidden = false;
      const right = line.getBoundingClientRect().right + 0.5;
      const first = chips.findIndex((chip) => chip.getBoundingClientRect().right > right);
      chips.forEach((chip, index) => (chip.hidden = first >= 0 && index >= first));
      line.dataset.left = String(first >= 0 ? chips.length - first : 0);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(line);
    return () => observer.disconnect();
  });
  if (phone || !here) return null;
  const entries = barEntries(here.place, here.now);
  const help = entries.find((entry) => entry.keys.includes("?"));
  return createPortal(
    <div className="key-bar" role="note" aria-label="Keys here" data-place={here.place}>
      <span className="key-bar-where" title={here.where}>
        {here.where}
      </span>
      <span className="key-bar-keys" ref={keys}>
        {entries
          .filter((entry) => entry !== help)
          .map((entry) => (
            <KeyChip key={entry.keys.join(" ")} entry={entry} does={barDoes(entry, here.name)} />
          ))}
      </span>
      {help ? <KeyChip entry={help} does={help.does} end /> : null}
    </div>,
    document.body,
  );
}

function KeyChip({ entry, does, end = false }: { entry: KeyEntry; does: string; end?: boolean }) {
  return (
    <span className={`key-bar-key${end ? " key-bar-end" : ""}`}>
      {entry.keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
      <span className="key-bar-does">{does}</span>
    </span>
  );
}

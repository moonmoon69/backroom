import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { stripStep } from "../keyOrder.ts";

/**
 * One button of an action strip: what it shows, what it is called (its accessible name, and the key bar's word for Enter
 * on it: "Enter Correct…"), and what it does.
 */
export interface StripAction {
  /** Stays the same while the button does, so the ring stays on it when the strip is drawn again. */
  key: string;
  label: ReactNode;
  name: string;
  title?: string | undefined;
  tone?: "primary" | "danger" | undefined;
  disabled?: boolean | undefined;
  /** As the control it stands for says it (Read aloud while reading, an open "turn in T3"). */
  pressed?: boolean | undefined;
  expanded?: boolean | undefined;
  press: () => void;
}

/** What the strip is in front of: anything open over the page takes the keys first (a menu, a dialog, a preview). */
const OVER = ".dialog, .dialog-backdrop, [role='menu'], .menu, .popover";

/**
 * An action strip (K1-5; the status chips and the members reuse it): the buttons of the item the ring is on, in one row
 * under it, opened by Enter on the item. The ring lands on the first (the default); ← → go between the buttons and stop
 * at the ends; Enter presses (the button's own); Esc closes the strip and puts the ring back on the item (Backspace too:
 * the strip is in front, keys.ts, inFront). ↑ ↓ are the page's: they move the ring off the item, and the strip closes
 * once the focus is somewhere else, unless that is in a layer over the page (a dialog a button opened, whose closing
 * gives the focus back here) or where `keeps` says (a box a button opened in place). A button that goes away with the
 * ring on it (its work done: a request cancelled, a notice dismissed) closes the strip, the ring back on the item.
 */
export function ActionStrip({ actions, where, item, onClose, keeps, ref }: {
  actions: StripAction[];
  /** The key bar's words for the item ("#33 · you to @fable, open"), after the name of the button the ring is on. */
  where: string;
  /** The item the strip is on: the ring goes back to it. */
  item: () => HTMLElement | null;
  /** The strip closes: with what took the focus or the pointer elsewhere, if that closed it. */
  onClose: (cause?: Event) => void;
  keeps?: ((element: Element) => boolean) | undefined;
  ref?: Ref<HTMLDivElement | null> | undefined;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(ref, () => strip.current, []);
  const buttons = () => [...(strip.current?.querySelectorAll<HTMLButtonElement>(":scope > button") ?? [])];
  const close = useRef(onClose);
  close.current = onClose;
  const itemRef = useRef(item);
  itemRef.current = item;
  const keepsRef = useRef(keeps);
  keepsRef.current = keeps;
  /** The ring back on the item, brought into view. */
  const back = () => {
    const owner = itemRef.current();
    owner?.focus({ preventScroll: true });
    owner?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  // The button the ring was last on, by key.
  const ringOn = useRef<string | null>(null);

  // The ring on the default (the first) once there is a button. Later, with the focus lost from the button it was on:
  // back on it once it can take it again (it was busy), or, the button gone, the strip closed and the ring on the item.
  useLayoutEffect(() => {
    const all = buttons();
    const now = document.activeElement;
    const lost = !now || now === document.body || !now.isConnected;
    if (ringOn.current === null) {
      const first = all.find((button) => !button.disabled) ?? all[0];
      first?.focus({ preventScroll: true });
      first?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (!lost) return;
    const again = all.find((button) => button.dataset.action === ringOn.current);
    if (again && !again.disabled) again.focus({ preventScroll: true });
    else if (!again) {
      back();
      close.current();
    }
  }, [actions]);

  useEffect(() => {
    const root = strip.current;
    if (!root) return;
    // Esc (and Backspace, sent as Esc while the strip is in front) once whatever is over it has had it. In what a button
    // opened in place (`keeps`: an answer of your own) it is in front of the strip: the ring goes back to the button.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || root.closest("[inert]")) return;
      if ([...document.querySelectorAll(OVER)].some((element) => !element.closest("[inert]") && !root.contains(element))) return;
      event.preventDefault();
      const now = document.activeElement;
      const pressed = buttons().find((button) => button.dataset.action === ringOn.current);
      if (now && !root.contains(now) && keepsRef.current?.(now) && pressed) {
        pressed.focus({ preventScroll: true });
        return;
      }
      back();
      close.current();
    };
    // Somewhere else: the strip closes. Not into itself, a layer over the page, or what `keeps` keeps.
    const away = (target: EventTarget | null) =>
      target instanceof Element && !root.contains(target) && !target.closest(OVER) && !keepsRef.current?.(target);
    const onFocus = (event: FocusEvent) => {
      if (away(event.target)) close.current(event);
    };
    const onPointer = (event: PointerEvent) => {
      if (away(event.target)) close.current(event);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  return (
    <div
      className="action-strip"
      ref={strip}
      role="toolbar"
      aria-label={`Actions on ${where}`}
      data-where={where}
      onFocus={(event) => {
        const key = (event.target as HTMLElement).dataset.action;
        if (key) ringOn.current = key;
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        // The arrows only move the ring, along the strip, stopping at its ends; the room's ← → never see them.
        event.preventDefault();
        const all = buttons();
        const next = stripStep(all.map((button) => !button.disabled), all.indexOf(document.activeElement as HTMLButtonElement), event.key === "ArrowRight" ? "right" : "left");
        if (next === null) return;
        all[next]!.focus({ preventScroll: true });
        all[next]!.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className={`small action${action.tone ? ` ${action.tone}` : ""}`}
          data-action={action.key}
          aria-label={action.name}
          title={action.title}
          disabled={action.disabled}
          aria-pressed={action.pressed}
          aria-expanded={action.expanded}
          onClick={action.press}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

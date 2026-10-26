import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import { navProps } from "../keys.ts";

/**
 * Look → Overview: the composer as an overlay. Closed, it is one thin strip where the composer was: who the message
 * goes to, what waits, and the draft if there is one. A click on the strip, Enter, or starting to type outside a text
 * field opens it over the lower middle of the conversation, in large text, with a real text field focused (dictation
 * tools type into it) and the caret after the draft. The conversation stays readable above it and scrolls with the
 * wheel, over the overlay too. Escape, or a fresh Backspace in an empty field, closes it; sending closes it. The draft
 * stays. A Backspace held down to clear the text stops at the empty field: its repeats never close the composer.
 * What sits above the input (a room's background bar) rides with it: in flow above the strip while closed, in the
 * float above the card while open (ComposerFloat), so the open card never covers it.
 */
export interface ComposerOverlay {
  /** Whether the composer is an overlay at all; when not, it is always open and none of this applies. */
  enabled: boolean;
  /** Whether the whole composer shows. */
  open: boolean;
  /** Open from a key or a click: the field is focused at once, so fast typing lands in it; `typed` is put in. */
  show: (typed?: string) => void;
  /** Open from code (a follow-up prefill): focusing is left to the caller. */
  reveal: () => void;
  /** Close to the strip; the strip takes the focus if the composer had it. */
  hide: () => void;
  /** Escape, or a fresh Backspace (not a held one's repeat) in an empty field, closes. True when the key was used. */
  fieldKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The open composer's float (ComposerFloat): the card, and what sits above the input above it. */
  panel: RefObject<HTMLDivElement | null>;
  strip: RefObject<HTMLButtonElement | null>;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
}

/** The conversation's scroller beside the composer: Timeline and the thread transcript both draw `.timeline-wrap > .timeline`. */
const scrollerBeside = (panel: HTMLElement | null): HTMLElement | null => panel?.parentElement?.querySelector<HTMLElement>(":scope > .timeline-wrap > .timeline") ?? null;

const isTextField = (element: HTMLElement): boolean => element.isContentEditable || element.matches("input, textarea, select");

/** `arrival`: the strip takes the focus as it is first drawn (a thread); a room places the ring itself (OverviewRoom). */
export function useComposerOverlay(enabled: boolean, textarea: RefObject<HTMLTextAreaElement | null>, text: string, arrival = true): ComposerOverlay {
  const [isOpen, setOpen] = useState(false);
  const open = !enabled || isOpen;
  const panel = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  /** The composer is under something (a member's thread over its room, a dialog): its page-wide keys are not its. */
  const covered = useCallback(() => Boolean((strip.current ?? panel.current)?.closest("[inert]")), []);

  // On arrival the strip takes the focus (a room opened by a click leaves it on the card behind the drawer), so the
  // first Enter opens the composer; a text field that has the focus keeps it.
  useEffect(() => {
    const active = document.activeElement;
    if (!enabled || !arrival || (active instanceof HTMLElement && isTextField(active))) return;
    strip.current?.focus({ preventScroll: true });
  }, [enabled, arrival]);

  // The field grows with the text up to its CSS max-height, then scrolls inside.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!enabled || !isOpen || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [enabled, isOpen, text, textarea]);

  // Opened: the field takes the focus with the caret after the draft. Closed: the strip takes it, so Enter opens again.
  useLayoutEffect(() => {
    if (!enabled) return;
    if (isOpen) {
      const el = textarea.current;
      if (!el || document.activeElement === el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    } else if (refocus.current) {
      refocus.current = false;
      strip.current?.focus({ preventScroll: true });
    }
  }, [enabled, isOpen, textarea]);

  // The float covers the foot of the conversation: pad it by that much, so its last lines scroll up into view above
  // the float (what rides above the card included). A conversation read at its end stays at its end. Before paint, so
  // the last lines never flash under it.
  useLayoutEffect(() => {
    const el = panel.current;
    const host = el?.parentElement;
    const scroller = scrollerBeside(el);
    if (!enabled || !isOpen || !el || !host || !scroller) return;
    const fit = () => {
      const covered = Math.max(0, scroller.getBoundingClientRect().bottom - el.getBoundingClientRect().top);
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      host.style.setProperty("--composer-cover", `${Math.round(covered)}px`);
      host.dataset.composerOpen = "";
      if (atEnd) scroller.scrollTop = scroller.scrollHeight;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--composer-cover");
      delete host.dataset.composerOpen;
    };
  }, [enabled, isOpen]);

  const show = useCallback(
    (typed?: string) => {
      if (!enabled) return;
      flushSync(() => setOpen(true));
      const el = textarea.current;
      if (!el) return;
      if (document.activeElement !== el) el.focus({ preventScroll: true });
      if (typed === undefined) return;
      // As if typed into the field: React sees the change and the browser's undo keeps it.
      if (!document.execCommand("insertText", false, typed)) {
        el.setRangeText(typed, el.selectionStart, el.selectionEnd, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    [enabled, textarea],
  );
  const reveal = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    refocus.current = Boolean(panel.current?.contains(document.activeElement));
    setOpen(false);
  }, []);

  // Esc with the focus elsewhere (a post, a button) closes the open composer before anything else closes but a menu, a
  // dialog or a post's action strip (keys.ts, inFront); in its field fieldKey takes it.
  useEffect(() => {
    if (!enabled || !isOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || covered() || document.querySelector(".dialog-backdrop, .menu")) return;
      if ([...document.querySelectorAll(".action-strip")].some((element) => !element.closest("[inert]"))) return;
      event.preventDefault();
      hide();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, isOpen, hide, covered]);

  // Enter, or a printable key, outside a text field opens the composer (and the key goes in). Enter on a button or
  // link is that control's; nothing opens over a dialog or a menu.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || covered()) return;
      if (document.querySelector(".dialog-backdrop, dialog[open], .menu")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && isTextField(target)) return;
      if (event.key === "Enter") {
        if (target?.closest("button, a[href], summary, [role='button'], [role='tab'], [role='menuitem'], [role='option']")) return;
        event.preventDefault();
        show();
      } else if (event.key.length === 1 && event.key !== " ") {
        event.preventDefault();
        show(event.key);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, show, covered]);

  const fieldKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!enabled || event.nativeEvent.isComposing) return false;
      const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
      if (event.key !== "Escape" && !(event.key === "Backspace" && plain && !event.repeat && event.currentTarget.value === "")) return false;
      // Escape here closes the composer, not the room around it.
      event.preventDefault();
      event.stopPropagation();
      hide();
      return true;
    },
    [enabled, hide],
  );

  // The wheel over the overlay, or over the strip, scrolls the conversation behind it (a remote's wheel scrolls
  // wherever the pointer was left), unless it is scrolling the field's own text.
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const field = textarea.current;
      if (field?.contains(target)) {
        const more = event.deltaY < 0 ? field.scrollTop > 0 : field.scrollTop + field.clientHeight < field.scrollHeight - 1;
        if (more) return;
      }
      if (target.closest(".mention-menu, .menu")) return;
      const scroller = scrollerBeside(event.currentTarget);
      if (!scroller) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollBy({ top: event.deltaY * unit });
    },
    [textarea],
  );

  return { enabled, open, show, reveal, hide, fieldKey, panel, strip, onWheel };
}

/**
 * The open composer, floated over the foot of the conversation: the card, and above it what sits above the input
 * (`above`: a room's background bar), so the card never covers it. It is the overlay's panel: what it covers is measured
 * from its top, and the wheel over any of it scrolls the conversation behind.
 */
export function ComposerFloat({ overlay, above, children }: { overlay: ComposerOverlay; above?: ReactNode; children: ReactNode }) {
  return (
    <div ref={overlay.panel} className="composer-float" onWheel={overlay.onWheel}>
      {above}
      {children}
    </div>
  );
}

/** One line of the draft for the strip. */
const firstWords = (text: string, max = 90): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The closed composer: one line where it was, kept in place (hidden) while the overlay is open so the conversation
 * does not jump. Files dropped on it are attached as on the composer.
 */
export function ComposerStrip({
  overlay,
  to,
  facts,
  draft,
  images = 0,
  actions,
  lane = false,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  overlay: ComposerOverlay;
  /** Who the message goes to. */
  to: ReactNode;
  /** Short facts after it: what is queued, a turn running. */
  facts: string[];
  draft: string;
  /** Images attached to the draft; with them and no text it is still a draft (the facts give their number). */
  images?: number;
  /** Buttons beside the strip (Stop for a running turn). */
  actions?: ReactNode;
  /** The strip is the composer's lane of a room's keys (keys.ts), its one item. */
  lane?: boolean;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const kept = draft.trim().length > 0 || images > 0;
  return (
    <div className={`composer-slot${overlay.open ? " under" : ""}`} onWheel={overlay.onWheel} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="composer-strip-row" data-nav-lane={lane ? "strip" : undefined}>
        <button
          ref={overlay.strip}
          type="button"
          className="composer-strip"
          onClick={() => overlay.show()}
          {...(lane ? navProps("strip", "strip", kept ? "Continue your draft" : "Write a message") : {})}
          title={touch ? "Write a message" : "Write a message: Enter, or start typing"}
          aria-label={kept ? "Continue your draft" : "Write a message"}
        >
          <span className="strip-to">{to}</span>
          {facts.map((fact) => (
            <span key={fact} className="strip-fact mono">
              {fact}
            </span>
          ))}
          {kept ? (
            <span className="strip-draft">
              <span className="pill pill-draft">draft</span>
              {draft.trim() ? <span className="strip-draft-text">{firstWords(draft)}</span> : null}
            </span>
          ) : (
            <span className="strip-hint">{touch ? "Tap to write" : "Enter or start typing to write"}</span>
          )}
        </button>
        {actions}
      </div>
    </div>
  );
}

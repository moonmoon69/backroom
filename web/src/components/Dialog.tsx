import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { returnFocus } from "../keys.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { CloseIcon } from "./icons.tsx";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** For looking at something (a file): about 90% of the window, whatever its size, and its body fills it. */
  large?: boolean;
  /** Preview dialogs opt into focus containment and restoration. */
  manageFocus?: boolean;
  /** Keep a document mounted but inert while its image preview is on top. */
  active?: boolean;
}

/**
 * Modal dialog: closes on Escape or backdrop click, labelled by its title. Rendered at the document body, so the
 * styles of whatever opened it (a panel head, a card) never reach into it.
 * Initial focus goes to the element marked `data-autofocus`, otherwise the first enabled field.
 * Focus is set exactly once when the dialog opens; background re-renders never move it. When it closes, focus goes back
 * to the element that opened it (keys.ts, returnFocus).
 *
 * While a dialog is open the page under it (#root) is inert, so neither Tab nor the page's arrows reach what is behind
 * it, and Tab goes round inside the dialog (and the menus it opened). A body that scrolls takes the focus too (Tab), so
 * the keys scroll it.
 */

/** Dialogs open now: the page under them is inert while there is one. */
let openDialogs = 0;
const pageRoot = () => document.getElementById("root");
export function Dialog({ title, onClose, children, footer, wide, large, manageFocus = false, active = true }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = panel.current;
      if (!activeRef.current || !root || root !== [...document.querySelectorAll(".dialog:not([inert])")].at(-1)) return;
      // A menu open in the dialog (a dropdown, the model list), or a field in it that used Esc itself (a correction
      // closing), takes Esc first: one thing closes at a time.
      if (event.key === "Escape" && (event.defaultPrevented || root.querySelector(".menu") || document.querySelector(".menu.in-dialog"))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        // A menu the dialog opened (portalled beside it) keeps its own Tab.
        if (document.activeElement?.closest(".popover")) return;
        const candidates = [...root.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, iframe, summary, [tabindex]')]
          .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, [hidden]') && element.getClientRects().length > 0);
        const first = candidates[0] ?? root;
        const last = candidates.at(-1) ?? root;
        if (!root.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [manageFocus]);

  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    // What opened it; nothing when the focus was nowhere (a menu item removed as the dialog opened): then the last
    // element focused outside dialogs and menus (the menu's button) takes it back.
    const focused = document.activeElement;
    const opener = focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement ? focused : null;
    openDialogs += 1;
    pageRoot()?.setAttribute("inert", "");
    const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select, button:not(.dialog-close)"));
    const target =
      preferred && !(preferred as HTMLInputElement).disabled
        ? preferred
        : manageFocus ? root.querySelector<HTMLElement>(".dialog-close") : candidates.find((element) => !(element as HTMLInputElement).disabled && element.getAttribute("type") !== "hidden");
    // Defer one frame so the browser has painted the dialog before focus moves into it.
    const frame = requestAnimationFrame(() => {
      if (activeRef.current) (target ?? (manageFocus ? root.querySelector<HTMLElement>(".dialog-close") ?? root : null))?.focus();
    });
    const containFocus = (event: FocusEvent) => {
      if (activeRef.current && root === [...document.querySelectorAll(".dialog:not([inert])")].at(-1) && !root.contains(event.target as Node)) {
        (root.querySelector<HTMLElement>(".dialog-close") ?? root).focus();
      }
    };
    if (manageFocus) document.addEventListener("focusin", containFocus);
    return () => {
      cancelAnimationFrame(frame);
      openDialogs -= 1;
      if (openDialogs === 0) pageRoot()?.removeAttribute("inert");
      if (manageFocus) {
        document.removeEventListener("focusin", containFocus);
        const fallback = [...document.querySelectorAll<HTMLElement>(".dialog:not([inert])")].at(-1)?.querySelector<HTMLElement>(".dialog-close");
        (opener?.isConnected && !opener.closest("[inert]") ? opener : fallback)?.focus();
      } else if (!document.activeElement || document.activeElement === document.body || root.contains(document.activeElement)) {
        // Every dialog gives the focus back to where the user was: what opened it, else (a menu item, gone) the last
        // element focused outside dialogs and menus.
        returnFocus(opener);
      }
    };
  }, [manageFocus]);

  // A body taller than the dialog is a scrolled region: focusable (Tab) and named, so the keys scroll it.
  const body = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setScrolls(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  });

  return createPortal(
    <div className="dialog-backdrop" aria-hidden={!active || undefined} inert={!active} onMouseDown={(event) => active && event.target === event.currentTarget && onClose()}>
      <div
        className={`dialog${wide ? " dialog-wide" : ""}${large ? " dialog-large" : ""}`}
        role="dialog"
        aria-modal={active || undefined}
        aria-label={title}
        inert={!active}
        tabIndex={manageFocus ? -1 : undefined}
        ref={panel}
      >
        <ErrorBoundary header={null} onReset={onClose} recovery={{ message: "This dialog could not be displayed.", action: "Close dialog" }}>
          <div className="dialog-header">
            <h2>{title}</h2>
            <button type="button" className="dialog-close small ghost icon-only" aria-label="Close dialog" title="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          <div className="dialog-body" ref={body} tabIndex={scrolls ? 0 : undefined} role={scrolls ? "region" : undefined} aria-label={scrolls ? `${title}, scrolls` : undefined}>
            {children}
          </div>
          {footer ? <div className="dialog-footer">{footer}</div> : null}
        </ErrorBoundary>
      </div>
    </div>,
    document.body,
  );
}

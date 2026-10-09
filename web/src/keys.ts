/**
 * Keyboard navigation of the page (the shortcuts are listed in one place: keyOrder.ts, KEYS, shown by `?` and in
 * README.md; the overview's reading order is there too, apart from the page, so it is tested on its own).
 *
 * The page moves real focus: every item the arrows reach is an element with `data-nav` (its group) and `data-nav-key`
 * (a key that survives a redraw: "room:<id>", "post:<seq>", …), focusable (a button, or tabindex -1 with a role and a
 * label), so assistive technology announces it and `:focus-visible` draws its ring. Tab and Enter reach every control
 * as before; the arrows only add the quick way between items.
 *
 * - The overview reads section by section (each project, its shelf, the crew, the browsers); inside a section column
 *   by column, as the cards are stacked, each column top to bottom. Up and Down follow that order through every card
 *   and member; Left and Right go to the column beside, to the item nearest in height.
 * - In a room, Up and Down go through the focused pane's items (the board's posts, the members), Left and Right between
 *   the panes: the board, then the side panel's Members, Browser and Git.
 * - Escape closes what is in front, one thing at a time (a menu, the composer, a status chip's choices, a Correct… box, a
 *   dialog, the key help), and nothing else: never the room, a member's thread or the side panel.
 * - Backspace outside a text field goes back one step: what is in front first (as Escape), then a member's thread, the
 *   side panel, and the room to its card. In a text field it is the field's.
 *
 * The arrows keep their own meaning wherever they already have one: text fields, selects, lists and menus with their own
 * arrows, dialogs, and any key with a modifier (Alt+Left stays the browser's back).
 */

import { useEffect, useRef, type RefObject } from "react";
import { inReadingOrder, readingTarget, type NavKey, type Placed } from "./keyOrder.ts";

const OWN_ARROW_ROLES = ["listbox", "option", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "radiogroup", "radio", "slider", "spinbutton", "combobox", "grid", "gridcell", "tree", "treeitem", "tablist", "tab", "scrollbar", "textbox", "searchbox"];

/** An element that keeps the arrow keys: a text field, a select, a widget with arrows of its own, anything in a dialog or menu. */
export function keepsArrows(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement && !["button", "submit", "reset", "checkbox", "image", "file", "color"].includes(element.type)) return true;
  if (element.closest(OWN_ARROW_ROLES.map((role) => `[role="${role}"]`).join(", "))) return true;
  return Boolean(element.closest(".dialog, .menu, .popover, [data-own-keys]"));
}

/** A text field (where Escape and printable keys are the field's). */
export const isTextField = (element: Element | null): boolean =>
  element instanceof HTMLElement && (element.isContentEditable || element.matches("textarea, select, input:not([type=button], [type=submit], [type=reset], [type=checkbox], [type=radio], [type=image], [type=file], [type=color])"));

/**
 * Something open that takes Escape: a dialog, a menu, a popover, a suggestion list, the composer, a status chip's
 * choices, a correction (Correct…'s box).
 */
const LAYER_SELECTOR = ".dialog-backdrop:not([inert]), [role='menu'], .menu, .popover, .mention-menu, .slash-menu, .composer-overlay, .work-open, .req-correct";

/**
 * Whether something is in front, for Escape and Backspace: such a thing open where the keys reach it, wherever the
 * focus is (not under an inert layer: the room's composer under a member's thread).
 */
export const inFront = (target: Element | null): boolean =>
  [...document.querySelectorAll(LAYER_SELECTOR)].some((element) => !element.closest("[inert]")) || Boolean(target?.closest(".dialog, .menu"));

/** The arrow keys and the two ends, without modifiers, outside anything that keeps them: a key the page's navigation takes. */
export function navKey(event: KeyboardEvent): NavKey | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const key = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "first", End: "last" } as const)[event.key as "ArrowUp"];
  if (!key) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (keepsArrows(target)) return null;
  return key;
}

const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0 && !element.closest("[inert], [hidden]");

/** The navigable items under a root, in document order. */
export function navItems(root: ParentNode, group?: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(group ? `[data-nav="${group}"]` : "[data-nav]")].filter(visible);
}

/** The controls Tab reaches under a root, in document order. */
export function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")].filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && visible(element));
}

/** The item that holds an element (itself, or the item it is in). */
export const itemOf = (element: Element | null): HTMLElement | null => (element?.closest<HTMLElement>("[data-nav]") ?? null);

export const keyOf = (element: Element | null): string | null => itemOf(element)?.dataset.navKey ?? null;

export function byKey(root: ParentNode, key: string | null | undefined): HTMLElement | null {
  if (!key) return null;
  return [...root.querySelectorAll<HTMLElement>("[data-nav-key]")].find((element) => element.dataset.navKey === key && visible(element)) ?? null;
}

/** Focus an item and bring it into view, the least scroll that shows it. */
export function focusItem(element: HTMLElement | null): boolean {
  if (!element) return false;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  return document.activeElement === element;
}

/** Focus what `probe` finds once it is drawn (a panel opening, a room loading): tried each frame, up to `ms`. */
export function focusWhen(probe: () => HTMLElement | null | undefined, ms = 2000): () => void {
  let frame = 0;
  const end = performance.now() + ms;
  const attempt = () => {
    const element = probe();
    if (element) focusItem(element);
    else if (performance.now() < end) frame = requestAnimationFrame(attempt);
  };
  frame = requestAnimationFrame(attempt);
  return () => cancelAnimationFrame(frame);
}

// ---- the overview's reading order ----

/** The overview's items where they are drawn now. */
function placedItems(root: HTMLElement, group: string): Placed<HTMLElement>[] {
  const sections = [...root.querySelectorAll<HTMLElement>("[data-nav-section]")];
  return navItems(root, group).map((element): Placed<HTMLElement> => {
    const rect = element.getBoundingClientRect();
    const card = element.closest<HTMLElement>("[data-nav-card]") ?? element;
    return {
      element,
      section: sections.indexOf(element.closest<HTMLElement>("[data-nav-section]")!),
      column: Math.round(card.getBoundingClientRect().left),
      top: rect.top,
      middle: rect.top + rect.height / 2,
    };
  });
}

/** Where a key moves from `current` on the overview; null when it stays. */
export function overviewTarget(root: HTMLElement, group: string, current: HTMLElement | null, key: NavKey): HTMLElement | null {
  const order = inReadingOrder(placedItems(root, group));
  return readingTarget(order, current ? order.findIndex((p) => p.element === current) : -1, key)?.element ?? null;
}

/** The next or previous item in a list (a pane's posts or members); with no current item, the last for Up, else the first. */
export function listTarget(items: HTMLElement[], current: HTMLElement | null, key: NavKey): HTMLElement | null {
  if (items.length === 0) return null;
  if (key === "first") return items[0]!;
  if (key === "last") return items.at(-1)!;
  const at = current ? items.indexOf(current) : -1;
  if (at < 0) return key === "up" ? items.at(-1)! : items[0]!;
  if (key === "down") return items[at + 1] ?? null;
  if (key === "up") return items[at - 1] ?? null;
  return null;
}

// ---- where focus was, for when what had it goes away ----

let lastOutside: HTMLElement | null = null;
let tracking = false;

/**
 * Remembers the last element focused outside dialogs and menus, so a dialog opened from a menu item (gone by the time the
 * dialog closes) gives the focus back to the menu's button. Started once by the app.
 */
export function trackFocus(): void {
  if (tracking) return;
  tracking = true;
  document.addEventListener("focusin", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && !target.closest(".dialog, .dialog-backdrop, [role='menu'], .menu, .popover")) lastOutside = target;
  });
  // A menu that closes with the focus on one of its items (Esc, or an item picked) leaves the focus nowhere: it goes back
  // to the menu's button, unless a dialog it opened has taken it.
  const rescue = (event: Event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".menu, [role='menu']")) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if ((!document.activeElement || document.activeElement === document.body) && !document.querySelector(".dialog-backdrop")) returnFocus(null);
      }),
    );
  };
  document.addEventListener("keydown", rescue, true);
  document.addEventListener("click", rescue, true);
  // Up and Down between a menu's items (the ARIA menu pattern), Home and End to its ends.
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const menu = target?.closest<HTMLElement>("[role='menu']");
    if (!menu || isTextField(target)) return;
    const items = [...menu.querySelectorAll<HTMLElement>("[role^='menuitem']")].filter((item) => !item.matches(":disabled") && visible(item) && item.closest("[role='menu']") === menu);
    if (items.length === 0) return;
    const at = items.indexOf(target!.closest<HTMLElement>("[role^='menuitem']")!);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    event.preventDefault();
    items[next]!.focus();
  });
}

/** Where focus goes back to when a dialog closes: the element that opened it, else the last one outside dialogs and menus. */
export function returnFocus(opener: HTMLElement | null): void {
  const usable = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected && !element.closest("[inert]") && visible(element));
  const target = usable(opener) ? opener : usable(lastOutside) ? lastOutside : null;
  target?.focus({ preventScroll: true });
}

/**
 * A menu drawn in place under its button (Settings, a card's ⋯, the room's ⋯, the composer's timing pill), from the
 * keyboard as a Popover menu is: opened with the focus on its button, the focus goes to its first item; closed with the
 * focus inside, it goes back to the button; Tab out of it closes it.
 */
export function useMenuFocus(wrapper: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const root = wrapper.current;
    if (!open || !root) return;
    const button = root.querySelector<HTMLElement>("[aria-haspopup]");
    if (button && button === document.activeElement) {
      root.querySelector<HTMLElement>("[role='menu'] [role^='menuitem']:not(:disabled)")?.focus({ preventScroll: true });
    }
    let inside = false;
    // Closed because the focus is leaving (Tab out of it): it goes where it was going, not back to the button.
    let leaving = false;
    const onIn = (event: FocusEvent) => {
      if ((event.target as Element).closest("[role='menu']")) inside = true;
    };
    const onOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next || root.contains(next)) return;
      leaving = true;
      closeRef.current();
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
      const now = document.activeElement;
      if (inside && !leaving && button?.isConnected && (!now || now === document.body || root.contains(now))) button.focus({ preventScroll: true });
    };
  }, [wrapper, open]);
}

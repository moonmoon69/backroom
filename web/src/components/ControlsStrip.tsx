import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { imageAction, numberRepeats, stripOrder, type ActionKind } from "../keyOrder.ts";
import { isTextField } from "../keys.ts";
import { ActionStrip, type StripAction } from "./ActionStrip.tsx";

// An action strip whose buttons are read off the page (K1-5's posts and running turns, K1-6's status chips): each
// button presses a control a mouse finds there, so the strip does exactly what the mouse does and no command is
// written twice.

/** A control a mouse finds on an item, as its action strip offers it. */
interface Control {
  element: HTMLElement;
  kind: ActionKind;
  /** Which of its kind, where that is more than its place: a request's number for Correct… and Cancel, a native
   *  request's id and the choice's place on its card for an approval's or a question's choices. */
  id?: string | undefined;
  label: string;
  name: string;
  title?: string | undefined;
  tone?: "primary" | "danger" | undefined;
  disabled: boolean;
  pressed?: boolean | undefined;
  expanded?: boolean | undefined;
}

/** What a mouse can press: a button, a link, a summary, a field. */
const CONTROLS = "button, a[href], summary, input:not([type='hidden']), select, textarea";
const textOf = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const cut = (text: string, most = 40): string => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** An item's controls as they are drawn (a folded text's are not), but not its strip's own nor a correction box's. */
export function* drawnControls(item: HTMLElement): Generator<HTMLElement> {
  for (const element of item.querySelectorAll<HTMLElement>(CONTROLS)) if (!element.closest(".action-strip, .req-correct") && element.getClientRects().length > 0) yield element;
}

/** Whether an item has anything its strip would offer (it stops at the first). */
export function offersControls(item: HTMLElement): boolean {
  for (const element of drawnControls(item)) if (describe(element, 0, 0)) return true;
  return false;
}

/** What a control of an item is in its strip, by what it is on the page; null for none of it. */
function describe(element: HTMLElement, requests: number, asking: number): Omit<Control, "element" | "disabled"> | null {
  const text = textOf(element);
  const title = element.getAttribute("title")?.split("\n")[0] || undefined;
  const expanded = element.tagName === "SUMMARY" ? Boolean(element.closest("details")?.open) : element.hasAttribute("aria-expanded") ? element.getAttribute("aria-expanded") === "true" : undefined;
  const tone = element.classList.contains("danger") ? ("danger" as const) : element.classList.contains("primary") ? ("primary" as const) : undefined;
  // A message to several members has a Correct… and a Cancel for each: said with its request's number and recipient.
  const block = element.closest<HTMLElement>(".req-block");
  const number = block?.dataset.number;
  const of = requests > 1 && number ? ` #${number}` : "";
  if (element.closest(".req-actions") && (text === "Correct…" || text === "Cancel")) {
    const kind = text === "Correct…" ? "correct" : "cancel";
    return { kind, id: number, label: `${text}${of}`, name: `${text}${of}${of && block?.dataset.to ? ` to ${block.dataset.to}` : ""}`, title, tone, expanded };
  }
  if (element.closest(".notice-actions") && (text === "Retry" || text === "Dismiss")) return { kind: text === "Retry" ? "retry" : "dismiss", label: text, name: text, title, tone };
  if (element.closest(".live-turn .chat-head, .run-actions") && text === "Stop") return { kind: "stop", label: text, name: text, title, tone };
  if (element.closest(".native-requests")) {
    const input = element instanceof HTMLInputElement ? element : null;
    // A secret's field is named for what it is, never for what is typed in it.
    const label = input && (input.type === "radio" || input.type === "checkbox") ? textOf(input.closest("label") ?? input) || "the answer of your own" : input?.type === "password" ? "Secret" : input ? input.placeholder || "Answer" : text;
    // Each its request's, by the request's id and not its place: answered elsewhere, its buttons go and another
    // request's never take their keys (the ring is not moved onto them). With several drawn, each is named with what it
    // asks ("Accept 2: run tests"), of those the strip offers (`asking`).
    const card = element.closest<HTMLElement>(".native-card");
    const id = card?.dataset.request ? `${card.dataset.request}:${[...card.querySelectorAll(CONTROLS)].indexOf(element)}` : undefined;
    const subject = card && asking > 1 ? textOf(card.querySelector(".native-detail, legend, .secret-label") ?? card) : "";
    return { kind: "choice", id, label: cut(label), name: cut(subject ? `${label}: ${subject}` : label), title, tone, ...(input && (input.type === "radio" || input.type === "checkbox") ? { pressed: input.checked } : {}) };
  }
  if (element.matches(".copy-button")) {
    const label = element.getAttribute("aria-label") === "Copied" ? "Copied" : "Copy";
    return { kind: "copy", label, name: label, title };
  }
  if (element.matches(".speak-button")) {
    const label = element.getAttribute("aria-label") ?? "Read aloud";
    return { kind: "speak", label, name: label, title, pressed: element.getAttribute("aria-pressed") === "true" };
  }
  if (element.matches(".post-ref")) return { kind: "ref", label: text, name: `show ${text}`, title };
  if (element.matches(".md-file")) {
    const name = textOf(element.querySelector(".md-file-name") ?? element);
    return { kind: "file", label: cut(name), name, title };
  }
  // Named with its alt text: Markdown's (its title when it has none), else the image's own (an attached image's).
  if (element.matches(".image-preview-trigger, .md-img")) return { kind: "image", ...imageAction(element.dataset.alt ?? element.querySelector("img")?.getAttribute("alt")), title: element.getAttribute("aria-label") ?? title };
  if (element.tagName === "SUMMARY" && element.closest(".turn-in-t3")) return { kind: "turn", label: text, name: text, title, expanded };
  if (element.tagName === "SUMMARY" && element.closest(".sent-to-t3")) return { kind: "sent", label: text, name: text, title, expanded };
  if (element.matches(".md-copy")) return { kind: "code", label: "Copy code", name: "Copy code", title };
  if (element.matches(".live-more")) return { kind: "more", label: text, name: text, title, expanded };
  if (element.tagName === "SUMMARY") return { kind: "text", label: "Full text", name: "Full text", title: cut(text, 120), expanded };
  if (element.matches("a[href]")) return { kind: "link", label: cut(text || element.getAttribute("href") || "Link"), name: cut(text || "Link"), title: element.getAttribute("href") ?? undefined };
  const other = element.getAttribute("aria-label") || text || title;
  return other ? { kind: "other", label: cut(other), name: cut(other), title, tone, expanded } : null;
}

/**
 * The controls a mouse finds on an item now, in its strip's order (keyOrder.ts, stripOrder): those drawn (a folded
 * text's are not, until it opens), not the strip's own nor what a button opened in place (a correction's box).
 * Only those `within` keeps (a status chip's own member's, of every member's choices drawn), counted, named and numbered
 * among themselves. Repeated labels are numbered ("Image 1", "Image 2"; numberRepeats).
 */
function itemControls(item: HTMLElement, within?: (element: Element) => boolean): Control[] {
  const requests = item.querySelectorAll(".req-block").length;
  const asking = [...item.querySelectorAll(".native-card")].filter((card) => within?.(card) ?? true).length;
  const found: Control[] = [];
  for (const element of drawnControls(item)) {
    if (within && !within(element)) continue;
    const described = describe(element, requests, asking);
    if (described) found.push({ element, disabled: element.matches(":disabled"), ...described });
  }
  return numberRepeats(stripOrder(found));
}

const sameControls = (a: Control[], b: Control[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    return x.element === y.element && x.kind === y.kind && x.id === y.id && x.label === y.label && x.name === y.name && x.title === y.title && x.tone === y.tone && x.disabled === y.disabled && x.pressed === y.pressed && x.expanded === y.expanded;
  });

/**
 * An item's action strip read off the page: every control a mouse finds in what it is drawn for (`from`: the item
 * itself, a post; or what the item opened, a status chip's choices), in the order of the design's table, each pressing
 * that control; then the strip's own (`extra`: a post's Detail, a chip's "show #n"). It follows the controls as they
 * change (Read aloud becomes Stop reading, an answered request loses Correct… and Cancel, a chosen option is pressed).
 * With nothing to offer it is not drawn: `onEmpty`, else `onClose`.
 */
export function ControlsStrip({ item, from = item, within, extra, where, keeps, onClose, onEmpty }: {
  /** The item the strip is on, found from the strip once drawn: the ring goes back to it. */
  item: (strip: HTMLElement) => HTMLElement | null;
  /** Where its controls are drawn: the item, unless it opened them elsewhere. */
  from?: (strip: HTMLElement) => HTMLElement | null;
  /** Only the controls this keeps, of those drawn there (a status chip's own member's, of every member's choices). */
  within?: ((element: Element) => boolean) | undefined;
  extra?: StripAction[] | undefined;
  where: string;
  /** What a button opened in place (a correction's box, an answer of your own): the focus there keeps the strip. */
  keeps?: ((element: Element, item: HTMLElement | null) => boolean) | undefined;
  onClose: (cause?: Event) => void;
  onEmpty?: (() => void) | undefined;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const owner = useRef<HTMLElement | null>(null);
  const withinRef = useRef(within);
  withinRef.current = within;
  // Null until the controls are read (after the first draw): the strip offers nothing before, so the ring lands on the
  // first of all its buttons, not on Detail alone.
  const [controls, setControls] = useState<Control[] | null>(null);
  useLayoutEffect(() => {
    const strip = root.current;
    owner.current = strip ? item(strip) : null;
    const source = strip ? from(strip) : null;
    if (!source) return;
    const read = () => {
      const next = itemControls(source, withinRef.current);
      setControls((last) => (last && sameControls(last, next) ? last : next));
    };
    read();
    // Whatever changes there; and a choice's checked state, a property no mutation shows, after React's draw once it is
    // chosen or an answer of your own is typed.
    const observer = new MutationObserver(read);
    observer.observe(source, { subtree: true, childList: true, attributes: true, characterData: true });
    const changed = () => requestAnimationFrame(read);
    source.addEventListener("change", changed);
    source.addEventListener("input", changed);
    return () => {
      observer.disconnect();
      source.removeEventListener("change", changed);
      source.removeEventListener("input", changed);
    };
  }, []);
  // Nothing to offer (a running turn with no button yet, no Detail): no strip; the ring stays on the item.
  const empty = controls !== null && controls.length === 0 && (extra ?? []).length === 0;
  const ends = useRef({ onClose, onEmpty });
  ends.current = { onClose, onEmpty };
  useEffect(() => {
    if (empty) (ends.current.onEmpty ?? ends.current.onClose)();
  }, [empty]);
  const actions = useMemo<StripAction[]>(() => {
    if (controls === null) return [];
    const at = new Map<ActionKind, number>();
    const list: StripAction[] = controls.map((control) => {
      const n = at.get(control.kind) ?? 0;
      at.set(control.kind, n + 1);
      const { element } = control;
      return {
        key: `${control.kind}:${control.id ?? n}`,
        label: control.label,
        name: control.name,
        title: control.title,
        tone: control.tone,
        disabled: control.disabled,
        pressed: control.pressed,
        expanded: control.expanded,
        // A field takes the focus (an answer of your own); anything else is clicked, as the mouse does. A #ref also
        // takes the ring to the post it shows, which the click brings into view.
        press: () => {
          if (isTextField(element)) return element.focus();
          element.click();
          if (control.kind !== "ref") return;
          const shown = element.closest(".timeline")?.querySelector<HTMLElement>(`[data-number="${control.label.replace(/^#/, "").split(" ")[0]}"]`);
          (shown?.closest<HTMLElement>("[data-nav]") ?? null)?.focus({ preventScroll: true });
        },
      };
    });
    return [...list, ...(extra ?? [])];
  }, [controls, extra]);
  return (
    <ActionStrip
      ref={root}
      actions={actions}
      where={where}
      item={() => owner.current}
      onClose={onClose}
      keeps={keeps ? (element) => keeps(element, owner.current) : undefined}
    />
  );
}


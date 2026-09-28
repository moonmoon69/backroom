/**
 * Reorder a list by dragging, with a mouse or a finger. A mouse drag starts once the pointer moves a few pixels, so
 * a click still selects; a finger drag starts after a long press, so a swipe still scrolls. While dragging, the list
 * shows the new order and scrolls at its edges; on release the order is committed. Alt+↑/↓ on a focused item moves
 * it one place. Pointer events rather than HTML drag and drop, which phones do not offer.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 350;
/** Within this distance of the list's top or bottom edge, dragging scrolls it. */
const EDGE = 48;

interface Press {
  id: string;
  pointerId: number;
  element: HTMLElement;
  x: number;
  y: number;
  lastY: number;
  touch: boolean;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SortableHandle {
  "data-sort": string;
  "data-sort-id": string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useSortable({
  name,
  ids,
  scopeOf = () => "",
  container,
  ignore,
  onCommit,
}: {
  /** Tells this list's items from another sortable list's in the same container. */
  name: string;
  /** The committed order, top to bottom. */
  ids: string[];
  /** Items only move among items of the same scope (a room within its project). */
  scopeOf?: (id: string) => string;
  /** The scrolling element the items are in. */
  container: RefObject<HTMLElement | null>;
  /** A press inside an element matching this (a menu button) does not start a drag. */
  ignore?: string;
  onCommit: (ids: string[]) => unknown;
}): { order: string[]; dragging: string | null; handle: (id: string) => SortableHandle } {
  const [live, setLive] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const press = useRef<Press | null>(null);
  const liveRef = useRef<string[] | null>(null);
  const latest = useRef({ ids, scopeOf, onCommit, name, ignore });
  latest.current = { ids, scopeOf, onCommit, name, ignore };
  const frame = useRef<number | null>(null);
  const idsKey = ids.join("\n");

  const show = useCallback((next: string[] | null) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  // The committed order arrived (or changed underneath): show it instead of the one kept since the drop.
  useEffect(() => {
    if (!press.current?.started) show(null);
  }, [idsKey, show]);

  /** Put the dragged item before the first item of its scope whose middle is below the pointer. */
  const place = useCallback((y: number) => {
    const p = press.current;
    const root = container.current;
    if (!p || !root) return;
    const { ids: committed, scopeOf: scope, name: list } = latest.current;
    const current = liveRef.current ?? committed;
    const nodes = [...root.querySelectorAll<HTMLElement>(`[data-sort="${list}"]`)].filter((node) => node.dataset.sortId !== p.id && scope(node.dataset.sortId!) === scope(p.id));
    const without = current.filter((id) => id !== p.id);
    const before = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    const last = nodes.at(-1);
    const index = before ? without.indexOf(before.dataset.sortId!) : last ? without.indexOf(last.dataset.sortId!) + 1 : current.indexOf(p.id);
    if (index < 0) return;
    without.splice(index, 0, p.id);
    if (without.join("\n") !== current.join("\n")) show(without);
  }, [container, show]);

  const commit = useCallback((next: string[] | null) => {
    const committed = latest.current.ids;
    if (!next || next.join("\n") === committed.join("\n")) return show(null);
    void Promise.resolve(latest.current.onCommit(next)).finally(() => {
      // Normally the new order arrives and replaces this; if it does not (refused, offline), show what is stored.
      setTimeout(() => {
        if (!press.current?.started && liveRef.current === next) show(null);
      }, 4000);
    });
  }, [show]);

  const scroll = useCallback(() => {
    const p = press.current;
    const root = container.current;
    if (!p?.started || !root) return;
    const rect = root.getBoundingClientRect();
    const step = p.lastY < rect.top + EDGE ? -Math.ceil((rect.top + EDGE - p.lastY) / 6) : p.lastY > rect.bottom - EDGE ? Math.ceil((p.lastY - rect.bottom + EDGE) / 6) : 0;
    if (step !== 0) {
      root.scrollTop += step;
      place(p.lastY);
    }
    frame.current = requestAnimationFrame(scroll);
  }, [container, place]);

  const handlers = useRef<{ move: (event: PointerEvent) => void; up: (event: PointerEvent) => void; cancel: (event: PointerEvent) => void } | null>(null);

  const end = useCallback(() => {
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (handlers.current) {
      window.removeEventListener("pointermove", handlers.current.move);
      window.removeEventListener("pointerup", handlers.current.up);
      window.removeEventListener("pointercancel", handlers.current.cancel);
    }
    document.body.classList.remove("sorting");
    press.current = null;
    setDragging(null);
  }, []);

  const begin = useCallback(() => {
    const p = press.current;
    if (!p || p.started) return;
    p.started = true;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    try {
      p.element.setPointerCapture(p.pointerId);
    } catch {
      // The pointer is already gone; the up handler ends the drag.
    }
    show(liveRef.current ?? latest.current.ids);
    setDragging(p.id);
    document.body.classList.add("sorting");
    if (p.touch) navigator.vibrate?.(8);
    frame.current = requestAnimationFrame(scroll);
  }, [scroll, show]);

  if (!handlers.current) {
    handlers.current = {
      move: (event) => {
        const p = press.current;
        if (!p || event.pointerId !== p.pointerId) return;
        p.lastY = event.clientY;
        if (!p.started) {
          const distance = Math.hypot(event.clientX - p.x, event.clientY - p.y);
          // A finger that moves before the long press is scrolling; a mouse that moves is dragging.
          if (p.touch && distance > TOUCH_SLOP) end();
          else if (!p.touch && distance > MOUSE_SLOP) begin();
          return;
        }
        event.preventDefault();
        place(event.clientY);
      },
      up: (event) => {
        const p = press.current;
        if (!p || event.pointerId !== p.pointerId) return;
        if (p.started) {
          // The release is not a click on what is under it.
          const swallow = (click: MouseEvent) => {
            click.stopPropagation();
            click.preventDefault();
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
          setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
          commit(liveRef.current);
        }
        end();
      },
      // The browser took the pointer over (rare once dragging): keep where the item was dragged to.
      cancel: (event) => {
        const p = press.current;
        if (!p || event.pointerId !== p.pointerId) return;
        if (p.started) commit(liveRef.current);
        end();
      },
    };
  }

  // Touch: once dragging, the finger moves the item instead of scrolling the list, and a long press opens no menu.
  // Listeners on the list itself (not passive), so scrolling elsewhere never waits on them.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const touchMove = (event: TouchEvent) => {
      if (press.current?.started && event.cancelable) event.preventDefault();
    };
    const contextMenu = (event: Event) => {
      if (press.current?.touch) event.preventDefault();
    };
    root.addEventListener("touchmove", touchMove, { passive: false });
    root.addEventListener("contextmenu", contextMenu);
    return () => {
      root.removeEventListener("touchmove", touchMove);
      root.removeEventListener("contextmenu", contextMenu);
    };
  }, [container]);

  useEffect(() => () => end(), [end]);

  const handle = (id: string): SortableHandle => ({
    "data-sort": name,
    "data-sort-id": id,
    onPointerDown: (event) => {
      if (event.button !== 0 || press.current) return;
      if (latest.current.ignore && (event.target as Element).closest(latest.current.ignore)) return;
      const touch = event.pointerType !== "mouse";
      press.current = { id, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, lastY: event.clientY, touch, started: false, timer: null };
      if (touch) press.current.timer = setTimeout(begin, LONG_PRESS_MS);
      window.addEventListener("pointermove", handlers.current!.move);
      window.addEventListener("pointerup", handlers.current!.up);
      window.addEventListener("pointercancel", handlers.current!.cancel);
    },
    onKeyDown: (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const { ids: committed, scopeOf: scope } = latest.current;
      const current = liveRef.current ?? committed;
      const peers = current.filter((other) => scope(other) === scope(id));
      const neighbour = peers[peers.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1)];
      if (!neighbour) return;
      const next = [...current];
      const [a, b] = [next.indexOf(id), next.indexOf(neighbour)];
      [next[a], next[b]] = [next[b]!, next[a]!];
      show(next);
      commit(next);
    },
  });

  return { order: live ?? ids, dragging, handle };
}

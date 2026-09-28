import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { boardRect, clubLampRect, displayRect, doorRect, drawStreet, groundOf, mailboxRect, MIN_VIEW_H, plateRect, signRect, windowRect, type Rect } from "../../street/art.ts";
import { money, type Books } from "../../street/books.ts";
import { LOT_W, type Lot, type Street, type StreetWindow } from "../../street/layout.ts";

export interface JumpItem {
  key: string;
  label: string;
  detail: string;
  go: () => void;
}

interface Props {
  street: Street;
  night: boolean;
  books: Books;
  /** Crew waiting at the club, for its windows. */
  crew: number;
  /** Why T3 cannot be reached, pinned on the club's door; null when it can. */
  t3Notice: string | null;
  /** The building to face when the street opens: the one you just came out of. */
  focus: string | null;
  jumpItems: JumpItem[];
  onWindow: (lot: Lot, w: StreetWindow, from: DOMRect | null) => void;
  onDoor: (lot: Lot, from: DOMRect | null) => void;
  onDirectory: (lot: Lot) => void;
  onClub: () => void;
  onRent: () => void;
  onNight: () => void;
  onT3: () => void;
  /** Something is open over the street (the club, a directory, a dialog): keys belong to it. */
  busy: boolean;
}

/** Where the camera was, so coming back out of a building finds the street as you left it. */
let lastCam: number | null = null;

const motionAllowed = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whole pixels, as large as fits: the tallest building with some sky, and a whole building across (a phone shows one at a time). */
function fitScale(w: number, h: number): number {
  const byHeight = Math.floor(h / MIN_VIEW_H);
  const byWidth = Math.floor(w / (LOT_W * 1.05));
  return Math.max(1, Math.min(6, byHeight, byWidth));
}

const STATE_TAG: Partial<Record<StreetWindow["state"], string>> = { needs: "needs you", failed: "failed" };

/**
 * The block, side-on: scroll along it (drag, wheel, arrow keys, swipe), click a window to go into that room, the door
 * for the room you were last in, the brass plate for the building's directory. Words sit over the pixels: the neon
 * signs, the chalkboards with each business's spend, a tag on any window that needs you. Anyone who needs you
 * off-screen gets an arrow at the edge. Type anywhere to jump to a building, room or thread by name.
 */
export function StreetView({ street, night, books, crew, t3Notice, focus, jumpItems, onWindow, onDoor, onDirectory, onClub, onRent, onNight, onT3, busy }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const scale = size.w > 0 ? fitScale(size.w, size.h) : 3;
  const viewW = Math.ceil(size.w / scale);
  const viewH = Math.ceil(size.h / scale);
  const ground = groundOf(viewH);
  const motion = useMemo(motionAllowed, []);

  const clamp = useCallback(
    (x: number) => {
      const min = -30;
      const max = street.width + 30 - viewW;
      return max < min ? (street.width - viewW) / 2 : Math.min(max, Math.max(min, x));
    },
    [street.width, viewW],
  );

  const [cam, setCam] = useState<number>(() => lastCam ?? -8);
  const camRef = useRef(cam);
  camRef.current = cam;
  useEffect(() => {
    lastCam = cam;
  }, [cam]);

  // ---- size ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const read = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // ---- the camera: face the building you came from, or anyone who needs you, else start at the club ----
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || size.w === 0) return;
    placed.current = true;
    const target = street.lots.find((lot) => lot.project?.id === focus) ?? (lastCam === null ? street.lots.find((lot) => lot.needs > 0) : undefined);
    if (target) setCam(clamp(target.x + target.width / 2 - viewW / 2));
    else setCam((x) => clamp(x));
  }, [size.w, street.lots, focus, clamp, viewW]);
  useEffect(() => {
    if (placed.current) setCam((x) => clamp(x));
  }, [clamp]);

  const glide = useRef(0);
  const glideTo = useCallback(
    (target: number) => {
      cancelAnimationFrame(glide.current);
      const to = clamp(target);
      if (!motion) {
        setCam(to);
        return;
      }
      const from = camRef.current;
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / 320);
        const eased = 1 - (1 - p) ** 3;
        setCam(from + (to - from) * eased);
        if (p < 1) glide.current = requestAnimationFrame(step);
      };
      glide.current = requestAnimationFrame(step);
    },
    [clamp, motion],
  );
  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  // ---- drawing ----
  const frameRef = useRef({ street, night, crew, cam, viewW, viewH, dirty: true });
  frameRef.current = { street, night, crew, cam, viewW, viewH, dirty: true };
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    let drawn: unknown = null;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const f = frameRef.current;
      const changed = drawn !== f;
      if (!changed && (!motion || t - last < 66)) return;
      if (f.viewW <= 0 || f.viewH <= 0) return;
      drawn = f;
      last = t;
      drawStreet(ctx, { street: f.street, camX: f.cam, viewW: f.viewW, viewH: f.viewH, night: f.night, crew: f.crew, t: motion ? t : 0 });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [motion]);

  // ---- moving along the street ----
  const drag = useRef<{ x: number; cam: number; id: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      if (busy) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      cancelAnimationFrame(glide.current);
      setCam((x) => clamp(x + delta / scale));
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [busy, clamp, scale]);

  const [jump, setJump] = useState<string | null>(null);
  useEffect(() => {
    if (busy || jump !== null) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        glideTo(camRef.current + (event.key === "ArrowRight" ? 1 : -1) * LOT_W);
      } else if (event.key === "Home") glideTo(-30);
      else if (event.key === "End") glideTo(street.width);
      else if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault();
        setJump(event.key);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, jump, glideTo, street.width]);

  // ---- placing words and buttons over the pixels ----
  const at = (r: Rect): CSSProperties => ({ left: (r.x - cam) * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale });
  const inView = (lot: Lot) => lot.x + lot.width > cam - 20 && lot.x < cam + viewW + 20;
  const rectOf = (element: HTMLElement | null) => element?.getBoundingClientRect() ?? null;

  const needLots = street.lots.filter((lot) => lot.needs > 0);
  const offLeft = needLots.filter((lot) => lot.x + lot.width < cam);
  const offRight = needLots.filter((lot) => lot.x > cam + viewW);
  const firstNeed = (lot: Lot) => [...lot.windows, ...lot.hidden].find((w) => w.state === "needs") ?? null;

  const style = { "--s": scale } as CSSProperties;

  return (
    <div
      ref={wrapRef}
      className={`street${night ? " is-night" : " is-day"}`}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, cam: camRef.current, id: event.pointerId, moved: false };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        const dx = event.clientX - d.x;
        if (!d.moved && Math.abs(dx) > 5) {
          d.moved = true;
          cancelAnimationFrame(glide.current);
          wrapRef.current?.setPointerCapture(d.id);
        }
        if (d.moved) setCam(clamp(d.cam - dx / scale));
      }}
      onPointerUp={() => {
        if (drag.current?.moved) swallowClick.current = true;
        drag.current = null;
        window.setTimeout(() => (swallowClick.current = false), 0);
      }}
      onPointerCancel={() => (drag.current = null)}
      onClickCapture={(event) => {
        if (swallowClick.current) {
          event.stopPropagation();
          event.preventDefault();
          swallowClick.current = false;
        }
      }}
    >
      <canvas ref={canvasRef} className="street-canvas" width={Math.max(1, viewW)} height={Math.max(1, viewH)} style={{ width: viewW * scale, height: viewH * scale }} aria-hidden="true" />

      <div className="st-streetsign" aria-hidden="true">
        <span>Mulberry St</span>
      </div>
      <p className="st-hint">Drag or scroll along the street · click a window or a door to go in · type a name to jump</p>

      <nav className="st-overlay" aria-label="The street">
        {street.lots.filter(inView).map((lot) => {
          if (lot.kind === "club") {
            const shop = displayRect(lot, ground);
            return (
              <div key="club" className="st-lot">
                <div className="st-sign is-club" style={at(signRect(lot, ground))}>
                  Social Club
                </div>
                <button type="button" className="st-clubboard" style={at({ x: shop.x + 8, y: shop.y + 4, w: shop.w - 16, h: shop.h - 9 })} onClick={onClub} aria-label="The club: the family, settings and the books">
                  {books.today !== null ? <span>Today {money(books.today)}</span> : null}
                  <span>{books.today !== null ? "All" : "The books"} {money(books.total)}</span>
                </button>
                <button type="button" className="st-hit" style={at(doorRect(lot, ground))} onClick={onClub} aria-label="Go into the social club: the family, settings and the books" title="The social club" />
                {Array.from({ length: lot.floors * 3 }, (_, i) => (
                  <button key={i} type="button" className="st-hit" style={at(windowRect(lot, i, ground))} onClick={onClub} tabIndex={-1} aria-hidden="true" />
                ))}
                <button
                  type="button"
                  className="st-hit st-lamp"
                  style={at(clubLampRect(lot, ground))}
                  onClick={onNight}
                  aria-label={night ? "Turn the street to day (light theme)" : "Turn the street to night (dark theme)"}
                  title={night ? "Day" : "Night"}
                />
                {t3Notice ? (
                  <button type="button" className="st-notice" style={at({ x: doorRect(lot, ground).x - 3, y: doorRect(lot, ground).y + 2, w: 22, h: 12 })} onClick={onT3} title={t3Notice}>
                    No line to T3
                  </button>
                ) : null}
              </div>
            );
          }
          if (lot.kind === "rent") {
            return (
              <div key="rent" className="st-lot">
                <div className="st-sign is-rent" style={at(signRect(lot, ground))}>
                  For Rent
                </div>
                <button type="button" className="st-hit st-rent" style={at({ ...displayRect(lot, ground), w: doorRect(lot, ground).x + 16 - displayRect(lot, ground).x })} onClick={onRent} aria-label="Open a new business: add a project" title="Add a project">
                  <span>+ New business</span>
                </button>
              </div>
            );
          }
          const project = lot.project!;
          const spend = books.byProject.get(project.id);
          const hiddenNeeds = lot.hidden.filter((w) => w.state === "needs").length;
          return (
            <div key={project.id} className="st-lot">
              <div className={`st-sign${night ? " is-neon" : ""}`} style={at(signRect(lot, ground))} title={project.workspaceRoot ?? undefined}>
                {project.title || "…"}
              </div>
              <div className="st-glass" style={at({ ...displayRect(lot, ground), h: 7 })} aria-hidden="true">
                {lot.business?.word}
              </div>
              {lot.windows.map((w, i) => {
                const tag = STATE_TAG[w.state];
                return (
                  <button
                    key={`${w.kind}:${w.id}`}
                    type="button"
                    className={`st-window is-${w.state}`}
                    style={at(windowRect(lot, i, ground))}
                    aria-label={`${w.kind === "room" ? "Room" : "Thread"} ${w.title}: ${w.label}`}
                    onClick={(event) => onWindow(lot, w, rectOf(event.currentTarget))}
                  >
                    <span className="st-tip" role="presentation">
                      <b>{w.title}</b>
                      <span>{w.label}</span>
                    </span>
                    {tag ? <span className="st-tag">{tag}</span> : null}
                  </button>
                );
              })}
              <button
                type="button"
                className="st-hit st-door"
                style={at(doorRect(lot, ground))}
                aria-label={`Go into ${project.title || "this business"}`}
                title={`Go in: ${project.title}`}
                onClick={(event) => onDoor(lot, rectOf(event.currentTarget))}
              />
              <button
                type="button"
                className="st-hit st-plate"
                style={at(plateRect(lot, ground))}
                aria-label={`Directory of ${project.title}: ${lot.windows.length + lot.hidden.length} rooms and threads${lot.settled.length ? `, ${lot.settled.length} settled` : ""}`}
                title="Directory"
                onClick={() => onDirectory(lot)}
              >
                {hiddenNeeds > 0 ? <span className="st-tag is-plate">{hiddenNeeds} inside</span> : null}
              </button>
              {lot.unseen > 0 ? (
                <button
                  type="button"
                  className="st-mail"
                  style={at(mailboxRect(lot, ground))}
                  aria-label={`${lot.unseen} new repl${lot.unseen === 1 ? "y" : "ies"} in ${project.title}`}
                  title="New replies"
                  onClick={(event) => {
                    const w = [...lot.windows, ...lot.hidden].find((x) => x.unseen > 0);
                    if (w) onWindow(lot, w, rectOf(event.currentTarget));
                  }}
                >
                  <span>{lot.unseen}</span>
                </button>
              ) : null}
              <button type="button" className="st-board" style={at(boardRect(lot, ground))} onClick={() => onDirectory(lot)} title="What this business has spent, estimated at list price" aria-label={`${project.title} has spent ${spend !== undefined ? money(spend) : "…"}, estimated`}>
                {spend !== undefined ? money(spend) : "…"}
              </button>
            </div>
          );
        })}
      </nav>

      {offLeft.length > 0 ? (
        <button type="button" className="st-arrow is-left" onClick={() => onWindow(offLeft.at(-1)!, firstNeed(offLeft.at(-1)!)!, null)} title="Go straight to them">
          ◀ {offLeft.length === 1 ? `${offLeft[0]!.project?.title} needs you` : `${offLeft.length} need you`}
        </button>
      ) : null}
      {offRight.length > 0 ? (
        <button type="button" className="st-arrow is-right" onClick={() => onWindow(offRight[0]!, firstNeed(offRight[0]!)!, null)} title="Go straight to them">
          {offRight.length === 1 ? `${offRight[0]!.project?.title} needs you` : `${offRight.length} need you`} ▶
        </button>
      ) : null}

      {jump !== null ? <JumpBox initial={jump} items={jumpItems} onClose={() => setJump(null)} /> : null}
    </div>
  );
}

/** Type a name, go there: buildings, rooms and threads. */
function JumpBox({ initial, items, onClose }: { initial: string; items: JumpItem[]; onClose: () => void }) {
  const [query, setQuery] = useState(initial);
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? items.filter((item) => item.label.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q)) : items).slice(0, 8);
  }, [items, query]);
  const choose = (item: JumpItem | undefined) => {
    if (!item) return;
    onClose();
    item.go();
  };
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(matches.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(matches[index]);
    }
  };
  return (
    <div className="st-jump" role="dialog" aria-label="Go to">
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={onKey}
        onBlur={() => window.setTimeout(onClose, 150)}
        placeholder="Go to a business, room or thread"
        aria-label="Go to a business, room or thread"
      />
      <ul>
        {matches.map((item, i) => (
          <li key={item.key}>
            <button type="button" className={i === index ? "is-on" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>
              <b>{item.label}</b>
              <span>{item.detail}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 ? <li className="st-jump-none">Nothing by that name</li> : null}
      </ul>
    </div>
  );
}

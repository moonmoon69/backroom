/**
 * The keyboard rehearsal (U1): `node scripts/rehearse.ts --step keys --as <rooms-browser key> [--port …] [--data …]`.
 *
 * rehearse.ts starts the throwaway service and seats the room (a Consigliere, a worker, a reviewer); this module adds
 * a second and a third room and a thread outside rooms through the API, and a long board of room notes on the journal
 * (src/briefing/envelope.ts's ROOM_NOTE, as journals from before N1 hold them), then drives the page with
 * `rooms-browser … press` and nothing else: never a click, a fill or a command that moves the user (but for two states of
 * the mouse on a tile's member line, a hover and a click, which are what they check). Each state checks
 * the page and the API: which item has the focus (its `data-nav-key`, read with `eval`), that the browser draws its ring
 * (`:focus-visible` with an outline, the card's ring or the pixel brackets), that assistive technology gets it (the page
 * snapshot's `focused` line carries a role and a name), what is open (the drawer's `data-view`/`data-id`, a dialog, a
 * menu, the side panel) against what the API says it should be (the room's ID and title, the post's number and seq, the
 * member's thread). Every state then checks the key bar (K1-1, KeyBar.tsx): drawn at the foot of the window, naming what
 * the ring is on as the API names it (a room's title, a post's number, a member's alias), reads the console (no
 * error-level line) and keeps a screenshot, the bar in it; every key on the bar is drawn whole and none is left out (at
 * this window the whole bar fits). One state draws every place's bar from the key table (keyOrder.ts) in the page, the
 * where-text at its widest, and checks each fits the window. Six states read the whole bar, every key with its words:
 * the overview with nothing focused, a room's tile, a post, the composer, a room with nothing in it focused, and the
 * Browser panel itself holding the ring.
 *
 * Esc and Backspace (K1-2): Esc closes what is in front (a menu, the composer, a chip's choices, a correction, a dialog,
 * the keys) and never the room, a member's thread, a thread or the side panel; Backspace outside a text field closes the
 * same things first, then a member's thread, the panel and the room in turn; in a dialog's text field it deletes.
 *
 * A room's lanes (K1-4): a room opens with the ring on the first status chip that needs you (a room with an approval
 * waiting), else on its newest post; Up from the first post goes on to the status chips, the room state (written by the
 * Consigliere with rooms-board state) and the header, the key bar naming each as the API names it; Left and Right go
 * along the header (Enter on the Board tab shows the board, on Members opens the panel with the ring in it) and along
 * the status chips; Home and End go to the first and last post from every lane. A room opened while a turn runs puts
 * the ring on something in view (the newest post if it shows, else the running turn's chip) without moving the board,
 * which stays at its bottom and follows the turn (its live bubble made tall with a style, as the fake streams no feed);
 * with the room's desk read held back past the landing's wait, the ring lands again when it comes, unless a key moved it.
 *
 * The overview's grid (K1-3): its stops are the tiles (every room, thread, crew member and browser of the API has one,
 * and a room's members are read on its tile, not visited) and the buttons of its rows (the header, each section's +).
 * With four tiles on three columns the fourth sits under the first, so Down from that room's tile reaches the tile
 * below, then Crew's head, a crew member, Browsers' head and a browser, keeping to the column it began in; Up from the
 * first row reaches its section's + and then the header, which is the top, and from a page scrolled to its foot each stop
 * on the way up is brought into view below the sticky header, not under it (in both looks); Left and Right stop at a
 * row's ends. A crew
 * member is seated in a room by keys alone, from its Edit dialog's Seat in a room…, and the API shows the new member.
 * The mouse does the same (#499, #507): hovering a member's line on a tile hovers the tile, not the member, and the ring
 * and the key bar stay on the room; a click on it opens the room's conversation, not the member's thread.
 * Every other move on the overview (goTo) follows the grid's own function (keyOrder.ts, gridTarget), each step checked
 * on the page.
 *
 * A post's actions (K1-5): Enter on a post opens its action strip under it, the ring on its first button; Left and Right
 * choose and stop at its ends (the side panel stays folded); Esc and Backspace close it with the ring back on the post;
 * Up and Down leave it for the post above or below (a running turn's live bubble after the newest post, then the
 * composer's strip), and a letter for the composer; it stays open past a poll. Each button does what the post's own does,
 * checked in the API: Correct… opens its box in place and Enter sends it (in a post's Detail too), Cancel, Retry and
 * Dismiss on failed turns, Stop on a live bubble; on a reply Copy (the clipboard stubbed), Read aloud (speechSynthesis
 * stubbed), a file chip's preview (a file in a project of the run's own) and "turn in T3"; Detail, last, the post's
 * detail, the ring back on Detail when it closes. A live bubble with an approval offers its choices.
 */
import { ROOM_NOTE } from "../src/briefing/envelope.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { barDoes, barEntries, gridTarget, KEYS, type Boxed, type KeyWhen, type NavKey, type Span } from "../web/src/keyOrder.ts";

// The parts of rehearse.ts this step uses (its classes, by shape).
export interface KeysService {
  base: string;
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  command<T = any>(command: Record<string, unknown>): Promise<T>;
  fake(action: string, body: Record<string, unknown>): Promise<any>;
}
export interface KeysBrowser {
  on(...args: string[]): string;
  eval<T>(fn: string): T;
  poll<T>(what: string, fn: string, ok: (value: T) => boolean, ms?: number): T;
  open(): void;
  waitFor(text: string): void;
  consoleClean(): void;
  screenshot(name: string): void;
}
type Alias = "fable" | "worker" | "reviewer";
export interface KeysRoom {
  roomId: string;
  readonly participant: Record<Alias, string>;
  readonly seat: Record<Alias, string>;
  readonly thread: Record<Alias, string>;
  /** The run's data folder (the throwaway service's): files the rehearsal needs live here, never in a temp folder. */
  readonly dataDir: string;
  snapshot(): Promise<any>;
  post(snapshot: any, requestId: string): any;
  message(text: string): Promise<string>;
  live(alias: Alias, phases?: string[]): Promise<any>;
  finish(alias: Alias, text: string, extra?: { outcome?: "completed" | "error" | "interrupted"; progress?: string[]; files?: unknown[] }): Promise<void>;
  settle(alias: Alias): Promise<void>;
  second(title: string, aliases: string[]): Promise<{ roomId: string; participant: Record<string, string>; snapshot: () => Promise<any> }>;
  /** Appends engine commands to the room's journal through a second connection, as another process would. */
  journal(commands: Array<Record<string, unknown>>): void;
  /** A member's rooms-board command, with its own key. */
  board(alias: Alias, ...args: string[]): string;
}
export interface KeysTools {
  log: (line: string) => void;
  fail: (message: string) => never;
  until: <T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms?: number, every?: number) => Promise<T>;
  sleep: (ms: number) => Promise<unknown>;
}

/** What the page says about the focus, read in one `eval`. */
interface Focus {
  key: string | null;
  tag: string | null;
  role: string | null;
  label: string;
  visible: boolean;
  ring: boolean;
  drawers: Array<{ view: string | null; id: string | null; inert: boolean; label: string | null }>;
  inLayer: string | null;
  dialog: string | null;
  menu: boolean;
  panel: string | null;
  view: "chat" | "board" | null;
  help: boolean;
  posts: number;
  /** The focus is inside a dialog. */
  inDialog: boolean;
  /** The focused field's value (a textarea or input), else null. */
  value: string | null;
  expanded: string | null;
  /** Any composer open (a visible one or one under a layer). */
  composerOpen: boolean;
  /** The draft the room's closed composer shows, under whatever covers it. */
  roomDraft: string | null;
  /** The open dialog's scrolled body: how far it is scrolled and how much it can be. */
  dialogBody: { top: number; more: number } | null;
  /** The focus is on a status chip of the work bar. */
  chip: boolean;
  /** A status chip's choices are open under the work bar. */
  chipOpen: boolean;
  /** A correction (Correct…'s box) is open where the keys reach it. */
  correctionOpen: boolean;
  /** The focus is in a request's block: its Correct…, Cancel, or its open correction. */
  inCorrection: boolean;
  /** Action strips on the page (K1-5): there is at most one. */
  strips: number;
  /** The focused button of an action strip (its `data-action`: "correct:88", "copy:0", "detail"), else null. */
  action: string | null;
  /** The item the focus is in or on (its `data-nav-key`): a strip's button is in its post. */
  item: string | null;
  /** The focused button's aria-pressed (a strip's choice, Read aloud). */
  pressed: string | null;
}

const FOCUS = `() => {
  const a = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const style = a ? getComputedStyle(a) : null;
  const card = a ? a.closest('[data-nav-card]') : null;
  const outline = Boolean(style && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0);
  const cardRing = Boolean(card && /0px 0px 0px 2px/.test(getComputedStyle(card).boxShadow));
  const brackets = Boolean(a && getComputedStyle(a, '::after').backgroundImage !== 'none');
  const drawers = [...document.querySelectorAll('.ov-drawer')].map((d) => ({ view: d.dataset.view ?? null, id: d.dataset.id ?? null, inert: Boolean(d.closest('[inert]')), label: d.getAttribute('aria-label') }));
  const layer = a ? a.closest('.ov-drawer') : null;
  const sheet = document.querySelector('.ov-drawer:not([inert] .ov-drawer) .sheet');
  return {
    key: a?.dataset?.navKey ?? null,
    tag: a?.tagName ?? null,
    role: a?.getAttribute('role') ?? null,
    label: (a?.getAttribute('aria-label') ?? a?.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 90),
    visible: Boolean(a && a.matches(':focus-visible')),
    ring: Boolean(a && a.matches(':focus-visible') && (outline || cardRing || brackets)),
    drawers,
    inLayer: layer ? (layer.dataset.view ?? null) : null,
    dialog: document.querySelector('.dialog')?.getAttribute('aria-label') ?? null,
    menu: Boolean(document.querySelector('.menu')),
    panel: document.querySelector('.inspector')?.dataset.navPane ?? null,
    view: sheet ? (sheet.classList.contains('sheet-board') ? 'board' : 'chat') : null,
    help: Boolean(document.querySelector('.key-help')),
    posts: document.querySelectorAll('.timeline [data-nav="post"]').length,
    inDialog: Boolean(a && a.closest('.dialog')),
    value: a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') ? a.value : null,
    expanded: a?.getAttribute('aria-expanded') ?? null,
    composerOpen: Boolean(document.querySelector('.composer-overlay')),
    roomDraft: document.querySelector('.ov-layer:not(.ov-layer-member) .strip-draft-text')?.textContent ?? null,
    dialogBody: (() => { const b = document.querySelector('.dialog .dialog-body'); return b ? { top: Math.round(b.scrollTop), more: b.scrollHeight - b.clientHeight } : null; })(),
    chip: Boolean(a && a.classList.contains('work-chip')),
    chipOpen: Boolean(document.querySelector('.work-open')),
    correctionOpen: [...document.querySelectorAll('.req-correct')].some((e) => !e.closest('[inert]')),
    inCorrection: Boolean(a && a.closest('.req-block')),
    strips: document.querySelectorAll('.action-strip').length,
    action: a && a.closest('.action-strip') ? (a.dataset.action ?? null) : null,
    item: a?.closest('[data-nav]')?.dataset.navKey ?? null,
    pressed: a?.getAttribute('aria-pressed') ?? null,
  };
}`;

/** The open action strip's buttons, by the names they are announced with (and its first's `data-action`), and the item it is on. */
const STRIP = `() => {
  const s = document.querySelector('.action-strip');
  return s ? { item: s.closest('[data-nav]')?.dataset.navKey ?? null, label: s.getAttribute('aria-label'), first: s.querySelector(':scope > button')?.dataset.action ?? null, names: [...s.querySelectorAll(':scope > button')].map((b) => b.getAttribute('aria-label')) } : null;
}`;

/**
 * The open room's board: how far it is from its bottom, its newest post (its key, how much of it shows in the board's
 * view, its height), its live bubble's height, and whether a live feed is drawn (it comes with the room's desk read).
 */
const BOARD = `() => {
  const t = document.querySelector('.ov-drawer[data-view="room"] .timeline');
  if (!t) return null;
  const post = [...t.querySelectorAll('[data-nav="post"]')].at(-1);
  const v = t.getBoundingClientRect();
  const r = post ? post.getBoundingClientRect() : null;
  const bubble = t.querySelector('.bubble-live');
  return {
    distance: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight),
    newest: post ? post.dataset.navKey : null,
    shown: r ? Math.round(Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)) : 0,
    height: r ? Math.round(r.height) : 0,
    bubble: bubble ? Math.round(bubble.getBoundingClientRect().height) : 0,
    view: Math.round(v.height),
    feed: Boolean(t.querySelector('.live-feed:not(.live-empty)')),
  };
}`;

/**
 * The overview's stops as keys.ts boxes them (overviewItems), by their keys: a tile by its card, a button in a row by
 * itself, a disabled one left out; the stray ones too (anything else with `data-nav` or focusable on a tile's members).
 */
const GRID = `() => {
  const root = document.querySelector('.overview');
  const page = root.scrollTop - root.getBoundingClientRect().top;
  const head = root.querySelector('.overview-head');
  const atTop = head ? -head.getBoundingClientRect().top : page;
  return [...root.querySelectorAll('[data-nav="ov"]')].filter((e) => e.getClientRects().length > 0 && !e.closest('[inert], [hidden]') && !e.matches(':disabled')).map((e) => {
    const card = e.closest('[data-nav-card]');
    const r = (card ?? e).getBoundingClientRect();
    const y = head && head.contains(e) ? atTop : page;
    return { element: e.dataset.navKey, left: r.left, right: r.right, top: r.top + y, bottom: r.bottom + y, tile: card !== null, needs: Boolean(card && card.matches('.needs')) };
  });
}`;

type Grid = Array<Boxed<string>>;

/** The key bar as the window shows it: where it is, what it names, and each key with its words ("Enter open the room"). */
interface Bar {
  shown: boolean;
  /** Its foot is the window's, its whole height inside it. */
  foot: boolean;
  place: string | null;
  where: string;
  keys: string[];
  /** The key at its right end (`? all keys`), if there is one. */
  end: string | null;
  /** Keys drawn in part (cut by the bar's edge or the line's). */
  cut: string[];
  /** Keys left out because they did not fit (KeyBar.tsx). */
  left: number;
}

const BAR = `() => {
  const b = document.querySelector('.key-bar');
  if (!b) return { shown: false, foot: false, place: null, where: '', keys: [], end: null, cut: [], left: 0 };
  const r = b.getBoundingClientRect();
  const chip = (k) => [...k.querySelectorAll('kbd')].map((x) => x.textContent).join(' ') + ' ' + k.querySelector('.key-bar-does').textContent;
  const line = b.querySelector('.key-bar-keys');
  const box = line.getBoundingClientRect();
  const shown = [...line.querySelectorAll('.key-bar-key')].filter((k) => !k.hidden && k.getClientRects().length > 0);
  const end = b.querySelector('.key-bar-end');
  // Whole: inside the line (a key of the line) or inside the bar (the end key), to the half pixel.
  const whole = (k, outer) => { const c = k.getBoundingClientRect(); return c.left >= outer.left - 0.5 && c.right <= outer.right + 0.5; };
  return {
    shown: r.height > 0 && getComputedStyle(b).display !== 'none' && getComputedStyle(b).visibility !== 'hidden',
    foot: Math.abs(r.bottom - innerHeight) < 1 && r.top >= 0,
    place: b.dataset.place ?? null,
    where: b.querySelector('.key-bar-where').textContent,
    keys: shown.map(chip),
    end: end ? chip(end) : null,
    cut: [...shown.filter((k) => !whole(k, box)), ...(end && !whole(end, r) ? [end] : [])].map(chip),
    left: Number(line.dataset.left ?? 0),
  };
}`;

/**
 * Every place's whole bar (each place of the key table with each mix of what can hold), drawn in the page with its own
 * CSS at the foot of the window, the where-text past its widest: the width its keys take against the width their line
 * has. Returns the places whose keys do not fit.
 */
function everyBarFits(): string {
  const conditions: KeyWhen[] = ["typing", "empty", "correcting", "composer-open", "chip-open", "panel-open", "help"];
  const mixes = Array.from({ length: 1 << conditions.length }, (_, mask) => conditions.filter((_, i) => mask & (1 << i)));
  const bars = new Map<string, { id: string; keys: Array<{ k: string[]; d: string }>; end: { k: string[]; d: string } | null }>();
  for (const place of KEYS.flatMap((area) => area.places)) {
    for (const now of mixes) {
      const entries = barEntries(place.id, now);
      const help = entries.find((entry) => entry.keys.includes("?"));
      // Enter in an action strip is named by its button, cut on the bar: drawn at its longest.
      const keys = entries.filter((entry) => entry !== help).map((entry) => ({ k: entry.keys, d: barDoes(entry, "Mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm") }));
      const signature = JSON.stringify([keys, help?.does ?? null]);
      if (!bars.has(signature)) bars.set(signature, { id: `${place.id}${now.length > 0 ? ` (${now.join(", ")})` : ""}`, keys, end: help ? { k: help.keys, d: help.does } : null });
    }
  }
  return `() => {
    const bars = ${JSON.stringify([...bars.values()])};
    const text = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const chip = (c, end) => '<span class="key-bar-key' + (end ? ' key-bar-end' : '') + '">' + c.k.map((k) => '<kbd>' + text(k) + '</kbd>').join('') + '<span class="key-bar-does">' + text(c.d) + '</span></span>';
    const over = [];
    for (const b of bars) {
      const bar = document.createElement('div');
      bar.className = 'key-bar';
      bar.setAttribute('aria-hidden', 'true');
      bar.innerHTML = '<span class="key-bar-where">' + 'A where-text longer than the bar ever shows it, cut by its ellipsis' + '</span><span class="key-bar-keys">' + b.keys.map((c) => chip(c, false)).join('') + '</span>' + (b.end ? chip(b.end, true) : '');
      document.body.append(bar);
      const line = bar.querySelector('.key-bar-keys').getBoundingClientRect();
      const chips = [...bar.querySelectorAll('.key-bar-keys .key-bar-key')].map((c) => c.getBoundingClientRect());
      const end = bar.querySelector('.key-bar-end')?.getBoundingClientRect();
      const need = chips.length > 0 ? chips.at(-1).right - line.left : 0;
      if (need > line.width + 0.5 || (end && end.right > bar.getBoundingClientRect().right + 0.5)) over.push(b.id + ': needs ' + Math.ceil(need) + ' px, has ' + Math.floor(line.width));
      bar.remove();
    }
    return { bars: bars.length, width: innerWidth, over };
  }`;
}

const ARROWS: Array<[NavKey, string]> = [["down", "ArrowDown"], ["up", "ArrowUp"], ["right", "ArrowRight"], ["left", "ArrowLeft"]];

/**
 * The fewest arrow presses from one stop to another on the grid, as the page moves (gridTarget): a run of Up and Down
 * keeps to the column it began in, Left and Right end the run. Each step: the key and where it lands.
 */
function route(grid: Grid, from: string, to: string): Array<{ press: string; to: string }> | null {
  const queue: Array<{ at: string; column: Span | undefined; path: Array<{ press: string; to: string }> }> = [{ at: from, column: undefined, path: [] }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (state.at === to) return state.path;
    const id = `${state.at}|${state.column ? `${state.column.left},${state.column.right}` : ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const at = grid.findIndex((p) => p.element === state.at);
    for (const [key, press] of ARROWS) {
      const vertical = key === "up" || key === "down";
      const next = gridTarget(grid, at, key, vertical ? state.column : undefined);
      if (!next || next.element === state.at) continue;
      queue.push({ at: next.element, column: vertical ? (state.column ?? grid[at]) : undefined, path: [...state.path, { press, to: next.element }] });
    }
  }
  return null;
}

export async function rehearseKeys(service: KeysService, browser: KeysBrowser, room: KeysRoom, tools: KeysTools): Promise<string[]> {
  const { log, fail, until, sleep } = tools;
  const passed: string[] = [];
  const R = room.roomId;
  const short = (key: string | null) => (key ? key.replace(/([0-9a-f]{8})[0-9a-f-]{28}/g, "$1") : String(key));

  // ---------------- the page, by keys only ----------------

  const press = (key: string) => {
    browser.on("press", key);
    log(`  press ${key}`);
  };
  const focus = (): Focus => browser.eval<Focus>(FOCUS);
  /** Wait until the focus (and whatever else `ok` asks of the page) is as expected; fail with what the page shows. */
  const expect = async (what: string, ok: (f: Focus) => boolean, ms = 6000): Promise<Focus> => {
    let last: Focus | null = null;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      last = focus();
      if (ok(last)) {
        log(`  focus: ${what} (${short(last.key) ?? last.tag} "${last.label.slice(0, 60)}"${last.ring ? ", ring drawn" : ""})`);
        return last;
      }
      await sleep(150);
    }
    return fail(`expected ${what}; the page shows ${JSON.stringify({ ...last, key: short(last?.key ?? null) })}`);
  };
  /** The focused item is keyboard-visible (its ring drawn) and announced (a role and a name in the page snapshot). */
  const announced = (role: RegExp, name: RegExp | string): void => {
    const snapshot = browser.on("snapshot");
    const line = snapshot.split("\n").find((l) => /\bfocused\b/.test(l));
    const parsed = line ? /uid=\S+ (\S+) "([^"]*)"/.exec(line) : null;
    if (!parsed) return fail(`the page snapshot has no focused element with a role and a name: ${line ?? "(no focused line)"}`);
    const [, gotRole, gotName] = parsed;
    const nameOk = typeof name === "string" ? gotName!.includes(name) : name.test(gotName!);
    if (!role.test(gotRole!) || !nameOk) fail(`the focused element is announced as ${gotRole} "${gotName}", expected ${role} "${name}"`);
    log(`  announced: ${gotRole} "${gotName!.slice(0, 70)}"`);
  };
  /**
   * The key bar, once it names `where` (a string is the whole name, a pattern its start) with every key drawn whole and
   * none left out; fails with what it shows.
   */
  const keyBar = async (where: string | RegExp, ms = 6000): Promise<Bar> => {
    let last: Bar | null = null;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      last = browser.eval<Bar>(BAR);
      if (last.shown && last.foot && (typeof where === "string" ? last.where === where : where.test(last.where)) && last.cut.length === 0 && last.left === 0) return last;
      await sleep(150);
    }
    return fail(`expected the key bar at the foot of the window naming ${where}, every key whole and none left out; it shows ${JSON.stringify(last)}`);
  };
  /** A state of the page: the key bar names what the ring is on (`where`), the console is clean, and a screenshot. */
  const state = async (name: string, where: string | RegExp) => {
    const bar = await keyBar(where);
    log(`  key bar: "${bar.where}" · ${[...bar.keys, bar.end ?? "(no ?)"].join(" · ")}`);
    browser.consoleClean();
    browser.screenshot(name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase());
    passed.push(name);
    log(`PASS ${name}`);
  };
  /** The whole key bar, as the user reads it: what the ring is on, each key with its words, and the key at its end. */
  const barSays = async (what: string, want: { place: string; where: string; keys: string[]; end: string | null }) => {
    const bar = await keyBar(want.where);
    const got = { place: bar.place, where: bar.where, keys: bar.keys, end: bar.end };
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(`the key bar on ${what} reads ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    log(`  key bar on ${what}: "${bar.where}" · ${[...bar.keys, bar.end ?? "(no ?)"].join(" · ")}`);
  };
  /**
   * What the bar calls an overview stop, from the API: a room's title, a thread's title, a crew member's or a browser's
   * name; a button in a row by its name (a section's + by the project's title from T3's list).
   */
  const overviewWhere = async (key: string): Promise<string> => {
    const [kind, id, more] = key.split(":");
    const heads: Record<string, string> = { project: "New project", arrange: "Arrange", settings: "Settings", crew: "New crew member", browsers: "New browser" };
    if (kind === "head" && heads[id!]) return heads[id!]!;
    if (kind === "head" && id === "room") {
      const project = (await service.call<Array<{ id: string; title: string }>>("GET", "/api/t3/projects")).find((p) => p.id === more);
      if (project) return `New room in ${project.title}`;
    }
    const view = await service.call<{ rooms: Array<{ id: string; title: string }>; threads: Array<{ id: string; title: string }> }>("GET", "/api/overview");
    const apiRoom = view.rooms.find((r) => r.id === id);
    if (kind === "room" && apiRoom) return apiRoom.title;
    const thread = view.threads.find((t) => t.id === id);
    if (kind === "thread" && thread) return thread.title;
    const browserItem = kind === "browser" ? (await service.call<Array<{ id: string; name: string }>>("GET", "/api/browsers")).find((b) => b.id === id) : undefined;
    if (browserItem) return `${browserItem.name} · browser`;
    const preset = kind === "preset" ? (await service.call<Array<{ id: string; name: string }>>("GET", "/api/presets")).find((p) => p.id === id) : undefined;
    if (preset) return `${preset.name} · crew member`;
    return fail(`the API has no ${short(key)} for the key bar to name`);
  };
  /** What the bar calls a post: its number from the API, then what it is ("#64 · note from you"). */
  const postWhere = async (key: string | null): Promise<RegExp> => {
    const post = (await room.snapshot()).posts.find((p: any) => `post:${p.seq}` === key);
    if (!post) return fail(`the focused ${key} is not a post of the API's snapshot`);
    return new RegExp(`^#${post.number} · \\S`);
  };
  /**
   * The composer opened by a letter and made to hold exactly that letter, by keys only (as rehearse.ts's compose()
   * makes a draft exact, without its click and fill): the page puts the letter in itself (insertText, which React
   * sees); a draft that was there already is selected and deleted with keys and the letter typed again.
   */
  const compose = (letter: string): void => {
    const value = "() => document.querySelector('textarea[aria-label=\"Message\"]')?.value ?? null";
    press(letter);
    const first = browser.poll<string | null>("the composer to open", value, (v) => v !== null);
    if (first !== letter) {
      press("Control+a");
      press("Backspace");
      browser.poll<string | null>("the composer to be empty", value, (v) => v === "");
      press(letter);
    }
    browser.poll<string | null>(`the composer to hold ${JSON.stringify(letter)}`, value, (v) => v === letter);
  };
  /** The overview's stops once they hold still (its polls rank the tiles: news, busy, needs you), as the page boxes them. */
  const settledGrid = async (): Promise<Grid> => {
    let previous = "";
    return until("the overview to hold still", async () => {
      const grid = browser.eval<Grid>(GRID);
      const signature = grid.map((p) => `${p.element}@${Math.round(p.left)},${Math.round(p.top)},${Math.round(p.bottom)}`).join(" ");
      const same = signature === previous;
      previous = signature;
      if (!same) await sleep(1200);
      return same ? grid : null;
    }, 30_000, 100);
  };
  /** How far the overview is scrolled, and how far it can be. */
  const scrolled = () => browser.eval<{ top: number; more: number }>("() => { const o = document.querySelector('.overview'); return { top: Math.round(o.scrollTop), more: o.scrollHeight - o.clientHeight }; }");
  /**
   * The ring's stop in sight, not under the sticky header: its top below the header's foot, and the page's element at
   * its middle (elementFromPoint) the stop itself or inside it.
   */
  const inSight = async (key: string, what: string): Promise<void> => {
    const seen = browser.eval<{ hit: string; top: number; head: number }>(
      `() => { const e = document.querySelector('[data-nav-key="${key}"]'); const r = e.getBoundingClientRect(); const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return { hit: at === e || e.contains(at) ? 'itself' : (at ? at.tagName + '.' + at.className : 'nothing'), top: Math.round(r.top), head: Math.round(document.querySelector('.overview-head').getBoundingClientRect().bottom) }; }`,
    );
    if (seen.hit !== "itself" || seen.top < seen.head) fail(`${what} is under the header: its top at ${seen.top}px, the header's foot at ${seen.head}px, its middle shows ${seen.hit}`);
    log(`  page: ${what} in sight below the header (its top at ${seen.top}px, the header's foot at ${seen.head}px; elementFromPoint at its middle: the stop)`);
  };
  /**
   * From the page scrolled to its foot (the ring on a browser there), up to the first row and onto its section's +:
   * each in sight below the header. Returns the first row's stop the way up came to, and the run's column.
   */
  const upFromTheFoot = async (foot: string, first: string): Promise<Span | undefined> => {
    await goTo(foot);
    const down = scrolled();
    if (down.more <= 0) fail(`the overview does not scroll in this window (${JSON.stringify(down)}): the check needs a page taller than it`);
    if (down.top <= 0) fail(`the ring on ${short(foot)} at the foot, yet the page is not scrolled (${JSON.stringify(down)})`);
    log(`  page: scrolled ${down.top} of ${down.more} px, the ring at the foot`);
    const column = await goTo(first);
    await inSight(first, `the first row's ${short(first)}`);
    press("ArrowUp");
    await expect("Up from the first row: its section's +, New room in demo", (f) => f.key === "head:room:project_demo" && f.label === "New room in demo" && f.ring);
    await inSight("head:room:project_demo", "the section's + (New room in demo)");
    return column;
  };
  /** Where a key moves from a stop on the grid as it is now, as the page's function says (null: it stays). */
  const predict = (grid: Grid, from: string, key: NavKey, column?: Span): string | null => gridTarget(grid, grid.findIndex((p) => p.element === from), key, column)?.element ?? null;
  /**
   * Move the overview's ring to a stop by the arrows alone: Home first (on the ring's row, or the start with nothing
   * focused; it ends any run of Up and Down), then the fewest arrows the grid needs (route), each landing checked. Returns
   * the column the run of Up and Down at the end keeps to, if it ends with one.
   */
  const goTo = async (key: string): Promise<Span | undefined> => {
    const grid = await settledGrid();
    if (!grid.some((p) => p.element === key)) fail(`${short(key)} is not a stop of the overview`);
    press("Home");
    const start = (await expect("Home: a stop of the overview", (f) => grid.some((p) => p.element === f.key))).key!;
    const steps = route(grid, start, key);
    if (!steps) return fail(`the arrows lead nowhere from ${short(start)} to ${short(key)}`);
    let column: Span | undefined;
    let here = start;
    for (const step of steps) {
      press(step.press);
      await expect(`${step.press.replace("Arrow", "")}: ${short(step.to)}`, (f) => f.key === step.to);
      const vertical = step.press === "ArrowUp" || step.press === "ArrowDown";
      column = vertical ? (column ?? grid.find((p) => p.element === here)) : undefined;
      here = step.to;
    }
    return column;
  };

  /**
   * Up from the posts to the lane above them: Home, then Up past the first post until the earlier posts are all drawn and
   * the ring leaves the posts (`ok` says where it must land).
   */
  const abovePosts = async (what: string, ok: (f: Focus) => boolean): Promise<Focus> => {
    for (let i = 0; i < 8; i += 1) {
      press("Home");
      const first = await expect("Home: the first post drawn", (f) => f.key?.startsWith("post:") === true);
      press("ArrowUp");
      const now = await expect(`Up past it: an earlier post, or ${what}`, (f) => ok(f) || (f.key?.startsWith("post:") === true && f.key !== first.key), 10_000);
      if (ok(now)) {
        log(`  focus: ${what} (${short(now.key)} "${now.label.slice(0, 60)}"${now.ring ? ", ring drawn" : ""})`);
        return now;
      }
    }
    return fail(`Up past the first post never reached ${what}`);
  };

  /** Tab (or Shift+Tab) until the focus is where `ok` says, at most `max` presses: how a keyboard user reaches a control. */
  const tabTo = async (what: string, ok: (f: Focus) => boolean, key: "Tab" | "Shift+Tab" = "Tab", max = 10): Promise<Focus> => {
    for (let i = 0; i < max; i += 1) {
      const now = focus();
      if (ok(now)) {
        log(`  focus: ${what}, after ${i} × ${key} ("${now.label.slice(0, 60)}")`);
        return now;
      }
      press(key);
    }
    return expect(what, ok, 2000);
  };

  /** In an open action strip, Right to its last button, Detail: each step on the next button, then Right stays. */
  const toDetail = async (): Promise<void> => {
    for (let i = 0; i < 12 && focus().action !== "detail"; i += 1) {
      const before = focus().action;
      press("ArrowRight");
      await expect(`Right: the next button after ${before}`, (f) => f.action !== before && f.action !== null && f.strips === 1);
    }
    await expect("Right to the strip's end: Detail", (f) => f.action === "detail");
  };

  // ---------------- setup through the API (the room is seated by rehearse.ts) ----------------

  // The Consigliere's conversation: one message and his reply.
  const ask = await room.message("Plan the release: the parser fix, the tag and the notes.");
  await room.live("fable");
  await room.finish("fable", "Plan: the parser fix first, then the v1.2 tag, then the notes.");
  await room.settle("fable");
  // A long board: more posts than the page draws at first (60 on the board, 40 in the chat). Room notes are gone (N1),
  // so these are written to the journal as one from before N1 holds them, which the page still shows.
  room.journal(Array.from({ length: 62 }, (_, i) => ({ type: "post", actor: "$user", id: `note:long-board:${i + 1}`, intent: "note", body: `Note ${i + 1} on the long board`, milestone: ROOM_NOTE })));
  // The room state, as the Consigliere writes it: the lane between the header and the status chips.
  room.board("fable", "state", "Release v1.2: the parser fix first, then the tag, then the notes.");
  const second = await room.second("Second", ["alpha", "beta"]);
  // Third seats seven, so its tile is tall and the overview scrolls in the rehearsal's window (the ring brought into view
  // under the sticky header is checked on the way up from the foot).
  const third = await room.second("Third", ["solo", "ada", "bea", "cyd", "dee", "eli", "fay"]);
  const loose = await service.command<{ threadId: string }>({ type: "thread.start", projectId: "project_demo", text: "A thread outside rooms: read the logs" });
  // Two crew members, for the grid's Crew row and a seat by keys (the throwaway's Browsers row has its "general").
  for (const name of ["sol", "astra"]) await service.command({ type: "preset.create", name, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", workspaceMode: "local" });
  log(`set up: rooms Rehearsal ${R.slice(0, 8)}, Second ${second.roomId.slice(0, 8)}, Third ${third.roomId.slice(0, 8)}; thread ${loose.threadId.slice(0, 8)} outside rooms; 62 notes; crew sol and astra`);

  browser.open();
  browser.waitFor("Rehearsal");
  browser.waitFor("Third");
  browser.waitFor("A thread outside rooms");
  browser.waitFor("astra");
  browser.consoleClean();

  // ---------------- 0. the key bar: nothing focused yet; every place's bar fits this window ----------------

  await expect("the page open, nothing focused", (f) => f.tag === null && f.drawers.length === 0);
  await barSays("the overview, nothing focused (no Enter: it does nothing there)", { place: "overview-page", where: "the overview", keys: ["↑ ↓ ← → to the tiles"], end: "? all keys" });
  const fits = browser.eval<{ bars: number; width: number; over: string[] }>(everyBarFits());
  if (fits.over.length > 0) fail(`at ${fits.width} px, ${fits.over.length} of ${fits.bars} bars do not fit: ${fits.over.join("; ")}`);
  log(`  page: all ${fits.bars} bars of the key table (each place, each mix of what holds) fit ${fits.width} px with the where-text at its widest`);
  await state("key bar: the overview with nothing focused; every place's whole bar fits the window", "the overview");

  // ---------------- 1. the overview's grid (K1-3) ----------------

  let grid = await settledGrid();
  const members0 = ((await room.snapshot()).participants as Array<{ id: string; alias: string; retiredAt: string | null }>).filter((p) => !p.retiredAt);
  const apiRoomTitle = (await room.snapshot()).room.title as string;
  const overview = await service.call<{ rooms: Array<{ id: string; members: Array<{ id: string; alias: string }> }> }>("GET", "/api/overview");
  const apiRooms = await service.call<Array<{ id: string; title: string }>>("GET", "/api/rooms");
  const apiPresets = await service.call<Array<{ id: string; name: string }>>("GET", "/api/presets");
  const apiBrowsers = await service.call<Array<{ id: string; name: string }>>("GET", "/api/browsers");
  // The stops are the tiles and the buttons of the rows: every room, the thread, every crew member and browser of the API
  // has a tile; nothing else is a stop.
  const tileOf = (key: string) => grid.find((p) => p.element === key && p.tile);
  for (const apiRoom of apiRooms) if (!tileOf(`room:${apiRoom.id}`)) fail(`room ${apiRoom.title} of the API has no tile on the page`);
  if (!tileOf(`thread:${loose.threadId}`)) fail("the thread outside rooms has no tile");
  for (const preset of apiPresets) if (!tileOf(`preset:${preset.id}`)) fail(`crew member ${preset.name} of the API has no tile`);
  for (const item of apiBrowsers) if (!tileOf(`browser:${item.id}`)) fail(`browser ${item.name} of the API has no tile`);
  const stray = grid.filter((p) => !/^(room|thread|preset|browser|shelf|head):/.test(p.element));
  if (stray.length > 0) fail(`stops that are neither tiles nor buttons of a row: ${stray.map((p) => short(p.element)).join(", ")}`);
  // A room's members are read on its tile, as the API lists them, and none of them is a stop or takes the focus.
  const onTiles = browser.eval<Array<{ key: string; aliases: string[]; stops: number }>>(
    "() => [...document.querySelectorAll('.overview .ov-room')].map((card) => ({ key: card.querySelector('[data-nav]')?.dataset.navKey ?? '', aliases: [...card.querySelectorAll('.ov-member')].map((m) => (m.getAttribute('aria-label') ?? '').split(',')[0]), stops: card.querySelectorAll('.ov-member[data-nav], .ov-member [data-nav], .ov-member[tabindex]').length }))",
  );
  for (const apiRoom of overview.rooms) {
    const tile = onTiles.find((t) => t.key === `room:${apiRoom.id}`);
    const want = apiRoom.members.map((m) => `@${m.alias}`).sort();
    if (!tile || [...tile.aliases].sort().join() !== want.join()) return fail(`room ${apiRoom.id.slice(0, 8)}: its tile reads ${JSON.stringify(tile?.aliases)}, the API's members are ${want.join(", ")}`);
    if (tile.stops > 0) fail(`room ${apiRoom.id.slice(0, 8)}: ${tile.stops} of its members on the tile are stops`);
  }
  log(`api: ${apiRooms.length} rooms, ${apiPresets.length} crew members, ${apiBrowsers.length} browsers; page: ${grid.length} stops (${grid.filter((p) => p.tile).length} tiles), every room's members on its tile and none a stop`);

  // Down from a room's tile with another under it (four tiles on three columns: the fourth sits under the first): the
  // tile below, then Crew's head, a crew member, Browsers' head and a browser, in the column the run began in.
  const sameColumn = (a: Boxed<string>, b: Boxed<string>) => Math.abs(a.left - b.left) < 2;
  const projectTiles = grid.filter((p) => p.tile && /^(room|thread):/.test(p.element));
  const upper = projectTiles.find((t) => t.element.startsWith("room:") && projectTiles.some((u) => u !== t && sameColumn(u, t) && u.top >= t.bottom - 1));
  if (!upper) return fail(`no room's tile has another under it (tiles at ${projectTiles.map((p) => Math.round(p.left)).join(", ")}): the window is too wide for this check`);
  const below = projectTiles.filter((u) => u !== upper && sameColumn(u, upper) && u.top >= upper.bottom - 1).sort((a, b) => a.top - b.top)[0]!;
  // The run's column: the tile's own, unless the way there was already a run of Up and Down.
  const span = (await goTo(upper.element)) ?? upper;
  const middleOf = (p: Span) => (p.left + p.right) / 2;
  const inColumn = (kind: string) => grid.filter((p) => p.element.startsWith(`${kind}:`) && p.left < span.right && p.right > span.left).sort((a, b) => Math.abs(middleOf(a) - middleOf(span)) - Math.abs(middleOf(b) - middleOf(span)))[0];
  const crewTile = inColumn("preset");
  const browserTile = inColumn("browser");
  if (!crewTile || !browserTile) return fail(`no crew member or browser under the column ${Math.round(span.left)}–${Math.round(span.right)}`);
  const run: Array<[string, string]> = [
    [below.element, `the tile below it, ${short(below.element)}`],
    ["head:crew", "Crew's head, its + New crew member"],
    [crewTile.element, `the crew member in its column, ${apiPresets.find((p) => `preset:${p.id}` === crewTile.element)?.name}`],
    ["head:browsers", "Browsers' head, its + New browser"],
    [browserTile.element, `the browser in its column, ${apiBrowsers.find((b) => `browser:${b.id}` === browserTile.element)?.name}`],
  ];
  for (const [key, what] of run) {
    press("ArrowDown");
    await expect(`Down: ${what}`, (f) => f.key === key && f.ring);
  }
  press("ArrowDown");
  await sleep(300);
  await expect("Down at the foot stays on the browser", (f) => f.key === browserTile.element);
  await state("overview: Down from a room's tile reaches the tile below, then Crew, then Browsers", await overviewWhere(browserTile.element));

  // Up from the first row: its section's +, then the page's header, which is the top. Along the header, Right stops at
  // its end; Home and End go to its ends.
  grid = await settledGrid();
  const firstRow = projectTiles.filter((p) => Math.abs(p.top - Math.min(...projectTiles.map((t) => t.top))) < 2).sort((a, b) => a.left - b.left);
  const header = grid.filter((p) => p.element.startsWith("head:") && p.bottom <= firstRow[0]!.top && !p.element.startsWith("head:room:")).sort((a, b) => a.left - b.left);
  // The page scrolled down first (the ring on the browser at the foot, where the run above ended): the way up brings each
  // stop into view below the sticky header (scroll-padding-top), the first row's tile and the + both in sight.
  const firstColumn = (await upFromTheFoot(browserTile.element, firstRow[0]!.element)) ?? firstRow[0]!;
  await keyBar("New room in demo");
  const onHeader = predict(grid, "head:room:project_demo", "up", firstColumn);
  if (!onHeader || !header.some((p) => p.element === onHeader)) fail(`Up from the section's + would go to ${onHeader}, not the header`);
  press("ArrowUp");
  await expect(`Up: the page's header, ${short(onHeader)}`, (f) => f.key === onHeader && f.ring);
  press("ArrowUp");
  await sleep(300);
  await expect("Up on the header stays: it is the top", (f) => f.key === onHeader && f.drawers.length === 0);
  press("Home");
  await expect(`Home: the header's first, ${short(header[0]!.element)}`, (f) => f.key === header[0]!.element);
  for (const item of header.slice(1)) {
    press("ArrowRight");
    await expect(`Right: ${short(item.element)}`, (f) => f.key === item.element && f.ring);
  }
  press("ArrowRight");
  await sleep(300);
  await expect("Right at the header's end stays", (f) => f.key === header.at(-1)!.element);
  await state("overview: Up from the first row reaches its section's +, then the page's header", await overviewWhere(header.at(-1)!.element));

  // Left and Right along the first row of tiles, stopping at its ends; End and Home go to them.
  await goTo(firstRow[0]!.element);
  for (const tile of firstRow.slice(1)) {
    press("ArrowRight");
    await expect(`Right: the tile beside, ${short(tile.element)}`, (f) => f.key === tile.element && f.ring);
  }
  press("ArrowRight");
  await sleep(300);
  await expect("Right at the row's end stays", (f) => f.key === firstRow.at(-1)!.element);
  for (const tile of firstRow.slice(0, -1).reverse()) {
    press("ArrowLeft");
    await expect(`Left: ${short(tile.element)}`, (f) => f.key === tile.element);
  }
  press("ArrowLeft");
  await sleep(300);
  await expect("Left at the row's start stays", (f) => f.key === firstRow[0]!.element);
  press("End");
  await expect("End: the row's last tile", (f) => f.key === firstRow.at(-1)!.element);
  press("Home");
  await expect("Home: the row's first tile", (f) => f.key === firstRow[0]!.element);
  announced(/^button$/, /\S/);
  await state("overview: Left and Right go along the row and stop at its ends", await overviewWhere(firstRow[0]!.element));

  // ---------------- 1b. the mouse on a member's line: it is the tile's (#499, #507) ----------------

  // The ring on Rehearsal's tile, then the mouse over @worker's line on it: the tile is hovered, not the member (nothing
  // in the line is under the pointer), the ring stays on the tile and the bar names the room.
  const workerAlias = members0.find((m) => m.alias === "worker")!;
  const memberLine = (): string => {
    // A member's line is no control, so only the full snapshot lists it.
    const line = browser.on("snapshot", "--verbose").split("\n").find((l) => /\blistitem "@worker,/.test(l));
    const uid = line ? /uid=(\S+)/.exec(line)?.[1] : undefined;
    return uid ?? fail(`the page snapshot has no line of @${workerAlias.alias} on Rehearsal's tile`);
  };
  await goTo(`room:${R}`);
  browser.on("hover", memberLine());
  const hovered = browser.eval<{ member: boolean; deepest: string | null; inTile: boolean; focus: string | null }>(
    `() => { const chain = [...document.querySelectorAll(':hover')]; const deepest = chain.at(-1) ?? null; const tile = document.querySelector('[data-nav-key="room:${R}"]').closest('[data-nav-card]'); return { member: chain.some((e) => e.closest('.ov-member')), deepest: deepest ? (deepest.dataset.navKey ?? deepest.className) : null, inTile: Boolean(deepest && tile.contains(deepest)), focus: document.activeElement?.dataset?.navKey ?? null }; }`,
  );
  if (hovered.member || !hovered.inTile) fail(`the mouse over @worker's line hovers ${JSON.stringify(hovered)}: the tile must be hovered, not the member`);
  log(`  page: the mouse over @worker's line hovers ${hovered.deepest} (the tile's), no member line; the focus on ${short(hovered.focus)}`);
  await expect("the ring stays on Rehearsal's tile", (f) => f.key === `room:${R}`);
  await barSays("Rehearsal's tile, the mouse over a member's line", {
    place: "overview-room",
    where: apiRoomTitle,
    keys: ["↑ ↓ the row above or below", "← → along the row", "Enter open the room", "Home End first or last in the row"],
    end: "? all keys",
  });
  await state("the mouse over a member's line on a tile: the tile is hovered, the bar names the room", apiRoomTitle);

  // A click on that line opens the room's conversation, not the member's thread; Backspace comes back to the tile.
  browser.on("click", memberLine());
  await expect("a click on @worker's line: Rehearsal is open, no member's thread over it", (f) => f.drawers.some((d) => d.view === "room" && d.id === R && !d.inert) && !f.drawers.some((d) => d.view === "member") && f.inLayer === "room");
  const clicked = focus();
  if (clicked.drawers[0]!.label !== `Room ${apiRoomTitle}`) fail(`the click opened ${clicked.drawers[0]!.label}, the API's room is ${apiRoomTitle}`);
  log(`api: room ${R.slice(0, 8)} "${apiRoomTitle}"; page: the drawer data-id ${R.slice(0, 8)}, no member's layer`);
  // The room opens on its newest post (K1-4), the API's newest in the chat.
  const clickedNewest = (await room.snapshot()).posts.at(-1);
  await expect(`the focus on the newest post #${clickedNewest.number}`, (f) => f.key === `post:${clickedNewest.seq}`);
  await state("a click on a member's line opens the room's conversation", new RegExp(`^#${clickedNewest.number} · `));
  press("Backspace");
  await expect("Backspace: back on the overview, the ring on Rehearsal's tile", (f) => f.drawers.length === 0 && f.key === `room:${R}`);

  // ---------------- 2. the focus survives a poll that moves its card ----------------

  await goTo(`room:${second.roomId}`);
  const before = browser.eval<number>(`() => [...document.querySelectorAll('.ov-tiles > *')].findIndex((c) => c.querySelector('[data-nav-key="room:${second.roomId}"]'))`);
  // An approval in the second room ranks its card first (needs you): the next poll moves it under the focus.
  const bindings = (await second.snapshot()).bindings as Array<{ participantId: string; threadId: string }>;
  const alphaThread = bindings.find((b) => b.participantId === second.participant.alpha)!.threadId;
  await service.command({ type: "message.create", roomId: second.roomId, sourceText: "@alpha check the logs", clientMessageId: crypto.randomUUID(), attachmentIds: [], assignments: [{ recipients: [second.participant.alpha], instruction: "check the logs" }] });
  await until("alpha's turn to run", async () => ((await second.snapshot()).runs as Array<{ phase: string }>).some((r) => r.phase === "running"));
  await service.fake("approval", { threadId: alphaThread });
  const needs = await until("the API to say the second room needs you", async () => {
    const list = await service.call<Array<{ id: string; counts: { needsYou: number } }>>("GET", "/api/rooms");
    return list.find((r) => r.id === second.roomId && r.counts.needsYou > 0);
  });
  const after = await until("the page to move the second room's card", () => {
    const index = browser.eval<number>(`() => [...document.querySelectorAll('.ov-tiles > *')].findIndex((c) => c.querySelector('[data-nav-key="room:${second.roomId}"]'))`);
    return index !== before ? { index } : null;
  }, 30_000, 500);
  log(`api: the second room needs you (counts.needsYou=${needs.counts.needsYou}); page: its card moved from tile ${before} to ${after.index}`);
  await expect("the moved card keeps the focus", (f) => f.key === `room:${second.roomId}` && f.visible);
  await state("overview: the focus stays on a card a poll moves", "Second");

  // ---------------- 2b. a dialog and a menu from the overview: the focus comes back; Tab stays in a dialog ----------------

  await goTo("head:room:project_demo");
  await expect("the arrows reach the project's + (New room in demo)", (f) => f.label === "New room in demo" && f.ring);
  press("Enter");
  await expect("Enter: the New room dialog, the focus in it", (f) => f.dialog === "New room" && f.inDialog);
  for (let i = 0; i < 8; i += 1) press("Tab");
  await expect("Tab ×8 stays in the dialog (the page under it is inert)", (f) => f.dialog === "New room" && f.inDialog);
  for (let i = 0; i < 3; i += 1) press("Shift+Tab");
  await expect("Shift+Tab ×3 stays in the dialog", (f) => f.dialog === "New room" && f.inDialog);
  press("ArrowDown");
  await expect("an arrow in the dialog moves nothing behind it", (f) => f.dialog === "New room" && f.inDialog);
  press("Escape");
  await expect("Esc: the dialog closed, the focus back on its + button", (f) => f.dialog === null && f.label === "New room in demo" && f.ring);
  await state("overview: a dialog holds Tab and gives the focus back to its button", "New room in demo");

  // A tile's ⋯ is no stop: from it the arrows go on as from its tile, in a run of their own (in the tile's column).
  await goTo(`room:${third.roomId}`);
  grid = await settledGrid();
  const thirdBox = grid.find((p) => p.element === `room:${third.roomId}`)!;
  const underThird = predict(grid, thirdBox.element, "down");
  if (!underThird) return fail("nothing under Third's tile on the grid");
  if (predict(grid, underThird, "up", thirdBox) !== thirdBox.element) fail(`Up from ${short(underThird)} in Third's column would not come back to Third`);
  press("Tab");
  await expect("Tab: the card's ⋯", (f) => f.label === "Third options");
  press("ArrowDown");
  await expect(`Down from the card's ⋯: as from the card, ${short(underThird)}`, (f) => f.key === underThird && f.ring);
  press("ArrowUp");
  await expect("Up: back on the card", (f) => f.key === `room:${third.roomId}`);
  press("Tab");
  press("Enter");
  await expect("Enter on ⋯: its menu, the focus on its first item", (f) => f.menu && f.role === "menuitem" && f.label.startsWith("Rename"));
  press("ArrowDown");
  await expect("Down in the menu: Delete…", (f) => f.menu && f.label.startsWith("Delete"));
  press("Tab");
  await expect("Tab out of the menu closes it, the focus going on past it", (f) => !f.menu && f.label !== "Third options" && !f.label.startsWith("Delete"));
  await goTo(`room:${third.roomId}`);
  press("Tab");
  press("Enter");
  await expect("Enter on ⋯ again: the menu, on Rename…", (f) => f.menu && f.label.startsWith("Rename"));
  press("Enter");
  await expect("Enter on Rename…: its dialog, the focus in its field", (f) => f.dialog === "Rename room" && f.inDialog && f.value === "Third");
  press("End");
  press("Backspace");
  await expect("Backspace in the dialog's field deletes its last letter; the dialog stays", (f) => f.dialog === "Rename room" && f.inDialog && f.tag === "INPUT" && f.value === "Thir");
  await state("Backspace in a dialog's text field deletes", "Rename room");
  await tabTo("Tab to a button of the dialog", (f) => f.dialog === "Rename room" && f.inDialog && f.tag === "BUTTON");
  press("Backspace");
  await expect("Backspace outside the field: the dialog closed, the focus back on the card's ⋯", (f) => f.dialog === null && !f.menu && f.label === "Third options" && f.ring && f.drawers.length === 0);
  const renamed = (await service.call<Array<{ id: string; title: string }>>("GET", "/api/rooms")).find((r) => r.id === third.roomId);
  if (renamed?.title !== "Third") fail(`the room was renamed to ${JSON.stringify(renamed?.title)}: closing the dialog with Backspace must cancel it`);
  log(`api: room ${third.roomId.slice(0, 8)} is still "Third"`);
  press("Enter");
  await expect("Enter on ⋯: the menu again", (f) => f.menu && f.label.startsWith("Rename"));
  press("Backspace");
  await expect("Backspace in the menu closes it, the focus back on the card's ⋯", (f) => !f.menu && f.label === "Third options" && f.drawers.length === 0);
  press("Enter");
  await expect("Enter on ⋯: the menu once more", (f) => f.menu && f.label.startsWith("Rename"));
  press("Enter");
  await expect("Enter on Rename…: its dialog", (f) => f.dialog === "Rename room" && f.value === "Third");
  press("Escape");
  await expect("Esc: the dialog closed, the focus back on the card's ⋯", (f) => f.dialog === null && !f.menu && f.label === "Third options" && f.ring);
  await state("overview: a card's menu takes the focus and gives it back through its dialog; Backspace closes them too", "Third options");

  // ---------------- 3. into a room ----------------

  await goTo(`room:${R}`);
  press("Enter");
  const apiRoom = await room.snapshot();
  const s1 = apiRoom;
  const askPost = s1.posts.find((p: any) => p.request?.id === ask);
  const answer = s1.posts.find((p: any) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === ask && c.outcome === "answered"));
  if (!askPost || !answer) fail("the API has no request and answer for the user's message");
  const notes = s1.posts.filter((p: any) => p.kind === "note" && p.author === "$user");
  // Nothing in the room needs the user (no approval, question or failed turn): the ring lands on the newest post.
  if (s1.nativeRequests.length > 0 || s1.needsYou.length > 0) fail(`the API shows something that needs the user in the room: ${JSON.stringify({ asking: s1.nativeRequests.length, needsYou: s1.needsYou.length })}`);
  await expect(`Enter: the room is open, the ring on its newest post #${notes.at(-1).number} (nothing needs you)`, (f) => f.drawers.some((d) => d.view === "room" && d.id === R && !d.inert) && f.inLayer === "room" && f.key === `post:${notes.at(-1).seq}` && f.ring && f.view === "chat");
  const opened = focus();
  if (opened.drawers[0]!.label !== `Room ${apiRoom.room.title}`) fail(`the drawer is named ${opened.drawers[0]!.label}, the API's room is ${apiRoom.room.title}`);
  log(`api: room ${R.slice(0, 8)} "${apiRoom.room.title}", nothing needs you, newest #${notes.at(-1).number}; page: drawer data-id ${R.slice(0, 8)}, named "${opened.drawers[0]!.label}"`);
  announced(/^article$/, new RegExp(`^#${notes.at(-1).number}, note from you`));
  await state("Enter on a room card opens it, the ring on its newest post", `#${notes.at(-1).number} · note from you`);

  // The chat: up from the newest post and back.
  press("ArrowUp");
  await expect(`Up: #${notes.at(-2).number}`, (f) => f.key === `post:${notes.at(-2).seq}`);
  press("ArrowDown");
  await expect(`Down: #${notes.at(-1).number}`, (f) => f.key === `post:${notes.at(-1).seq}`);
  await state("in a room: Up and Down go through the chat's posts", `#${notes.at(-1).number} · note from you`);
  await barSays(`#${notes.at(-1).number}`, {
    place: "room-post",
    where: `#${notes.at(-1).number} · note from you`,
    keys: ["↑ ↓ previous or next post", "← → between the panes", "Enter its actions", "Backspace back to the overview", "a–z start writing", "Home End first or last post"],
    end: "? all keys",
  });
  await state("key bar: a post's keys, each by what it does there", `#${notes.at(-1).number} · note from you`);

  // Past the top: the earlier posts load and the focus goes on to the post above.
  press("Home");
  const top = await expect("Home: the first post drawn", (f) => f.key?.startsWith("post:") === true);
  const drawn = top.posts;
  const topSeq = Number(top.key!.slice(5));
  press("ArrowUp");
  const above = await expect("Up past the top: earlier posts drawn, the focus on the one above", (f) => f.posts > drawn && Number(f.key?.slice(5)) < topSeq, 10_000);
  const abovePost = s1.posts.find((p: any) => p.seq === Number(above.key!.slice(5)));
  if (!abovePost) fail(`the focused post ${above.key} is not in the API's snapshot`);
  log(`api: the post above #${s1.posts.find((p: any) => p.seq === topSeq)?.number} is #${abovePost.number}; page: ${drawn} → ${above.posts} posts drawn`);
  await state("in a room: Up past the top draws the earlier posts", new RegExp(`^#${abovePost.number} · \\S`));

  // Up past the very first post: the lanes above, each named on the key bar as the ring reaches it. No turn runs yet, so
  // no status chip has choices: the room state's line, then the header on the open view's tab; Up there stays.
  const stateLine: string | undefined = s1.state?.line;
  if (!stateLine || s1.state?.by !== "fable") fail(`the API has no room state written by @fable: ${JSON.stringify(s1.state)}`);
  const stateWhere = `room state · ${stateLine}`;
  await abovePosts("the room state", (f) => f.key === "state");
  await expect("the room state's line has the ring", (f) => f.key === "state" && f.ring && f.tag === "BUTTON");
  announced(/^button$/, /^Room state/);
  await barSays("the room state", { place: "room-state", where: stateWhere, keys: ["↑ ↓ the lane above or below", "← → between the panes", "Enter open or fold it", "Backspace back to the overview", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  const folded = focus().expanded;
  press("Enter");
  await expect("Enter opens or folds the room state", (f) => f.key === "state" && f.expanded !== folded);
  press("Enter");
  await expect("Enter again puts it back", (f) => f.key === "state" && f.expanded === folded);
  log(`api: the room state by @${s1.state.by}, "${stateLine}"; page: its line holds the ring, Enter folds and unfolds it`);
  await state("in a room: Up past the first post reaches the room state, named on the key bar", stateWhere);
  press("ArrowUp");
  await expect("Up: the header, on the open view's tab (the chat)", (f) => f.key === "head:chat" && f.role === "tab" && f.ring && f.view === "chat");
  announced(/^tab$/, "fable");
  await barSays("the chat's tab in the header", { place: "room-head-tab", where: "header · the chat with @fable", keys: ["↓ the lane below", "← → along the header", "Enter show this view", "Backspace back to the overview", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  press("ArrowUp");
  await sleep(400);
  await expect("Up at the top stays on the tab", (f) => f.key === "head:chat");
  await state("in a room: Up from the room state reaches the header, named on the key bar", "header · the chat with @fable");

  // Left and Right along the header move the ring and nothing else; Enter presses: the Board tab shows the board, Members
  // opens its panel with the ring in it, and Backspace there brings the ring back to Members.
  press("ArrowLeft");
  await expect("Left: × (back to the overview), the room still open", (f) => f.key === "head:close" && f.ring && f.drawers.some((d) => d.view === "room" && !d.inert));
  await keyBar("header · back to the overview");
  press("ArrowLeft");
  await sleep(400);
  await expect("Left at the header's start stays", (f) => f.key === "head:close");
  press("ArrowRight");
  press("ArrowRight");
  await expect("Right ×2: the Board tab, the chat still showing (the arrows switch nothing)", (f) => f.key === "head:board" && f.view === "chat" && f.ring);
  press("Enter");
  await expect("Enter on the Board tab: the board shows, the ring stays on its tab", (f) => f.key === "head:board" && f.view === "board" && f.role === "tab");
  await state("in a room: Left and Right along the header; Enter on the Board tab shows the board", "header · the board");
  const roster = (s1.participants as Array<{ id: string; alias: string; retiredAt: string | null }>).filter((p) => !p.retiredAt);
  press("ArrowRight");
  await expect("Right: Members, the panel still folded", (f) => f.key === "head:people" && f.panel === null && f.ring);
  await keyBar("header · Members");
  press("Enter");
  await expect(`Enter on Members: the panel opens, the ring on its first member @${roster[0]!.alias}`, (f) => f.panel === "people" && f.key === `member:${roster[0]!.id}` && f.ring);
  await state("in a room: Enter on Members in the header opens the panel with the ring in it", new RegExp(`^@${roster[0]!.alias}(, the Consigliere)? · `));
  press("Backspace");
  await expect("Backspace: the panel folds, the ring back on Members in the header", (f) => f.panel === null && f.key === "head:people" && f.ring);
  for (const [next, where] of [["head:browser", "header · Browser"], ["head:git", "header · Git"], ["head:menu", "header · the room's options"]] as const) {
    press("ArrowRight");
    await expect(`Right: ${where}, no panel opened`, (f) => f.key === next && f.panel === null && f.ring);
    await keyBar(where);
  }
  press("ArrowRight");
  await sleep(400);
  await expect("Right at the header's end stays", (f) => f.key === "head:menu" && f.panel === null);
  press("Enter");
  await expect("Enter on the room's options: its menu, the focus on its first item", (f) => f.menu && (f.role ?? "").startsWith("menuitem"));
  press("Escape");
  await expect("Esc: the menu closed, the ring back on ⋯", (f) => !f.menu && f.key === "head:menu");
  await state("in a room: Right along the header to its end; Enter on ⋯ opens its menu", "header · the room's options");
  for (let i = 0; i < 4; i += 1) press("ArrowLeft");
  await expect("Left ×4: back on the Board tab", (f) => f.key === "head:board" && f.view === "board");
  press("ArrowDown");
  await expect("Down: the room state", (f) => f.key === "state");
  press("ArrowDown");
  await expect("Down: the posts lane, a post of the board", (f) => f.key?.startsWith("post:") === true && f.view === "board");
  press("End");
  const newest = s1.posts.at(-1);
  await expect(`End: the board's newest post #${newest.number}`, (f) => f.key === `post:${newest.seq}` && f.view === "board");
  for (let i = 2; i <= 4; i += 1) {
    press("ArrowUp");
    const post = s1.posts.at(-i);
    await expect(`Up: #${post.number}, as the API orders the board`, (f) => f.key === `post:${post.seq}` && f.ring);
  }
  announced(/^article$/, new RegExp(`^#${s1.posts.at(-4).number}, `));
  await state("in a room: the board's posts in the API's order, from the tabs", new RegExp(`^#${s1.posts.at(-4).number} · \\S`));

  // A post's detail, through its actions (K1-5): Enter opens them, Right to Detail (last), Enter; Esc closes the detail
  // with the ring back on Detail, and Esc again the actions with the ring back on the post.
  const detailPost = s1.posts.at(-4);
  press("Enter");
  await expect(`Enter: #${detailPost.number}'s actions, the ring on the first`, (f) => f.strips === 1 && f.item === `post:${detailPost.seq}` && f.action !== null && f.action === browser.eval<{ first: string | null } | null>(STRIP)?.first && f.ring);
  await toDetail();
  press("Enter");
  await expect(`Enter on Detail: the detail of #${detailPost.number}`, (f) => f.dialog === `Post #${detailPost.number}` && f.label === "Close dialog");
  await state("Detail, last in a post's actions, opens its detail", `Post #${detailPost.number}`);
  press("Escape");
  await expect(`Esc: the detail closed, the ring back on Detail in #${detailPost.number}'s actions`, (f) => f.dialog === null && f.action === "detail" && f.item === `post:${detailPost.seq}` && f.ring && f.drawers.some((d) => d.view === "room"));
  press("Escape");
  await expect(`Esc: the actions closed, the ring back on #${detailPost.number}, the room still open`, (f) => f.strips === 0 && f.key === `post:${detailPost.seq}` && f.ring && f.drawers.some((d) => d.view === "room"));
  // The keys, with ?: Esc closes it and the focus is back.
  press("?");
  // Shown, and the focus in it (the dialog takes it a frame after it is drawn: a Tab before that starts over at its ×).
  const help = await expect("?: the keys are shown, the focus in them", (f) => f.help && f.dialog === "Keyboard" && f.inDialog);
  if (help.dialogBody && help.dialogBody.more > 0) {
    // Its body scrolls in this window: Tab reaches it and the keys scroll it.
    press("Tab");
    await expect("Tab: the help's scrolled body", (f) => f.inDialog && f.label === "Keyboard, scrolls");
    press("End");
    await expect("End scrolls it to its foot", (f) => (f.dialogBody?.top ?? 0) > 0);
  } else log(`  the help fits this window (${JSON.stringify(help.dialogBody)}): nothing to scroll`);
  await state("? shows the keys", "Keyboard");
  press("Escape");
  await expect("Esc: the keys closed, the focus back on the post", (f) => !f.help && f.key === `post:${detailPost.seq}` && f.drawers.some((d) => d.view === "room"));

  // The composer: a key starts it; its own arrows; Esc closes it (not the room); Up comes back to the post.
  compose("w");
  await expect("a letter opens the composer, in its field", (f) => f.tag === "TEXTAREA");
  await barSays("the composer", {
    place: "room-composer",
    where: "writing a message",
    keys: ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept", "@ mention a member", "/ a command"],
    end: null,
  });
  await state("key bar: the composer's keys, and no ? in its field", "writing a message");
  press("ArrowUp");
  await expect("Up in the composer's field stays in the field", (f) => f.tag === "TEXTAREA");
  press("Escape");
  await expect("Esc closes the composer, not the room", (f) => f.label.includes("draft") && f.drawers.some((d) => d.view === "room"));
  press("ArrowUp");
  await expect("Up from the strip: back to the post", (f) => f.key === `post:${detailPost.seq}`);
  await state("the composer keeps its keys; Esc closes it first", new RegExp(`^#${detailPost.number} · \\S`));

  // Correct… on an open request (a message to him, made through the API; his turn on it is held open).
  const open = await room.message("Draft the release notes.");
  await room.live("fable");
  const openPost = room.post(await room.snapshot(), open);
  browser.poll<boolean>(`the page to draw #${openPost.number}`, `() => Boolean(document.querySelector('[data-nav-key="post:${openPost.seq}"]'))`, (drawn) => drawn === true);
  press("End");
  await expect(`End: the newest post, #${openPost.number}, the open request`, (f) => f.key === `post:${openPost.seq}`);
  await tabTo("Tab to its Correct…", (f) => f.label === "Correct…");
  press("Enter");
  await expect("Enter: the correction's field has the focus", (f) => f.tag === "TEXTAREA" && f.label === `Correction to #${openPost.number}`);
  press("x");
  press("y");
  await expect("what is typed goes into the correction, not a new message", (f) => f.value === "xy" && !f.composerOpen);
  press("Escape");
  await expect("Esc: back on Correct…, the field closed", (f) => f.label === "Correct…" && f.expanded === "false" && f.drawers.some((d) => d.view === "room" && !d.inert));
  await state("Correct… takes the focus; Esc goes back to it", new RegExp(`^Correct… · #${openPost.number} · you to @fable, `));

  // An open correction is in front wherever the focus is: Esc closes it from outside it, and Backspace closes it first.
  const inRoom = (f: Focus) => f.drawers.some((d) => d.view === "room" && !d.inert);
  press("Enter");
  await expect("Enter: the correction open again, its field focused", (f) => f.tag === "TEXTAREA" && f.label === `Correction to #${openPost.number}` && f.correctionOpen);
  const away = await tabTo("Tab out of the correction, leaving it open", (f) => f.correctionOpen && !f.inCorrection && inRoom(f), "Tab", 6);
  // The reference button "#88" is outside the post's item: the bar names it alone.
  const onPost = new RegExp(`^#${openPost.number}\\b`);
  const openBar = await keyBar(onPost);
  if (!openBar.keys.includes("Esc Backspace close correction")) fail(`with the correction open the key bar reads ${JSON.stringify(openBar.keys)}: expected Esc and Backspace to close the correction`);
  log(`  key bar: ${openBar.keys.join(" · ")}`);
  press("Escape");
  await expect(`Esc from "${away.label.slice(0, 30)}": the correction closed, the room open, the focus where it was`, (f) => !f.correctionOpen && inRoom(f) && f.label === away.label && f.tag === away.tag);
  await tabTo("Shift+Tab back to Correct…", (f) => f.label === "Correct…" && f.inCorrection, "Shift+Tab", 6);
  press("Enter");
  await expect("Enter: the correction once more", (f) => f.tag === "TEXTAREA" && f.correctionOpen);
  await tabTo("Tab out of it again", (f) => f.correctionOpen && !f.inCorrection && inRoom(f), "Tab", 6);
  press("Backspace");
  await expect("Backspace from outside it closes the correction first: the room stays, the focus where it was", (f) => !f.correctionOpen && inRoom(f) && f.label === away.label && f.tag === away.tag);
  const still = room.post(await room.snapshot(), open);
  if (still.request?.state !== "open" || still.request?.corrections !== 0) fail(`#${openPost.number} changed in the API: ${JSON.stringify(still.request)}`);
  log(`api: #${openPost.number} is still open with no correction sent`);
  const closedBar = await keyBar(onPost);
  if (closedBar.keys.some((key) => key.endsWith("close correction"))) fail(`with the correction closed the key bar still reads ${JSON.stringify(closedBar.keys)}`);
  await state("an open correction is in front wherever the focus is: Esc closes it, Backspace closes it first", onPost);
  await tabTo("Shift+Tab back to Correct…", (f) => f.label === "Correct…" && f.inCorrection, "Shift+Tab", 6);

  // The same inside the post's detail (through its actions): Esc in the correction closes the field, not the dialog (and
  // its text with it).
  press("End");
  await expect(`End: #${openPost.number}`, (f) => f.key === `post:${openPost.seq}`);
  press("Enter");
  await expect(`Enter: #${openPost.number}'s actions`, (f) => f.strips === 1 && f.item === `post:${openPost.seq}`);
  await toDetail();
  press("Enter");
  await expect(`Enter on Detail: the detail of #${openPost.number}`, (f) => f.dialog === `Post #${openPost.number}`);
  await tabTo("Tab to Correct… in the detail", (f) => f.inDialog && f.label === "Correct…");
  press("Enter");
  await expect("Enter: the correction's field in the detail has the focus", (f) => f.inDialog && f.tag === "TEXTAREA");
  press("a");
  press("b");
  await expect("what is typed goes into it", (f) => f.inDialog && f.value === "ab");
  press("Escape");
  await expect("Esc closes the field only: the detail stays, the focus on its Correct…", (f) => f.dialog === `Post #${openPost.number}` && f.inDialog && f.label === "Correct…");
  press("Enter");
  await expect("Enter: the correction in the detail open again", (f) => f.inDialog && f.tag === "TEXTAREA" && f.correctionOpen);
  const elsewhere = await tabTo("Tab out of it, still in the detail", (f) => f.inDialog && f.correctionOpen && !f.inCorrection, "Tab", 6);
  press("Escape");
  await expect("Esc from elsewhere in the detail closes the correction, not the detail", (f) => f.dialog === `Post #${openPost.number}` && f.inDialog && !f.correctionOpen && f.label === elsewhere.label);
  press("Escape");
  await expect(`Esc again closes the detail, the ring back on Detail in #${openPost.number}'s actions`, (f) => f.dialog === null && f.action === "detail" && f.item === `post:${openPost.seq}`);
  press("Escape");
  await expect(`Esc: the actions closed, the ring on #${openPost.number}`, (f) => f.strips === 0 && f.key === `post:${openPost.seq}`);
  await state("in a post's detail, Esc in a correction closes the field, not the detail", new RegExp(`^#${openPost.number} · you to @fable, `));

  // ---------------- 3b. a status chip: Esc folds its choices, and so does Backspace; the room stays ----------------

  // His turn on the open request runs (the fake holds it): the work bar shows it as a chip whose choices hold Stop, the
  // only chip with choices (no approval, question or failed turn). Up from the first post now reaches it first, then the
  // room state and the header, each named on the key bar.
  const s3 = await room.snapshot();
  const runs = (s3.runs as Array<{ id: string; phase: string }>).filter((r) => r.phase !== "terminal");
  const running = runs.filter((r) => r.phase === "running").length;
  if (running === 0 || runs.length !== 1 || s3.nativeRequests.length > 0 || s3.needsYou.length > 0) fail(`the API should show one running turn and nothing that needs the user: ${JSON.stringify({ runs: runs.map((r) => r.phase), asking: s3.nativeRequests.length, needsYou: s3.needsYou.length })}`);
  const chipKey = `chip:run:${runs[0]!.id}`;
  const chipWhere = `status · @fable working: on #${openPost.number}`;
  await abovePosts("the status chip", (f) => f.chip);
  await expect(`the ring on @fable's working chip (run ${runs[0]!.id.slice(0, 8)} in the API)`, (f) => f.key === chipKey && f.chip && f.expanded === "false" && f.ring);
  announced(/^button$/, /fable/);
  await barSays("the working chip", { place: "room-chip", where: chipWhere, keys: ["↑ ↓ the lane above or below", "← → between the chips", "Enter its choices", "Backspace back to the overview", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  press("ArrowRight");
  press("ArrowLeft");
  await sleep(400);
  await expect("Right and Left with one chip of choices: the ring stays on it", (f) => f.key === chipKey);
  press("ArrowUp");
  await expect("Up: the room state", (f) => f.key === "state");
  await keyBar(stateWhere);
  press("ArrowUp");
  await expect("Up: the header, on the Board tab last visited there", (f) => f.key === "head:board" && f.view === "board");
  await keyBar("header · the board");
  press("ArrowDown");
  press("ArrowDown");
  await expect("Down ×2: back on the working chip", (f) => f.key === chipKey && f.ring);
  await state("in a room: Up from the first post names the status chips, the room state and the header on the key bar", chipWhere);
  press("Enter");
  await expect("Enter: the chip's choices open under the bar", (f) => f.chip && f.expanded === "true" && f.chipOpen);
  log(`api: ${running} running turn; page: its chip open`);
  const chipBar = await keyBar(chipWhere);
  if (!chipBar.keys.includes("Esc Backspace fold the choices")) fail(`with the chip open the key bar reads ${JSON.stringify(chipBar.keys)}: expected Esc and Backspace to fold the chip's choices`);
  log(`  key bar: ${chipBar.keys.join(" · ")}`);
  // Its choices are reached with Tab (K1-6 makes them a strip); Up from them is back on the chip, the choices still open.
  await tabTo("Tab to Stop in the chip's choices", (f) => f.label === "Stop" && f.chipOpen, "Tab", 4);
  press("ArrowUp");
  await expect("Up from the choices: back on the chip, its choices still open", (f) => f.key === chipKey && f.chipOpen && f.expanded === "true");
  press("Escape");
  await expect("Esc: the choices folded, the focus on the chip, the room still open", (f) => f.chip && f.expanded === "false" && !f.chipOpen && f.drawers.some((d) => d.view === "room" && !d.inert));
  press("Escape");
  await sleep(400);
  await expect("Esc again, nothing in front: the room stays, the focus on the chip", (f) => f.chip && f.drawers.some((d) => d.view === "room" && !d.inert));
  await state("Esc with a chip expanded folds it; the room stays", chipWhere);
  press("Enter");
  await expect("Enter: the choices again", (f) => f.chip && f.chipOpen);
  press("Backspace");
  await expect("Backspace folds them as Esc does, the room still open", (f) => f.chip && !f.chipOpen && f.drawers.some((d) => d.view === "room" && !d.inert));
  const foldedBar = await keyBar(chipWhere);
  if (!foldedBar.keys.includes("Backspace back to the overview") || foldedBar.keys.some((key) => key.startsWith("Esc "))) fail(`with the chip folded the key bar reads ${JSON.stringify(foldedBar.keys)}: expected "Backspace back to the overview" and no Esc`);
  await state("Backspace with a chip expanded folds it first", chipWhere);
  // Home and End go to the posts from every lane.
  press("End");
  await expect(`End from the chip: the newest post, #${openPost.number}`, (f) => f.key === `post:${openPost.seq}`);

  // ---------------- 4. the panes ----------------

  const members = (s1.participants as Array<{ id: string; alias: string; retiredAt: string | null }>).filter((p) => !p.retiredAt);
  press("ArrowRight");
  await expect(`Right: the Members panel opens, the focus on @${members[0]!.alias}`, (f) => f.panel === "people" && f.key === `member:${members[0]!.id}` && f.ring);
  announced(/^group$/, `@${members[0]!.alias}`);
  press("ArrowDown");
  await expect(`Down: @${members[1]!.alias}, as the API lists the members`, (f) => f.key === `member:${members[1]!.id}`);
  press("ArrowRight");
  await expect("Right: the Browser panel", (f) => f.panel === "browser" && f.inLayer === "room");
  press("ArrowRight");
  await expect("Right: the Git panel", (f) => f.panel === "git" && f.inLayer === "room");
  press("ArrowLeft");
  await expect("Left: the Browser panel", (f) => f.panel === "browser");
  press("ArrowLeft");
  await expect(`Left: Members, back on @${members[1]!.alias}`, (f) => f.panel === "people" && f.key === `member:${members[1]!.id}`);
  press("ArrowLeft");
  await expect(`Left: the board, back on #${openPost.number}`, (f) => f.key === `post:${openPost.seq}`);
  press("ArrowRight");
  await expect(`Right: Members, on @${members[1]!.alias}`, (f) => f.key === `member:${members[1]!.id}`);
  await state("in a room: Left and Right between the board, Members, Browser and Git", new RegExp(`^@${members[1]!.alias} · `));

  // Esc in a menu closes the menu only; the focus goes back to the member.
  press("Tab");
  await expect("Tab: the member's menu button", (f) => f.tag === "BUTTON" && f.label.includes(members[1]!.alias));
  press("Enter");
  await expect("Enter: the member's menu, the focus on its first item", (f) => f.menu && f.label === "Open thread");
  press("ArrowDown");
  await expect("Down in the menu: its next item", (f) => f.menu && f.label === "Open in T3");
  press("Escape");
  await expect("Esc: the menu closed, the room still open, the focus on the member", (f) => !f.menu && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key === `member:${members[1]!.id}`);
  await state("Esc closes a menu, not the room", new RegExp(`^@${members[1]!.alias} · `));
  press("Escape");
  await sleep(400);
  await expect("Esc with the panel open and nothing in front: the room and the panel stay, the focus on the member", (f) => f.panel === "people" && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key === `member:${members[1]!.id}`);
  const panelBar = await keyBar(new RegExp(`^@${members[1]!.alias} · `));
  if (!panelBar.keys.includes("Backspace fold the side panel") || panelBar.keys.some((key) => key.startsWith("Esc "))) fail(`with the panel open the key bar reads ${JSON.stringify(panelBar.keys)}: expected "Backspace fold the side panel" and no Esc`);
  log(`  key bar: ${panelBar.keys.join(" · ")}`);
  await state("Esc with the panel open stays in the room", new RegExp(`^@${members[1]!.alias} · `));

  // A toast while a dialog is open is outside the inert page: read out (in the page snapshot), above the dialog.
  press("Tab");
  press("Enter");
  await expect("the member's menu again, on Open thread", (f) => f.menu && f.label === "Open thread");
  press("ArrowDown");
  press("Enter");
  await expect(`Open in T3…: its dialog`, (f) => f.dialog === `Open ${members[1]!.alias} in T3` && f.inDialog);
  await tabTo("Tab to Copy project id", (f) => f.inDialog && f.label === "Copy project id");
  press("Enter");
  const toast = browser.poll<{ text: string; inert: boolean; underRoot: boolean } | null>(
    "a toast to show",
    "() => { const t = document.querySelector('.toast-stack .toast'); return t ? { text: t.textContent.trim(), inert: Boolean(t.closest('[inert]')), underRoot: Boolean(t.closest('#root')) } : null; }",
    (value) => value !== null,
  )!;
  if (toast.inert || toast.underRoot) fail(`the toast is under the inert page while the dialog is open: ${JSON.stringify(toast)}`);
  const tree = browser.on("snapshot");
  if (!tree.includes(toast.text)) fail(`the toast "${toast.text}" is not in the page snapshot (assistive technology does not get it)`);
  log(`  page: the toast "${toast.text}" is outside #root, not inert, and in the page snapshot while the dialog is open`);
  press("Escape");
  await expect(`Esc: the dialog closed, the focus back on @${members[1]!.alias}`, (f) => f.dialog === null && f.key === `member:${members[1]!.id}`);
  await state("a toast during a dialog is read out", new RegExp(`^@${members[1]!.alias} · `));

  // ---------------- 5. a member's thread, and back out ----------------

  const workerThread = (s1.bindings as Array<{ participantId: string; threadId: string; retiredAt: string | null }>).find((b) => b.participantId === members[1]!.id && !b.retiredAt)!.threadId;
  press("Enter");
  await expect(`Enter: @${members[1]!.alias}'s thread over the room`, (f) => f.drawers.some((d) => d.view === "member" && d.id === workerThread) && f.drawers.some((d) => d.view === "room" && d.inert) && f.inLayer === "member");
  log(`api: @${members[1]!.alias}'s binding is thread ${workerThread.slice(0, 8)}; page: the layer shows data-id ${workerThread.slice(0, 8)}, the room under it inert`);
  browser.waitFor("This thread is now a member in a room");
  // Read only: what is typed here goes nowhere, not into the room's composer under it; Enter opens nothing.
  const draft = focus().roomDraft;
  press("h");
  press("i");
  press("Enter");
  await sleep(600);
  await expect(`letters and Enter in the thread leave the room's draft as it was (${JSON.stringify(draft)})`, (f) => f.roomDraft === draft && !f.composerOpen && f.inLayer === "member");
  const controls = browser.eval<{ menu: number; browser: number; settings: number; composer: number; note: string }>(
    "() => { const l = document.querySelector('.ov-layer-member'); return { menu: l.querySelectorAll('[aria-label=\"Thread options\"]').length, browser: l.querySelectorAll('.thread-browser-button').length, settings: l.querySelectorAll('button.thread-setting:not(.thread-usage)').length, composer: l.querySelectorAll('.composer-strip, .composer').length, note: l.querySelector('.thread-direct-note')?.textContent ?? '' }; }",
  );
  if (controls.menu + controls.browser + controls.settings + controls.composer > 0 || !controls.note.includes("read only")) fail(`the member's thread offers what T3 refuses for a seated thread: ${JSON.stringify(controls)}`);
  log(`  page: the member's thread has no thread menu, browser, settings or composer ("${controls.note}")`);
  await state("Enter on a member opens its thread", `@${members[1]!.alias}'s thread, read only`);
  press("Escape");
  await sleep(400);
  await expect("Esc in the member's thread closes nothing: the thread stays over the room", (f) => f.drawers.some((d) => d.view === "member" && d.id === workerThread) && f.inLayer === "member");
  const threadBar = await keyBar(`@${members[1]!.alias}'s thread, read only`);
  if (!threadBar.keys.includes("Backspace back to the room") || threadBar.keys.some((key) => key.startsWith("Esc "))) fail(`in the member's thread the key bar reads ${JSON.stringify(threadBar.keys)}: expected "Backspace back to the room" and no Esc`);
  press("Backspace");
  await expect(`Backspace: back in the room, Members open, the focus on @${members[1]!.alias}`, (f) => !f.drawers.some((d) => d.view === "member") && f.drawers.some((d) => d.view === "room" && !d.inert) && f.panel === "people" && f.key === `member:${members[1]!.id}` && f.ring);
  await state("Backspace from a member's thread goes back to the room", new RegExp(`^@${members[1]!.alias} · `));
  press("Backspace");
  await expect(`Backspace: the panel folds, the room stays, the focus back on #${openPost.number} where it came from`, (f) => f.panel === null && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key === `post:${openPost.seq}` && f.ring);
  await state("Backspace folds the side panel, back to the conversation", await postWhere(`post:${openPost.seq}`));

  // A side panel itself holding the ring: → → from the conversation reaches the Browser panel (it has no items, so the
  // panel takes the ring). The bar says Enter writes a message, and it does; Backspace folds the panel, then leaves.
  press("ArrowRight");
  await expect("Right: Members, on a member", (f) => f.panel === "people" && f.key?.startsWith("member:") === true);
  press("ArrowRight");
  await expect("Right: the Browser panel itself holds the ring", (f) => f.panel === "browser" && f.tag === "ASIDE" && f.label === "Browser" && f.inLayer === "room");
  await barSays("the Browser panel itself", {
    place: "room-pane",
    where: "the Browser panel",
    keys: ["↑ ↓ its buttons and fields", "← → between the panes", "Enter write a message", "Backspace fold the side panel", "a–z start writing"],
    end: "? all keys",
  });
  await state("key bar: the Browser panel itself, Enter writes a message", "the Browser panel");
  press("Enter");
  await expect("Enter: the composer, in its field", (f) => f.tag === "TEXTAREA" && f.composerOpen && f.panel === "browser");
  press("Escape");
  await expect("Esc: the composer closed, the focus on its strip, the panel still open", (f) => !f.composerOpen && f.tag === "BUTTON" && /Write a message|draft/.test(f.label) && f.panel === "browser");
  press("Backspace");
  await expect("Backspace: the panel folds, the focus stays on the strip", (f) => f.panel === null && f.tag === "BUTTON" && /Write a message|draft/.test(f.label) && inRoom(f));
  press("Backspace");
  await expect("Backspace: back on the overview, the focus on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}` && f.ring);
  announced(/^button$/, "Rehearsal");
  await state("Backspace from the room goes back to its card on the overview", apiRoom.room.title);
  await barSays("the room's tile", {
    place: "overview-room",
    where: apiRoom.room.title,
    keys: ["↑ ↓ the row above or below", "← → along the row", "Enter open the room", "Home End first or last in the row"],
    end: "? all keys",
  });
  press("Escape");
  await sleep(400);
  await expect("Esc on the overview, nothing in front: nothing moves", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  await state("key bar: a room's tile, each key by what it does there", apiRoom.room.title);

  // A member is reached in the room (the overview's tiles only show them): the room's tile, Right to Members, the
  // member, Enter for its thread over the room; Backspace three times comes back to the tile.
  const reviewer = members[2]!;
  const reviewerThread = (s1.bindings as Array<{ participantId: string; threadId: string; retiredAt: string | null }>).find((b) => b.participantId === reviewer.id && !b.retiredAt)!.threadId;
  await goTo(`room:${R}`);
  press("Enter");
  await expect("Enter: the room open, the focus in it", (f) => f.drawers.some((d) => d.view === "room" && d.id === R && !d.inert) && f.inLayer === "room");
  press("ArrowRight");
  await expect("Right: Members open, on a member", (f) => f.panel === "people" && f.key?.startsWith("member:") === true);
  press("Home");
  for (let i = 0; i < members.length && focus().key !== `member:${reviewer.id}`; i += 1) press("ArrowDown");
  await expect(`Down to @${reviewer.alias}`, (f) => f.key === `member:${reviewer.id}`);
  press("Enter");
  await expect(`Enter on @${reviewer.alias}: its thread over the room`, (f) => f.drawers.some((d) => d.view === "room" && d.id === R && d.inert) && f.drawers.some((d) => d.view === "member" && d.id === reviewerThread) && f.inLayer === "member", 10_000);
  await state("from the room's tile: Members, a member, Enter opens its thread over the room", `@${reviewer.alias}'s thread, read only`);
  press("Backspace");
  await expect(`Backspace: the room, Members open, the focus on @${reviewer.alias}`, (f) => f.panel === "people" && f.key === `member:${reviewer.id}` && !f.drawers.some((d) => d.view === "member"));
  press("Backspace");
  await expect("Backspace: the panel folds, the focus on the conversation's newest post", (f) => f.panel === null && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key?.startsWith("post:") === true);

  // Nothing in the room focused (as when it opens, after a click on empty space, or when the button that had the focus
  // goes away), by keys and without changing the room: opened afresh, its chat draws the newest posts only; Home, then
  // Shift+Tab reaches "N earlier", and Enter on it draws the rest, the button going away with the focus on it. The bar
  // says Enter writes a message, and it does.
  press("Home");
  await expect("Home: the first post drawn", (f) => f.key?.startsWith("post:") === true);
  const drawnBefore = focus().posts;
  await tabTo("Shift+Tab to the earlier posts' button", (f) => f.tag === "BUTTON" && /earlier|older/.test(f.label), "Shift+Tab", 3);
  for (let i = 0; i < 6 && focus().tag === "BUTTON"; i += 1) {
    press("Enter");
    await sleep(800);
  }
  const drawnAll = await expect("Enter on it until every post is drawn: the button gone, nothing in the room focused", (f) => f.tag === null && f.panel === null && inRoom(f) && f.posts > drawnBefore, 10_000);
  log(`  page: ${drawnBefore} → ${drawnAll.posts} posts drawn; the room is unchanged (no command sent)`);
  await barSays("the room, nothing in it focused", {
    place: "room-itself",
    where: apiRoom.room.title,
    keys: ["↑ ↓ to the posts", "← → between the panes", "Enter write a message", "Backspace back to the overview", "a–z start writing", "Home End first or last post"],
    end: "? all keys",
  });
  await state("key bar: a room with nothing in it focused, Enter writes a message", apiRoom.room.title);
  press("Enter");
  await expect("Enter: the composer, in its field", (f) => f.tag === "TEXTAREA" && f.composerOpen);
  press("Escape");
  await expect("Esc: the composer closed, the focus on its strip", (f) => !f.composerOpen && f.tag === "BUTTON" && /Write a message|draft/.test(f.label));
  press("Backspace");
  await expect("Backspace: the overview, the focus back on the room's tile", (f) => f.drawers.length === 0 && f.key === `room:${R}` && f.ring);
  await state("Backspace three times comes back to the room's tile: the thread, the panel, the room", apiRoom.room.title);

  // ---------------- 5b. a room with an approval waiting opens on its chip ----------------

  // The second room's approval (section 2) still waits in the API: the room opens with the ring on its chip, not on a post.
  const secondNow = await second.snapshot();
  const alphaAsks = (secondNow.nativeRequests as Array<{ participantId: string; kind: string }>).filter((r) => r.participantId === second.participant.alpha);
  if (alphaAsks.length !== 1 || alphaAsks[0]!.kind !== "approval") fail(`the API should show one approval of @alpha waiting in the second room: ${JSON.stringify(secondNow.nativeRequests)}`);
  const askWhere = "status · @alpha approval: waiting for you";
  await goTo(`room:${second.roomId}`);
  press("Enter");
  await expect("Enter on the second room's card: it opens with the ring on @alpha's approval chip", (f) => f.drawers.some((d) => d.view === "room" && d.id === second.roomId && !d.inert) && f.key === `chip:ask:${second.participant.alpha}` && f.chip && f.ring, 10_000);
  log(`api: @alpha's approval waits in room ${second.roomId.slice(0, 8)}; page: the ring on its chip`);
  announced(/^button$/, /alpha/);
  await barSays("the approval's chip", { place: "room-chip", where: askWhere, keys: ["↑ ↓ the lane above or below", "← → between the chips", "Enter its choices", "Backspace back to the overview", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  await state("a room with an approval waiting opens with the ring on its chip", askWhere);
  // Its other chip with choices: @alpha's running turn (Stop). Right goes to it and stops there; Left comes back.
  const alphaRun = (secondNow.runs as Array<{ id: string; phase: string; seatId: string }>).filter((r) => r.phase !== "terminal");
  if (alphaRun.length !== 1) fail(`the API should show one turn of @alpha running in the second room: ${JSON.stringify(alphaRun)}`);
  press("ArrowRight");
  await expect(`Right: @alpha's working chip (run ${alphaRun[0]!.id.slice(0, 8)})`, (f) => f.key === `chip:run:${alphaRun[0]!.id}` && f.ring);
  await keyBar(/^status · @alpha working: on #\d+$/);
  press("ArrowRight");
  await sleep(400);
  await expect("Right at the last chip stays", (f) => f.key === `chip:run:${alphaRun[0]!.id}`);
  press("ArrowLeft");
  await expect("Left: back on the approval's chip", (f) => f.key === `chip:ask:${second.participant.alpha}`);
  // Down to its newest post and back; up to the header, which has no tabs (no Consigliere): Members.
  const secondNewest = secondNow.posts.at(-1);
  press("ArrowDown");
  await expect(`Down: the posts, on the newest #${secondNewest.number}`, (f) => f.key === `post:${secondNewest.seq}`);
  press("ArrowUp");
  await expect("Up: back on the approval's chip", (f) => f.key === `chip:ask:${second.participant.alpha}`);
  press("ArrowUp");
  await expect("Up: the header, on Members (no view tabs in a room without a Consigliere)", (f) => f.key === "head:people" && f.ring);
  await keyBar("header · Members");
  press("Backspace");
  await expect("Backspace: back on the overview, the ring on the second room's card", (f) => f.drawers.length === 0 && f.key === `room:${second.roomId}`);
  const waitingAfter = (await second.snapshot()).nativeRequests.length;
  if (waitingAfter !== 1) fail(`the approval changed in the API while the room was looked at: ${waitingAfter} waiting`);
  await state("Backspace from the second room: its approval still waits, the ring on its card", "Second");

  // ---------------- 5c. a room opened while a turn runs: the ring on something in view, the board at its bottom ----------------

  // @fable's turn on #openPost still runs (the fake holds it), the room's only one, and nothing needs the user. Its live
  // bubble is small here (the fake T3 streams no feed): the newest post shows and takes the ring. Made tall with a style,
  // as a streaming feed makes it (the review's way; 75vh, so that none of the post shows at this window), the bubble
  // pushes the newest post out of the board's view: the room opens with the ring on the running turn's chip, and the
  // board stays at its bottom and follows the bubble as it grows.
  const s5 = await room.snapshot();
  const turns = (s5.runs as Array<{ id: string; phase: string }>).filter((r) => r.phase !== "terminal");
  if (turns.length !== 1 || turns[0]!.phase !== "running" || `chip:run:${turns[0]!.id}` !== chipKey || s5.nativeRequests.length > 0 || s5.needsYou.length > 0) fail(`the API should show @fable's one running turn and nothing that needs the user: ${JSON.stringify({ runs: turns, asking: s5.nativeRequests.length, needsYou: s5.needsYou.length })}`);
  const board = () => browser.eval<{ distance: number; newest: string | null; shown: number; height: number; bubble: number; view: number; feed: boolean } | null>(BOARD);
  await goTo(`room:${R}`);
  press("Enter");
  await expect(`Enter: the room opens while @fable's turn runs, the ring on the newest post #${openPost.number} (it shows)`, (f) => inRoom(f) && f.key === `post:${openPost.seq}` && f.ring, 10_000);
  const small = board() ?? fail("the page draws no open room's board");
  if (small.newest !== `post:${openPost.seq}` || small.shown < Math.min(small.height, 48) || small.distance > 2) fail(`with a small live bubble the newest post should show and the board be at its bottom: ${JSON.stringify(small)}`);
  log(`api: run ${turns[0]!.id.slice(0, 8)} running; page: the bubble ${small.bubble}px, the newest post shows ${small.shown}px of ${small.height}, the board ${small.distance}px from its bottom`);
  press("Backspace");
  await expect("Backspace: back on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  browser.eval<boolean>(`() => { document.head.insertAdjacentHTML('beforeend', '<style id="rehearse-tall-bubble">.bubble-live { min-height: 75vh }</style>'); return true; }`);
  press("Enter");
  const landed = await expect("Enter: the room opens with its live bubble tall, the ring placed", (f) => inRoom(f) && f.key !== null && f.ring, 10_000);
  const tall = board() ?? fail("the page draws no open room's board");
  log(`  page: the bubble ${tall.bubble}px of a ${tall.view}px board; the newest post shows ${Math.max(0, tall.shown)}px of ${tall.height}; the board ${tall.distance}px from its bottom`);
  if (tall.shown >= Math.min(tall.height, 48) || tall.distance > 2) fail(`with a tall live bubble the newest post should be out of the board's view and the board at its bottom: ${JSON.stringify(tall)}`);
  await expect("the ring on the running turn's chip, in view (not on the newest post out of view)", (f) => f.key === chipKey && f.chip && f.ring && landed.key === chipKey);
  // The turn grows: the board follows it, the ring stays on the chip.
  browser.eval<boolean>(`() => { document.getElementById('rehearse-tall-bubble').textContent = '.bubble-live { min-height: 95vh }'; return true; }`);
  const grown = await until("the board to follow the grown bubble to its bottom", () => {
    const now = board();
    return now && now.bubble > tall.bubble && now.distance <= 2 ? now : null;
  }, 6000, 200);
  log(`  page: the bubble grew to ${grown.bubble}px, the board ${grown.distance}px from its bottom`);
  await expect("the ring stays on the chip", (f) => f.key === chipKey && f.ring);
  await state("a room opened while a turn runs: the ring on something in view, the board at its bottom and following", chipWhere);
  browser.eval<boolean>(`() => { document.getElementById('rehearse-tall-bubble')?.remove(); return true; }`);
  press("Backspace");
  await expect("Backspace: back on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}`);

  // ---------------- 5d. a room whose desk read comes late: the ring lands again when it comes ----------------

  // The room's desk read (a running turn's live feed comes with it) slower than the landing waits for it (1.5 s): the
  // page's desk fetch held back, and the live bubble made tall only once its feed is drawn, as a real feed grows it. The
  // room is opened after another one, so its desk is read afresh. At first the bubble is small and the newest post shows,
  // so the ring lands on it; when the desk comes the bubble grows over the post, and the ring lands again, on the
  // running turn's chip. A key pressed before the desk comes keeps the ring where the key put it.
  const holdDesk = (ms: number) =>
    browser.eval<boolean>(`() => { if (!window.__rehearseFetch) { const real = window.fetch.bind(window); window.__rehearseFetch = real; window.fetch = (input, init) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; const hold = window.__rehearseDeskHold; return hold && /\\/desk(\\?|$)/.test(url) ? new Promise((done) => setTimeout(done, hold)).then(() => real(input, init)) : real(input, init); }; } window.__rehearseDeskHold = ${ms}; if (!document.getElementById('rehearse-feed-bubble')) document.head.insertAdjacentHTML('beforeend', '<style id="rehearse-feed-bubble">.bubble-live:has(.live-feed:not(.live-empty)) { min-height: 75vh }</style>'); return true; }`);
  /** Another room opened and closed, so this room's desk is read afresh when it opens next. */
  const deskAfresh = async () => {
    await goTo(`room:${third.roomId}`);
    press("Enter");
    await expect("Enter: the third room open (another room's desk read)", (f) => f.drawers.some((d) => d.view === "room" && d.id === third.roomId && !d.inert));
    press("Backspace");
    await expect("Backspace: back on its card", (f) => f.drawers.length === 0 && f.key === `room:${third.roomId}`);
  };
  await deskAfresh();
  holdDesk(4000);
  await goTo(`room:${R}`);
  press("Enter");
  await expect(`Enter, the desk held back 4 s: the ring on the newest post #${openPost.number} (the bubble small, no feed yet)`, (f) => inRoom(f) && f.key === `post:${openPost.seq}`, 3500);
  const early = board() ?? fail("the page draws no open room's board");
  if (early.feed || early.shown < Math.min(early.height, 48)) fail(`before the desk comes the feed should not be drawn and the newest post should show: ${JSON.stringify(early)}`);
  log(`  page: before the desk, the bubble ${early.bubble}px, no feed; the newest post shows ${early.shown}px of ${early.height}`);
  await expect("the desk comes late: the ring lands again, on the running turn's chip", (f) => f.key === chipKey && f.chip && f.ring, 10_000);
  const late = board() ?? fail("the page draws no open room's board");
  if (!late.feed || late.shown >= Math.min(late.height, 48) || late.distance > 2) fail(`after the desk the feed should be drawn, the newest post out of view and the board at its bottom: ${JSON.stringify(late)}`);
  log(`  page: after the desk, the feed drawn, the bubble ${late.bubble}px of a ${late.view}px board; the newest post shows ${Math.max(0, late.shown)}px of ${late.height}; the board ${late.distance}px from its bottom`);
  await state("a room whose desk read comes late: the ring lands again when it comes, on the running turn's chip", chipWhere);
  press("Backspace");
  await expect("Backspace: back on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  // A key first: ↑ before the desk comes (held back 6 s this time) moves the ring to the post above, and the desk
  // coming later leaves it there.
  await deskAfresh();
  holdDesk(6000);
  await goTo(`room:${R}`);
  press("Enter");
  await expect(`Enter, the desk held back 6 s: the ring on the newest post #${openPost.number}`, (f) => inRoom(f) && f.key === `post:${openPost.seq}`, 4000);
  press("ArrowUp");
  const keyed = await expect("↑ before the desk comes: the post above", (f) => f.key?.startsWith("post:") === true && f.key !== `post:${openPost.seq}` && f.ring);
  if (board()?.feed) fail("the desk came before ↑ was pressed: the key was not first");
  await until("the desk to come, the feed drawn", () => (board()?.feed ? true : null), 12_000, 200);
  await sleep(1000);
  await expect("the desk came: the ring stays on the post the key put it on", (f) => f.key === keyed.key && f.ring);
  await state("a key pressed before a late desk read keeps the ring where it put it", await postWhere(keyed.key));
  holdDesk(0);
  browser.eval<boolean>(`() => { document.getElementById('rehearse-feed-bubble')?.remove(); return true; }`);
  press("Backspace");
  await expect("Backspace: back on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}`);

  // ---------------- 5e. a post's actions (K1-5) ----------------

  // @fable's turn on #openPost still runs (the fake holds it), the room's only one, and nothing needs you: the room opens
  // on #openPost, your open request, and Enter opens its actions under it (Correct…, Cancel, Copy, Detail), the ring on
  // Correct…. Left and Right choose, stopping at the ends (the side panel stays folded); a poll keeps them; Esc and
  // Backspace close them, the ring back on the post.
  const strip = () => browser.eval<{ item: string | null; label: string | null; first: string | null; names: string[] } | null>(STRIP);
  const names = (what: string, want: string[]) => {
    const got = strip();
    if (JSON.stringify(got?.names) !== JSON.stringify(want)) fail(`${what}: the strip offers ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    log(`  page: "${got!.label}": ${got!.names.join(" · ")}`);
  };
  /** The arrows to a post, once the page draws it: End, then Up until it has the ring. */
  const toPost = async (seq: number, what: string): Promise<void> => {
    browser.poll<boolean>(`the page to draw ${what}`, `() => Boolean(document.querySelector('[data-nav-key="post:${seq}"]'))`, (drawn) => drawn === true);
    press("End");
    await expect("End: the newest post", (f) => f.key?.startsWith("post:") === true);
    for (let i = 0; i < 12 && focus().key !== `post:${seq}`; i += 1) {
      press("ArrowUp");
      await sleep(200);
    }
    await expect(what, (f) => f.key === `post:${seq}` && f.ring);
  };
  const s6 = await room.snapshot();
  const fableRun = (s6.runs as Array<{ id: string; phase: string }>).find((r) => r.phase !== "terminal");
  if (!fableRun || fableRun.id !== turns[0]!.id || fableRun.phase !== "running" || s6.needsYou.length > 0 || s6.nativeRequests.length > 0) return fail(`the API should still show @fable's one running turn and nothing that needs you: ${JSON.stringify({ runs: s6.runs.filter((r: any) => r.phase !== "terminal").map((r: any) => [r.id.slice(0, 8), r.phase]), needsYou: s6.needsYou.length })}`);
  const mine = `#${openPost.number} · you to @fable, open`;
  const correct = `correct:${openPost.number}`;
  await goTo(`room:${R}`);
  press("Enter");
  await expect(`Enter: the room, the ring on its newest post #${openPost.number}`, (f) => inRoom(f) && f.key === `post:${openPost.seq}` && f.ring, 10_000);
  press("Enter");
  await expect(`Enter on #${openPost.number}: its actions under it, the ring on Correct…, the panel folded`, (f) => f.strips === 1 && f.item === `post:${openPost.seq}` && f.action === correct && f.ring && f.panel === null);
  names(`#${openPost.number}, your open request`, ["Correct…", "Cancel", "Copy", "Detail"]);
  announced(/^button$/, "Correct…");
  await barSays(`#${openPost.number}'s actions`, { place: "room-actions", where: `Correct… · ${mine}`, keys: ["↑ ↓ previous or next post", "← → choose", "Enter Correct…", "Esc Backspace close", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  press("ArrowLeft");
  await sleep(400);
  await expect("Left at the strip's start: the ring stays on Correct…, the panel folded", (f) => f.action === correct && f.strips === 1 && f.panel === null);
  press("ArrowRight");
  await expect("Right: Cancel", (f) => f.action === `cancel:${openPost.number}` && f.ring);
  const onCancel = await keyBar(`Cancel · ${mine}`);
  if (!onCancel.keys.includes("Enter Cancel")) fail(`on Cancel the key bar reads ${JSON.stringify(onCancel.keys)}: expected "Enter Cancel"`);
  press("ArrowRight");
  await expect("Right: Copy", (f) => f.action === "copy:0");
  press("ArrowRight");
  await expect("Right: Detail", (f) => f.action === "detail");
  press("ArrowRight");
  await sleep(400);
  await expect("Right at the strip's end: the ring stays on Detail, the panel folded", (f) => f.action === "detail" && f.strips === 1 && f.panel === null);
  // Past a poll of the room (its snapshot read again): still open, the ring on the same button.
  browser.eval<boolean>("() => { performance.clearResourceTimings(); return true; }");
  await until("a poll of the room (its snapshot read again)", () => browser.eval<number>(`() => performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === '/api/rooms/${R}').length`) > 0 || null, 20_000, 500);
  await sleep(600);
  await expect("after a poll: the actions still open, the ring still on Detail", (f) => f.strips === 1 && f.action === "detail" && f.ring);
  await state("a post's actions: Enter opens them under it, Left and Right choose and stop at the ends, a poll keeps them", `Detail · ${mine}`);
  press("Escape");
  await expect(`Esc: the actions closed, the ring on #${openPost.number}, the room open`, (f) => f.strips === 0 && f.key === `post:${openPost.seq}` && f.ring && inRoom(f));
  press("Enter");
  await expect("Enter: the actions again, on Correct…", (f) => f.strips === 1 && f.action === correct);
  press("Backspace");
  await expect("Backspace closes them as Esc does: the ring on the post, the room open", (f) => f.strips === 0 && f.key === `post:${openPost.seq}` && f.ring && inRoom(f));
  await state("Esc and Backspace close a post's actions, the ring back on the post, the room open", mine);

  // A letter on the actions: the composer opens with it (after the draft it holds) and the actions close; Esc then
  // closes only the composer.
  const heldDraft = focus().roomDraft ?? "";
  press("q");
  await expect(`a letter: the composer opens with it after the draft ${JSON.stringify(heldDraft)}, the actions closed`, (f) => f.tag === "TEXTAREA" && f.value === `${heldDraft}q` && f.composerOpen && f.strips === 0);
  press("Escape");
  await expect("Esc closes only the composer: the room open, the actions still closed, the ring on the composer's strip", (f) => !f.composerOpen && f.strips === 0 && inRoom(f) && f.tag === "BUTTON" && /Write a message|draft/.test(f.label));
  await state("a letter on a post's actions opens the composer with it; Esc then closes only the composer", /^(Write a message|Continue your draft)/);
  // The letter taken out of the draft again, by keys.
  press("Enter");
  await expect("Enter: the composer with the draft", (f) => f.tag === "TEXTAREA" && f.value === `${heldDraft}q`);
  press("Backspace");
  await expect("Backspace: the draft as it was", (f) => f.tag === "TEXTAREA" && f.value === heldDraft);
  press("Escape");
  await expect("Esc: the composer closed", (f) => !f.composerOpen && f.tag === "BUTTON");

  // The composer open behind a post's actions (the ring put on the post as a click puts it, the composer left open):
  // Esc closes the actions first, then the composer.
  press("Enter");
  await expect("Enter on the composer's strip: the composer, its draft as it was", (f) => f.tag === "TEXTAREA" && f.value === heldDraft && f.composerOpen);
  browser.eval<boolean>(`() => { document.querySelector('[data-nav-key="post:${openPost.seq}"]').focus(); return true; }`);
  log(`  page: the ring put on #${openPost.number} as a click on it puts it, the composer left open`);
  await expect(`the ring on #${openPost.number}, the composer open`, (f) => f.key === `post:${openPost.seq}` && f.composerOpen);
  press("Enter");
  await expect("Enter: its actions, the composer still open behind them", (f) => f.strips === 1 && f.action === correct && f.composerOpen);
  press("Escape");
  await expect("Esc: the actions closed first, the composer still open", (f) => f.strips === 0 && f.composerOpen && f.key === `post:${openPost.seq}`);
  await state("with the composer open behind a post's actions, Esc closes the actions first", mine);
  press("Escape");
  await expect("Esc again: the composer closed, the ring on the post", (f) => !f.composerOpen && f.strips === 0 && f.key === `post:${openPost.seq}`);

  // Up and Down leave the actions for the post above or below: past the newest post, @fable's running turn (its live
  // bubble), whose actions are Stop, what it works on and sent to T3 (no Detail: no post behind it yet); past it the
  // composer's strip.
  press("Enter");
  await expect("Enter: its actions", (f) => f.strips === 1 && f.item === `post:${openPost.seq}`);
  press("ArrowUp");
  const postAbove = await expect("Up from the actions: the post above, no actions left", (f) => f.strips === 0 && f.key?.startsWith("post:") === true && f.key !== `post:${openPost.seq}` && f.ring);
  press("Enter");
  await expect("Enter: the post above's actions", (f) => f.strips === 1 && f.item === postAbove.key);
  press("ArrowDown");
  await expect(`Down from them: #${openPost.number}, no actions left`, (f) => f.strips === 0 && f.key === `post:${openPost.seq}`);
  const liveKey = `live:${fableRun.id}`;
  const liveWhere = `@fable's turn · working on #${openPost.number}`;
  // End, then Down past the newest post.
  press("End");
  await expect("End: the newest post (End stays on the posts, not the running turn after them)", (f) => f.key?.startsWith("post:") === true && f.ring);
  press("ArrowDown");
  await expect(`Down from the newest post: @fable's running turn (run ${fableRun.id.slice(0, 8)} in the API)`, (f) => f.key === liveKey && f.ring);
  announced(/^article$/, liveWhere);
  await keyBar(liveWhere);
  press("Enter");
  await expect("Enter: the turn's actions, the ring on Stop", (f) => f.strips === 1 && f.item === liveKey && f.action === "stop:0" && f.ring);
  names("@fable's running turn", ["Stop", `show #${openPost.number}`, "sent to T3"]);
  await barSays("the turn's actions", { place: "room-actions", where: `Stop · ${liveWhere}`, keys: ["↑ ↓ previous or next post", "← → choose", "Enter Stop", "Esc Backspace close", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  await state("a running turn's actions: Stop, what it works on, sent to T3", `Stop · ${liveWhere}`);
  press("ArrowDown");
  await expect("Down from the turn's actions: the composer's strip, no actions left", (f) => f.strips === 0 && f.tag === "BUTTON" && /Write a message|draft/.test(f.label));
  press("ArrowUp");
  await expect("Up: back on the running turn", (f) => f.key === liveKey);
  await state("Up and Down leave a post's actions: the post above or below, the running turn, the composer's strip", liveWhere);

  // Stop from the turn's actions (nothing waits for him, so nothing wakes him again): the API shows the run ended and
  // T3's thread running nothing; the ring goes to a post.
  press("Enter");
  await expect("Enter: the turn's actions, on Stop", (f) => f.action === "stop:0");
  press("Enter");
  const stopped = await until("the API to show @fable's turn stopped", async () => {
    const s = await room.snapshot();
    const desk = await service.call<{ participants: Record<string, { runningRun?: unknown }> }>("GET", `/api/rooms/${R}/desk`);
    const run = s.runs.find((r: any) => r.id === fableRun.id);
    const notice = s.needsYou.find((p: any) => p.notice?.retryRunId === fableRun.id);
    return run?.phase === "terminal" && !desk.participants[room.participant.fable]?.runningRun && notice ? notice : null;
  });
  log(`api: run ${fableRun.id.slice(0, 8)} terminal, T3's thread runs nothing; #${stopped.number} needs you, Retry offered`);
  const afterStop = await expect("the turn gone, the ring on a post (not on the page itself)", (f) => f.key?.startsWith("post:") === true && f.ring && inRoom(f) && !browser.eval<boolean>(`() => Boolean(document.querySelector('[data-nav-key="${liveKey}"]'))`));
  await state("Stop from a running turn's actions stops it through T3", await postWhere(afterStop.key));

  // A failed turn's actions: Retry, Dismiss, the post it is on, Detail. Down from the newest post's actions goes to the
  // composer's strip. Retry sends the turn again (the API: a new run on the request, the notice retried); then the new
  // turn fails in T3 and Dismiss takes its notice off your list.
  press("End");
  const newestNow = await expect("End: the newest post", (f) => f.key?.startsWith("post:") === true);
  press("Enter");
  await expect("Enter: the newest post's actions", (f) => f.strips === 1 && f.item === newestNow.key);
  press("ArrowDown");
  await expect("Down from the newest post's actions (no turn running): the composer's strip, no actions left", (f) => f.strips === 0 && f.tag === "BUTTON" && /Write a message|draft/.test(f.label));
  await toPost(stopped.seq, `the stopped turn's notice #${stopped.number}`);
  press("Enter");
  await expect("Enter: the notice's actions, the ring on Retry", (f) => f.strips === 1 && f.item === `post:${stopped.seq}` && f.action === "retry:0" && f.ring);
  names(`#${stopped.number}, a failed turn`, ["Retry", "Dismiss", `show #${openPost.number}`, "Detail"]);
  press("Enter");
  const retried = await until("the API to show the turn sent again", async () => {
    const s = await room.snapshot();
    const notice = s.posts.find((p: any) => p.id === stopped.id);
    const run = s.runs.find((r: any) => r.id !== fableRun.id && r.phase !== "terminal" && r.requestIds.includes(open));
    return notice?.notice.retried && !s.needsYou.some((p: any) => p.id === stopped.id) && run ? run : null;
  });
  await room.live("fable");
  log(`api: #${stopped.number} retried, off your list; run ${retried.id.slice(0, 8)} on #${openPost.number} runs`);
  await expect("Retry gone with the ring on it: the actions closed, the ring on the notice", (f) => f.strips === 0 && f.key === `post:${stopped.seq}` && f.ring);
  await state("Retry from a failed turn's actions sends it again", await postWhere(`post:${stopped.seq}`));
  // Correct… from the actions (while the retried turn runs): its box opens in place, the field focused (the actions
  // stay under it); Esc closes the box with the ring back on Correct…; Enter sends (Shift+Enter is a new line) and the
  // ring is back on Correct….
  const unCorrected = room.post(await room.snapshot(), open).request.corrections as number;
  await toPost(openPost.seq, `#${openPost.number}, still open`);
  press("Enter");
  await expect("Enter: the actions, on Correct…", (f) => f.action === correct);
  press("Enter");
  await expect("Enter on Correct…: its box in place, the field focused, the actions still there", (f) => f.tag === "TEXTAREA" && f.label === `Correction to #${openPost.number}` && f.correctionOpen && f.strips === 1);
  await barSays("the correction's field", { place: "correction", where: `correcting #${openPost.number}`, keys: ["Enter send it", "Shift+Enter new line", "Tab on to Send correction", "Esc close it, back to Correct…"], end: null });
  press("Escape");
  await expect("Esc: the box closed, the ring back on Correct… in the actions", (f) => !f.correctionOpen && f.action === correct && f.strips === 1 && f.ring);
  press("Enter");
  await expect("Enter on Correct… again: the field", (f) => f.tag === "TEXTAREA" && f.correctionOpen);
  for (const key of ["d", "a", "t", "e"]) press(key);
  press("Shift+Enter");
  for (const key of ["o", "k"]) press(key);
  await expect("typed: date, Shift+Enter a new line, ok", (f) => f.value === "date\nok");
  press("Enter");
  const corrected = await until("the API to show the correction sent", async () => {
    const s = await room.snapshot();
    const post = room.post(s, open);
    const correction = s.posts.find((p: any) => p.kind === "correction" && p.body === "date\nok");
    return post.request.corrections === unCorrected + 1 && post.request.state === "open" && correction ? { post, correction } : null;
  });
  log(`api: #${openPost.number} corrected ${corrected.post.request.corrections}×, still open; the correction #${corrected.correction.number} reads "date\\nok"`);
  await expect("Enter sent it: the box closed, the ring back on Correct… in the actions", (f) => !f.correctionOpen && f.action === correct && f.strips === 1 && f.ring);
  await state("Correct… from a post's actions: the box in place, Esc closes it, Enter sends it, the ring back on Correct…", `Correct… · ${mine}`);

  // The same in the post's Detail: Enter in its correction sends it too; the detail stays, the ring on its Correct….
  await toDetail();
  press("Enter");
  await expect(`Enter on Detail: the detail of #${openPost.number}`, (f) => f.dialog === `Post #${openPost.number}`);
  await tabTo("Tab to Correct… in the detail", (f) => f.inDialog && f.label === "Correct…");
  press("Enter");
  await expect("Enter: the detail's correction field", (f) => f.inDialog && f.tag === "TEXTAREA");
  for (const key of ["t", "a", "g"]) press(key);
  await expect("typed: tag", (f) => f.inDialog && f.value === "tag");
  press("Enter");
  await until("the API to show the detail's correction sent", async () => {
    const s = await room.snapshot();
    return room.post(s, open).request.corrections === unCorrected + 2 && s.posts.some((p: any) => p.kind === "correction" && p.body === "tag") ? true : null;
  });
  await expect("Enter sent it: the detail stays, the ring on its Correct…", (f) => f.dialog === `Post #${openPost.number}` && f.inDialog && f.label === "Correct…" && !f.correctionOpen);
  log(`api: #${openPost.number} corrected ${unCorrected + 2}×, the second "tag", from the detail`);
  await state("Enter in the Detail's correction sends it too", `Post #${openPost.number}`);
  press("Escape");
  await expect("Esc: the detail closed, the ring back on Detail in the actions", (f) => f.dialog === null && f.action === "detail" && f.strips === 1);
  press("Escape");
  await expect("Esc: the actions closed", (f) => f.strips === 0 && f.key === `post:${openPost.seq}`);

  // The retried turn fails in T3 (the corrections then wake him again, for a turn of their own).
  await room.finish("fable", "The model is overloaded.", { outcome: "error" });
  const failed = await until("the API to show the new turn failed, needing you", async () => {
    const s = await room.snapshot();
    return s.needsYou.find((p: any) => p.notice?.retryRunId === retried.id) ?? null;
  });
  await toPost(failed.seq, `the failed turn's notice #${failed.number}`);
  press("Enter");
  await expect("Enter: its actions, on Retry", (f) => f.strips === 1 && f.item === `post:${failed.seq}` && f.action === "retry:0");
  press("ArrowRight");
  await expect("Right: Dismiss", (f) => f.action === "dismiss:0");
  press("Enter");
  await until("the API to show the notice dismissed", async () => {
    const s = await room.snapshot();
    const notice = s.posts.find((p: any) => p.id === failed.id);
    return notice?.notice.dismissed && !notice.notice.needsYou && s.needsYou.length === 0 ? true : null;
  });
  log(`api: #${failed.number} dismissed, nothing needs you`);
  await expect("Dismiss gone with the ring on it: the actions closed, the ring on the notice", (f) => f.strips === 0 && f.key === `post:${failed.seq}` && f.ring);
  await state("Dismiss from a failed turn's actions takes it off your list", await postWhere(`post:${failed.seq}`));

  // Cancel from the actions: the API shows the request cancelled, with its cancel post; the ring on the post.
  await toPost(openPost.seq, `#${openPost.number}, still open`);
  press("Enter");
  await expect("Enter: its actions", (f) => f.strips === 1 && f.action === correct);
  press("ArrowRight");
  await expect("Right: Cancel", (f) => f.action === `cancel:${openPost.number}`);
  press("Enter");
  const cancelled = await until("the API to show the request cancelled", async () => {
    const s = await room.snapshot();
    const cancel = s.posts.find((p: any) => p.kind === "cancel" && p.about.some((r: any) => r.requestId === open));
    return room.post(s, open).request.state === "cancelled" && cancel ? cancel : null;
  });
  log(`api: #${openPost.number} cancelled, the cancel #${cancelled.number}`);
  await expect("Correct… and Cancel gone: the actions closed, the ring on the post", (f) => f.strips === 0 && f.key === `post:${openPost.seq}` && f.ring);
  await state("Cancel from a request's actions cancels it", new RegExp(`^#${openPost.number} · you to @fable, cancelled`));

  // A reply's actions: Copy, Read aloud, what it answers, its file chip, turn in T3, sent to T3, Detail. The file is in
  // a project of the run's own (its data folder), named in his text; his turn has earlier messages and a file changed.
  const project = join(room.dataDir, "k1-5-project");
  const fileText = "# Release v1.2\n\nThe parser fix, then the tag, then these notes.\n";
  mkdirSync(join(project, "notes"), { recursive: true });
  writeFileSync(join(project, "notes", "release.md"), fileText);
  await service.command({ type: "project.create", workspaceRoot: project, title: "k1-5-files" });
  await room.settle("fable");
  const notesAsk = await room.message("Write the release notes.");
  const notesRun = await room.live("fable");
  // The ring on his running turn when it ends: it goes to the reply that replaced it, not to the page.
  browser.poll<boolean>("the page to draw his running turn", `() => Boolean(document.querySelector('[data-nav-key="live:${notesRun.id}"]'))`, (drawn) => drawn === true);
  press("End");
  await expect("End: the newest post", (f) => f.key?.startsWith("post:") === true);
  press("ArrowDown");
  await expect(`Down: his running turn (run ${notesRun.id.slice(0, 8)})`, (f) => f.key === `live:${notesRun.id}` && f.ring, 10_000);
  const progress = ["Reading the parser fix.", "Writing the notes."];
  await room.finish("fable", "The notes are in `notes/release.md`: the parser fix, then the tag.", { progress, files: [{ path: "notes/release.md", kind: "modified", additions: 3, deletions: 0 }] });
  const s8 = await room.snapshot();
  const asked = room.post(s8, notesAsk);
  const reply = s8.posts.find((p: any) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === notesAsk && c.outcome === "answered"));
  if (!reply?.output.t3?.runId) fail(`the API has no reply with a T3 turn answering #${asked.number}: ${JSON.stringify(reply?.output ?? null).slice(0, 300)}`);
  const replyWhere = `#${reply.number} · @fable replied`;
  await expect(`the turn ended: the ring on his reply #${reply.number}, not on the page`, (f) => f.key === `post:${reply.seq}` && f.ring, 10_000);
  await state("the ring on a running turn goes to its reply when the turn ends", replyWhere);
  browser.eval<boolean>(`() => {
    window.__rehearseCopied = null;
    navigator.clipboard.writeText = (text) => { window.__rehearseCopied = text; return Promise.resolve(); };
    window.__rehearseSpoken = [];
    window.__rehearseHushed = 0;
    speechSynthesis.speak = (u) => { window.__rehearseSpoken.push(u.text); setTimeout(() => u.onstart && u.onstart(new Event('start')), 0); };
    speechSynthesis.cancel = () => { window.__rehearseHushed += 1; };
    return true;
  }`);
  log("  page: the clipboard's writeText and speechSynthesis stubbed, recording what the page sends them");
  await toPost(reply.seq, `@fable's reply #${reply.number}`);
  press("Enter");
  await expect("Enter: the reply's actions, the ring on Copy", (f) => f.strips === 1 && f.item === `post:${reply.seq}` && f.action === "copy:0" && f.ring);
  names(`#${reply.number}, a reply`, ["Copy", "Read aloud", `show #${asked.number}`, "release.md", "turn in T3", "sent to T3", "Detail"]);
  press("Enter");
  await expect("Enter on Copy: Copied", (f) => f.action === "copy:0" && f.label === "Copied");
  const copied = browser.eval<string | null>("() => window.__rehearseCopied");
  if (copied === null || copied !== reply.body) return fail(`the clipboard got ${JSON.stringify(copied)}, the API's post reads ${JSON.stringify(reply.body)}`);
  log(`  page: the clipboard holds the API's body of #${reply.number} (${copied.length} characters)`);
  press("ArrowRight");
  await expect("Right: Read aloud", (f) => f.action === "speak:0" && f.label === "Read aloud");
  press("Enter");
  await expect("Enter: it reads, the button says Stop reading", (f) => f.action === "speak:0" && f.label === "Stop reading");
  const spoken = browser.eval<string[]>("() => window.__rehearseSpoken").join(" ");
  if (!spoken.includes("fable") || !spoken.includes("The notes are in")) fail(`the voice was given ${JSON.stringify(spoken)}`);
  const hushed = browser.eval<number>("() => window.__rehearseHushed");
  await keyBar(`Stop reading · ${replyWhere}`);
  press("Enter");
  await expect("Enter on Stop reading: it stops, Read aloud again", (f) => f.action === "speak:0" && f.label === "Read aloud");
  if (browser.eval<number>("() => window.__rehearseHushed") <= hushed) fail("Stop reading did not stop the voice");
  log(`  page: the voice was given "${spoken.slice(0, 60)}…", then stopped`);
  await state("a reply's actions: Copy puts it on the clipboard, Read aloud reads it, Stop reading stops", `Read aloud · ${replyWhere}`);
  // A #ref shows the post it names and takes the ring there.
  press("ArrowRight");
  await expect(`Right: show #${asked.number}`, (f) => f.action === "ref:0");
  press("Enter");
  await expect(`Enter on show #${asked.number}: the ring on #${asked.number}, the actions closed`, (f) => f.key === `post:${asked.seq}` && f.strips === 0 && f.ring);
  await until(`#${asked.number} in the board's view`, () => browser.eval<boolean>(`() => { const t = document.querySelector('.ov-drawer[data-view="room"] .timeline').getBoundingClientRect(); const r = document.querySelector('[data-nav-key="post:${asked.seq}"]').getBoundingClientRect(); return r.top >= t.top - 1 && r.bottom <= t.bottom + 1; }`) || null, 6000, 200);
  await state("a reply's actions: a #ref shows the post it names, the ring on it", await postWhere(`post:${asked.seq}`));
  await toPost(reply.seq, `back on @fable's reply #${reply.number}`);
  press("Enter");
  await expect("Enter: the reply's actions, on Copy", (f) => f.strips === 1 && f.action === "copy:0");
  press("ArrowRight");
  press("ArrowRight");
  press("ArrowRight");
  await expect("Right ×3: the file chip release.md", (f) => f.action === "file:0" && f.label === "release.md");
  press("Enter");
  await expect("Enter on release.md: its preview over the page", (f) => (f.dialog ?? "").includes("release.md") && f.inDialog);
  browser.poll<string>("the preview to show the file", "() => document.querySelector('.dialog')?.textContent ?? ''", (text) => text.includes("The parser fix, then the tag, then these notes."));
  const previewed = await service.call<{ content?: string; path: string }>("GET", `/api/file-preview?path=${encodeURIComponent("notes/release.md")}`);
  if (previewed.content !== fileText) fail(`the API previews ${JSON.stringify(previewed)}, the file holds ${JSON.stringify(fileText)}`);
  log(`api: GET /api/file-preview reads ${previewed.path}, as the page shows it`);
  await state("a reply's actions: a file chip opens its preview", focus().dialog!);
  press("Escape");
  await expect("Esc: the preview closed, the ring back on release.md in the actions", (f) => f.dialog === null && f.action === "file:0" && f.strips === 1 && f.ring);
  press("ArrowRight");
  await expect("Right: turn in T3", (f) => f.action === "turn:0");
  press("Enter");
  await expect("Enter: turn in T3 opens", (f) => f.action === "turn:0" && f.expanded === "true");
  browser.poll<string>("the turn as T3 shows it", `() => document.querySelector('[data-nav-key="post:${reply.seq}"] .turn-in-t3')?.textContent ?? ''`, (text) => progress.every((m) => text.includes(m)) && text.includes("1 file changed"));
  const t3 = await service.call<{ items: Array<{ kind: string; runId?: string; progress?: Array<{ text: string }>; files?: { count: number } | null }> }>("GET", `/api/threads/${room.thread.fable}`);
  const turn = t3.items.find((i) => i.kind === "reply" && i.runId === reply.output.t3.runId);
  if (JSON.stringify(turn?.progress?.map((n) => n.text)) !== JSON.stringify(progress) || turn?.files?.count !== 1) fail(`T3's turn for #${reply.number} is ${JSON.stringify(turn)}`);
  log(`api: T3's turn ${String(reply.output.t3.runId).slice(0, 8)}: ${progress.length} earlier messages, 1 file changed, as the page shows them`);
  await state("a reply's actions: turn in T3 shows its earlier messages and the files it changed", `turn in T3 · ${replyWhere}`);
  press("Escape");
  await expect("Esc: the actions closed, the ring on the reply", (f) => f.strips === 0 && f.key === `post:${reply.seq}`);

  // A preview opened from a running turn's actions, the turn ending while it is open: its button went with the turn,
  // so when the preview closes the ring goes to the newest post, the turn's reply, not to the page. The fake T3 streams
  // no feed: the page's desk read is given one message naming the file, as T3's feed would show it.
  await room.settle("fable");
  const tagAsk = await room.message("Check the tag.");
  const tagRun = await room.live("fable");
  const tagAsked = room.post(await room.snapshot(), tagAsk);
  browser.eval<boolean>(`() => {
    if (!window.__rehearseFeedFetch) {
      const real = window.fetch.bind(window);
      window.__rehearseFeedFetch = real;
      window.fetch = async (input, init) => {
        const response = await real(input, init);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const feed = window.__rehearseFeed;
        if (!feed || !/\\/desk(\\?|$)/.test(url) || !response.ok) return response;
        const body = await response.clone().json();
        const desk = body.participants && body.participants[feed.participant];
        if (!desk || !desk.runningRun) return response;
        desk.liveFeed = [...(desk.liveFeed || []), feed.item];
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
      };
    }
    window.__rehearseFeed = { participant: '${room.participant.fable}', item: { kind: 'message', id: 'rehearse-feed', text: 'Checking \`notes/release.md\` for the tag.', streaming: false, at: new Date().toISOString() } };
    return true;
  }`);
  browser.poll<boolean>("his running turn drawn, its feed naming the file", `() => Boolean(document.querySelector('[data-nav-key="live:${tagRun.id}"] .md-file'))`, (drawn) => drawn === true);
  press("End");
  await expect("End: the newest post", (f) => f.key?.startsWith("post:") === true);
  press("ArrowDown");
  await expect(`Down: his running turn (run ${tagRun.id.slice(0, 8)})`, (f) => f.key === `live:${tagRun.id}`);
  press("Enter");
  await expect("Enter: the turn's actions, on Stop", (f) => f.strips === 1 && f.action === "stop:0");
  names("his turn, a file named in its feed", ["Stop", `show #${tagAsked.number}`, "release.md", "sent to T3"]);
  press("ArrowRight");
  press("ArrowRight");
  await expect("Right ×2: the feed's file chip", (f) => f.action === "file:0");
  press("Enter");
  await expect("Enter: its preview over the page", (f) => (f.dialog ?? "").includes("release.md") && f.inDialog);
  await room.finish("fable", "The tag is v1.2.");
  const tagReply = (await room.snapshot()).posts.find((p: any) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === tagAsk && c.outcome === "answered"));
  if (!tagReply) fail(`the API has no reply answering #${tagAsked.number}`);
  browser.poll<boolean>("the turn gone from the page under the preview", `() => !document.querySelector('[data-nav-key="live:${tagRun.id}"]')`, (gone) => gone === true);
  log(`api: run ${tagRun.id.slice(0, 8)} ended with the reply #${tagReply.number}; page: its bubble gone under the preview`);
  press("Escape");
  await expect(`Esc: the preview closed; its button gone with the turn, the ring on his reply #${tagReply.number}`, (f) => f.dialog === null && f.key === `post:${tagReply.seq}` && f.ring);
  await state("a preview opened from a running turn's actions: the turn ends meanwhile, its closing puts the ring on the reply", `#${tagReply.number} · @fable replied`);
  browser.eval<boolean>("() => { window.__rehearseFeed = null; return true; }");

  // The ring is rescued only when the keys put it there (round 1's required change): after a click the page moves
  // neither the board nor the focus, as on main. The board's scrollTop, read before and after. A running turn's control
  // is clicked with the board at its bottom (a bubble out of view is left out of the page snapshot), by the last of its
  // kind in the snapshot (the turn's comes after the posts'), and the click is checked to have landed in the turn.
  const boardAt = () => browser.eval<{ top: number; distance: number }>("() => { const t = document.querySelector('.ov-drawer[data-view=room] .timeline'); return { top: Math.round(t.scrollTop), distance: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight) }; }");
  const toBoardTop = async (): Promise<number> => {
    browser.eval<boolean>("() => { document.querySelector('.ov-drawer[data-view=room] .timeline').scrollTop = 0; return true; }");
    await sleep(800);
    const at = boardAt();
    // Far from its bottom: the newest post out of view, where a rescue would scroll to.
    if (at.distance < 1000) fail(`the board scrolled to its top is only ${at.distance} px from its bottom: too short to show a move`);
    log(`  page: the board scrolled to its top (scrollTop ${at.top}, ${at.distance} px from its bottom)`);
    return at.top;
  };
  const lastUid = (pattern: RegExp, what: string): string => {
    const line = browser.on("snapshot").split("\n").filter((l) => pattern.test(l)).at(-1);
    const uid = line ? /uid=(\S+)/.exec(line)?.[1] : undefined;
    return uid ?? fail(`the page snapshot has no ${what}`);
  };
  /** A click on a running turn's control, the board at its bottom first; it fails unless the press landed in the turn. */
  const clickInTurn = async (run: string, pattern: RegExp, what: string): Promise<void> => {
    browser.eval<boolean>(`() => {
      const t = document.querySelector('.ov-drawer[data-view=room] .timeline');
      t.scrollTop = t.scrollHeight;
      window.__rehearseDown = null;
      document.addEventListener('pointerdown', (event) => { window.__rehearseDown = event.target.closest('[data-run]')?.dataset.run ?? 'elsewhere'; }, { capture: true, once: true });
      return true;
    }`);
    await sleep(500);
    browser.on("click", lastUid(pattern, what));
    const down = browser.eval<string | null>("() => window.__rehearseDown");
    if (down !== run) fail(`the click on ${what} landed ${down === null ? "nowhere" : down === "elsewhere" ? "outside his turn" : `in turn ${down.slice(0, 8)}`}, not in his running turn ${run.slice(0, 8)}`);
    log(`  page: a click on ${what}, in his running turn`);
  };
  const replyTo = async (ask: string): Promise<any> => {
    const reply = (await room.snapshot()).posts.find((p: any) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === ask && c.outcome === "answered"));
    return reply ?? fail(`the API has no reply answering request ${ask}`);
  };
  // The focus on nothing: FOCUS reads the page's body as no element (tag null).
  const boardStays = async (what: string, top: number, run: string, reply: any): Promise<void> => {
    browser.poll<boolean>("his turn gone and his reply drawn", `() => !document.querySelector('[data-run="${run}"]') && Boolean(document.querySelector('[data-nav-key="post:${reply.seq}"]'))`, (done) => done === true);
    // The rescue runs after the draw, a dialog's after two frames: time for it to have moved the board.
    await sleep(800);
    const after = boardAt();
    if (after.top !== top) fail(`${what}: the board moved from scrollTop ${top} to ${after.top} (${after.distance} px from its bottom)`);
    await expect(`${what}: the focus not moved by the page (on nothing)`, (f) => f.tag === null && f.dialog === null);
    log(`api: run ${run.slice(0, 8)} ended with the reply #${reply.number}; page: the board still at scrollTop ${after.top}, the focus on nothing`);
  };

  // A click in a running turn's bubble (its "sent to T3"), then the board scrolled to its top: the turn ends.
  await room.settle("fable");
  const clickAsk = await room.message("Check the parser once more.");
  const clickRun = await room.live("fable");
  browser.poll<boolean>("his running turn drawn, with what was sent to T3", `() => Boolean(document.querySelector('[data-nav-key="live:${clickRun.id}"] .sent-to-t3 summary'))`, (drawn) => drawn === true);
  await clickInTurn(clickRun.id, /DisclosureTriangle "sent to T3"/, `"sent to T3" on his running turn`);
  await expect(`a click on his turn's "sent to T3": the focus in his bubble, no ring drawn`, (f) => f.item === `live:${clickRun.id}` && f.tag === "SUMMARY" && !f.visible);
  const clickTop = await toBoardTop();
  await room.finish("fable", "The parser is fine.");
  await boardStays("the turn ended after a click in its bubble", clickTop, clickRun.id, await replyTo(clickAsk));
  await state("a click in a running turn's bubble: when the turn ends the page moves neither the board nor the focus", apiRoomTitle);

  // A preview opened from a running turn, the turn ending while it is open, closed with a click: opened by the mouse
  // from the feed's file chip, then by the keys from the turn's actions. The board, scrolled to its top under it, stays.
  const previewClosedByClick = async (how: "mouse" | "keys"): Promise<void> => {
    await room.settle("fable");
    const ask = await room.message(how === "mouse" ? "Check the notes." : "Check the notes once more.");
    const run = await room.live("fable");
    browser.eval<boolean>(`() => { window.__rehearseFeed = { participant: '${room.participant.fable}', item: { kind: 'message', id: 'rehearse-feed', text: 'Checking \`notes/release.md\`.', streaming: false, at: new Date().toISOString() } }; return true; }`);
    browser.poll<boolean>("his running turn drawn, its feed naming the file", `() => Boolean(document.querySelector('[data-nav-key="live:${run.id}"] .md-file'))`, (drawn) => drawn === true);
    if (how === "mouse") {
      await clickInTurn(run.id, /button "release\.md"/, "the file chip in his running turn's feed");
    } else {
      press("End");
      await expect("End: the newest post", (f) => f.key?.startsWith("post:") === true);
      press("ArrowDown");
      await expect(`Down: his running turn (run ${run.id.slice(0, 8)})`, (f) => f.key === `live:${run.id}`);
      press("Enter");
      await expect("Enter: the turn's actions, on Stop", (f) => f.strips === 1 && f.action === "stop:0");
      press("ArrowRight");
      press("ArrowRight");
      await expect("Right ×2: the feed's file chip", (f) => f.action === "file:0");
      press("Enter");
    }
    await expect(`${how === "mouse" ? "a click on the feed's file chip" : "Enter on it"}: its preview over the page`, (f) => (f.dialog ?? "").includes("release.md") && f.inDialog);
    const top = await toBoardTop();
    await room.finish("fable", "The notes are right.");
    browser.poll<boolean>("the turn gone from the page under the preview", `() => !document.querySelector('[data-run="${run.id}"]')`, (gone) => gone === true);
    browser.on("click", lastUid(/button "Close dialog"/, "the preview's Close"));
    await boardStays(`the preview ${how === "mouse" ? "the mouse" : "the keys"} opened, closed with a click`, top, run.id, await replyTo(ask));
    browser.eval<boolean>("() => { window.__rehearseFeed = null; return true; }");
  };
  await previewClosedByClick("mouse");
  await previewClosedByClick("keys");
  await state("a preview opened from a running turn, closed with a click once the turn ended: the page moves neither the board nor the focus", apiRoomTitle);

  // A turn still being prepared (the engine's phase before it is sent to T3) has no Stop and no "sent to T3". On no
  // request it has nothing to press: no stop, so the bar never offers Enter its actions on it; on a request it is one,
  // and Enter opens its actions, what it works on. The fake T3 sends at once: the page's snapshot is given such a turn
  // of @fable's, the API's turns all ended.
  await room.settle("fable");
  const ended = ((await room.snapshot()).runs as any[]).filter((r) => r.seatId === room.seat.fable && r.phase === "terminal").at(-1);
  if (!ended) fail("the API has no ended turn of @fable's");
  const prepared = { ...ended, id: "rehearse-prepared", phase: "prepared", t3RunId: null, requestIds: [], failure: null, output: null, startedAt: null, endedAt: null };
  const givePrepared = (run: unknown) =>
    browser.eval<boolean>(`() => {
      if (!window.__rehearseRunsFetch) {
        const real = window.fetch.bind(window);
        window.__rehearseRunsFetch = real;
        window.fetch = async (input, init) => {
          const response = await real(input, init);
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
          const run = window.__rehearseRun;
          if (!run || url.pathname !== '/api/rooms/${R}' || !response.ok) return response;
          const body = await response.clone().json();
          body.runs = [...body.runs, run];
          return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
        };
      }
      window.__rehearseRun = ${JSON.stringify(run)};
      return true;
    }`);
  givePrepared(prepared);
  browser.poll<boolean>("the page to draw @fable's turn being prepared", `() => Boolean(document.querySelector('[data-run="rehearse-prepared"]'))`, (drawn) => drawn === true, 25_000);
  if (((await room.snapshot()).runs as any[]).some((r) => r.seatId === room.seat.fable && r.phase !== "terminal")) fail("the API has a turn of @fable's that has not ended: the prepared one is to be the page's only");
  press("End");
  await expect("End: the newest post", (f) => f.key?.startsWith("post:") === true);
  press("ArrowDown");
  await expect("Down from the newest post: the composer's strip (the turn being prepared has nothing to press: no stop)", (f) => f.tag === "BUTTON" && /Write a message|draft/.test(f.label) && f.strips === 0);
  if (browser.eval<boolean>("() => document.querySelector('[data-run=\"rehearse-prepared\"]').hasAttribute('data-nav')")) fail("@fable's turn being prepared, on no request, is a stop with nothing to press");
  log("api: no turn of @fable's runs; page: his turn being prepared drawn, no stop");
  givePrepared({ ...prepared, requestIds: [clickAsk] });
  const clickAsked = room.post(await room.snapshot(), clickAsk);
  const preparedWhere = `@fable's turn · preparing on #${clickAsked.number}`;
  browser.poll<boolean>("the turn being prepared a stop now it is on a request", `() => Boolean(document.querySelector('[data-nav-key="live:rehearse-prepared"]'))`, (stop) => stop === true, 25_000);
  press("ArrowUp");
  await expect("Up from the strip: the newest post", (f) => f.key?.startsWith("post:") === true);
  press("ArrowDown");
  await expect("Down: his turn being prepared", (f) => f.key === "live:rehearse-prepared" && f.ring);
  await barSays("his turn being prepared, on a request", { place: "room-post", where: preparedWhere, keys: ["↑ ↓ previous or next post", "← → between the panes", "Enter its actions", "Backspace back to the overview", "a–z start writing", "Home End first or last post"], end: "? all keys" });
  press("Enter");
  await expect("Enter: its actions, on what it works on", (f) => f.strips === 1 && f.action === "ref:0");
  names("his turn being prepared, on a request", [`show #${clickAsked.number}`]);
  press("Escape");
  await expect("Esc: the actions closed, the ring on his turn", (f) => f.strips === 0 && f.key === "live:rehearse-prepared");
  await state("a turn being prepared: no stop with nothing to press; on a request Enter opens its actions", preparedWhere);
  browser.eval<boolean>("() => { window.__rehearseRun = null; return true; }");
  browser.poll<boolean>("the page's turn being prepared gone", `() => !document.querySelector('[data-run="rehearse-prepared"]')`, (gone) => gone === true, 25_000);

  // A turn typed in T3 (the worker's; the board draws it, the chat only the Consigliere's): no stop while it asks
  // nothing (it has no Stop here, nothing to do); with a question it is one, and its actions are the question's choices.
  // A choice pressed shows as chosen (the strip follows the checked state), an answer of your own takes the focus and Esc
  // there gives the ring back to its button, and Submit answers answers T3.
  await abovePosts("the room state", (f) => f.key === "state");
  press("ArrowUp");
  await expect("Up: the header, on the chat's tab", (f) => f.key === "head:chat");
  press("ArrowRight");
  await expect("Right: the Board tab", (f) => f.key === "head:board");
  press("Enter");
  await expect("Enter: the board", (f) => f.view === "board" && f.key === "head:board");
  const external = (await service.fake("external-run", { threadId: room.thread.worker, text: "Check the logs in T3." })) as { runId: string };
  const liveT3 = `live:t3:${external.runId}`;
  browser.poll<boolean>("the worker's turn drawn on the board", "() => [...document.querySelectorAll('.timeline .live-turn')].some((row) => row.textContent.includes('worker'))", (drawn) => drawn === true);
  press("End");
  await expect("End: the board's newest post", (f) => f.key?.startsWith("post:") === true && f.view === "board");
  press("ArrowDown");
  await expect("Down from the newest post: the composer's strip (the worker's turn asks nothing: no stop)", (f) => f.tag === "BUTTON" && /Write a message|draft/.test(f.label) && f.strips === 0);
  if (browser.eval<boolean>(`() => Boolean(document.querySelector('[data-nav-key="${liveT3}"]'))`)) fail("the worker's turn typed in T3 is a stop while it asks nothing");
  log(`api: the worker's turn ${external.runId.slice(0, 8)} typed in T3 runs; page: drawn on the board, no stop`);
  await service.fake("question", { threadId: room.thread.worker, questions: [{ id: "Proceed?", header: "Confirm", question: "Proceed?", options: [{ label: "yes", description: "Proceed" }, { label: "no", description: "Do not proceed" }], allowCustomAnswer: true }] });
  await until("the API to show the worker's question", async () => ((await room.snapshot()).nativeRequests as Array<{ participantId: string }>).some((r) => r.participantId === room.participant.worker) || null);
  browser.poll<boolean>("the worker's turn a stop now it asks", `() => Boolean(document.querySelector('[data-nav-key="${liveT3}"]'))`, (stop) => stop === true);
  press("ArrowUp");
  await expect("Up from the strip: the newest post", (f) => f.key?.startsWith("post:") === true);
  press("ArrowDown");
  await expect("Down: the worker's turn, a stop now", (f) => f.key === liveT3 && f.ring);
  press("Enter");
  await expect("Enter: its actions, the ring on yes", (f) => f.strips === 1 && f.item === liveT3 && f.action === "choice:0" && f.ring);
  names("the worker's turn asking", ["yes", "no", "the answer of your own", "Custom answer", "Submit answers", "Dismiss"]);
  const pressedOf = (key: string) => browser.eval<string | null>(`() => document.querySelector('.action-strip [data-action="${key}"]')?.getAttribute('aria-pressed') ?? null`);
  press("Enter");
  await expect("Enter on yes: chosen", (f) => f.action === "choice:0" && f.pressed === "true");
  press("ArrowRight");
  await expect("Right: no, not chosen", (f) => f.action === "choice:1" && f.pressed === "false");
  press("Enter");
  await expect("Enter on no: chosen", (f) => f.action === "choice:1" && f.pressed === "true");
  await until("yes shown as no longer chosen", () => pressedOf("choice:0") === "false" || null, 3000, 100);
  await state("a turn typed in T3 asking a question: its actions are the choices, each shown as chosen", "no · @worker's turn · needs you, typed in T3");
  press("ArrowRight");
  press("ArrowRight");
  await expect("Right ×2: Custom answer", (f) => f.action === "choice:3");
  press("Enter");
  await expect("Enter on Custom answer: its field focused, the actions still open", (f) => f.tag === "INPUT" && f.strips === 1);
  for (const key of ["m", "a", "y", "b", "e"]) press(key);
  await expect("typed: maybe", (f) => f.tag === "INPUT" && f.value === "maybe");
  await until("the answer of your own shown as chosen once typed", () => pressedOf("choice:2") === "true" || null, 3000, 100);
  press("Escape");
  await expect("Esc in the field: the ring back on Custom answer in the actions", (f) => f.action === "choice:3" && f.strips === 1 && f.ring);
  press("ArrowRight");
  await expect("Right: Submit answers", (f) => f.action === "choice:4");
  press("Enter");
  await until("the API to show the question answered", async () => !((await room.snapshot()).nativeRequests as Array<{ participantId: string }>).some((r) => r.participantId === room.participant.worker) || null);
  log("api: the worker's question answered, nothing asks you");
  await expect("the turn asks nothing more: no stop, the actions gone, the ring on a post (not on the page)", (f) => f.strips === 0 && f.key?.startsWith("post:") === true && f.ring, 10_000);
  await state("Submit answers from a turn's actions answers T3; asking nothing more, the turn is no stop", await postWhere(focus().key));
  // The worker's turn ends; its follow-up wakes the Consigliere (maybe only after a moment), whose turn is ended too:
  // the room is quiet once nothing runs or waits to, three reads in a row a second apart.
  await service.fake("complete", { threadId: room.thread.worker, text: "Logs checked." });
  let calm = 0;
  await until("the room to be quiet", async () => {
    const s = await room.snapshot();
    const busy = (s.runs as Array<{ phase: string }>).some((r) => r.phase !== "terminal") || (s.seats as Array<{ status: string; activeRunId: string | null; unread: number }>).some((x) => x.status !== "retired" && (x.activeRunId !== null || x.unread > 0));
    if (busy) {
      calm = 0;
      for (const alias of ["fable", "worker", "reviewer"] as const) await room.settle(alias);
      return null;
    }
    calm += 1;
    return calm >= 3 || null;
  }, 90_000, 1000);
  press("Backspace");
  await expect("Backspace: back on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  // The room's tile ranks by what it asks (busy among them): the arrows go on once a poll shows it settled.
  browser.poll<boolean>("the room's tile to show nothing busy", `() => !(document.querySelector('[data-nav-key="room:${R}"]')?.closest('[data-nav-card]')?.textContent ?? 'busy').includes('busy')`, (settled) => settled === true, 30_000);

  // A running turn with an approval waiting (the second room's @alpha): its actions hold Stop, the approval's choices,
  // what it works on and sent to T3. Esc closes them; the approval still waits in the API.
  const secondLive = (await second.snapshot()) as { runs: Array<{ id: string; phase: string; requestIds: string[] }>; nativeRequests: unknown[]; requests: Array<{ id: string; number: number }> };
  const alphaLive = secondLive.runs.find((r) => r.id === alphaRun[0]!.id && r.phase === "running");
  if (!alphaLive || secondLive.nativeRequests.length !== 1) return fail(`the API should still show @alpha's turn running with its approval waiting: ${JSON.stringify({ runs: secondLive.runs.map((r) => [r.id.slice(0, 8), r.phase]), asking: secondLive.nativeRequests.length })}`);
  const alphaOn = alphaLive.requestIds.map((id) => secondLive.requests.find((q) => q.id === id)?.number).filter((n): n is number => n !== undefined);
  await goTo(`room:${second.roomId}`);
  press("Enter");
  await expect("Enter: the second room, the ring on the approval's chip", (f) => f.key === `chip:ask:${second.participant.alpha}` && inRoom(f), 10_000);
  press("ArrowDown");
  await expect("Down: its newest post", (f) => f.key?.startsWith("post:") === true);
  press("ArrowDown");
  await expect(`Down: @alpha's running turn (run ${alphaLive.id.slice(0, 8)})`, (f) => f.key === `live:${alphaLive.id}` && f.ring);
  press("Enter");
  await expect("Enter: the turn's actions, on Stop", (f) => f.strips === 1 && f.action === "stop:0");
  names("@alpha's turn with an approval", ["Stop", "Accept", "Accept for session", "Always accept", "Decline", "Cancel turn", ...alphaOn.map((n) => `show #${n}`), "sent to T3"]);
  await state("a running turn with an approval waiting: its actions offer the approval's choices", new RegExp("^Stop · @alpha's turn · needs you"));
  press("Escape");
  await expect("Esc: the actions closed, the ring on the turn", (f) => f.strips === 0 && f.key === `live:${alphaLive.id}`);
  press("Backspace");
  await expect("Backspace: back on the second room's card", (f) => f.drawers.length === 0 && f.key === `room:${second.roomId}`);
  if ((await second.snapshot()).nativeRequests.length !== 1) fail("the approval changed in the API while its actions were looked at");
  log("api: @alpha's approval still waits");

  // A thread outside rooms, by keys: Enter on its card, Up from its composer's strip to the conversation, Esc back.
  await goTo(`thread:${loose.threadId}`);
  press("Enter");
  await expect("Enter on the thread's card: it is open, the focus on its composer's strip", (f) => f.drawers.some((d) => d.view === "thread" && d.id === loose.threadId) && f.label.includes("Write a message"));
  press("ArrowUp");
  await expect("Up from the strip: the conversation (its arrows scroll it)", (f) => f.role === "log" && f.label === "Thread" && f.inLayer === "thread");
  press("Escape");
  await sleep(400);
  await expect("Esc in the thread closes nothing: it stays open", (f) => f.drawers.some((d) => d.view === "thread" && d.id === loose.threadId) && f.role === "log");
  press("Backspace");
  await expect("Backspace: back on the thread's card", (f) => f.drawers.length === 0 && f.key === `thread:${loose.threadId}`);
  await state("a thread outside rooms: Enter, Up to its conversation, Esc stays, Backspace back", await overviewWhere(`thread:${loose.threadId}`));

  // ---------------- 5b. a crew member seated in a room by keys alone (K1-3) ----------------

  // Enter on the crew member's tile opens its Edit dialog; its Seat in a room… lists the rooms; Enter on one seats them
  // there on a new thread, as dragging them onto the room's tile does. The API shows the new member.
  const sol = apiPresets.find((p) => p.name === "sol")!;
  const thirdBefore = ((await third.snapshot()).participants as Array<{ id: string; alias: string; retiredAt: string | null }>).filter((p) => !p.retiredAt);
  await goTo(`preset:${sol.id}`);
  await keyBar("sol · crew member");
  press("Enter");
  await expect("Enter on sol's tile: its Edit dialog, the focus in its name", (f) => f.dialog === "Edit sol" && f.inDialog && f.value === "sol");
  const seatButton =
    "() => { const b = [...document.querySelectorAll('.dialog button')].find((e) => e.textContent.trim() === 'Seat in a room…'); const why = b && b.getAttribute('aria-describedby') ? document.getElementById(b.getAttribute('aria-describedby')) : null; return b ? { waits: b.getAttribute('aria-disabled') === 'true', disabled: b.disabled, why: why && why.getClientRects().length > 0 ? why.textContent.trim() : null } : null; }";
  type Seat = { waits: boolean; disabled: boolean; why: string | null } | null;
  // They are seated with their saved settings: the button waits while the form says otherwise. A keyboard user still
  // reaches it, and its reason is a line in the dialog, the button's description.
  press("End");
  press("x");
  const waiting = browser.poll<Seat>("Seat in a room… to wait while the name is changed, its reason in sight", seatButton, (b) => b?.waits === true && !b.disabled && (b.why ?? "").includes("save or cancel the changes first"));
  log(`  page: Seat in a room… waits, its reason shown: "${waiting!.why}"`);
  await tabTo("Shift+Tab reaches the waiting Seat in a room…", (f) => f.inDialog && f.label === "Seat in a room…", "Shift+Tab", 6);
  announced(/^button$/, "Seat in a room…");
  press("Enter");
  await sleep(400);
  await expect("Enter on it while it waits opens nothing; the dialog stays", (f) => !f.menu && f.dialog === "Edit sol" && f.label === "Seat in a room…");
  await state("crew: Seat in a room… waits while the form has changes, reached by Tab, its reason in the dialog", "Edit sol");
  await tabTo("Tab back to the name field", (f) => f.inDialog && f.tag === "INPUT" && f.value === "solx", "Tab", 8);
  press("End");
  press("Backspace");
  browser.poll<Seat>("Seat in a room… to be back once the name is as saved, no reason shown", seatButton, (b) => b?.waits === false && b.why === null);
  await tabTo("Shift+Tab to Seat in a room…", (f) => f.inDialog && f.label === "Seat in a room…", "Shift+Tab", 6);
  press("Enter");
  await expect("Enter: the rooms in a menu over the dialog, the focus on the first", (f) => f.menu && f.role === "menuitem" && f.dialog === "Edit sol");
  press("Escape");
  await expect("Esc: the menu closed, the dialog stays, the focus back on Seat in a room…", (f) => !f.menu && f.dialog === "Edit sol" && f.label === "Seat in a room…");
  press("Enter");
  await expect("Enter: the rooms again", (f) => f.menu && f.role === "menuitem");
  for (let i = 0; i < apiRooms.length && !focus().label.startsWith("Third"); i += 1) press("ArrowDown");
  await expect("Down to Third", (f) => f.menu && f.label.startsWith("Third"));
  await state("crew: Seat in a room… in the Edit dialog lists the rooms", "Seat sol in a room");
  press("Enter");
  await expect("Enter on Third: the menu and the dialog closed, the focus back on sol's tile", (f) => !f.menu && f.dialog === null && f.key === `preset:${sol.id}` && f.ring);
  const seated = await until("the API to show sol seated in Third", async () => {
    const now = ((await third.snapshot()).participants as Array<{ id: string; alias: string; presetId?: string | null; retiredAt: string | null }>).filter((p) => !p.retiredAt);
    return now.length === thirdBefore.length + 1 ? now.find((p) => !thirdBefore.some((b) => b.id === p.id)) : null;
  });
  if (seated.alias !== "sol") fail(`the member seated in Third is @${seated.alias}, not @sol`);
  const seatToast = browser.poll<string | null>("the toast for the seat", "() => [...document.querySelectorAll('.toast-stack .toast')].map((t) => t.textContent.trim()).find((t) => t.includes('is seated')) ?? null", (t) => t !== null);
  log(`api: Third has @${seated.alias} (${seated.id.slice(0, 8)}), ${thirdBefore.length + 1} members; page: "${seatToast}"`);
  await state("a crew member seated in a room by keys alone", "sol · crew member");

  // ---------------- 6. the pixel look draws its own ring ----------------

  // Settings → Look → Pixel, by keys: the arrows to Settings in the header, Enter, Down to Pixel, Enter; the focus goes
  // back to Settings.
  await goTo("head:settings");
  await expect("the arrows reach Settings in the header", (f) => f.label === "Settings");
  press("Enter");
  await expect("Enter: the Settings menu, the focus on its first item", (f) => f.menu && (f.role ?? "").startsWith("menuitem"));
  for (let i = 0; i < 30 && !focus().label.startsWith("Pixel"); i += 1) press("ArrowDown");
  await expect("Down to Look → Pixel", (f) => f.menu && f.label.startsWith("Pixel"));
  press("Enter");
  await expect("Enter: the menu closed, the focus back on Settings", (f) => !f.menu && f.label === "Settings");
  await until("the pixel look", () => browser.eval<string>("() => document.documentElement.dataset.skin ?? ''") === "pixel");
  grid = await settledGrid();
  const pixelFoot = grid.filter((p) => p.element.startsWith("browser:")).sort((a, b) => b.bottom - a.bottom)[0]!;
  const pixelFirst = grid.filter((p) => p.tile && /^(room|thread):/.test(p.element)).sort((a, b) => a.top - b.top || a.left - b.left)[0]!;
  await upFromTheFoot(pixelFoot.element, pixelFirst.element);
  await state("pixel look: from the foot, Up brings the first row and its + into sight below the header", "New room in demo");
  await goTo(`preset:${sol.id}`);
  await expect("pixel look: the crew member's ring is drawn", (f) => f.ring);
  await state("pixel look: the overview's focus ring", "sol · crew member");
  await goTo(`room:${R}`);
  await expect("pixel look: the room card's brackets are drawn", (f) => f.ring);
  press("Enter");
  await expect("pixel look: the room is open", (f) => f.inLayer === "room");
  press("ArrowUp");
  const pixelPost = await expect("pixel look: a post's ring is drawn", (f) => f.key?.startsWith("post:") === true && f.ring);
  await state("pixel look: the room's focus ring", await postWhere(pixelPost.key));
  press("Backspace");
  await expect("pixel look: Backspace back to the overview", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  return passed;
}

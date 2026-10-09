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
 * The overview's grid (K1-3): its stops are the tiles (every room, thread, crew member and browser of the API has one,
 * and a room's members are read on its tile, not visited) and the buttons of its rows (the header, each section's +).
 * With four tiles on three columns the fourth sits under the first, so Down from that room's tile reaches the tile
 * below, then Crew's head, a crew member, Browsers' head and a browser, keeping to the column it began in; Up from the
 * first row reaches its section's + and then the header, which is the top; Left and Right stop at a row's ends. A crew
 * member is seated in a room by keys alone, from its Edit dialog's Seat in a room…, and the API shows the new member.
 * The mouse does the same (#499, #507): hovering a member's line on a tile hovers the tile, not the member, and the ring
 * and the key bar stay on the room; a click on it opens the room's conversation, not the member's thread.
 * Every other move on the overview (goTo) follows the grid's own function (keyOrder.ts, gridTarget), each step checked
 * on the page.
 */
import { ROOM_NOTE } from "../src/briefing/envelope.ts";
import { barEntries, gridTarget, KEYS, type Boxed, type KeyWhen, type NavKey, type Span } from "../web/src/keyOrder.ts";

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
  readonly thread: Record<Alias, string>;
  snapshot(): Promise<any>;
  post(snapshot: any, requestId: string): any;
  message(text: string): Promise<string>;
  live(alias: Alias, phases?: string[]): Promise<any>;
  finish(alias: Alias, text: string): Promise<void>;
  settle(alias: Alias): Promise<void>;
  second(title: string, aliases: string[]): Promise<{ roomId: string; participant: Record<string, string>; snapshot: () => Promise<any> }>;
  /** Appends engine commands to the room's journal through a second connection, as another process would. */
  journal(commands: Array<Record<string, unknown>>): void;
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
      const keys = entries.filter((entry) => entry !== help).map((entry) => ({ k: entry.keys, d: entry.does }));
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

  /** Up from the posts to the view's tabs: Home, then Up past the first post until the earlier posts are all drawn. */
  const toTabs = async (): Promise<Focus> => {
    for (let i = 0; i < 8; i += 1) {
      press("Home");
      const first = await expect("Home: the first post drawn", (f) => f.key?.startsWith("post:") === true);
      press("ArrowUp");
      const now = await expect("Up past it: an earlier post, or the view's tab", (f) => f.role === "tab" || (f.key?.startsWith("post:") === true && f.key !== first.key), 10_000);
      if (now.role === "tab") return now;
    }
    return fail("Up past the first post never reached the view's tabs");
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

  // ---------------- setup through the API (the room is seated by rehearse.ts) ----------------

  // The Consigliere's conversation: one message and his reply.
  const ask = await room.message("Plan the release: the parser fix, the tag and the notes.");
  await room.live("fable");
  await room.finish("fable", "Plan: the parser fix first, then the v1.2 tag, then the notes.");
  await room.settle("fable");
  // A long board: more posts than the page draws at first (60 on the board, 40 in the chat). Room notes are gone (N1),
  // so these are written to the journal as one from before N1 holds them, which the page still shows.
  room.journal(Array.from({ length: 62 }, (_, i) => ({ type: "post", actor: "$user", id: `note:long-board:${i + 1}`, intent: "note", body: `Note ${i + 1} on the long board`, milestone: ROOM_NOTE })));
  const second = await room.second("Second", ["alpha", "beta"]);
  const third = await room.second("Third", ["solo"]);
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
  const firstColumn = (await goTo(firstRow[0]!.element)) ?? firstRow[0]!;
  press("ArrowUp");
  await expect("Up from the first row: its section's +, New room in demo", (f) => f.key === "head:room:project_demo" && f.label === "New room in demo" && f.ring);
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
  await state("a click on a member's line opens the room's conversation", "Write a message");
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
  await expect("Enter: the room is open and the focus is in it (the composer's strip)", (f) => f.drawers.some((d) => d.view === "room" && d.id === R && !d.inert) && f.inLayer === "room" && f.label.includes("Write a message"));
  const opened = focus();
  if (opened.drawers[0]!.label !== `Room ${apiRoom.room.title}`) fail(`the drawer is named ${opened.drawers[0]!.label}, the API's room is ${apiRoom.room.title}`);
  log(`api: room ${R.slice(0, 8)} "${apiRoom.room.title}"; page: drawer data-id ${R.slice(0, 8)}, named "${opened.drawers[0]!.label}"`);
  await state("Enter on a room card opens it, with the focus inside", "Write a message");

  // The chat: the newest post first, then up through it.
  const s1 = await room.snapshot();
  const askPost = s1.posts.find((p: any) => p.request?.id === ask);
  const answer = s1.posts.find((p: any) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === ask && c.outcome === "answered"));
  if (!askPost || !answer) fail("the API has no request and answer for the user's message");
  const notes = s1.posts.filter((p: any) => p.kind === "note" && p.author === "$user");
  press("ArrowUp");
  await expect(`Up: the newest post of the chat, #${notes.at(-1).number} (the last note)`, (f) => f.key === `post:${notes.at(-1).seq}` && f.ring && f.view === "chat");
  announced(/^article$/, new RegExp(`^#${notes.at(-1).number}, note from you`));
  press("ArrowUp");
  await expect(`Up: #${notes.at(-2).number}`, (f) => f.key === `post:${notes.at(-2).seq}`);
  press("ArrowDown");
  await expect(`Down: #${notes.at(-1).number}`, (f) => f.key === `post:${notes.at(-1).seq}`);
  await state("in a room: Up and Down go through the chat's posts", `#${notes.at(-1).number} · note from you`);
  await barSays(`#${notes.at(-1).number}`, {
    place: "room-post",
    where: `#${notes.at(-1).number} · note from you`,
    keys: ["↑ ↓ previous or next post", "← → between the panes", "Enter its detail", "Backspace back to the overview", "a–z start writing", "Home End first or last post"],
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

  // Up past the very top reaches the view's tabs; Right switches to the board; Down goes to its newest post.
  press("Home");
  await expect("Home: the first post of the chat", (f) => f.key?.startsWith("post:") === true);
  press("ArrowUp");
  await expect("Up past the first post: the chat's tab", (f) => f.role === "tab" && f.label.includes("fable"));
  press("ArrowRight");
  await expect("Right on the tabs: the Board", (f) => f.role === "tab" && f.label.startsWith("Board") && f.view === "board");
  press("ArrowDown");
  const newest = s1.posts.at(-1);
  await expect(`Down: the board's newest post #${newest.number}`, (f) => f.key === `post:${newest.seq}` && f.view === "board");
  for (let i = 2; i <= 4; i += 1) {
    press("ArrowUp");
    const post = s1.posts.at(-i);
    await expect(`Up: #${post.number}, as the API orders the board`, (f) => f.key === `post:${post.seq}` && f.ring);
  }
  announced(/^article$/, new RegExp(`^#${s1.posts.at(-4).number}, `));
  await state("in a room: the board's posts in the API's order, from the tabs", new RegExp(`^#${s1.posts.at(-4).number} · \\S`));

  // A post's detail, and back to the post.
  const detailPost = s1.posts.at(-4);
  press("Enter");
  await expect(`Enter: the detail of #${detailPost.number}`, (f) => f.dialog === `Post #${detailPost.number}` && f.label === "Close dialog");
  await state("Enter on a post opens its detail", `Post #${detailPost.number}`);
  press("Escape");
  await expect(`Esc: the detail closed, the focus back on #${detailPost.number}, the room still open`, (f) => f.dialog === null && f.key === `post:${detailPost.seq}` && f.drawers.some((d) => d.view === "room"));
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

  // The same inside the post's detail: Esc in the correction closes the field, not the dialog (and its text with it).
  press("End");
  await expect(`End: #${openPost.number}`, (f) => f.key === `post:${openPost.seq}`);
  press("Enter");
  await expect(`Enter: the detail of #${openPost.number}`, (f) => f.dialog === `Post #${openPost.number}`);
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
  await expect(`Esc again closes the detail, the focus back on #${openPost.number}`, (f) => f.dialog === null && f.key === `post:${openPost.seq}`);
  await state("in a post's detail, Esc in a correction closes the field, not the detail", new RegExp(`^#${openPost.number} · you to @fable, `));

  // ---------------- 3b. a status chip: Esc folds its choices, and so does Backspace; the room stays ----------------

  // His turn on the open request runs (the fake holds it): the work bar shows it as a chip whose choices hold Stop.
  const running = ((await room.snapshot()).runs as Array<{ phase: string }>).filter((r) => r.phase === "running").length;
  if (running === 0) fail("the API shows no running turn for the work bar's chip");
  await toTabs();
  await tabTo("Tab from the view's tab to the working chip", (f) => f.chip && f.expanded === "false" && f.label.includes("fable"), "Tab", 14);
  press("Enter");
  await expect("Enter: the chip's choices open under the bar", (f) => f.chip && f.expanded === "true" && f.chipOpen);
  log(`api: ${running} running turn; page: its chip open`);
  const chipBar = await keyBar(/^fable ?working/);
  if (!chipBar.keys.includes("Esc Backspace fold the choices")) fail(`with the chip open the key bar reads ${JSON.stringify(chipBar.keys)}: expected Esc and Backspace to fold the chip's choices`);
  log(`  key bar: ${chipBar.keys.join(" · ")}`);
  press("Escape");
  await expect("Esc: the choices folded, the focus on the chip, the room still open", (f) => f.chip && f.expanded === "false" && !f.chipOpen && f.drawers.some((d) => d.view === "room" && !d.inert));
  press("Escape");
  await sleep(400);
  await expect("Esc again, nothing in front: the room stays, the focus on the chip", (f) => f.chip && f.drawers.some((d) => d.view === "room" && !d.inert));
  await state("Esc with a chip expanded folds it; the room stays", /^fable ?working/);
  press("Enter");
  await expect("Enter: the choices again", (f) => f.chip && f.chipOpen);
  press("Backspace");
  await expect("Backspace folds them as Esc does, the room still open", (f) => f.chip && !f.chipOpen && f.drawers.some((d) => d.view === "room" && !d.inert));
  const foldedBar = await keyBar(/^fable ?working/);
  if (!foldedBar.keys.includes("Backspace back to the overview") || foldedBar.keys.some((key) => key.startsWith("Esc "))) fail(`with the chip folded the key bar reads ${JSON.stringify(foldedBar.keys)}: expected "Backspace back to the overview" and no Esc`);
  await state("Backspace with a chip expanded folds it first", /^fable ?working/);
  // From the chip, outside the posts, the first key lands on the post last visited; End again goes to the newest.
  press("End");
  await expect("End from the chip: the posts", (f) => f.key?.startsWith("post:") === true);
  press("End");
  await expect(`End: back on the newest post, #${openPost.number}`, (f) => f.key === `post:${openPost.seq}`);

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
    keys: ["↑ ↓ to the posts", "← → between the panes", "Enter write a message", "Backspace back to the overview", "a–z start writing"],
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
  const seatButton = "() => { const b = [...document.querySelectorAll('.dialog button')].find((e) => e.textContent.trim() === 'Seat in a room…'); return b ? { disabled: b.disabled, title: b.title } : null; }";
  // They are seated with their saved settings: the button waits while the form says otherwise.
  press("End");
  press("x");
  browser.poll<{ disabled: boolean; title: string } | null>("Seat in a room… to wait while the name is changed", seatButton, (b) => b?.disabled === true && b.title.startsWith("Save or cancel"));
  press("Backspace");
  browser.poll<{ disabled: boolean; title: string } | null>("Seat in a room… to be back once the name is as saved", seatButton, (b) => b?.disabled === false);
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

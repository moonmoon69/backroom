/**
 * The keyboard rehearsal (U1): `node scripts/rehearse.ts --step keys --as <rooms-browser key> [--port …] [--data …]`.
 *
 * rehearse.ts starts the throwaway service and seats the room (a Consigliere, a worker, a reviewer); this module adds
 * a second and a third room and a thread outside rooms through the API, and a long board of room notes on the journal
 * (src/briefing/envelope.ts's ROOM_NOTE, as journals from before N1 hold them), then drives the page with
 * `rooms-browser … press` and nothing else: never a click, a fill or a command that moves the user. Each state checks
 * the page and the API: which item has the focus (its `data-nav-key`, read with `eval`), that the browser draws its ring
 * (`:focus-visible` with an outline, the card's ring or the pixel brackets), that assistive technology gets it (the page
 * snapshot's `focused` line carries a role and a name), what is open (the drawer's `data-view`/`data-id`, a dialog, a
 * menu, the side panel) against what the API says it should be (the room's ID and title, the post's number and seq, the
 * member's thread). Every state then checks the key bar (K1-1, KeyBar.tsx): drawn at the foot of the window, naming what
 * the ring is on as the API names it (a room's title, a post's number, a member's alias), reads the console (no
 * error-level line) and keeps a screenshot, the bar in it; every key on the bar is drawn whole and none is left out (at
 * this window the whole bar fits). One state draws every place's bar from the key table (keyOrder.ts) in the page, the
 * where-text at its widest, and checks each fits the window. Five states read the whole bar, every key with its words:
 * the overview with nothing focused, a room's tile, a post, the composer, and a room with nothing in it focused.
 *
 * The overview's reading order is checked as keys.ts defines it: section by section, column by column (cards are stacked
 * per column), each column top to bottom. With four tiles on three columns the fourth sits under the first, so Down from
 * the first card's last member goes to the fourth card, not to the second as the page's own order would.
 */
import { ROOM_NOTE } from "../src/briefing/envelope.ts";
import { barEntries, KEYS, type KeyWhen } from "../web/src/keyOrder.ts";

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
  };
}`;

/** The overview's items with where each sits: its section, the left edge of its card (its column), its top and middle. */
const LAYOUT = `() => {
  const root = document.querySelector('.overview');
  const sections = [...root.querySelectorAll('[data-nav-section]')];
  return [...root.querySelectorAll('[data-nav]')].filter((e) => e.getClientRects().length > 0).map((e) => {
    const r = e.getBoundingClientRect();
    const card = e.closest('[data-nav-card]') ?? e;
    return { key: e.dataset.navKey, section: sections.indexOf(e.closest('[data-nav-section]')), column: Math.round(card.getBoundingClientRect().left), top: r.top, middle: r.top + r.height / 2, card: card === e ? null : (card.querySelector('[data-nav]')?.dataset.navKey ?? null) };
  });
}`;

interface Placed {
  key: string;
  section: number;
  column: number;
  top: number;
  middle: number;
  card: string | null;
}

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
  const conditions: KeyWhen[] = ["typing", "empty", "composer-open", "help"];
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

/** The reading order the overview's Up and Down must follow: section, then column, then top. */
const readingOrder = (items: Placed[]): Placed[] => [...items].sort((a, b) => a.section - b.section || a.column - b.column || a.top - b.top);

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
  /** What the bar calls an overview item, from the API: a room's title, "@alias in <room>", a thread's title, a browser's name. */
  const overviewWhere = async (key: string): Promise<string> => {
    const [kind, id, member] = key.split(":");
    const view = await service.call<{ rooms: Array<{ id: string; title: string; members: Array<{ id: string; alias: string }> }>; threads: Array<{ id: string; title: string }> }>("GET", "/api/overview");
    const apiRoom = view.rooms.find((r) => r.id === id);
    if (kind === "room" && apiRoom) return apiRoom.title;
    const alias = apiRoom?.members.find((m) => m.id === member)?.alias;
    if (kind === "member" && apiRoom && alias) return `@${alias} in ${apiRoom.title}`;
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
  const layout = (): Placed[] => browser.eval<Placed[]>(LAYOUT);
  /** The overview's order once it holds still (its polls rank the tiles: news, busy, needs you). */
  const settledOrder = async (): Promise<Placed[]> => {
    let previous = "";
    return until("the overview to hold still", async () => {
      const order = readingOrder(layout());
      const signature = order.map((p) => `${p.key}@${p.column}`).join(" ");
      const same = signature === previous;
      previous = signature;
      if (!same) await sleep(1200);
      return same ? order : null;
    }, 30_000, 100);
  };
  /** Move the overview's focus to an item with Down (and Up), from Home, following the reading order. */
  const goTo = async (key: string): Promise<void> => {
    const order = await settledOrder();
    const at = order.findIndex((p) => p.key === key);
    if (at < 0) fail(`${short(key)} is not on the overview`);
    press("Home");
    await expect(`the first item ${short(order[0]!.key)}`, (f) => f.key === order[0]!.key);
    for (let i = 1; i <= at; i += 1) press("ArrowDown");
    await expect(short(key), (f) => f.key === key);
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
  log(`set up: rooms Rehearsal ${R.slice(0, 8)}, Second ${second.roomId.slice(0, 8)}, Third ${third.roomId.slice(0, 8)}; thread ${loose.threadId.slice(0, 8)} outside rooms; 62 notes`);

  browser.open();
  browser.waitFor("Rehearsal");
  browser.waitFor("Third");
  browser.waitFor("A thread outside rooms");
  browser.consoleClean();

  // ---------------- 0. the key bar: nothing focused yet; every place's bar fits this window ----------------

  await expect("the page open, nothing focused", (f) => f.tag === null && f.drawers.length === 0);
  await barSays("the overview, nothing focused (no Enter: it does nothing there)", { place: "overview-page", where: "the overview", keys: ["↑ ↓ ← → to the tiles"], end: "? all keys" });
  const fits = browser.eval<{ bars: number; width: number; over: string[] }>(everyBarFits());
  if (fits.over.length > 0) fail(`at ${fits.width} px, ${fits.over.length} of ${fits.bars} bars do not fit: ${fits.over.join("; ")}`);
  log(`  page: all ${fits.bars} bars of the key table (each place, each mix of what holds) fit ${fits.width} px with the where-text at its widest`);
  await state("key bar: the overview with nothing focused; every place's whole bar fits the window", "the overview");

  // ---------------- 1. the overview's reading order ----------------

  let order = await settledOrder();
  const overview = await service.call<{ rooms: Array<{ id: string; members: Array<{ id: string }> }> }>("GET", "/api/overview");
  const apiRooms = await service.call<Array<{ id: string; title: string }>>("GET", "/api/rooms");
  for (const apiRoom of overview.rooms) {
    const onPage = order.filter((p) => p.key.startsWith(`member:${apiRoom.id}:`)).map((p) => p.key.split(":")[2]).sort();
    const api = apiRoom.members.map((m) => m.id).sort();
    if (onPage.join() !== api.join()) fail(`room ${apiRoom.id.slice(0, 8)}: members on the page ${onPage.join()} != the API's ${api.join()}`);
  }
  for (const apiRoom of apiRooms) if (!order.some((p) => p.key === `room:${apiRoom.id}`)) fail(`room ${apiRoom.title} of the API has no card on the page`);
  if (!order.some((p) => p.key === `thread:${loose.threadId}`)) fail("the thread outside rooms has no card");
  // The column rule matters only if a column holds two cards: four tiles on fewer than four columns.
  const projectCards = order.filter((p) => p.section === 0 && p.card === p.key);
  const columns = [...new Set(projectCards.map((p) => p.column))];
  const stacked = columns.find((column) => projectCards.filter((p) => p.column === column).length >= 2);
  if (stacked === undefined) fail(`no column of the project holds two cards (cards at ${projectCards.map((p) => p.column).join(", ")}): the window is too wide for this check`);
  const pageOrder = browser.eval<string[]>("() => [...document.querySelectorAll('.overview [data-nav]')].filter((e) => e.getClientRects().length > 0).map((e) => e.dataset.navKey)");
  log(`api: ${apiRooms.length} rooms, members as /api/overview lists them; page: ${order.length} items on ${columns.length} columns, column ${stacked} holds two cards`);
  log(`  reading order: ${order.map((p) => short(p.key)).join(" → ")}`);
  if (pageOrder.join() === order.map((p) => p.key).join()) fail("the reading order equals the page's own order: the column rule is not exercised");

  press("Home");
  await expect(`Home: the first item ${short(order[0]!.key)}`, (f) => f.key === order[0]!.key && f.ring);
  for (let i = 1; i < order.length; i += 1) {
    press("ArrowDown");
    await expect(`Down #${i}: ${short(order[i]!.key)}`, (f) => f.key === order[i]!.key && f.ring);
  }
  press("ArrowDown");
  await expect("Down at the end stays on the last item", (f) => f.key === order.at(-1)!.key);
  for (let i = order.length - 2; i >= order.length - 4 && i >= 0; i -= 1) {
    press("ArrowUp");
    await expect(`Up: ${short(order[i]!.key)}`, (f) => f.key === order[i]!.key);
  }
  press("End");
  await expect("End: the last item", (f) => f.key === order.at(-1)!.key);
  await state("overview: Up and Down follow the reading order, column by column", await overviewWhere(order.at(-1)!.key));

  // Left and Right: the column beside, the item nearest in height.
  const rehearsalColumn = order.find((p) => p.key === `room:${R}`)!.column;
  const startAt = order.filter((p) => p.key.startsWith(`member:${R}:`))[1]!;
  await goTo(startAt.key);
  const sorted = [...columns].sort((a, b) => a - b);
  const rightColumn = sorted[sorted.indexOf(rehearsalColumn) + 1];
  const leftColumn = sorted[sorted.indexOf(rehearsalColumn) - 1];
  const nearest = (column: number, middle: number) => order.filter((p) => p.section === 0 && p.column === column).sort((a, b) => Math.abs(a.middle - middle) - Math.abs(b.middle - middle) || a.top - b.top)[0]!;
  if (rightColumn !== undefined) {
    const target = nearest(rightColumn, startAt.middle);
    press("ArrowRight");
    await expect(`Right: ${short(target.key)}, in the next column at the same height`, (f) => f.key === target.key && f.ring);
    press("ArrowLeft");
    const back = nearest(rehearsalColumn, target.middle);
    await expect(`Left: back to ${short(back.key)}`, (f) => f.key === back.key);
  } else if (leftColumn !== undefined) {
    const target = nearest(leftColumn, startAt.middle);
    press("ArrowLeft");
    await expect(`Left: ${short(target.key)}, in the column before at the same height`, (f) => f.key === target.key && f.ring);
  }
  announced(/^(listitem|button)$/, /\S/);
  await state("overview: Left and Right go to the column beside, at the same height", await overviewWhere(focus().key!));

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

  await goTo((await settledOrder())[0]!.key);
  await tabTo("Shift+Tab to the project's + (New room in demo)", (f) => f.label === "New room in demo", "Shift+Tab");
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

  await goTo(`room:${third.roomId}`);
  press("Tab");
  await expect("Tab: the card's ⋯", (f) => f.label === "Third options");
  press("ArrowDown");
  await expect("Down from the card's ⋯: its member (the arrows go on from the card)", (f) => f.key === `member:${third.roomId}:${third.participant.solo}`);
  press("ArrowUp");
  await expect("Up: the card", (f) => f.key === `room:${third.roomId}`);
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
  press("Escape");
  await expect("Esc: the dialog closed, the focus back on the card's ⋯", (f) => f.dialog === null && !f.menu && f.label === "Third options" && f.ring);
  await state("overview: a card's menu takes the focus and gives it back through its dialog", "Third options");

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
    keys: ["↑ ↓ previous or next post", "← → between the panes", "Enter its detail", "Esc back to the overview", "a–z start writing", "Home End first or last post"],
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
  const help = await expect("?: the keys are shown", (f) => f.help && f.dialog === "Keyboard");
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
  press("Escape");
  await expect(`Esc again closes the detail, the focus back on #${openPost.number}`, (f) => f.dialog === null && f.key === `post:${openPost.seq}`);
  await state("in a post's detail, Esc in a correction closes the field, not the detail", new RegExp(`^#${openPost.number} · you to @fable, `));

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
  await expect(`Esc: back in the room, the focus on @${members[1]!.alias}`, (f) => !f.drawers.some((d) => d.view === "member") && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key === `member:${members[1]!.id}` && f.ring);
  await state("Esc from a member's thread goes back to the room", new RegExp(`^@${members[1]!.alias} · `));

  // Nothing in the room focused (as when it opens, or after a click on empty space): Members' × pressed with Enter goes
  // away with the focus on it. The bar says Enter writes a message, and it does.
  await tabTo("Shift+Tab to the panel's × (Close panel)", (f) => f.label === "Close panel", "Shift+Tab");
  press("Enter");
  await expect("Enter: the panel closed, nothing in the room focused", (f) => f.tag === null && f.panel === null && f.drawers.some((d) => d.view === "room" && !d.inert));
  await barSays("the room, nothing in it focused", {
    place: "room-itself",
    where: apiRoom.room.title,
    keys: ["↑ ↓ to the posts", "← → between the panes", "Enter write a message", "Esc back to the overview", "a–z start writing"],
    end: "? all keys",
  });
  await state("key bar: a room with nothing in it focused, Enter writes a message", apiRoom.room.title);
  press("Enter");
  await expect("Enter: the composer, in its field", (f) => f.tag === "TEXTAREA" && f.composerOpen);
  press("Escape");
  await expect("Esc: the composer closed, the focus on its strip", (f) => !f.composerOpen && f.tag === "BUTTON" && /Write a message|draft/.test(f.label));
  press("Escape");
  await expect("Esc: back on the overview, the focus on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}` && f.ring);
  announced(/^button$/, "Rehearsal");
  await state("Esc from the room goes back to its card on the overview", apiRoom.room.title);
  await barSays("the room's tile", {
    place: "overview-room",
    where: apiRoom.room.title,
    keys: ["↑ ↓ previous or next, column by column", "← → the column beside, at the same height", "Enter open the room", "Home End first or last on the page"],
    end: "? all keys",
  });
  await state("key bar: a room's tile, each key by what it does there", apiRoom.room.title);

  // From the overview: Enter on a member opens its thread over its room; Esc twice comes back to it.
  const reviewer = members[2]!;
  const reviewerThread = (s1.bindings as Array<{ participantId: string; threadId: string; retiredAt: string | null }>).find((b) => b.participantId === reviewer.id && !b.retiredAt)!.threadId;
  await goTo(`member:${R}:${reviewer.id}`);
  announced(/^listitem$/, `@${reviewer.alias}`);
  press("Enter");
  await expect(`Enter on @${reviewer.alias} on the overview: its thread over its room`, (f) => f.drawers.some((d) => d.view === "room" && d.id === R && d.inert) && f.drawers.some((d) => d.view === "member" && d.id === reviewerThread) && f.inLayer === "member", 10_000);
  await state("Enter on an overview member opens its thread over its room", `@${reviewer.alias}'s thread, read only`);
  press("Escape");
  await expect(`Esc: the room, Members open, the focus on @${reviewer.alias}`, (f) => f.panel === "people" && f.key === `member:${reviewer.id}` && !f.drawers.some((d) => d.view === "member"));
  press("Escape");
  await expect(`Esc: the overview, the focus back on @${reviewer.alias}`, (f) => f.drawers.length === 0 && f.key === `member:${R}:${reviewer.id}` && f.ring);
  await state("Esc twice comes back to the overview member", await overviewWhere(`member:${R}:${reviewer.id}`));

  // A thread outside rooms, by keys: Enter on its card, Up from its composer's strip to the conversation, Esc back.
  await goTo(`thread:${loose.threadId}`);
  press("Enter");
  await expect("Enter on the thread's card: it is open, the focus on its composer's strip", (f) => f.drawers.some((d) => d.view === "thread" && d.id === loose.threadId) && f.label.includes("Write a message"));
  press("ArrowUp");
  await expect("Up from the strip: the conversation (its arrows scroll it)", (f) => f.role === "log" && f.label === "Thread" && f.inLayer === "thread");
  press("Escape");
  await expect("Esc: back on the thread's card", (f) => f.drawers.length === 0 && f.key === `thread:${loose.threadId}`);
  await state("a thread outside rooms: Enter, Up to its conversation, Esc", await overviewWhere(`thread:${loose.threadId}`));

  // ---------------- 6. the pixel look draws its own ring ----------------

  // Settings → Look → Pixel, by keys: the menu takes the focus, Down to Pixel, Enter; the focus goes back to Settings.
  await goTo((await settledOrder())[0]!.key);
  await tabTo("Shift+Tab to Settings", (f) => f.label === "Settings", "Shift+Tab");
  press("Enter");
  await expect("Enter: the Settings menu, the focus on its first item", (f) => f.menu && (f.role ?? "").startsWith("menuitem"));
  for (let i = 0; i < 30 && !focus().label.startsWith("Pixel"); i += 1) press("ArrowDown");
  await expect("Down to Look → Pixel", (f) => f.menu && f.label.startsWith("Pixel"));
  press("Enter");
  await expect("Enter: the menu closed, the focus back on Settings", (f) => !f.menu && f.label === "Settings");
  await until("the pixel look", () => browser.eval<string>("() => document.documentElement.dataset.skin ?? ''") === "pixel");
  await goTo(`member:${R}:${reviewer.id}`);
  await expect("pixel look: the member's ring is drawn", (f) => f.ring);
  await state("pixel look: the overview's focus ring", await overviewWhere(`member:${R}:${reviewer.id}`));
  await goTo(`room:${R}`);
  await expect("pixel look: the room card's brackets are drawn", (f) => f.ring);
  press("Enter");
  await expect("pixel look: the room is open", (f) => f.inLayer === "room");
  press("ArrowUp");
  const pixelPost = await expect("pixel look: a post's ring is drawn", (f) => f.key?.startsWith("post:") === true && f.ring);
  await state("pixel look: the room's focus ring", await postWhere(pixelPost.key));
  press("Escape");
  await expect("pixel look: Esc back to the overview", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  return passed;
}

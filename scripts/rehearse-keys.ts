/**
 * The keyboard rehearsal (U1): `node scripts/rehearse.ts --step keys --as <rooms-browser key> [--port …] [--data …]`.
 *
 * rehearse.ts starts the throwaway service and seats the room (a Consigliere, a worker, a reviewer); this module adds
 * a second and a third room, a thread outside rooms and a long board through the API, then drives the page with
 * `rooms-browser … press` and nothing else: never a click, a fill or a command that moves the user. Each state checks
 * the page and the API: which item has the focus (its `data-nav-key`, read with `eval`), that the browser draws its ring
 * (`:focus-visible` with an outline, the card's ring or the pixel brackets), that assistive technology gets it (the page
 * snapshot's `focused` line carries a role and a name), what is open (the drawer's `data-view`/`data-id`, a dialog, a
 * menu, the side panel) against what the API says it should be (the room's ID and title, the post's number and seq, the
 * member's thread). Every state then reads the console (no error-level line) and keeps a screenshot.
 *
 * The overview's reading order is checked as keys.ts defines it: section by section, column by column (cards are stacked
 * per column), each column top to bottom. With four tiles on three columns the fourth sits under the first, so Down from
 * the first card's last member goes to the fourth card, not to the second as the page's own order would.
 */

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
  const state = (name: string) => {
    browser.consoleClean();
    browser.screenshot(name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase());
    passed.push(name);
    log(`PASS ${name}`);
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
  // A long board: more posts than the page draws at first (60 on the board, 40 in the chat).
  for (let i = 1; i <= 62; i += 1) await service.command({ type: "room.note.create", roomId: R, text: `Note ${i} on the long board` });
  const second = await room.second("Second", ["alpha", "beta"]);
  const third = await room.second("Third", ["solo"]);
  const loose = await service.command<{ threadId: string }>({ type: "thread.start", projectId: "project_demo", text: "A thread outside rooms: read the logs" });
  log(`set up: rooms Rehearsal ${R.slice(0, 8)}, Second ${second.roomId.slice(0, 8)}, Third ${third.roomId.slice(0, 8)}; thread ${loose.threadId.slice(0, 8)} outside rooms; 62 notes`);

  browser.open();
  browser.waitFor("Rehearsal");
  browser.waitFor("Third");
  browser.waitFor("A thread outside rooms");
  browser.consoleClean();

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
  state("overview: Up and Down follow the reading order, column by column");

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
  state("overview: Left and Right go to the column beside, at the same height");

  // ---------------- 2. the focus survives a poll that moves its card ----------------

  await goTo(`room:${second.roomId}`);
  const before = browser.eval<number>(`() => [...document.querySelectorAll('.ov-tiles > *')].findIndex((c) => c.querySelector('[data-nav-key="room:${second.roomId}"]'))`);
  // An approval in the second room ranks its card first (needs you): the next poll moves it under the focus.
  const bindings = (await second.snapshot()).bindings as Array<{ participantId: string; threadId: string }>;
  const alphaThread = bindings.find((b) => b.participantId === second.participant.alpha)!.threadId;
  await service.command({ type: "message.create", roomId: second.roomId, sourceText: "@alpha check the logs", clientMessageId: crypto.randomUUID(), attachmentIds: [], assignments: [{ recipients: [second.participant.alpha], instruction: "check the logs", schedule: { mode: "now" }, after: [] }] });
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
  state("overview: the focus stays on a card a poll moves");

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
  state("overview: a dialog holds Tab and gives the focus back to its button");

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
  state("overview: a card's menu takes the focus and gives it back through its dialog");

  // ---------------- 3. into a room ----------------

  await goTo(`room:${R}`);
  press("Enter");
  const apiRoom = await room.snapshot();
  await expect("Enter: the room is open and the focus is in it (the composer's strip)", (f) => f.drawers.some((d) => d.view === "room" && d.id === R && !d.inert) && f.inLayer === "room" && f.label.includes("Write a message"));
  const opened = focus();
  if (opened.drawers[0]!.label !== `Room ${apiRoom.room.title}`) fail(`the drawer is named ${opened.drawers[0]!.label}, the API's room is ${apiRoom.room.title}`);
  log(`api: room ${R.slice(0, 8)} "${apiRoom.room.title}"; page: drawer data-id ${R.slice(0, 8)}, named "${opened.drawers[0]!.label}"`);
  state("Enter on a room card opens it, with the focus inside");

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
  state("in a room: Up and Down go through the chat's posts");

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
  state("in a room: Up past the top draws the earlier posts");

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
  state("in a room: the board's posts in the API's order, from the tabs");

  // A post's detail, and back to the post.
  const detailPost = s1.posts.at(-4);
  press("Enter");
  await expect(`Enter: the detail of #${detailPost.number}`, (f) => f.dialog === `Post #${detailPost.number}` && f.label === "Close dialog");
  state("Enter on a post opens its detail");
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
  state("? shows the keys");
  press("Escape");
  await expect("Esc: the keys closed, the focus back on the post", (f) => !f.help && f.key === `post:${detailPost.seq}` && f.drawers.some((d) => d.view === "room"));

  // The composer: a key starts it; its own arrows; Esc closes it (not the room); Up comes back to the post.
  compose("w");
  await expect("a letter opens the composer, in its field", (f) => f.tag === "TEXTAREA");
  press("ArrowUp");
  await expect("Up in the composer's field stays in the field", (f) => f.tag === "TEXTAREA");
  press("Escape");
  await expect("Esc closes the composer, not the room", (f) => f.label.includes("draft") && f.drawers.some((d) => d.view === "room"));
  press("ArrowUp");
  await expect("Up from the strip: back to the post", (f) => f.key === `post:${detailPost.seq}`);
  state("the composer keeps its keys; Esc closes it first");

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
  state("Correct… takes the focus; Esc goes back to it");

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
  state("in a post's detail, Esc in a correction closes the field, not the detail");

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
  state("in a room: Left and Right between the board, Members, Browser and Git");

  // Esc in a menu closes the menu only; the focus goes back to the member.
  press("Tab");
  await expect("Tab: the member's menu button", (f) => f.tag === "BUTTON" && f.label.includes(members[1]!.alias));
  press("Enter");
  await expect("Enter: the member's menu, the focus on its first item", (f) => f.menu && f.label === "Open thread");
  press("ArrowDown");
  await expect("Down in the menu: its next item", (f) => f.menu && f.label === "Open in T3");
  press("Escape");
  await expect("Esc: the menu closed, the room still open, the focus on the member", (f) => !f.menu && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key === `member:${members[1]!.id}`);
  state("Esc closes a menu, not the room");

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
  state("a toast during a dialog is read out");

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
  state("Enter on a member opens its thread");
  press("Escape");
  await expect(`Esc: back in the room, the focus on @${members[1]!.alias}`, (f) => !f.drawers.some((d) => d.view === "member") && f.drawers.some((d) => d.view === "room" && !d.inert) && f.key === `member:${members[1]!.id}` && f.ring);
  state("Esc from a member's thread goes back to the room");
  press("Escape");
  await expect("Esc: back on the overview, the focus on the room's card", (f) => f.drawers.length === 0 && f.key === `room:${R}` && f.ring);
  announced(/^button$/, "Rehearsal");
  state("Esc from the room goes back to its card on the overview");

  // From the overview: Enter on a member opens its thread over its room; Esc twice comes back to it.
  const reviewer = members[2]!;
  const reviewerThread = (s1.bindings as Array<{ participantId: string; threadId: string; retiredAt: string | null }>).find((b) => b.participantId === reviewer.id && !b.retiredAt)!.threadId;
  await goTo(`member:${R}:${reviewer.id}`);
  announced(/^listitem$/, `@${reviewer.alias}`);
  press("Enter");
  await expect(`Enter on @${reviewer.alias} on the overview: its thread over its room`, (f) => f.drawers.some((d) => d.view === "room" && d.id === R && d.inert) && f.drawers.some((d) => d.view === "member" && d.id === reviewerThread) && f.inLayer === "member", 10_000);
  state("Enter on an overview member opens its thread over its room");
  press("Escape");
  await expect(`Esc: the room, Members open, the focus on @${reviewer.alias}`, (f) => f.panel === "people" && f.key === `member:${reviewer.id}` && !f.drawers.some((d) => d.view === "member"));
  press("Escape");
  await expect(`Esc: the overview, the focus back on @${reviewer.alias}`, (f) => f.drawers.length === 0 && f.key === `member:${R}:${reviewer.id}` && f.ring);
  state("Esc twice comes back to the overview member");

  // A thread outside rooms, by keys: Enter on its card, Up from its composer's strip to the conversation, Esc back.
  await goTo(`thread:${loose.threadId}`);
  press("Enter");
  await expect("Enter on the thread's card: it is open, the focus on its composer's strip", (f) => f.drawers.some((d) => d.view === "thread" && d.id === loose.threadId) && f.label.includes("Write a message"));
  press("ArrowUp");
  await expect("Up from the strip: the conversation (its arrows scroll it)", (f) => f.role === "log" && f.label === "Thread" && f.inLayer === "thread");
  press("Escape");
  await expect("Esc: back on the thread's card", (f) => f.drawers.length === 0 && f.key === `thread:${loose.threadId}`);
  state("a thread outside rooms: Enter, Up to its conversation, Esc");

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
  state("pixel look: the overview's focus ring");
  await goTo(`room:${R}`);
  await expect("pixel look: the room card's brackets are drawn", (f) => f.ring);
  press("Enter");
  await expect("pixel look: the room is open", (f) => f.inLayer === "room");
  press("ArrowUp");
  await expect("pixel look: a post's ring is drawn", (f) => f.key?.startsWith("post:") === true && f.ring);
  state("pixel look: the room's focus ring");
  press("Escape");
  await expect("pixel look: Esc back to the overview", (f) => f.drawers.length === 0 && f.key === `room:${R}`);
  return passed;
}

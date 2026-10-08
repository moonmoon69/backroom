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
  await expect("?: the keys are shown", (f) => f.help && f.dialog === "Keyboard");
  state("? shows the keys");
  press("Escape");
  await expect("Esc: the keys closed, the focus back on the post", (f) => !f.help && f.key === `post:${detailPost.seq}` && f.drawers.some((d) => d.view === "room"));

  // The composer: a key starts it; its own arrows; Esc closes it (not the room); Up comes back to the post.
  press("w");
  await expect("a letter opens the composer, in its field", (f) => f.tag === "TEXTAREA");
  press("ArrowUp");
  await expect("Up in the composer's field stays in the field", (f) => f.tag === "TEXTAREA");
  press("Escape");
  await expect("Esc closes the composer, not the room", (f) => f.label.includes("draft") && f.drawers.some((d) => d.view === "room"));
  press("ArrowUp");
  await expect("Up from the strip: back to the post", (f) => f.key === `post:${detailPost.seq}`);
  state("the composer keeps its keys; Esc closes it first");

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
  await expect(`Left: the board, back on #${detailPost.number}`, (f) => f.key === `post:${detailPost.seq}`);
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

  // ---------------- 5. a member's thread, and back out ----------------

  const workerThread = (s1.bindings as Array<{ participantId: string; threadId: string; retiredAt: string | null }>).find((b) => b.participantId === members[1]!.id && !b.retiredAt)!.threadId;
  press("Enter");
  await expect(`Enter: @${members[1]!.alias}'s thread over the room`, (f) => f.drawers.some((d) => d.view === "member" && d.id === workerThread) && f.drawers.some((d) => d.view === "room" && d.inert) && f.inLayer === "member");
  log(`api: @${members[1]!.alias}'s binding is thread ${workerThread.slice(0, 8)}; page: the layer shows data-id ${workerThread.slice(0, 8)}, the room under it inert`);
  browser.waitFor("This thread is now a member in a room");
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

  // ---------------- 6. the pixel look draws its own ring ----------------

  browser.on("eval", "() => { localStorage.setItem('backroom.skin', 'pixel'); return true; }");
  browser.on("reload");
  browser.waitFor("Rehearsal");
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
  browser.on("eval", "() => { localStorage.removeItem('backroom.skin'); return true; }");
  return passed;
}

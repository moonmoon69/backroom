/** The street look: the block follows the projects, rooms and threads Backroom already has, and stores nothing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutStreet, MAX_FLOORS, WINDOWS_PER_FLOOR } from "../web/src/street/layout.ts";
import type { RoomListItem, T3Project, T3ThreadShell } from "../web/src/types.ts";

const project = (id: string, title = id): T3Project => ({ id, title, workspaceRoot: `/srv/${id}`, defaultModelSelection: null });
const room = (id: string, projectId: string, over: Partial<RoomListItem> = {}): RoomListItem =>
  ({
    id,
    projectId,
    title: id,
    participantCount: 2,
    working: 0,
    waiting: 0,
    activity: { turn: 0, background: 0, monitoring: 0, needsInput: 0 },
    news: { unseen: 0, latest: null },
    ...over,
  }) as RoomListItem;
const thread = (id: string, projectId: string, over: Partial<T3ThreadShell> = {}): T3ThreadShell =>
  ({
    id,
    projectId,
    title: id,
    session: { status: "ready", activeTurnId: null, lastError: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-09-28T08:00:00Z",
    boundToRoom: false,
    news: null,
    ...over,
  }) as T3ThreadShell;

test("the club comes first, a business per project in the sidebar's order, the shop to rent last", () => {
  const street = layoutStreet([project("b"), project("a")], [], []);
  assert.deepEqual(
    street.lots.map((lot) => lot.kind),
    ["club", "business", "business", "rent"],
  );
  assert.deepEqual(
    street.lots.map((lot) => lot.project?.id ?? null),
    [null, "b", "a", null],
  );
  // Lots follow each other along the street without overlapping.
  for (let i = 1; i < street.lots.length; i++) assert.ok(street.lots[i]!.x >= street.lots[i - 1]!.x + street.lots[i - 1]!.width);
  assert.equal(street.width, street.lots.at(-1)!.x + street.lots.at(-1)!.width);
});

test("an empty Backroom is the club and an empty shop", () => {
  assert.deepEqual(
    layoutStreet([], [], []).lots.map((lot) => lot.kind),
    ["club", "rent"],
  );
});

test("a project's business and colours come from its id, so renaming changes only the sign", () => {
  const before = layoutStreet([project("p1", "Old name")], [], []).lots[1]!;
  const after = layoutStreet([project("p1", "New name")], [], []).lots[1]!;
  assert.equal(before.business, after.business);
  assert.equal(before.facade, after.facade);
  assert.equal(after.project?.title, "New name");
});

test("a few standard heights: one floor per three windows, never more than the tallest", () => {
  const rooms = (n: number) => Array.from({ length: n }, (_, i) => room(`r${i}`, "p"));
  assert.equal(layoutStreet([project("p")], [], []).lots[1]!.floors, 1);
  assert.equal(layoutStreet([project("p")], rooms(4), []).lots[1]!.floors, 2);
  const busy = layoutStreet([project("p")], rooms(20), []).lots[1]!;
  assert.equal(busy.floors, MAX_FLOORS);
  assert.equal(busy.windows.length, MAX_FLOORS * WINDOWS_PER_FLOOR);
  assert.equal(busy.hidden.length, 20 - MAX_FLOORS * WINDOWS_PER_FLOOR);
});

test("a room that needs you always gets a window, even past the building's windows", () => {
  const rooms = Array.from({ length: 12 }, (_, i) => room(`r${i}`, "p", i === 11 ? { activity: { turn: 0, background: 0, monitoring: 0, needsInput: 1 } } : {}));
  const lot = layoutStreet([project("p")], rooms, []).lots[1]!;
  assert.ok(lot.windows.some((w) => w.id === "r11" && w.state === "needs"));
  assert.equal(lot.needs, 1);
  // The others keep their order.
  assert.deepEqual(
    lot.windows.slice(0, 3).map((w) => w.id),
    ["r0", "r1", "r2"],
  );
});

test("windows say what their room or thread is doing", () => {
  const lot = layoutStreet(
    [project("p")],
    [
      room("working", "p", { working: 2 }),
      room("failed", "p", { news: { unseen: 1, latest: { at: "2026-09-28T08:00:00Z", alias: "sol", kind: "failed", preview: "" } } }),
      room("empty", "p", { participantCount: 0 }),
    ],
    [thread("asks", "p", { hasPendingUserInput: true }), thread("busy", "p", { session: { status: "running", activeTurnId: "t", lastError: null } })],
  ).lots[1]!;
  const state = Object.fromEntries(lot.windows.map((w) => [w.id, w.state]));
  assert.deepEqual(state, { working: "working", failed: "failed", empty: "dark", asks: "needs", busy: "working" });
  assert.equal(lot.windows.find((w) => w.id === "working")?.label, "2 working");
  assert.equal(lot.unseen, 1);
});

test("threads held by a room, settled, archived or deleted have no window of their own", () => {
  const lot = layoutStreet(
    [project("p")],
    [],
    [
      thread("mine", "p"),
      thread("bound", "p", { boundToRoom: true }),
      thread("settled", "p", { settledAt: "2026-09-27T08:00:00Z" }),
      thread("archived", "p", { archivedAt: "2026-09-27T08:00:00Z" }),
      thread("deleted", "p", { deletedAt: "2026-09-27T08:00:00Z" }),
    ],
  ).lots[1]!;
  assert.deepEqual(
    lot.windows.map((w) => w.id),
    ["mine"],
  );
  assert.deepEqual(
    lot.settled.map((t) => t.id),
    ["settled"],
  );
});

test("rooms of a project T3 no longer lists still get a business", () => {
  const street = layoutStreet([project("p")], [room("stray", "gone")], []);
  const lot = street.lots.find((l) => l.project?.id === "gone");
  assert.equal(lot?.project?.title, "Unknown project");
  assert.deepEqual(
    lot?.windows.map((w) => w.id),
    ["stray"],
  );
});

/**
 * B1 (board #449): a seat's briefing is Backroom's request, not the user's, and one Dismiss clears what the user sees as
 * one failure. On a full stack with the fake T3 and the HTTP routes the page and rooms-board use.
 *
 * The case the user met (room Improvement, #91 → #101, #103 → #108, #116 → #126): a member whose thread cannot run
 * failed its briefing (a request in the user's name, so its notice was the user's), then failed the Consigliere's
 * request (his notice), then was woken by his cancel of it and failed again. That last run carried nothing anyone asked,
 * and its "Recovery failure" notice, addressed to nobody, counted as the user's: a second "needs you" for the same
 * member after the first was dismissed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createStack } from "../src/app/bootstrap.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import type { EngineOverview, EnginePost, EngineRoomListItem, EngineRoomSnapshot } from "../src/domain/engineView.ts";
import type { Projection } from "../src/engine/index.ts";
import { createHttpApp } from "../src/server/http.ts";
import { RuntimeFake } from "./runtime/helpers.ts";

async function stack(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-b1-"));
  const fake = new RuntimeFake();
  const s = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null });
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(s, config, "/nonexistent/dist", { tools: null, token: "secret", command: "rooms-browser" });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (command: RoomCommandInput) => s.service.execute(parseCommand(command));
  const { roomId } = (await run({ type: "room.create", projectId: "project_demo", title: "b1" })) as { roomId: string };
  const ids: Record<string, string> = {};
  const add = async (alias: string) => {
    ids[alias] = ((await run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string }).participantId;
  };
  // A member's binding, retired or not (after a retire it is no longer the current one).
  const binding = (alias: string) => s.repos.listBindings([ids[alias]!]).at(-1)!;
  const seat = (alias: string) => binding(alias).id;
  const thread = (alias: string) => binding(alias).threadId;
  const p = (): Projection => s.engine.view(roomId);
  const tick = async (times = 1) => {
    for (let i = 0; i < times; i += 1) await s.engine.tick();
  };
  const running = (alias: string) => fake.liveRun(thread(alias)) !== null;
  const wakes = (alias: string) => fake.runsOf(thread(alias)).length;
  const complete = (alias: string, text: string, outcome?: "error") => fake.completeRun(thread(alias), { text, ...(outcome ? { outcome } : {}) });
  /** Every running turn answers in one line until nothing runs. */
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) {
      await tick();
      const busy = Object.keys(ids).filter((alias) => !s.repos.getParticipant(ids[alias]!)!.retiredAt && running(alias));
      if (busy.length === 0) return;
      for (const alias of busy) complete(alias, "Noted.");
    }
    assert.fail("turns kept coming");
  };
  const get = async <T>(path: string): Promise<T> => {
    const response = await app.request(path);
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const snapshot = () => get<EngineRoomSnapshot>(`/api/rooms/${roomId}`);
  /** Every place the page shows "needs you" for this room: the room's list (the work bar), its count, the room list, the overview tile. */
  const needs = async () => {
    const snap = await snapshot();
    const listed = (await get<EngineRoomListItem[]>("/api/rooms")).find((r) => r.id === roomId)!;
    const tile = (await get<EngineOverview>("/api/overview")).rooms.find((r) => r.id === roomId)!;
    return { posts: snap.needsYou.map((post) => post.number), count: snap.counts.needsYou, list: listed.counts.needsYou, tile: tile.needs };
  };
  const dismiss = (ids: string[]) => app.request(`/api/rooms/${roomId}/notices/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
  const board = async (alias: string, ...argv: string[]): Promise<{ status: number; text: string }> => {
    const response = await app.request("/api/board-tools", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ argv, as: agentKey(alias, roomId) }) });
    const body = (await response.json()) as { text?: string; message?: string };
    return { status: response.status, text: body.text ?? body.message ?? "" };
  };
  const number = (eventId: string) => p().events.find((e) => e.id === eventId)!.seq;
  /** The error notice of the latest run of a seat. */
  const noticeOf = async (alias: string): Promise<EnginePost> => {
    const runId = [...p().runs.values()].filter((r) => r.seatId === seat(alias)).at(-1)!.id;
    return (await snapshot()).posts.find((post) => post.kind === "notice" && post.notice?.runId === runId)!;
  };
  return { s, fake, run, roomId, ids, add, seat, thread, p, tick, running, wakes, complete, settle, snapshot, needs, dismiss, board, number, noticeOf };
}

test("B1: a seat's briefing is Backroom's: its failure goes to the Consigliere and never reaches the user; he cancels it, and retire takes it with the member", async (t) => {
  const h = await stack(t);
  for (const alias of ["C", "W"]) await h.add(alias);
  await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids.C! });
  await h.settle();

  // Grok is seated; its briefing is Backroom's request; its thread cannot run.
  await h.add("Grok");
  const briefing = `seat-briefing:${h.seat("Grok")}:seated`;
  const q = h.p().requests.get(briefing)!;
  assert.deepEqual([q.owner, q.returnTo], [h.seat("Grok"), "$system"]);
  const post = (await h.snapshot()).posts.find((x) => x.request?.id === briefing)!;
  assert.deepEqual([post.author, post.to], ["$system", [h.seat("Grok")]]);
  await h.tick();
  assert.ok(h.running("Grok"));
  const cWakes = h.wakes("C");
  h.complete("Grok", "Cursor Agent SDK open failed.", "error");
  await h.tick();
  const failed = await h.noticeOf("Grok");
  assert.deepEqual([failed.to, failed.notice!.needsYou], [[h.seat("C")], false], "the Consigliere's notice, not the user's");
  assert.deepEqual(await h.needs(), { posts: [], count: 0, list: 0, tile: 0 }, "nothing reaches the user");
  // It wakes the Consigliere, who can act on it.
  await h.tick();
  assert.equal(h.wakes("C"), cWakes + 1);
  assert.match(h.fake.promptOf(h.thread("C"), h.fake.runsOf(h.thread("C")).at(-1)!), /Cursor Agent SDK open failed/);
  h.complete("C", "Grok cannot run; I will retire it.");
  await h.tick();

  // The board names it Backroom's. A member cannot cancel it; the Consigliere can.
  const n = h.number(briefing);
  assert.match((await h.board("C", "read", String(n))).text, new RegExp(`^\\[#${n} request · Backroom → @Grok · open\\]`));
  const refused = await h.board("W", "cancel", `#${n}`);
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Backroom's briefing of @Grok: only this room's Consigliere \(@C\) can cancel it/);
  const cancelled = await h.board("C", "cancel", `#${n}`);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(h.p().requests.get(briefing)!.state, "cancelled");
  // The cancel wakes Grok, whose thread fails again: a run that carried only the cancel. Nobody waits on that notice.
  await h.tick();
  h.complete("Grok", "Cursor Agent SDK open failed.", "error");
  await h.tick();
  const recovery = await h.noticeOf("Grok");
  assert.match(recovery.body, /^Recovery failure: /);
  assert.deepEqual([recovery.to, recovery.notice!.needsYou, recovery.notice!.retryRunId], [[], false, null], "to nobody, needs nobody, nothing to retry");
  assert.deepEqual(await h.needs(), { posts: [], count: 0, list: 0, tile: 0 });
  const retired = await h.board("C", "retire", "Grok");
  assert.equal(retired.status, 200, retired.text);
  assert.equal(h.p().seats.get(h.seat("Grok"))!.status, "retired");

  // Sol is seated and fails its briefing too; the Consigliere retires it at once: the briefing goes with it, and Sol is
  // not woken again.
  await h.add("Sol");
  const solBriefing = `seat-briefing:${h.seat("Sol")}:seated`;
  await h.tick();
  h.complete("Sol", "You've hit your usage limit.", "error");
  await h.tick();
  await h.settle();
  assert.equal(h.p().requests.get(solBriefing)!.state, "open");
  const solWakes = h.wakes("Sol");
  const gone = await h.board("C", "retire", "Sol");
  assert.equal(gone.status, 200, gone.text);
  assert.equal(h.p().requests.get(solBriefing)!.state, "cancelled");
  assert.equal(h.p().seats.get(h.seat("Sol"))!.status, "retired");
  await h.tick(3);
  assert.equal(h.wakes("Sol"), solWakes, "a retired seat is not woken by its briefing's cancel");
  assert.deepEqual(await h.needs(), { posts: [], count: 0, list: 0, tile: 0 });
  // Open work still holds a retire; a briefing is not work.
  h.s.engine.post(h.roomId, { actor: h.seat("C"), id: "job", to: h.seat("W"), body: "Build it." });
  const held = await h.board("C", "retire", "W");
  assert.equal(held.status, 409);
  assert.match(held.text, /owns open request #\d+/);
});

test("B1: the user's case replayed (a journal from before B1): the briefing in the user's name fails, then a cancel wakes the member again; one Dismiss clears it everywhere, and the Consigliere retires the member", async (t) => {
  const h = await stack(t);
  for (const alias of ["C", "W", "Grok"]) await h.add(alias);
  await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids.C! });
  await h.settle();
  // A briefing as journals from before B1 hold it: a request in the user's name (#91).
  const legacy = `seat-briefing:${h.seat("Grok")}:before-b1`;
  h.s.engine.request(h.roomId, { actor: "$user", id: legacy, to: h.seat("Grok"), body: "You are seated in a room whose Consigliere is @C." });
  await h.tick();
  h.complete("Grok", "Cursor Agent SDK open failed.", "error");
  await h.tick();
  const first = await h.noticeOf("Grok"); // #101
  assert.deepEqual([first.to.sort(), first.notice!.needsYou], [["$user", h.seat("C")].sort(), true]);
  await h.settle(); // the notice woke the Consigliere

  // His request to Grok fails (#103 → #108), and he cancels it (#116): the cancel wakes Grok, which fails once more (#126).
  h.s.engine.post(h.roomId, { actor: h.seat("C"), id: "k1", to: h.seat("Grok"), body: "Design K1." });
  await h.tick();
  h.complete("Grok", "Cursor Agent SDK open failed.", "error");
  await h.tick();
  assert.deepEqual((await h.noticeOf("Grok")).to, [h.seat("C")]);
  await h.settle();
  const cancel = await h.board("C", "cancel", `#${h.number("k1")}`);
  assert.equal(cancel.status, 200, cancel.text);
  await h.tick();
  assert.ok(h.running("Grok"), "the cancel woke it");
  h.complete("Grok", "Cursor Agent SDK open failed.", "error");
  await h.tick();
  const again = await h.noticeOf("Grok");
  assert.deepEqual([again.to, again.notice!.needsYou, again.notice!.retryRunId], [[], false, null], "#126 no longer counts as the user's");

  // One failure of Grok's waits on the user, in every place the page shows it; one Dismiss clears them all.
  assert.deepEqual(await h.needs(), { posts: [first.number], count: 1, list: 1, tile: 1 });
  assert.equal((await h.dismiss([first.id])).status, 200);
  assert.deepEqual(await h.needs(), { posts: [], count: 0, list: 0, tile: 0 });

  // The briefing in the user's name is Backroom's too: the board says so, the Consigliere may cancel it, and retire
  // takes it with Grok.
  const n = h.number(legacy);
  assert.match((await h.board("C", "read", String(n))).text, new RegExp(`^\\[#${n} request · Backroom \\(in the user's name\\) → @Grok · open\\]`));
  assert.match((await h.board("W", "cancel", `#${n}`)).text, /Backroom's briefing of @Grok: only this room's Consigliere \(@C\) can cancel it/);
  assert.equal(h.p().requests.get(legacy)!.state, "open");
  const retired = await h.board("C", "retire", "Grok");
  assert.equal(retired.status, 200, retired.text);
  assert.equal(h.p().requests.get(legacy)!.state, "cancelled");
  assert.equal(h.p().seats.get(h.seat("Grok"))!.status, "retired");
});

test("B1: a member's failed turn that does need the user is still one notice: one Dismiss clears it, and a later wake that carried nothing asked adds none", async (t) => {
  // No Consigliere: the user asks the member directly, so its failure is the user's.
  const h = await stack(t);
  await h.add("W");
  const one = "one";
  h.s.engine.request(h.roomId, { actor: "$user", id: one, to: h.seat("W"), body: "One." });
  const two = "two";
  h.s.engine.request(h.roomId, { actor: "$user", id: two, to: h.seat("W"), body: "Two." });
  await h.tick();
  h.complete("W", "provider error", "error");
  await h.tick();
  const failed = await h.noticeOf("W");
  assert.deepEqual([failed.to, failed.notice!.needsYou, failed.notice!.retryRunId !== null], [["$user"], true, true]);
  // The user cancels the second request: the cancel wakes W, which fails again; that run carried only the cancel.
  await h.s.engine.cancel(h.roomId, { actor: "$user", id: "cancel-two", requestId: two });
  await h.tick();
  h.complete("W", "provider error", "error");
  await h.tick();
  const recovery = await h.noticeOf("W");
  assert.notEqual(recovery.id, failed.id);
  assert.deepEqual([recovery.notice!.needsYou, recovery.notice!.retryRunId], [false, null]);
  assert.deepEqual(await h.needs(), { posts: [failed.number], count: 1, list: 1, tile: 1 });
  assert.equal((await h.dismiss([failed.id])).status, 200);
  assert.deepEqual(await h.needs(), { posts: [], count: 0, list: 0, tile: 0 });
  // Dismissed is off the list, not the board: Retry is still there for the request still open.
  const after = (await h.snapshot()).posts.find((post) => post.id === failed.id)!;
  assert.deepEqual([after.notice!.dismissed, after.notice!.retryRunId !== null], [true, true]);
});

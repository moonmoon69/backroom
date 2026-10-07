/**
 * The tag over a reply says truthfully what it answers: only a message the user wrote is "your", only a reply to a
 * message has the arrow, and a report after something a member did says "after …".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { replySources, replyText, replyTitle, type ReplyContext } from "../web/src/replyTo.ts";
import type { RoomEvent, Task } from "../web/src/types.ts";
import { Board } from "../src/app/board.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { parseCommand } from "../src/domain/commands.ts";
import { createTestStack } from "./helpers.ts";

const at = (minute: number) => `2026-10-05T19:${String(minute).padStart(2, "0")}:00.000Z`;
const hhmm = (iso: string) => iso.slice(11, 16);
let sequence = 0;
const event = (id: string, kind: RoomEvent["kind"], minute: number, extra: Partial<RoomEvent> = {}): RoomEvent =>
  ({ id, kind, speaker: { type: "user" }, text: "", createdAt: at(minute), sequence: ++sequence, postNumber: sequence, to: null, ...extra }) as unknown as RoomEvent;
const task = (id: string, kind: Task["kind"], sourceEventId: string, participantId: string, minute: number, extra: Partial<Task> = {}): Task =>
  ({ id, kind, sourceEventId, participantId, number: Number(id.replace(/\D/g, "")) || 1, prerequisites: [], createdAt: at(minute), ...extra }) as unknown as Task;
const member = (participantId: string) => ({ type: "participant", participantId, bindingId: `b-${participantId}` }) as RoomEvent["speaker"];

// A room: the user asks Fable; Fable posts to Opus; Opus answers; Fable is woken with it; Astra continues on its own.
const ask = event("e-ask", "user.message", 30, { text: "@Fable look at the vault" });
const ask2 = event("e-ask2", "user.message", 31, { text: "and the gate too" });
const post = event("e-post", "member.message", 33, { speaker: member("fable"), to: "opus", text: "@Opus fix the gate" });
const result = event("e-result", "assistant.reply", 43, { speaker: member("opus"), text: "Fixed." });
const astraPost = event("e-post2", "member.message", 35, { speaker: member("fable"), to: "astra", text: "@Astra review it" });
const astraTurn = event("e-turn", "t3.turn", 50, { speaker: member("astra"), text: "Review done on my own." });
const seat = event("e-seat", "system", 1, { speaker: { type: "system" }, text: "Seat briefing sent to @Opus" });
const moved = event("e-moved", "system", 2, { speaker: { type: "system" }, text: "New Consigliere sent to @Opus" });

const t1 = task("t1", "assignment", "e-ask", "fable", 30);
const t1b = task("t1b", "assignment", "e-ask2", "fable", 31);
const t2 = task("t2", "assignment", "e-post", "opus", 33);
const t3 = task("t3", "wake", "e-post", "fable", 33, { prerequisites: [{ taskId: "t2", revision: 1 }] });
const t4 = task("t4", "assignment", "e-post2", "astra", 35);
const t5 = task("t5", "wake", "e-post2", "fable", 35, { prerequisites: [{ taskId: "t4", revision: 1 }] });
const t6 = task("t6", "wake", "e-post2", "fable", 51);
const t7 = task("t7", "seat", "e-seat", "opus", 1);
const t8 = task("t8", "seat", "e-moved", "opus", 2);

const context: ReplyContext = {
  tasks: [t1, t1b, t2, t3, t4, t5, t6, t7, t8],
  runs: [
    { taskId: "t2", resultEventId: "e-result" },
    { taskId: "t4", resultEventId: null },
  ],
  events: [seat, moved, ask, ask2, post, astraPost, result, astraTurn],
  aliasOf: (id) => ({ fable: "Fable", opus: "Opus", astra: "Astra" })[id] ?? id,
};
const tag = (...answered: Task[]) => replyText(replySources(answered, context), hhmm);

test("each kind of source a task can have gets its own words; only the user's own message is 'your'", () => {
  assert.equal(tag(t1), "↩ your 19:30 message", "the user asked");
  assert.equal(tag(t1, t1b), "↩ your 19:30 and 19:31 messages", "two of the user's messages steered into one turn");
  assert.equal(tag(t2), "↩ Fable's 19:33 message", "a member's post to another member");
  assert.equal(tag(t3), "after Opus's result · 19:43", "a wake-up after a member's task: the time is the result's");
  assert.equal(tag(t5), "after Astra's task4 ended", "a wake-up after a task that ended without an answer");
  assert.equal(tag(t6), "after Astra's own turn · 19:50", "a wake-up after a member's own turn");
  assert.equal(tag(t7), "↩ seat briefing");
  assert.equal(tag(t8), "↩ new Consigliere notice");
  assert.equal(tag(t1, t3), "↩ your 19:30 message · after Opus's result · 19:43", "a message steered into a wake-up turn");
  for (const answered of [t2, t3, t5, t6, t7, t8]) assert.doesNotMatch(tag(answered), /your/, `${answered.id} is not the user's`);
  // Only a reply to a message has the arrow; a report that follows what a member did does not.
  for (const answered of [t3, t5, t6]) assert.match(tag(answered), /^after /, `${answered.id} follows, it does not reply`);
  for (const answered of [t1, t2, t7]) assert.match(tag(answered), /^↩ /, `${answered.id} replies to a message`);
  // The tooltip says the same words.
  assert.match(replyTitle(replySources([t3], context), [t3], hhmm), /^After Opus's result · 19:43 \(task3\); on the board as #\d+; click a time/);
  assert.match(replyTitle(replySources([t1], context), [t1], hhmm), /^Reply to your 19:30 message \(task1\)/);
});

test("the tag and rooms-board agree on a real post, its answer and the poster's wake-up", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const board = new Board({ repos: stack.repos, execute: (command) => stack.service.execute(parseCommand(command)), afterSeat: () => stack.tick(2), statusOf: (id) => stack.scheduler.participantStatus(id) });
  await board.run(["post", "@sol2 Check the parser."], agentKey("sol1", stack.roomId));
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "The parser is fine." });
  await stack.tick(3);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Noted; nothing more to do." });
  await stack.tick(2);

  const events = stack.repos.listEvents(stack.roomId, 1, Number.MAX_SAFE_INTEGER, 100_000);
  const tasks = stack.repos.listTasks(stack.roomId);
  const runs = tasks.flatMap((t) => stack.repos.listRunsForTask(t.id));
  const aliases = new Map(stack.repos.listParticipants(stack.roomId).map((p) => [p.id, p.alias]));
  const live: ReplyContext = { tasks: tasks as never, runs, events: events as never, aliasOf: (id) => aliases.get(id) ?? id };
  const answer = events.find((e) => e.kind === "assistant.reply" && e.speaker.type === "participant" && e.speaker.participantId === stack.participants.sol2)!;
  const woken = events.find((e) => e.kind === "assistant.reply" && e.speaker.type === "participant" && e.speaker.participantId === stack.participants.sol1)!;
  const answeredBy = (reply: typeof answer) => tasks.filter((t) => runs.some((r) => r.taskId === t.id && r.resultEventId === reply.id)) as never as Task[];
  assert.match(replyText(replySources(answeredBy(answer), live), hhmm), /^↩ sol1's \d\d:\d\d message$/);
  assert.equal(replyText(replySources(answeredBy(woken), live), hhmm), `after sol2's result · ${hhmm(answer.createdAt)}`);

  const index = await board.run(["index"], agentKey("sol2", stack.roomId));
  assert.match(index, new RegExp(`#${answer.postNumber}  assistant\\.reply  @sol2 → @sol1 · `), "an answer to a member's post goes to that member");
  assert.match(index, new RegExp(`#${woken.postNumber}  assistant\\.reply  @sol1 · after @sol2's result #${answer.postNumber} · `), "a wake-up's report says what it follows, as the page does");
  assert.doesNotMatch(index, /→ user/, "nobody here answered the user");
  const read = await board.run(["read", String(woken.postNumber)], agentKey("sol2", stack.roomId));
  assert.match(read, new RegExp(`^\\[#${woken.postNumber} assistant\\.reply · @sol1 · after @sol2's result #${answer.postNumber} · `));
});

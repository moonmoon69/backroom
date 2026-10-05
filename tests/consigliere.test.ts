/** The board command (rooms-board), the Consigliere's designation, his rules, the seat briefing, and starting a conversation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack, type TestStack } from "./helpers.ts";
import { BOARD_PAGE_CHARS, Board } from "../src/app/board.ts";
import { parseCommand } from "../src/domain/commands.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { parseExplicit } from "../src/parser/explicit.ts";

const board = (stack: TestStack) =>
  new Board({ repos: stack.repos, execute: (command) => stack.service.execute(parseCommand(command)), afterSeat: () => stack.tick(2), statusOf: (participantId) => stack.scheduler.participantStatus(participantId) });
const key = (stack: TestStack, alias: string, roomId = stack.roomId) => agentKey(alias, roomId);
const preset = async (stack: TestStack, name: string) =>
  ((await stack.run({ type: "preset.create", name, modelSelection: { instanceId: "codex", model: "gpt-6-sol" } })) as { presetId: string }).presetId;
const briefingOf = (stack: TestStack, taskNumber: number) => stack.repos.listRunsForTask(stack.task(taskNumber).id)[0]!.briefing;

test("rooms-board lists the room's posts and prints one by number, exactly as saved", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "Research the timeout.", sourceText: "@sol1 Research the timeout.", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "It is the retry loop.\n\nHandoff: nothing changed." });
  await stack.tick(2);
  const index = await board(stack).run(["index"], key(stack, "sol2"));
  const request = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "user.message")!;
  const reply = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "assistant.reply")!;
  assert.match(index, new RegExp(`#${request.sequence}  user\\.message  user → @sol1 · 27 chars`));
  assert.match(index, new RegExp(`#${reply.sequence}  assistant\\.reply  @sol1 → user`));
  assert.doesNotMatch(index, /task\.status|Research the timeout/, "no status lines and no text");
  assert.match(await board(stack).run(["index", "--all"], key(stack, "sol2")), /task\.status/);
  assert.doesNotMatch(await board(stack).run(["index", "--after", String(request.sequence)], key(stack, "sol2")), new RegExp(`#${request.sequence} `));

  const read = await board(stack).run(["read", String(reply.sequence)], key(stack, "sol2"));
  assert.ok(read.endsWith("It is the retry loop.\n\nHandoff: nothing changed."), "the exact text");
  await assert.rejects(board(stack).run(["read", "9999"], key(stack, "sol2")), /no post #9999/);
  await assert.rejects(board(stack).run(["index"], null), /--as/);
  await assert.rejects(board(stack).run(["index"], key(stack, "nobody")), /not the key of a member/);
});

test("a post longer than a page is printed in pages", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const long = `${"a".repeat(BOARD_PAGE_CHARS)}${"b".repeat(100)}`;
  await stack.run({ type: "room.note.create", roomId: stack.roomId, text: long });
  const note = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "note")!;
  const first = await board(stack).run(["read", String(note.sequence)], key(stack, "sol1"));
  assert.match(first, /page 1 of 2/);
  assert.match(first, new RegExp(`continues: read ${note.sequence} --page 2`));
  assert.ok(!first.includes("b".repeat(100)));
  const second = await board(stack).run(["read", String(note.sequence), "--page", "2"], key(stack, "sol1"));
  assert.ok(second.endsWith("b".repeat(100)));
  await assert.rejects(board(stack).run(["read", String(note.sequence), "--page", "3"], key(stack, "sol1")), /has 2 pages/);
});

test("a key of another room reads only that room's posts", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const other = ((await stack.run({ type: "room.create", projectId: "project_demo", title: "other" })) as { roomId: string }).roomId;
  await stack.run({ type: "participant.create", roomId: other, alias: "eve", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } });
  await stack.run({ type: "room.note.create", roomId: stack.roomId, text: "secret of the first room" });
  await stack.run({ type: "room.note.create", roomId: other, text: "note of the other room" });
  const theirs = await board(stack).run(["index"], key(stack, "eve", other));
  assert.match(theirs, /Board of "other": 1 post/);
  const own = stack.repos.listEvents(other).find((e) => e.kind === "note")!;
  assert.match(await board(stack).run(["read", String(own.sequence)], key(stack, "eve", other)), /note of the other room/);
  const first = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "note")!;
  // The first room's note has a number the other room does not reach: there is no way to name it from there.
  if (first.sequence !== own.sequence) await assert.rejects(board(stack).run(["read", String(first.sequence)], key(stack, "eve", other)), /no post/);
  assert.doesNotMatch(await board(stack).run(["read", String(own.sequence)], key(stack, "eve", other)), /secret/);
  await assert.rejects(board(stack).run(["index"], key(stack, "sol1", other)), /not the key of a member/, "an alias of another room is nobody here");
});

test("seat brings a saved crew member into the room; in a room with a Consigliere only he may, and the new member's first turn is the seat briefing", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob"]);
  t.after(() => stack.close());
  await preset(stack, "carol");
  assert.match(await board(stack).run(["crew"], key(stack, "bob")), /carol · gpt-6-sol/);
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await assert.rejects(board(stack).run(["seat", "carol"], key(stack, "bob")), /only this room's Consigliere \(@alice\) seats members/);
  await assert.rejects(board(stack).run(["seat", "nobody"], key(stack, "alice")), /no saved crew member called "nobody"/);
  const seated = await board(stack).run(["seat", "carol"], key(stack, "alice"));
  assert.match(seated, /Seated @carol \(gpt-6-sol\) · thread /);
  const members = await board(stack).run(["members"], key(stack, "alice"));
  assert.match(members, /@alice \(the Consigliere\)/);
  assert.match(members, /@carol · gpt-6-sol · working on task2 · thread /);
  const carol = stack.repos.listActiveParticipants(stack.roomId).find((p) => p.alias === "carol")!;
  const seatTask = stack.repos.listTasks(stack.roomId).find((task) => task.participantId === carol.id)!;
  assert.equal(seatTask.kind, "seat");
  const run = stack.repos.listRunsForTask(seatTask.id)[0]!;
  assert.ok(run, "already sent when seat returns");
  assert.match(run.briefing, /You are "carol", a member of the crew .* @alice is this room's Consigliere\./);
  assert.match(run.briefing, /Work from @alice arrives as an assignment on your thread/);
  assert.match(run.briefing, /rooms-board post "@name the question"/, "members post on the board; no thread ids to send to");
  assert.match(run.briefing, /you may use subagents freely/);
  assert.match(run.briefing, /rooms-board <command> --as carol\./);
  assert.doesNotMatch(run.briefing, /Shared room messages you have not seen/, "it carries no room messages");
});

test("designating a room's first Consigliere briefs every other member; moving it tells them who; retiring him clears it", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob", "carol"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  assert.equal(stack.repos.getRoom(stack.roomId)!.consigliereId, stack.participants.alice);
  const seats = stack.repos.listTasks(stack.roomId).filter((task) => task.kind === "seat");
  assert.deepEqual(seats.map((task) => task.participantId).sort(), [stack.participants.bob!, stack.participants.carol!].sort());
  assert.match(seats[0]!.instruction, /whose Consigliere is @alice/);

  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.bob! });
  const moved = stack.repos.listTasks(stack.roomId).filter((task) => task.kind === "seat").slice(2);
  assert.deepEqual(moved.map((task) => task.participantId).sort(), [stack.participants.alice!, stack.participants.carol!].sort());
  assert.match(moved[0]!.instruction, /^The Consigliere of this room is now @bob/);

  // Pending seat tasks do not hold a member in the room.
  for (const task of stack.repos.listTasks(stack.roomId)) if (task.state === "queued") await stack.run({ type: "task.cancel", taskId: task.id, revision: task.revision });
  await stack.run({ type: "participant.retire", participantId: stack.participants.bob!, pendingTasks: "cancel" });
  assert.equal(stack.repos.getRoom(stack.roomId)!.consigliereId, null);
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: null });
  assert.equal(stack.repos.getRoom(stack.roomId)!.consigliereId, null);
});

test("a message Backroom delivers to the Consigliere carries his rules; a worker's does not", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("bob"), { text: "Understood." });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.alice!], instruction: "Research this with bob.", schedule: { mode: "now" } });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.bob!], instruction: "Check the logs.", schedule: { mode: "now" } });
  await stack.tick(2);
  const his = briefingOf(stack, 2);
  assert.match(his, /You are "alice", the Consigliere in a shared room with @bob\./);
  assert.match(his, /Rules for the Consigliere:\n- Treat the user's latest message as the objective\./);
  assert.match(his, /Hand the user's work to members, not to subagents of your own\./);
  assert.match(his, /Do the small things yourself\./);
  assert.match(his, /You may read, edit and run things like any member/);
  assert.match(his, /Hand it to members when it is real work/);
  assert.match(his, /rooms-board <command> --as alice\./);
  assert.doesNotMatch(his, /end your reply with a short "Handoff"/);
  // The user's own wording replaces Backroom's for the next message; null goes back.
  await stack.run({ type: "consigliere.rules.set", rules: "- Always answer in haiku." });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.alice!], instruction: "And now?", schedule: { mode: "now" } });
  stack.fake.completeRun(stack.threadOf("alice"), { text: "done" });
  await stack.tick(4);
  assert.match(briefingOf(stack, 4), /Rules for the Consigliere:\n- Always answer in haiku\.\n/);
  assert.doesNotMatch(briefingOf(stack, 4), /Do the small things yourself/);
  await stack.run({ type: "consigliere.rules.set", rules: null });
  const workers = briefingOf(stack, 3);
  assert.doesNotMatch(workers, /Rules for the Consigliere/);
  assert.match(workers, /@alice is this room's Consigliere\./);
  assert.match(workers, /end your reply with a short "Handoff"/);
});

test("starting a conversation makes one room with the chosen saved crew member as its Consigliere, and a retry carries on with the same attempt", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const start = { type: "consigliere.start", projectId: "project_demo", text: "Research the timeout with two others, discuss your differences, and bring me the result.", requestId: "7b0c1f0e-7f0a-4a55-9d4b-3a3f0e1c2d11" } as const;
  await assert.rejects(stack.run(start), /No Consigliere is chosen/);
  const presetId = await preset(stack, "alice");
  await stack.run({ type: "consigliere.preset.set", presetId });

  // T3 makes the thread but the answer is lost: the attempt stops half way.
  stack.fake.dropAcks = true;
  await assert.rejects(stack.run(start));
  stack.fake.dropAcks = false;
  const threadsBefore = stack.fake.threads.size;
  const started = (await stack.run(start)) as { roomId: string; participantId: string };
  assert.equal(stack.fake.threads.size, threadsBefore, "the retry asked T3 for the same thread");
  const again = (await stack.run(start)) as { roomId: string; participantId: string };
  assert.deepEqual(again, started);

  const rooms = stack.repos.listRooms().filter((room) => room.id !== stack.roomId);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0]!.title, "Research the timeout with two others, di");
  assert.equal(rooms[0]!.consigliereId, started.participantId);
  assert.deepEqual(stack.repos.listActiveParticipants(started.roomId).map((p) => p.alias), ["alice"]);
  const tasks = stack.repos.listTasks(started.roomId);
  assert.equal(tasks.length, 1, "the message was delivered once");
  assert.equal(tasks[0]!.participantId, started.participantId);
  await stack.tick(2);
  assert.match(stack.repos.listRunsForTask(tasks[0]!.id)[0]!.briefing, /Rules for the Consigliere/);

  // Deleting the saved crew member clears the setting; the seated Consigliere stays.
  await stack.run({ type: "preset.delete", presetId });
  await assert.rejects(stack.run({ ...start, requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" }), /No Consigliere is chosen/);
  assert.equal(stack.repos.getRoom(started.roomId)!.consigliereId, started.participantId);
});

test("in a room with a Consigliere every message is for him, as a steer, whoever it names; without one plain text is incomplete", () => {
  const members = [{ id: "a", alias: "alice" }, { id: "b", alias: "bob" }, { id: "c", alias: "carol" }];
  const plain = parseExplicit("change direction: look at the queue first", members, [], { consigliereId: "a" });
  assert.equal(plain.unresolved.length, 0);
  assert.deepEqual(plain.assignments.map((a) => [a.recipients, a.instruction, a.delivery]), [[["a"], "change direction: look at the queue first", "steer"]]);
  const without = parseExplicit("change direction: look at the queue first", members, []);
  assert.deepEqual(without.unresolved.map((u) => u.severity), ["incomplete"]);
  assert.deepEqual(parseExplicit("@all review it", members, []).assignments[0]!.recipients, ["a", "b", "c"]);
  // A message that names members goes to him whole: he reads the names and hands the work out.
  for (const text of ["@bob check the logs", "@all review it", "@bob fix it. @carol check bob's work", "hey team, @bob do x", "@nobody do it"]) {
    const routed = parseExplicit(text, members, [], { consigliereId: "a" });
    assert.deepEqual(routed.assignments.map((a) => [a.recipients, a.instruction, a.delivery]), [[["a"], text, "steer"]], text);
    assert.equal(routed.unresolved.length, 0, text);
  }
  // A T3 slash command still goes to the member it names: a harness runs one only on its own thread.
  assert.deepEqual(parseExplicit("@bob /compact", members, [], { consigliereId: "a" }).assignments.map((a) => [a.recipients, a.slashCommand]), [[["b"], "compact"]]);
  assert.equal(parseExplicit("/note keep the API", members, [], { consigliereId: "a" }).kind, "note");
  assert.deepEqual(parseExplicit("/compact", members, [], { consigliereId: "a" }).assignments.map((a) => [a.recipients, a.delivery, a.slashCommand]), [[["a"], "queue", "compact"]]);
});

test("an unaddressed message reaches a working Consigliere inside his turn, and starts a turn when he is idle", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  const send = (text: string) => stack.run({ type: "message.create", roomId: stack.roomId, sourceText: text, assignments: [{ recipients: [stack.participants.alice!], instruction: text, delivery: "steer" }] });
  await send("Research the timeout.");
  await stack.tick(3);
  const first = stack.taskByAlias("alice")[0]!;
  assert.equal(first.state, "running", "idle: it starts a turn of its own");
  assert.match(stack.repos.listRunsForTask(first.id)[0]!.briefing, /Rules for the Consigliere/);
  await send("Look at the queue first.");
  await stack.tick(2);
  const second = stack.taskByAlias("alice")[1]!;
  const run = stack.repos.listRunsForTask(second.id)[0]!;
  assert.equal(run.steered, true, "working: it goes into his turn");
  assert.equal(run.t3RunId, stack.repos.listRunsForTask(first.id)[0]!.t3RunId);
});

test("what waits on the user: an answer, held or blocked work, and a failure that is still the last thing its member was given", async () => {
  const { tasksNeedingYou } = await import("../src/domain/workStatus.ts");
  const task = (number: number, participantId: string, state: string, extra: Record<string, unknown> = {}) => ({ id: `t${number}`, number, participantId, state, kind: "assignment", dismissedAt: null, ...extra }) as never;
  const numbers = (tasks: Array<{ number: number }>) => tasks.map((t) => t.number);
  const tasks = [task(1, "a", "failed"), task(2, "a", "succeeded"), task(3, "b", "failed"), task(4, "c", "held"), task(5, "c", "blocked"), task(6, "d", "needs_input"), task(7, "d", "queued"), task(8, "e", "running"), task(9, "e", "interrupted")];
  assert.deepEqual(numbers(tasksNeedingYou(tasks)), [3, 4, 5, 6]);
  // With a Consigliere a worker's failure is his to deal with; his own still waits on the user.
  assert.deepEqual(numbers(tasksNeedingYou(tasks, "a")), [4, 5, 6]);
  assert.deepEqual(numbers(tasksNeedingYou(tasks, "b")), [3, 4, 5, 6]);
  // A dismissed failure, and what Backroom sent by itself, ask nothing.
  assert.deepEqual(numbers(tasksNeedingYou([task(1, "a", "failed", { dismissedAt: "2026-10-03T00:00:00Z" }), task(2, "b", "failed", { kind: "seat" }), task(3, "c", "blocked", { kind: "seat" })])), []);
});

test("a failed task can be dismissed and a retry brings it back; a question can be dropped", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice"]);
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.alice!], instruction: "do it", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("alice"), { text: "boom", outcome: "error" });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "failed");
  await stack.run({ type: "task.dismiss", taskId: stack.task(1).id });
  assert.ok(stack.task(1).dismissedAt);
  await stack.run({ type: "task.retry", taskId: stack.task(1).id, revision: stack.task(1).revision, reattachDependents: true });
  assert.equal(stack.task(1).dismissedAt, null);
  await assert.rejects(stack.run({ type: "task.dismiss", taskId: stack.task(1).id }), /only a failed task/);

  await stack.tick(2);
  const requestId = stack.fake.raiseQuestion(stack.threadOf("alice"));
  await stack.tick(2);
  assert.equal(stack.repos.listOpenNativeRequests([stack.participants.alice!]).length, 1);
  await stack.run({ type: "native.userInput.dismiss", participantId: stack.participants.alice!, requestId });
  assert.equal(stack.repos.listOpenNativeRequests([stack.participants.alice!]).length, 0);
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.user-input.dismiss"));
});

test("a member's thread is named after its room and alias, and is renamed back when T3 or a rename changes that", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice"]);
  t.after(() => stack.close());
  const thread = stack.fake.threads.get(stack.threadOf("alice"))!;
  assert.equal(thread.shell.title, "payments · alice");
  thread.shell.title = "Compare parsers";
  await stack.tick();
  assert.equal(thread.shell.title, "payments · alice", "a title T3 generated is set back");
  await stack.run({ type: "room.update", roomId: stack.roomId, title: "billing" });
  await stack.tick();
  assert.equal(thread.shell.title, "billing · alice");
  await stack.run({ type: "participant.update", participantId: stack.participants.alice!, alias: "al" });
  await stack.tick();
  assert.equal(thread.shell.title, "billing · al");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.alice!], instruction: "go", schedule: { mode: "now" } });
  await stack.tick(2);
  const sent = stack.fake.commands.filter((c) => c.type === "message.dispatch").at(-1) as { payload?: { titleSeed?: string } } | undefined;
  assert.equal((sent as { titleSeed?: string } | undefined)?.titleSeed ?? (sent?.payload as { titleSeed?: string } | undefined)?.titleSeed, undefined, "no title seed on a room send");
});

test("in a room with a Consigliere only his replies are the room's news", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("bob"), { text: "Understood." });
  await stack.tick(2);
  assert.equal(stack.repos.listRoomFinishes(stack.roomId, "2000-01-01", 10, stack.participants.alice!).length, 0, "the worker's acknowledgement is not news");
  assert.equal(stack.repos.listRoomFinishes(stack.roomId, "2000-01-01", 10).length, 1, "it would be in a room without one");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.alice!], instruction: "report", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("alice"), { text: "Here is the report." });
  await stack.tick(2);
  const news = stack.repos.listRoomFinishes(stack.roomId, "2000-01-01", 10, stack.participants.alice!);
  assert.deepEqual(news.map((n) => n.text), ["Here is the report."]);
});

test("a new room seats the chosen Consigliere and designates him; without a choice it opens empty", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const empty = (await stack.run({ type: "room.create", projectId: "project_demo", title: "before" })) as { roomId: string };
  assert.equal(stack.repos.listActiveParticipants(empty.roomId).length, 0);
  assert.equal(stack.repos.getRoom(empty.roomId)!.consigliereId, null);

  const presetId = await preset(stack, "alice");
  await stack.run({ type: "consigliere.preset.set", presetId });
  const created = (await stack.run({ type: "room.create", projectId: "project_demo", title: "after" })) as { roomId: string };
  const members = stack.repos.listActiveParticipants(created.roomId);
  assert.deepEqual(members.map((m) => m.alias), ["alice"]);
  assert.equal(stack.repos.getRoom(created.roomId)!.consigliereId, members[0]!.id);
  assert.ok(stack.repos.currentBinding(members[0]!.id)?.threadId, "he sits on a thread of his own");

  // Asked not to (the start of a conversation seats him itself), the room opens empty even with a choice.
  const bare = (await stack.run({ type: "room.create", projectId: "project_demo", title: "bare", consigliere: false })) as { roomId: string };
  assert.equal(stack.repos.listActiveParticipants(bare.roomId).length, 0);
});

test("a board post is a task for the member it names, and the poster is woken with the answer; a failure wakes him too", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const sol1 = stack.participants.sol1!;
  const sol2 = stack.participants.sol2!;
  await assert.rejects(board(stack).run(["post"], key(stack, "sol1")), /needs the text/);
  await assert.rejects(board(stack).run(["post", "@sol1 note to self"], key(stack, "sol1")), /nobody called @sol1/);
  await assert.rejects(board(stack).run(["post", "just some text"], key(stack, "sol1")), /start with @name/);

  const out = await board(stack).run(["post", "@sol2 Check the parser; report what you find."], key(stack, "sol1"));
  assert.match(out, /Posted as #\d+/);
  assert.match(out, /task1 → @sol2: queued/);
  assert.match(out, /end your turn/);
  const post = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "member.message")!;
  assert.equal(post.sourceRef, null, "a board post, not a T3 import");
  assert.equal(post.to, sol2);
  assert.deepEqual(post.speaker.type === "participant" ? post.speaker.participantId : null, sol1);
  const work = stack.task(1);
  assert.equal(work.participantId, sol2);
  assert.equal(work.kind, "assignment");
  const wake = stack.repos.listTasks(stack.roomId).find((task) => task.kind === "wake")!;
  assert.equal(wake.participantId, sol1);
  assert.deepEqual(wake.prerequisites, [{ taskId: work.id, revision: 1 }]);
  assert.equal(wake.state, "queued");

  await stack.tick(2);
  assert.equal(stack.repos.getTask(work.id)!.state, "running");
  assert.equal(stack.repos.getTask(wake.id)!.state, "queued", "the poster is not woken before the work ends");
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "The parser is fine; one dead branch.\n\nHandoff: nothing changed." });
  await stack.tick(3);
  const wakeRun = stack.repos.listRunsForTask(wake.id)[0]!;
  assert.match(wakeRun.briefing, /task1 by @sol2/);
  assert.match(wakeRun.briefing, /The parser is fine; one dead branch/);
  assert.match(wakeRun.briefing, /has ended\. Its answer is above/);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Noted; nothing more to do." });
  await stack.tick(2);
  assert.equal(stack.repos.getTask(wake.id)!.state, "succeeded");

  // The work fails: the poster is still woken, told so, and nothing is blocked.
  await board(stack).run(["post", "@sol2 Now break it on purpose."], key(stack, "sol1"));
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "(crashed)", outcome: "error" });
  await stack.tick(3);
  const second = stack.repos.listTasks(stack.roomId).filter((task) => task.kind === "wake")[1]!;
  const secondRun = stack.repos.listRunsForTask(second.id)[0];
  assert.ok(secondRun, "woken although the work failed");
  assert.match(secondRun.briefing, /It failed/);
  assert.ok(!stack.repos.listTasks(stack.roomId).some((task) => task.state === "blocked"), "no task is blocked by the failure");
});

test("a member's post delivers names as written; plain text from a member goes to the Consigliere, who cannot address nobody", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.sol1! });
  await stack.tick(2);
  // sol2 names sol1: direct, not "the whole message to the Consigliere as a steer".
  await board(stack).run(["post", "@sol1 Which branch should I use?"], key(stack, "sol2"));
  const toConsigliere = stack.repos.listTasks(stack.roomId).filter((task) => task.kind === "assignment" && task.participantId === stack.participants.sol1!);
  assert.equal(toConsigliere.length, 1);
  assert.equal(toConsigliere[0]!.instruction, "Which branch should I use?");
  // Plain text from a member is for the Consigliere.
  await board(stack).run(["post", "Done with the review, see #3."], key(stack, "sol2"));
  assert.equal(stack.repos.listTasks(stack.roomId).filter((task) => task.kind === "assignment" && task.participantId === stack.participants.sol1!).length, 2);
  // The Consigliere's own post must name someone.
  await assert.rejects(board(stack).run(["post", "think about it"], key(stack, "sol1")), /start with @name/);
});

test("a worker that continues on its own after a posted job wakes the poster again; members shows what each is doing", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await board(stack).run(["post", "@sol2 Watch the build and report."], key(stack, "sol1"));
  await stack.tick(2);
  assert.match(await board(stack).run(["members"], key(stack, "sol1")), /@sol2 · gpt-6-sol · working on task1/);
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "Started the watch in the background; more when it ends." });
  await stack.tick(3);
  const wakes = () => stack.repos.listTasks(stack.roomId).filter((task) => task.kind === "wake");
  assert.equal(wakes().length, 1, "the first answer woke sol1 once");
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Noted." });
  await stack.tick(2);
  // The watch ends and sol2 continues on its own, then that run ends too.
  stack.fake.startSelfRun(stack.threadOf("sol2"));
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "The build is green." });
  await stack.tick(3);
  assert.equal(wakes().length, 2, "the continuation woke sol1 again");
  const again = wakes()[1]!;
  assert.equal(again.participantId, stack.participants.sol1!);
  assert.deepEqual(again.prerequisites, []);
  assert.match(again.instruction, /@sol2 continued on its own after task1 and that run has ended: post #\d+\. It says: The build is green\./);
  const run = stack.repos.listRunsForTask(again.id)[0];
  assert.ok(run, "delivered at once");
  assert.match(await board(stack).run(["members"], key(stack, "sol2")), /@sol1 · gpt-6-sol · working/);
});

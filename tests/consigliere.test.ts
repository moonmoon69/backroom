/** The Consigliere's designation by Settings, starting a conversation, a message's routing to him, and a member's thread. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack, type TestStack } from "./helpers.ts";
import { NOTE_GONE, STEER_GONE, parseExplicit } from "../src/parser/explicit.ts";

const preset = async (stack: TestStack, name: string) =>
  ((await stack.run({ type: "preset.create", name, modelSelection: { instanceId: "codex", model: "gpt-6-sol" } })) as { presetId: string }).presetId;

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
  const seat = stack.repos.currentBinding(started.participantId)!;
  const requests = [...stack.engine.view(started.roomId).requests.values()];
  assert.deepEqual(requests.map((q) => q.owner), [seat.id], "the message was delivered once, as his request");
  await stack.tick(2);
  const thread = stack.fake.threads.get(seat.threadId)!;
  assert.match(thread.messages.find((m) => m.id === thread.runs[0]!.userMessageId)!.text, /Rules for the Consigliere/);

  // Deleting the saved crew member clears the setting; the seated Consigliere stays.
  await stack.run({ type: "preset.delete", presetId });
  await assert.rejects(stack.run({ ...start, requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" }), /No Consigliere is chosen/);
  assert.equal(stack.repos.getRoom(started.roomId)!.consigliereId, started.participantId);
});

test("in a room with a Consigliere every message is for him, whoever it names (by name too: M1 has no exception); without one plain text is incomplete; /steer is refused", () => {
  const members = [{ id: "a", alias: "alice" }, { id: "b", alias: "bob" }, { id: "c", alias: "carol" }];
  const plain = parseExplicit("change direction: look at the queue first", members, { consigliereId: "a" });
  assert.equal(plain.unresolved.length, 0);
  assert.deepEqual(plain.assignments.map((a) => [a.recipients, a.instruction]), [[["a"], "change direction: look at the queue first"]]);
  assert.equal("delivery" in plain.assignments[0]!, false, "no delivery to choose: every message goes into his running turn when he works");
  const without = parseExplicit("change direction: look at the queue first", members);
  assert.deepEqual(without.unresolved.map((u) => u.severity), ["incomplete"]);
  assert.deepEqual(parseExplicit("@all review it", members).assignments[0]!.recipients, ["a", "b", "c"]);
  // A message that names members goes to him whole: he reads the names and hands the work out.
  for (const text of ["@bob check the logs", "@all review it", "@bob fix it. @carol check bob's work", "hey team, @bob do x", "@nobody do it"]) {
    const routed = parseExplicit(text, members, { consigliereId: "a" });
    assert.deepEqual(routed.assignments.map((a) => [a.recipients, a.instruction]), [[["a"], text]], text);
    assert.equal(routed.unresolved.length, 0, text);
  }
  // A T3 slash command still goes to the member it names: a harness runs one only on its own thread.
  assert.deepEqual(parseExplicit("@bob /compact", members, { consigliereId: "a" }).assignments.map((a) => [a.recipients, a.slashCommand]), [[["b"], "compact"]]);
  // The note directive is gone (N1): refused, not sent to him as a slash command.
  assert.deepEqual(parseExplicit("/note keep the API", members, { consigliereId: "a" }).unresolved.map((u) => u.message), [NOTE_GONE]);
  assert.deepEqual(parseExplicit("/compact", members, { consigliereId: "a" }).assignments.map((a) => [a.recipients, a.slashCommand]), [[["a"], "compact"]]);
  // Addressed to him by name: his like any message, with nothing that holds it to his next turn.
  const named = parseExplicit("@alice deploy it", members, { consigliereId: "a" });
  assert.deepEqual([named.assignments.map((a) => [a.recipients, a.instruction, a.timing]), named.unresolved], [[[["a"], "deploy it", null]], []]);
  // /steer is gone (M1): refused with its hint, at the start of a message and after an @name, never sent to T3 as a command.
  for (const text of ["/steer look at the queue first", "@alice /steer look at the queue first", "@bob /steer check the logs"]) {
    assert.deepEqual(parseExplicit(text, members, { consigliereId: "a" }).unresolved.filter((u) => u.severity === "error").map((u) => u.message), [STEER_GONE], text);
  }
});

test("a question a member's turn asks can be dropped", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice"]);
  t.after(() => stack.close());
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.alice!], instruction: "do it" }] });
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
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.alice!], instruction: "go" }] });
  await stack.tick(2);
  const sent = stack.fake.commands.filter((c) => c.type === "message.dispatch").at(-1) as { payload?: { titleSeed?: string } } | undefined;
  assert.equal((sent as { titleSeed?: string } | undefined)?.titleSeed ?? (sent?.payload as { titleSeed?: string } | undefined)?.titleSeed, undefined, "no title seed on a room send");
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

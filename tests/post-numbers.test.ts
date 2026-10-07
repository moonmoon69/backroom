/** Post numbers: only posts take one, so a room's posts count 1, 2, 3; posts made before keep the number they had. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack, type TestStack } from "./helpers.ts";
import { Board } from "../src/app/board.ts";
import { NUMBER_EXISTING_POSTS } from "../src/db/database.ts";
import { parseCommand } from "../src/domain/commands.ts";
import { POST_KINDS } from "../src/domain/types.ts";
import { agentKey } from "../src/browser/catalog.ts";

const board = (stack: TestStack) =>
  new Board({ repos: stack.repos, execute: (command) => stack.service.execute(parseCommand(command)), afterSeat: () => stack.tick(2), statusOf: (participantId) => stack.scheduler.participantStatus(participantId) });
const key = (stack: TestStack, alias: string) => agentKey(alias, stack.roomId);

/** A request, its answer (each with status lines around it) and a note. */
async function talk(stack: TestStack): Promise<void> {
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "Research the timeout.", sourceText: "@sol1 Research the timeout.", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "It is the retry loop." });
  await stack.tick(2);
  await stack.run({ type: "room.note.create", roomId: stack.roomId, text: "Noted." });
}

test("a new room's posts count 1, 2, 3 without gaps; status lines and system notes take no number", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await talk(stack);
  const posted = await board(stack).run(["post", "@sol2 check the retry loop"], key(stack, "sol1"));

  const events = stack.repos.listEvents(stack.roomId, 1, Number.MAX_SAFE_INTEGER, 100_000);
  const posts = events.filter((e) => POST_KINDS.has(e.kind));
  assert.ok(events.some((e) => e.kind === "task.status") && events.some((e) => e.kind === "system"), "the room has status lines and system notes between its posts");
  assert.deepEqual(
    posts.map((e) => e.postNumber),
    posts.map((_, i) => i + 1),
    "posts are numbered in order, without gaps",
  );
  assert.ok(posts.at(-1)!.sequence > posts.length, "while their sequence skips over the status lines");
  for (const event of events.filter((e) => !POST_KINDS.has(e.kind))) assert.equal(event.postNumber, null, `${event.kind} takes no number`);
  assert.match(posted, new RegExp(`^Posted as #${posts.length}\\.`), "the member's post is told the number it took");

  // The board shows and takes those numbers.
  const index = await board(stack).run(["index"], key(stack, "sol2"));
  assert.match(index, new RegExp(`: ${posts.length} posts\\.`));
  for (const post of posts) assert.match(index, new RegExp(`^#${post.postNumber}  ${post.kind.replace(".", "\\.")} `, "m"));
  const all = await board(stack).run(["index", "--all"], key(stack, "sol2"));
  assert.match(all, /^ {2}· {2}task\.status /m, "--all adds the status lines, without a number");
  assert.match(all, new RegExp(`: ${posts.length} posts\\.`), "and they are not counted as posts");
  const after = await board(stack).run(["index", "--after", "2"], key(stack, "sol2"));
  assert.doesNotMatch(after, /^#[12] /m);
  assert.match(after, /^#3 /m);
  assert.match(after, new RegExp(`: ${posts.length - 2} posts after #2\\.`));
  assert.match(await board(stack).run(["read", "2"], key(stack, "sol2")), /^\[#2 assistant\.reply · @sol1 → user · .*\]\nIt is the retry loop\.$/);
});

test("an older room keeps its posts' numbers, and its new posts continue from the highest", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await talk(stack);
  // As before post numbers: a post's number was its sequence. The migration gives each post that number back.
  stack.db.raw.exec("UPDATE events SET post_number = NULL");
  stack.db.raw.exec(NUMBER_EXISTING_POSTS);
  const before = stack.repos.listEvents(stack.roomId, 1, Number.MAX_SAFE_INTEGER, 100_000);
  for (const event of before) assert.equal(event.postNumber, POST_KINDS.has(event.kind) ? event.sequence : null, `${event.kind} #${event.sequence}`);
  const highest = Math.max(...before.filter((e) => e.postNumber !== null).map((e) => e.postNumber!));
  const reply = before.find((e) => e.kind === "assistant.reply")!;
  assert.match(await board(stack).run(["read", String(reply.sequence)], key(stack, "sol2")), /It is the retry loop\./, "an old number still reads the same post");

  // A status line after the last post takes a sequence, but the next post is still the highest number + 1.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "Check it.", sourceText: "@sol2 Check it.", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "room.note.create", roomId: stack.roomId, text: "And another." });
  const added = stack.repos.listEvents(stack.roomId, 1, Number.MAX_SAFE_INTEGER, 100_000).filter((e) => e.sequence > before.at(-1)!.sequence);
  assert.deepEqual(
    added.filter((e) => e.postNumber !== null).map((e) => [e.kind, e.postNumber]),
    [
      ["user.message", highest + 1],
      ["note", highest + 2],
    ],
  );
  assert.ok(added.some((e) => e.kind === "task.status" && e.postNumber === null));
  assert.ok(added.at(-1)!.sequence > highest + 2, "the sequence went on counting status lines");
});

test("two posts cannot share a number in a room", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await talk(stack);
  assert.throws(() => stack.db.raw.exec(`UPDATE events SET post_number = 1 WHERE post_number = 2 AND room_id = '${stack.roomId}'`), /UNIQUE/);
  // Another room counts from 1 of its own.
  const other = ((await stack.run({ type: "room.create", projectId: "project_demo", title: "other" })) as { roomId: string }).roomId;
  await stack.run({ type: "room.note.create", roomId: other, text: "First." });
  assert.equal(stack.repos.listEvents(other).find((e) => e.kind === "note")?.postNumber, 1);
});

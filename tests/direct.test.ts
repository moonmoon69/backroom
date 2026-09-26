import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { threadTitleFor } from "../src/app/direct.ts";
import { RoomError } from "../src/domain/errors.ts";
import { createTestStack } from "./helpers.ts";

test("project.create adds a T3 project named after its folder and refuses a folder already in use", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const created = (await stack.run({ type: "project.create", workspaceRoot: "/srv/code/new-thing/", createIfMissing: true })) as { projectId: string };
  const project = stack.fake.projects.find((p) => p.id === created.projectId);
  assert.equal(project?.title, "new-thing");
  const sent = stack.fake.commands.find((c) => c.type === "project.create")?.payload as { workspaceRoot: string; createIfMissing: boolean };
  assert.deepEqual([sent.workspaceRoot, sent.createIfMissing], ["/srv/code/new-thing/", true]);

  await assert.rejects(stack.run({ type: "project.create", workspaceRoot: "/srv/code/new-thing" }), (error: RoomError) => error.code === "project_exists");
  await assert.rejects(stack.run({ type: "project.create", workspaceRoot: "code/relative" }), (error: RoomError) => error.code === "invalid_path");
  const titled = (await stack.run({ type: "project.create", workspaceRoot: "/srv/other", title: "Other work" })) as { projectId: string };
  assert.equal(stack.fake.projects.find((p) => p.id === titled.projectId)?.title, "Other work");
});

test("thread.start creates a thread and sends the text as typed, without a room briefing", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const started = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "Why is the parser slow on big files?\nLook at src/parser.ts" })) as { type: string; threadId: string };
  assert.equal(started.type, "thread.started");
  const thread = stack.fake.threads.get(started.threadId);
  assert.ok(thread);
  assert.equal(thread.shell.title, "Why is the parser slow on big files?");
  assert.deepEqual(thread.shell.modelSelection, { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "medium" }] }, "T3's default model");
  const turn = stack.fake.commands.find((c) => c.type === "thread.turn.start" && c.threadId === started.threadId)?.payload as { text: string; titleSeed: string };
  assert.equal(turn.text, "Why is the parser slow on big files?\nLook at src/parser.ts");
  assert.equal(turn.titleSeed, "Why is the parser slow on big files?");

  await assert.rejects(stack.run({ type: "thread.start", projectId: "nope", text: "hi" }), (error: RoomError) => error.code === "unknown_project");
});

test("direct thread commands work on loose threads and refuse threads seated in a room", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await assert.rejects(stack.run({ type: "thread.send", threadId: stack.threadOf("sol1"), text: "psst" }), (error: RoomError) => error.code === "thread_in_room" && error.status === 409);

  const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "first", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "approval-required" })) as { threadId: string };
  stack.fake.completeTurn(threadId, { text: "first answer" });
  const png = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`;
  await stack.run({ type: "thread.send", threadId, text: "second", images: [{ name: "shot.png", dataUrl: png }] });
  const send = stack.fake.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === threadId)[1]?.payload as { text: string; runtimeMode: string; images: Array<{ name: string; mimeType: string; sizeBytes: number }> };
  assert.equal(send.text, "second");
  assert.equal(send.runtimeMode, "approval-required", "the thread's own permission mode");
  assert.deepEqual(send.images.map((i) => [i.name, i.mimeType, i.sizeBytes]), [["shot.png", "image/png", 8]]);

  await stack.run({ type: "thread.interrupt", threadId });
  assert.equal(stack.fake.threads.get(threadId)?.shell.latestTurn?.state, "interrupted");
  await assert.rejects(stack.run({ type: "thread.model.set", threadId, modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" } }), (error: RoomError) => error.code === "provider_fixed");
  await stack.run({ type: "thread.runtimeMode.set", threadId, runtimeMode: "full-access" });
  assert.equal(stack.fake.threads.get(threadId)?.shell.runtimeMode, "full-access");
  await stack.run({ type: "thread.lifecycle", threadId, action: "delete" });
  assert.equal(stack.fake.threads.has(threadId), false);
  await assert.rejects(stack.run({ type: "thread.send", threadId, text: "anyone?" }), (error: RoomError) => error.code === "not_found");
});

test("the thread view shows one reply per turn, streams the running turn, and lists open approvals", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-direct", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "fix the parser" })) as { threadId: string };
  stack.fake.completeTurn(threadId, { text: "Fixed it.", progress: ["Reading the parser.", "Editing now."], files: [{ path: "src/parser.ts", kind: "modified", additions: 4, deletions: 1 }] });
  await stack.run({ type: "thread.send", threadId, text: "now the tests" });
  const approval = stack.fake.raiseApproval(threadId);

  const view = (await (await app.request(`/api/threads/${threadId}`)).json()) as {
    thread: { boundToRoom: boolean; title: string };
    project: { id: string } | null;
    items: Array<{ kind: string; text: string; progress?: Array<{ text: string }>; files?: { count: number; additions: number } | null }>;
    running: { turnId: string } | null;
    requests: Array<{ requestId: string; kind: string }>;
    contextWindow: { maxTokens: number } | null;
  };
  assert.equal(view.thread.boundToRoom, false);
  assert.equal(view.project?.id, "project_demo");
  assert.deepEqual(view.items.map((i) => [i.kind, i.text]), [["user", "fix the parser"], ["reply", "Fixed it."], ["user", "now the tests"]]);
  assert.deepEqual(view.items[1]?.progress?.map((p) => p.text), ["Reading the parser.", "Editing now."]);
  assert.deepEqual(view.items[1]?.files, { count: 1, additions: 4, deletions: 1 });
  assert.ok(view.running, "the second turn is running");
  assert.deepEqual(view.requests.map((r) => [r.requestId, r.kind]), [[approval, "approval"]]);
  assert.equal(view.contextWindow?.maxTokens, 200000);

  await stack.run({ type: "thread.approval.respond", threadId, requestId: approval, decision: "accept" });
  const after = (await (await app.request(`/api/threads/${threadId}`)).json()) as { requests: unknown[] };
  assert.equal(after.requests.length, 0);
  assert.equal((await app.request("/api/threads/missing")).status, 404);
  // An unknown API path is a JSON 404, never the app shell.
  const unknown = await app.request("/api/no-such-route");
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: string }).error, "not_found");
});

test("thread titles come from the first line of the message", () => {
  assert.equal(threadTitleFor("\n  hello   world \nmore"), "hello world");
  assert.equal(threadTitleFor(""), "New thread");
  const long = threadTitleFor("Investigate why the nightly build of the payments service fails on arm64 runners only");
  assert.ok(long.length <= 61 && long.endsWith("…"), long);
});

test("threads can be settled and archived and brought back; archived ones are listed only on request", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-direct", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "tidy up" })) as { threadId: string };
  stack.fake.completeTurn(threadId, { text: "tidied" });
  const listed = async (query = "") =>
    ((await (await app.request(`/api/t3/threads${query}`)).json()) as Array<{ id: string; settledAt: string | null; archivedAt: string | null }>).find((x) => x.id === threadId);

  await stack.run({ type: "thread.lifecycle", threadId, action: "settle" });
  assert.ok((await listed())?.settledAt, "settled");
  await stack.run({ type: "thread.lifecycle", threadId, action: "unsettle" });
  assert.equal((await listed())?.settledAt, null);
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.unsettle" && c.threadId === threadId));

  await stack.run({ type: "thread.lifecycle", threadId, action: "archive" });
  assert.equal(await listed(), undefined, "T3 leaves archived threads out of the live list");
  assert.ok((await listed("?includeArchived=1"))?.archivedAt, "listed as archived on request");
  assert.equal((await app.request(`/api/threads/${threadId}`)).status, 404, "T3 does not serve an archived thread's conversation");

  // Found through T3's archived list, so it can be restored (or deleted) from the room.
  await stack.run({ type: "thread.lifecycle", threadId, action: "unarchive" });
  assert.equal((await listed())?.archivedAt, null);
  assert.equal((await app.request(`/api/threads/${threadId}`)).status, 200);
});

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { ThreadCosts } from "../src/usage/threadCosts.ts";
import { createTestStack } from "./helpers.ts";

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "cost"}: ${actual} is not ${expected}`);

// Per token: opus 4/20 per million in/out, cache read 0.2, cache write 5; fable 10/50, 0.25, 12.5; gpt 10/50, cache read 1.
const RATES = {
  "claude-opus": { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: 0.2e-6, cache_creation_input_token_cost: 5e-6 },
  "claude-fable": { input_cost_per_token: 10e-6, output_cost_per_token: 50e-6, cache_read_input_token_cost: 0.25e-6, cache_creation_input_token_cost: 12.5e-6 },
  "gpt-astra": { input_cost_per_token: 10e-6, output_cost_per_token: 50e-6, cache_read_input_token_cost: 1e-6 },
};

const claudeLine = (id: string, model: string, at: string, usage: { input: number; read: number; write: number; output: number }) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at,
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model, usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: usage.output } },
  });

const codexLine = (at: string, usage: { input: number; cached: number; output: number }) =>
  JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: usage.input, cached_input_tokens: usage.cached, cache_write_input_tokens: 0, output_tokens: usage.output } } } });

/** A machine as the reader finds it: T3's database and price table, and the two harnesses' transcript folders. */
function machine(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rooms-costs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userdata = join(root, "t3");
  const claude = join(root, "claude", "projects");
  const codex = join(root, "codex", "sessions");
  for (const dir of [userdata, join(claude, "-work-app"), join(codex, "2026", "09", "26")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(userdata, "usage-model-rates.json"), JSON.stringify({ fetchedAtMs: Date.parse("2026-09-26T00:00:00Z"), document: RATES }));
  const db = new DatabaseSync(join(userdata, "state.sqlite"));
  db.exec("CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT, resume_cursor_json TEXT)");
  const bind = (threadId: string, provider: string, cursor: unknown) =>
    db.prepare("INSERT OR REPLACE INTO provider_session_runtime (thread_id, provider_name, resume_cursor_json) VALUES (?, ?, ?)").run(threadId, provider, JSON.stringify(cursor));
  t.after(() => db.close());
  const past = new Map<string, Array<{ provider: string; sessionId: string }>>();
  const costs = () =>
    new ThreadCosts({
      t3StateDb: join(userdata, "state.sqlite"),
      ratesPath: join(userdata, "usage-model-rates.json"),
      claudeProjectsDir: claude,
      codexSessionsDir: codex,
      remember: (threadId, provider, sessionId) => {
        const list = past.get(threadId) ?? [];
        if (!list.some((s) => s.sessionId === sessionId)) past.set(threadId, [...list, { provider, sessionId }]);
      },
      remembered: (threadId) => past.get(threadId) ?? [],
    });
  return { root, userdata, claudeProject: join(claude, "-work-app"), codexDay: join(codex, "2026", "09", "26"), bind, costs };
}

test("a Claude thread: its own calls and its subagents', per model, each message once", (t) => {
  const m = machine(t);
  m.bind("thread-1", "claudeAgent", { resume: "sess-1" });
  const own = claudeLine("a", "claude-fable", "2026-09-26T10:00:00Z", { input: 100, read: 1000, write: 200, output: 50 });
  writeFileSync(
    join(m.claudeProject, "sess-1.jsonl"),
    [
      JSON.stringify({ type: "user", timestamp: "2026-09-26T09:59:00Z", message: { role: "user", content: "go" } }),
      own,
      own, // the same message again, once per block of it
      claudeLine("b", "claude-fable", "2026-09-26T10:05:00Z", { input: 10, read: 2000, write: 0, output: 100 }),
      "{ not json",
    ].join("\n") + "\n",
  );
  mkdirSync(join(m.claudeProject, "sess-1", "subagents"), { recursive: true });
  writeFileSync(join(m.claudeProject, "sess-1", "subagents", "agent-x.jsonl"), claudeLine("c", "claude-opus", "2026-09-26T10:02:00Z", { input: 5, read: 4000, write: 1000, output: 300 }) + "\n");

  const cost = m.costs().cost(["thread-1"]);
  assert.equal(cost.available, true);
  assert.equal(cost.provider, "claudeAgent");
  assert.deepEqual(
    { ...cost.own, costUsd: 0 },
    { inputTokens: 110, cachedInputTokens: 3000, cacheWriteTokens: 200, outputTokens: 150, calls: 2, costUsd: 0 },
  );
  close(cost.own.costUsd, 110 * 10e-6 + 3000 * 0.25e-6 + 200 * 12.5e-6 + 150 * 50e-6, "own");
  close(cost.subagents.costUsd, 5 * 4e-6 + 4000 * 0.2e-6 + 1000 * 5e-6 + 300 * 20e-6, "subagents");
  close(cost.total.costUsd, cost.own.costUsd + cost.subagents.costUsd, "total");
  assert.equal(cost.total.calls, 3);
  assert.equal(cost.total.outputTokens, 450);
  assert.deepEqual(cost.models.map((model) => [model.model, model.calls, model.own.calls, model.subagents.calls, model.priced]), [
    // Largest cost first: by a hair, the thread's own model here.
    ["claude-fable", 2, 2, 0, true],
    ["claude-opus", 1, 0, 1, true],
  ]);
  assert.equal(cost.firstAt, "2026-09-26T10:00:00.000Z");
  assert.equal(cost.lastAt, "2026-09-26T10:05:00.000Z");
});

test("a Codex thread: cached input is part of its input, and the turn names the model", (t) => {
  const m = machine(t);
  const session = "01a0dd5f-d44c-7a82-bea6-0b079927dec1";
  m.bind("thread-2", "codex", { threadId: session });
  writeFileSync(
    join(m.codexDay, `rollout-2026-09-26T11-00-00-${session}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-09-26T11:00:00Z", type: "turn_context", payload: { model: "gpt-astra" } }),
      codexLine("2026-09-26T11:00:05Z", { input: 1500, cached: 1000, output: 20 }),
      JSON.stringify({ timestamp: "2026-09-26T11:00:06Z", type: "event_msg", payload: { type: "token_count", info: null } }),
      codexLine("2026-09-26T11:00:09Z", { input: 3000, cached: 2500, output: 80 }),
    ].join("\n") + "\n",
  );
  const cost = m.costs().cost(["thread-2"]);
  assert.deepEqual({ ...cost.total, costUsd: 0 }, { inputTokens: 1000, cachedInputTokens: 3500, cacheWriteTokens: 0, outputTokens: 100, calls: 2, costUsd: 0 });
  close(cost.total.costUsd, 1000 * 10e-6 + 3500 * 1e-6 + 100 * 50e-6);
  assert.deepEqual(cost.models.map((model) => model.model), ["gpt-astra"]);
  close(cost.subagents.costUsd, 0, "Codex has no subagents");
});

test("a transcript that grows is read from where it was left, a line still being written waits", (t) => {
  const m = machine(t);
  m.bind("thread-1", "claudeAgent", { resume: "sess-1" });
  const path = join(m.claudeProject, "sess-1.jsonl");
  const second = claudeLine("b", "claude-fable", "2026-09-26T10:05:00Z", { input: 1, read: 0, write: 0, output: 20 });
  writeFileSync(path, claudeLine("a", "claude-fable", "2026-09-26T10:00:00Z", { input: 1, read: 0, write: 0, output: 10 }) + "\n" + second.slice(0, 40));
  const costs = m.costs();
  assert.equal(costs.cost(["thread-1"]).total.outputTokens, 10, "the half-written line is not counted");
  appendFileSync(path, second.slice(40) + "\n");
  assert.equal(costs.cost(["thread-1"]).total.outputTokens, 30);
  assert.equal(costs.cost(["thread-1"]).total.calls, 2, "reading again counts nothing twice");
  // A new subagent appears while the thread runs.
  mkdirSync(join(m.claudeProject, "sess-1", "subagents"), { recursive: true });
  writeFileSync(join(m.claudeProject, "sess-1", "subagents", "agent-y.jsonl"), claudeLine("c", "claude-opus", "2026-09-26T10:06:00Z", { input: 1, read: 0, write: 0, output: 5 }) + "\n");
  assert.equal(costs.cost(["thread-1"]).subagents.outputTokens, 5);
});

test("what a thread used between two moments, for a task's run", (t) => {
  const m = machine(t);
  m.bind("thread-1", "claudeAgent", { resume: "sess-1" });
  writeFileSync(
    join(m.claudeProject, "sess-1.jsonl"),
    ["10:00", "10:10", "10:20"].map((time, index) => claudeLine(String(index), "claude-fable", `2026-09-26T${time}:00Z`, { input: 0, read: 0, write: 0, output: 10 * (index + 1) })).join("\n") + "\n",
  );
  const between = m.costs().costBetween(["thread-1"], Date.parse("2026-09-26T10:05:00Z"), Date.parse("2026-09-26T10:20:00Z"));
  assert.equal(between.total.calls, 2);
  assert.equal(between.total.outputTokens, 50);
  assert.equal(m.costs().costBetween(["thread-1"], Date.parse("2026-09-26T11:00:00Z"), Date.parse("2026-09-26T12:00:00Z")).total.calls, 0);
});

test("no estimate is said with its reason, and a model without a price counts tokens only", (t) => {
  const m = machine(t);
  m.bind("thread-cursor", "cursor", { sessionId: "whatever" });
  m.bind("thread-lost", "claudeAgent", { resume: "sess-gone" });
  m.bind("thread-new", "claudeAgent", { resume: "sess-new" });
  writeFileSync(
    join(m.claudeProject, "sess-new.jsonl"),
    [claudeLine("a", "claude-next", "2026-09-26T10:00:00Z", { input: 10, read: 0, write: 0, output: 10 }), claudeLine("b", "claude-fable", "2026-09-26T10:01:00Z", { input: 0, read: 0, write: 0, output: 10 })].join("\n") + "\n",
  );
  const costs = m.costs();
  assert.deepEqual([costs.cost(["thread-cursor"]).available, costs.cost(["thread-cursor"]).reason, costs.cost(["thread-cursor"]).provider], [false, "unsupported_provider", "cursor"]);
  assert.deepEqual([costs.cost(["thread-lost"]).available, costs.cost(["thread-lost"]).reason], [false, "no_transcript"]);
  assert.deepEqual([costs.cost(["thread-unknown"]).available, costs.cost(["thread-unknown"]).reason], [false, "no_session"]);
  assert.deepEqual([costs.cost([]).available, costs.cost([]).reason], [false, "no_session"]);

  const partly = costs.cost(["thread-new"]);
  assert.equal(partly.priced, false, "one model has no price");
  assert.equal(partly.total.outputTokens, 20, "its tokens are counted");
  close(partly.total.costUsd, 10 * 50e-6, "only the priced model costs");
  assert.deepEqual(partly.models.map((model) => [model.model, model.priced]), [["claude-fable", true], ["claude-next", false]]);

  const missing = new ThreadCosts({ t3StateDb: join(m.root, "nowhere.sqlite"), ratesPath: join(m.root, "none.json"), claudeProjectsDir: m.claudeProject, codexSessionsDir: m.codexDay });
  assert.deepEqual([missing.cost(["thread-new"]).available, missing.cost(["thread-new"]).reason], [false, "unreadable"]);
  assert.equal(missing.pricesFetchedAt(), null);
});

test("a thread given a new session keeps what its earlier session used", (t) => {
  const m = machine(t);
  m.bind("thread-1", "claudeAgent", { resume: "sess-1" });
  writeFileSync(join(m.claudeProject, "sess-1.jsonl"), claudeLine("a", "claude-fable", "2026-09-26T10:00:00Z", { input: 0, read: 0, write: 0, output: 10 }) + "\n");
  writeFileSync(join(m.claudeProject, "sess-2.jsonl"), claudeLine("b", "claude-fable", "2026-09-26T12:00:00Z", { input: 0, read: 0, write: 0, output: 30 }) + "\n");
  const costs = m.costs();
  assert.equal(costs.cost(["thread-1"]).total.outputTokens, 10);
  m.bind("thread-1", "claudeAgent", { resume: "sess-2" });
  // T3's sessions are read again after ten seconds; a new reader stands for that here and shares what was remembered.
  assert.equal(m.costs().cost(["thread-1"]).total.outputTokens, 40);
});

test("the room's costs: per participant, per reply and for the room", async (t) => {
  const m = machine(t);
  const stack = await createTestStack({ autoCompleteMs: 1 }, ["sol1", "grok"]);
  t.after(() => stack.close());
  const sol = stack.threadOf("sol1");
  m.bind(sol, "claudeAgent", { resume: "sess-sol" });
  m.bind(stack.threadOf("grok"), "cursor", { sessionId: "x" });

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1 as string], instruction: "do it", schedule: { mode: "now" } });
  await stack.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await stack.tick(2);
  const reply = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "assistant.reply");
  assert.ok(reply, "the task was answered");
  const answered = Date.parse(reply.createdAt);
  const at = (ms: number) => new Date(ms).toISOString();
  writeFileSync(
    join(m.claudeProject, "sess-sol.jsonl"),
    [
      claudeLine("before", "claude-fable", "2020-01-01T00:00:00Z", { input: 0, read: 0, write: 0, output: 100 }), // long before the room: the first reply's
      claudeLine("turn", "claude-fable", at(answered - 1), { input: 0, read: 0, write: 0, output: 7 }),
      claudeLine("after", "claude-fable", at(answered + 1), { input: 0, read: 0, write: 0, output: 30 }), // the turn now in progress
    ].join("\n") + "\n",
  );
  mkdirSync(join(m.claudeProject, "sess-sol", "subagents"), { recursive: true });
  writeFileSync(join(m.claudeProject, "sess-sol", "subagents", "agent-z.jsonl"), claudeLine("sub", "claude-opus", at(answered - 1), { input: 0, read: 0, write: 0, output: 5 }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 10));

  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(m.root, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: m.userdata, CLAUDE_CONFIG_DIR: join(m.root, "claude"), CODEX_HOME: join(m.root, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const body = (await (await app.request(`/api/rooms/${stack.roomId}/costs`)).json()) as any;
  assert.equal(body.participants[stack.participants.sol1 as string].total.outputTokens, 142);
  assert.equal(body.participants[stack.participants.grok as string].reason, "unsupported_provider");
  assert.deepEqual(body.withoutEstimate, [stack.participants.grok]);
  assert.equal(body.room.total.outputTokens, 142);
  assert.equal(body.pricesFetchedAt, "2026-09-26T00:00:00.000Z");
  assert.equal(body.replies[reply.id].total.outputTokens, 112, "the turn that produced the reply, its subagent included, and everything before it");
  assert.equal(body.replies[reply.id].subagents.outputTokens, 5);
  assert.equal(body.openTurns[stack.participants.sol1 as string].total.outputTokens, 30, "used since the last reply: the turn in progress");
  assert.equal(body.openTurns[stack.participants.grok as string], undefined);
  assert.deepEqual(stack.repos.listThreadSessions(sol), [{ provider: "claudeAgent", sessionId: "sess-sol" }], "the session is remembered by the room");

  const direct = (await (await app.request(`/api/t3/threads/${sol}/cost`)).json()) as any;
  assert.equal(direct.cost.total.outputTokens, 142);
  assert.equal((await app.request("/api/rooms/nope/costs")).status, 404);
});

test("a thread's replies divide its spend between them", async (t) => {
  const m = machine(t);
  const stack = await createTestStack({ autoCompleteMs: 1 }, ["sol1"]);
  t.after(() => stack.close());
  m.bind(stack.threadOf("sol1"), "claudeAgent", { resume: "sess-sol" });
  for (const instruction of ["first", "second"]) {
    await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1 as string], instruction, schedule: { mode: "now" } });
    await stack.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stack.tick(2);
  }
  const [first, second] = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply");
  assert.ok(first && second, "two replies");
  const a = Date.parse(first.createdAt);
  const b = Date.parse(second.createdAt);
  assert.ok(b > a + 2, "the replies are apart in time");
  const at = (ms: number) => new Date(ms).toISOString();
  writeFileSync(
    join(m.claudeProject, "sess-sol.jsonl"),
    [
      claudeLine("a", "claude-fable", at(a - 1), { input: 0, read: 0, write: 0, output: 1 }),
      claudeLine("b", "claude-fable", at(a + 1), { input: 0, read: 0, write: 0, output: 2 }), // after the first reply: the second's turn
      claudeLine("c", "claude-fable", at(b), { input: 0, read: 0, write: 0, output: 4 }), // at the second reply's moment: the second's
      claudeLine("d", "claude-fable", at(b + 1), { input: 0, read: 0, write: 0, output: 8 }), // since the last reply: in progress
    ].join("\n") + "\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(m.root, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: m.userdata, CLAUDE_CONFIG_DIR: join(m.root, "claude"), CODEX_HOME: join(m.root, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const body = (await (await app.request(`/api/rooms/${stack.roomId}/costs`)).json()) as any;
  assert.equal(body.replies[first.id].total.outputTokens, 1);
  assert.equal(body.replies[second.id].total.outputTokens, 6);
  assert.equal(body.openTurns[stack.participants.sol1 as string].total.outputTokens, 8);
});

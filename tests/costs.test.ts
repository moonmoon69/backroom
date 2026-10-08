import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { journalView } from "../src/server/engineView.ts";
import { ThreadCosts } from "../src/usage/threadCosts.ts";
import { contextPhrase } from "../src/domain/contextMeter.ts";
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
  // T3's V2 database: each of a thread's provider threads names the harness's own conversation (its native id).
  const db = new DatabaseSync(join(userdata, "statev2.sqlite"));
  db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT)");
  const bind = (threadId: string, provider: string, sessionId: string) =>
    db
      .prepare("INSERT OR REPLACE INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, driver, payload_json) VALUES (?, ?, ?, ?)")
      .run(`provider-thread:${threadId}`, threadId, provider, JSON.stringify({ nativeThreadRef: { driver: provider, nativeId: sessionId, strength: "strong" } }));
  t.after(() => db.close());
  const past = new Map<string, Array<{ provider: string; sessionId: string }>>();
  const costs = () =>
    new ThreadCosts({
      t3StateDb: join(userdata, "statev2.sqlite"),
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
  m.bind("thread-1", "claudeAgent", "sess-1");
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
  m.bind("thread-2", "codex", session);
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
  m.bind("thread-1", "claudeAgent", "sess-1");
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

test("what a thread used between two moments, for a reply", (t) => {
  const m = machine(t);
  m.bind("thread-1", "claudeAgent", "sess-1");
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
  m.bind("thread-cursor", "cursor", "whatever");
  m.bind("thread-lost", "claudeAgent", "sess-gone");
  m.bind("thread-new", "claudeAgent", "sess-new");
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
  m.bind("thread-1", "claudeAgent", "sess-1");
  writeFileSync(join(m.claudeProject, "sess-1.jsonl"), claudeLine("a", "claude-fable", "2026-09-26T10:00:00Z", { input: 0, read: 0, write: 0, output: 10 }) + "\n");
  writeFileSync(join(m.claudeProject, "sess-2.jsonl"), claudeLine("b", "claude-fable", "2026-09-26T12:00:00Z", { input: 0, read: 0, write: 0, output: 30 }) + "\n");
  const costs = m.costs();
  assert.equal(costs.cost(["thread-1"]).total.outputTokens, 10);
  m.bind("thread-1", "claudeAgent", "sess-2");
  // T3's sessions are read again after ten seconds; a new reader stands for that here and shares what was remembered.
  assert.equal(m.costs().cost(["thread-1"]).total.outputTokens, 40);
});

test("the room's costs: per participant, per reply and for the room", async (t) => {
  const m = machine(t);
  const stack = await createTestStack({ autoCompleteMs: 1 }, ["sol1", "grok"]);
  t.after(() => stack.close());
  const sol = stack.threadOf("sol1");
  m.bind(sol, "claudeAgent", "sess-sol");
  m.bind(stack.threadOf("grok"), "cursor", "x");

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1 as string], instruction: "do it" }] });
  await stack.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await stack.tick(2);
  // The reply is the member's final on the journal; its moment is its T3 run's end.
  const [reply] = journalView({ p: stack.engine.view(stack.roomId) }).posts.filter((post) => post.output?.source === "final");
  assert.ok(reply, "the request was answered");
  const answered = Date.parse(stack.fake.threads.get(sol)!.runs[0]!.completedAt!);
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
  assert.equal(body.contexts[stack.participants.sol1 as string].available, true, "a Claude thread has a meter");
  assert.equal(body.contexts[stack.participants.grok as string].reason, "not_claude", "the others have none");
  assert.deepEqual(stack.repos.listThreadSessions(sol), [{ provider: "claudeAgent", sessionId: "sess-sol" }], "the session is remembered by the room");

  const direct = (await (await app.request(`/api/t3/threads/${sol}/cost`)).json()) as any;
  assert.equal(direct.cost.total.outputTokens, 142);
  assert.equal((await app.request("/api/rooms/nope/costs")).status, 404);
});

test("a thread on its own gets a room member's figures: the total, one per reply, and the turn in progress", async (t) => {
  const m = machine(t);
  const stack = await createTestStack();
  t.after(() => stack.close());
  const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "first", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" } })) as { threadId: string };
  m.bind(threadId, "claudeAgent", "sess-direct");
  stack.fake.completeRun(threadId, { text: "first answer" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await stack.run({ type: "thread.send", threadId, text: "second" });
  stack.fake.completeRun(threadId, { text: "second answer" });

  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(m.root, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: m.userdata, CLAUDE_CONFIG_DIR: join(m.root, "claude"), CODEX_HOME: join(m.root, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const view = (await (await app.request(`/api/threads/${threadId}`)).json()) as any;
  const replies = view.items.filter((item: { kind: string }) => item.kind === "reply") as Array<{ id: string; at: string }>;
  assert.equal(replies.length, 2);
  assert.deepEqual(view.usage, { lastCompaction: null, subagents: [], changedFiles: { count: 0, additions: 0, deletions: 0 }, contextReporting: true }, "the usage card's facts come with the view");
  const at = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString();
  writeFileSync(
    join(m.claudeProject, "sess-direct.jsonl"),
    [
      claudeLine("one", "claude-fable", at(replies[0]!.at, -1), { input: 0, read: 0, write: 0, output: 7 }),
      claudeLine("two", "claude-fable", at(replies[1]!.at, -1), { input: 0, read: 0, write: 0, output: 11 }),
      claudeLine("open", "claude-fable", at(replies[1]!.at, 1), { input: 0, read: 0, write: 0, output: 30 }),
    ].join("\n") + "\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const body = (await (await app.request(`/api/t3/threads/${threadId}/costs`)).json()) as any;
  assert.equal(body.total.total.outputTokens, 48);
  assert.equal(body.replies[replies[0]!.id].total.outputTokens, 7, "the first reply: everything before it");
  assert.equal(body.replies[replies[1]!.id].total.outputTokens, 11, "the second: since the first");
  assert.equal(body.openTurn.total.outputTokens, 30, "since the last reply: the turn in progress");
  assert.equal(body.pricesFetchedAt, "2026-09-26T00:00:00.000Z");
  assert.equal((await app.request("/api/t3/threads/nope/costs")).status, 404);
});

const boundary = (id: string, at: string, trigger: "auto" | "manual", pre: number, post: number) =>
  JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: at, uuid: `b-${id}`, compactMetadata: { trigger, preTokens: pre, postTokens: post } });

/** T3's manifest as it is shaped: a model names its profile; the profile has a window per contextWindow option, or a fixed one. */
const MANIFEST = {
  manifest: {
    providers: {
      claudeAgent: {
        models: [
          { slug: "claude-opus-5-5", aliases: ["opus-5.5"], profile: "opus-5-5" },
          { slug: "claude-opus-4-8", profile: "opus-4-8" },
        ],
        profiles: {
          "opus-5-5": {
            capabilities: { optionDescriptors: [{ id: "contextWindow", options: [{ id: "200k" }, { id: "1m", isDefault: true }] }] },
            adapter: { claudeCode: { contextWindowTokens: { "200k": 200000, "1m": 1000000 } } },
          },
          "opus-4-8": { adapter: { claudeCode: { fixedContextWindowTokens: 1000000 } } },
        },
      },
    },
  },
};

test("the context meter: the last call's context, the peak, the compactions, and near compaction from three quarters of the window", (t) => {
  const m = machine(t);
  writeFileSync(join(m.userdata, "model-manifest.json"), JSON.stringify(MANIFEST));
  m.bind("thread-c", "claudeAgent", "sess-c");
  m.bind("thread-x", "codex", "codex-x");
  const call = (id: string, at: string, read: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...JSON.parse(claudeLine(id, "claude-opus-5-5", at, { input: 10, read, write: 90, output: 5 })), ...extra });
  const path = join(m.claudeProject, "sess-c.jsonl");
  writeFileSync(
    path,
    [
      call("a", "2026-09-26T10:00:00Z", 899_900),
      boundary("1", "2026-09-26T10:01:00Z", "auto", 950_000, 20_000),
      call("b", "2026-09-26T10:02:00Z", 120_000),
      // A side chain is a subagent's call, and a message that only mentions a boundary is not one.
      call("c", "2026-09-26T10:03:00Z", 990_000, { isSidechain: true }),
      JSON.stringify({ type: "user", timestamp: "2026-09-26T10:03:30Z", message: { role: "user", content: 'look for "compact_boundary" in the log' } }),
      boundary("2", "2026-09-26T10:04:00Z", "manual", 130_000, 8_000),
      call("d", "2026-09-26T10:05:00Z", 400_000),
    ].join("\n") + "\n",
  );
  const costs = new ThreadCosts({
    t3StateDb: join(m.userdata, "statev2.sqlite"),
    ratesPath: join(m.userdata, "usage-model-rates.json"),
    claudeProjectsDir: join(m.root, "claude", "projects"),
    codexSessionsDir: join(m.root, "codex", "sessions"),
    modelManifestPath: join(m.userdata, "model-manifest.json"),
  });
  const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "contextWindow", value: "1m" }] };
  const meter = costs.context(["thread-c"], opus);
  assert.equal(meter.available, true);
  assert.equal(meter.tokens, 400_100, "the last own call: input, cache read and cache write");
  assert.equal(meter.peak, 950_000, "the largest context, here the one the first compaction started from");
  assert.equal(meter.compactions, 2);
  assert.equal(meter.lastCompactionAt, "2026-09-26T10:04:00.000Z");
  assert.deepEqual([meter.window, meter.windowSource], [1_000_000, "manifest"]);
  assert.equal(meter.nearCompaction, false);
  assert.equal(contextPhrase(meter), "context ≈ 400k, 2 compactions");

  // Seated with the 200k window, the same thread is past three quarters of it.
  const small = costs.context(["thread-c"], { ...opus, options: [{ id: "contextWindow", value: "200k" }] });
  assert.deepEqual([small.window, small.nearCompaction], [200_000, true]);
  assert.equal(contextPhrase(small), "context ≈ 400k (near compaction), 2 compactions");
  assert.equal(costs.contextWindow({ instanceId: "claudeAgent", model: "claude-opus-4-8" })?.tokens, 1_000_000, "a fixed window");
  assert.deepEqual(costs.contextWindow({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" }), { tokens: 200_000, source: "table" }, "a model the manifest does not list");
  assert.deepEqual(costs.contextWindow({ instanceId: "claudeAgent", model: "claude-fable-5-1" }), { tokens: 1_000_000, source: "table" });

  // A compaction after the last call: the context is what it left.
  appendFileSync(path, boundary("3", "2026-09-26T10:06:00Z", "auto", 800_000, 15_000) + "\n");
  const after = costs.context(["thread-c"], opus);
  assert.deepEqual([after.tokens, after.compactions, after.at], [15_000, 3, "2026-09-26T10:06:00.000Z"]);

  // Only Claude threads have a meter; one T3 has no session for yet goes by the provider it is seated on.
  assert.equal(contextPhrase(costs.context(["thread-x"], null)), "no meter");
  assert.equal(costs.context(["thread-new"], { instanceId: "codex", model: "gpt-6-sol" }).reason, "not_claude");
  assert.equal(contextPhrase(costs.context(["thread-new"], opus)), "context unknown", "a Claude seat whose transcript is not there yet is not guessed");
});

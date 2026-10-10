#!/usr/bin/env node
/**
 * Live adapter contract check against a real T3 Code server (Orchestrator V2, orchestration protocol 2).
 *
 *   npm run t3:check                 read-only: descriptor and protocol, auth policy, projects, catalog, threads
 *   npm run t3:check -- --write --project <projectId> [--model instanceId/model]
 *                                    also launches one thread, sends one short message, follows its run to the end
 *                                    by the message id, reads the reply, queues a message behind a running run,
 *                                    steers one into it (and waits for the agent to work after it, which is
 *                                    when Backroom confirms such a message in the run), and interrupts a run.
 *
 * Exit code 0 when every executed check passed. Nothing is deleted; created threads are titled "Backroom contract check".
 */
import { randomUUID } from "node:crypto";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { ORCHESTRATION_PROTOCOL_VERSION, isRunActive, runForMessage, runReplies } from "../src/adapter/types.ts";
import { loadConfig } from "../src/config.ts";
import { takenInRun } from "../src/runtime/steer.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};
const write = args.includes("--write");
const projectArg = flag("--project");
const modelArg = flag("--model");

const config = loadConfig();
const stored = readStoredAuth(config.dataDir);
const baseUrl = config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773";
const adapter = new HttpT3Adapter({ baseUrl, accessToken: config.t3AccessToken ?? stored?.accessToken ?? null, userDataDir: config.t3UserDataDir });

let failures = 0;
const ok = (name: string, detail = "") => console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
const fail = (name: string, detail: string) => {
  failures += 1;
  console.log(`FAIL ${name}: ${detail}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`T3 base URL: ${baseUrl}`);
console.log(`credentials: ${adapter.hasCredentials ? "present" : "missing"}`);

try {
  const environment = await adapter.describe();
  ok("descriptor", `${environment.label} ${environment.serverVersion} (${environment.environmentId})`);
  if (environment.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) ok("protocol", `orchestration protocol ${environment.orchestrationProtocolVersion}`);
  else fail("protocol", `the server speaks orchestration protocol ${environment.orchestrationProtocolVersion ?? 1}; Backroom needs ${ORCHESTRATION_PROTOCOL_VERSION} (T3 Code 0.0.46 or newer)`);
} catch (error) {
  fail("descriptor", (error as Error).message);
}

let policy: string | null = null;
try {
  const session = await adapter.authSession();
  policy = session.policy;
  ok("auth session", `authenticated=${session.authenticated} policy=${session.policy} bootstrap=${session.bootstrapMethods.join(",")}`);
  if (!session.authenticated) {
    if (!session.bootstrapMethods.includes("one-time-token")) {
      console.log(
        "NOTE this server does not offer one-time-token pairing. For the Desktop app: Settings → Connections → enable Network access, " +
          "then create a pairing link. Or run `t3 serve` / `t3 service install` and `t3 pair`.",
      );
    } else {
      console.log("NOTE not paired yet. Create a pairing link and run: npm run t3:pair -- <url>");
    }
  }
} catch (error) {
  fail("auth session", (error as Error).message);
}

if (!adapter.hasCredentials) {
  console.log(`\n${failures === 0 ? "read-only checks passed" : "checks failed"}; authenticated checks skipped (policy ${policy ?? "unknown"})`);
  process.exit(failures === 0 ? 0 : 1);
}

let projects: Awaited<ReturnType<typeof adapter.listProjects>> = [];
try {
  projects = await adapter.listProjects();
  ok("projects", projects.map((p) => `${p.title} (${p.id})`).join("; ") || "none");
} catch (error) {
  fail("projects", (error as Error).message);
}

try {
  const home = await adapter.browseFolders("~/");
  ok("folders", `filesystem.browse lists ${home.entries.length} folders under ${home.parentPath} (the New project dialog's picker)`);
} catch (error) {
  fail("folders", (error as Error).message);
}

try {
  const catalog = await adapter.listCatalog();
  ok("catalog", `${catalog.length} entries, e.g. ${catalog.slice(0, 3).map((c) => c.label).join(", ")}`);
} catch (error) {
  fail("catalog", (error as Error).message);
}

try {
  const threads = await adapter.listThreads();
  const longest = threads.length > 0 ? threads[0] : null;
  ok("threads", `${threads.length} threads visible`);
  if (longest) {
    const detail = await adapter.getThreadDetail(longest.id, { bounded: true });
    const maxLength = Math.max(0, ...(detail?.messages.map((m) => m.text.length) ?? [0]));
    ok("thread detail", `${detail?.runs.length ?? 0} runs, ${detail?.messages.length ?? 0} messages in the recent window; longest ${maxLength} chars (no client-side cap)`);
    const archived = await adapter.listArchivedThreads();
    ok("archived threads", `${archived.length} listed apart`);
  }
} catch (error) {
  fail("thread detail", (error as Error).message);
}

if (!write) {
  console.log(`\n${failures === 0 ? "read-only checks passed" : "checks failed"}; pass --write --project <id> to exercise a turn`);
  process.exit(failures === 0 ? 0 : 1);
}

const project = projects.find((p) => p.id === projectArg) ?? null;
if (!project) {
  fail("write checks", `--project must name one of: ${projects.map((p) => p.id).join(", ")}`);
  process.exit(1);
}
let modelSelection = project.defaultModelSelection;
if (modelArg) {
  const [instanceId, model] = modelArg.split("/");
  if (instanceId && model) modelSelection = { instanceId, model };
}
if (!modelSelection) {
  const catalog = await adapter.listCatalog();
  const first = catalog[0];
  if (first) modelSelection = { instanceId: first.instanceId, model: first.model };
}
if (!modelSelection) {
  fail("write checks", "no model selection available; pass --model instanceId/model");
  process.exit(1);
}
console.log(`using model ${modelSelection.instanceId}/${modelSelection.model} in project ${project.title}`);

const threadId = randomUUID();
const prompt = (text: string) => `This is an automated contract check from Backroom. ${text} Do not run tools.`;
const finished = async (messageId: string, limitMs: number): Promise<{ status: string; reply: string; runId: string } | null> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < limitMs) {
    await sleep(1000);
    const detail = await adapter.getThreadDetail(threadId, { bounded: true });
    const run = detail ? runForMessage(detail, messageId) : null;
    if (detail && run && !isRunActive(run.status)) return { status: run.status, reply: runReplies(detail, run.id).map((m) => m.text).join("\n"), runId: run.id };
  }
  return null;
};

const firstMessage = randomUUID();
try {
  const shell = await adapter.launchThread({
    commandId: randomUUID(),
    threadId,
    projectId: project.id,
    title: "Backroom contract check",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspace: { type: "root" },
    initialMessage: { messageId: firstMessage, text: prompt("Reply with exactly: CONTRACT-CHECK-OK.") },
  });
  const listed = await adapter.getThreadShell(threadId);
  if (listed) ok("orchestration.launchThread", `thread ${threadId} listed; status ${shell.status}`);
  else fail("orchestration.launchThread", "thread not listed after launch");
} catch (error) {
  fail("orchestration.launchThread", (error as Error).message);
  process.exit(1);
}

{
  const detail = await adapter.getThreadDetail(threadId, { bounded: true });
  const run = detail ? runForMessage(detail, firstMessage) : null;
  if (run) ok("run by message id", `message ${firstMessage} → ${run.id} (${run.status})`);
  else fail("run by message id", "T3 lists no run for the launch message");
  const first = await finished(firstMessage, 180_000);
  if (!first) fail("run completion", "the run did not end within 3 minutes (is the provider signed in?)");
  else if (first.status === "completed") ok("run completion", `status=${first.status}; reply ${JSON.stringify(first.reply.slice(0, 80))}`);
  else fail("run completion", `status=${first.status}`);
  const after = await adapter.getThreadDetail(threadId, { bounded: true });
  const checkpoint = after?.checkpoints.find((c) => c.runId === first?.runId);
  if (checkpoint) ok("checkpoint", `status=${checkpoint.status} files=${checkpoint.files.length}`);
  const usage = after?.providerTurns.at(-1)?.tokenUsage;
  if (usage) ok("context reading", `${usage.usedTokens} of ${usage.maxTokens ?? "?"} tokens`);
  const session = after?.providerThreads.at(-1)?.nativeId;
  if (session) ok("harness session", `native id ${session} (what the cost reader looks up)`);
}

// A resend with the same command id must not start a second run (T3 keeps a receipt per command).
try {
  const messageId = randomUUID();
  const commandId = randomUUID();
  const message = { commandId, threadId, messageId, text: prompt("Reply with exactly: SECOND-OK."), modelSelection, mode: { type: "start" } as const };
  await adapter.sendMessage(message);
  await adapter.sendMessage(message);
  const second = await finished(messageId, 180_000);
  const detail = await adapter.getThreadDetail(threadId, { bounded: true });
  const copies = detail?.messages.filter((m) => m.id === messageId).length ?? 0;
  if (copies === 1 && second?.status === "completed") ok("message.dispatch (identical resend)", "one message, one run");
  else fail("message.dispatch (identical resend)", `${copies} copies of the message; run ${second?.status ?? "not finished"}`);
} catch (error) {
  fail("message.dispatch", (error as Error).message);
}

// While a run is going: a queued message gets its own run after it, a steered message joins it, and it can be interrupted.
try {
  const longMessage = randomUUID();
  await adapter.sendMessage({ commandId: randomUUID(), threadId, messageId: longMessage, text: prompt("Count slowly from 1 to 300, one number per line."), modelSelection, mode: { type: "start" } });
  let running: string | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !running) {
    await sleep(300);
    const shell = await adapter.getThreadShell(threadId);
    if (shell?.status === "running" && shell.activeRunId) running = shell.activeRunId;
  }
  if (!running) throw new Error("the long run never started");
  const queuedMessage = randomUUID();
  await adapter.sendMessage({ commandId: randomUUID(), threadId, messageId: queuedMessage, text: prompt("Reply with exactly: QUEUED-OK."), modelSelection, mode: { type: "queue" } });
  const steeredMessage = randomUUID();
  await adapter.sendMessage({ commandId: randomUUID(), threadId, messageId: steeredMessage, text: "Stop counting at 20.", modelSelection, mode: { type: "steer", runId: running } });
  const during = await adapter.getThreadDetail(threadId, { bounded: true });
  const queuedRun = during ? runForMessage(during, queuedMessage) : null;
  const steeredRun = during ? runForMessage(during, steeredMessage) : null;
  if (queuedRun && queuedRun.id !== running) ok("queue", `a queued message has its own run (${queuedRun.status}${queuedRun.queuePosition ? `, position ${queuedRun.queuePosition}` : ""})`);
  else fail("queue", `queued message → ${queuedRun?.id ?? "no run"}`);
  if (steeredRun?.id === running) ok("steer", "a steered message joined the running run");
  else fail("steer", `steered message → ${steeredRun?.id ?? "no run"}; expected ${running}`);
  // M1: Backroom confirms a message in the run it was sent into once T3 shows the agent working after it there.
  let taken: ReturnType<typeof takenInRun> = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000 && !taken) {
    await sleep(500);
    const detail = await adapter.getThreadDetail(threadId);
    taken = detail ? takenInRun(detail, steeredMessage, running) : null;
  }
  if (taken) ok("steer taken", `the agent worked after the message in the running run (intent ${taken.inputIntent}, after ${Math.round((Date.now() - t1) / 1000)} s): Backroom confirms it there`);
  else fail("steer taken", "T3 showed no work after the steered message in the running run within 60 s: Backroom would not confirm it");
  await adapter.interruptRun({ commandId: randomUUID(), threadId, runId: running });
  const long = await finished(longMessage, 60_000);
  if (long?.status === "interrupted") ok("run.interrupt", "observed status=interrupted");
  else if (long) ok("run.interrupt", `the run ended before the interrupt took effect (status=${long.status}); recorded as observed, not as interrupted`);
  else fail("run.interrupt", "no terminal status observed within 60s");
  const queued = await finished(queuedMessage, 180_000);
  if (queued?.status === "completed") ok("queue drains", `the queued run ran after it; reply ${JSON.stringify(queued.reply.slice(0, 40))}`);
  else fail("queue drains", `queued run ${queued?.status ?? "did not finish"} (T3 holds a queue after an interrupt until it is resumed, when asked to)`);
} catch (error) {
  fail("queue, steer and interrupt", (error as Error).message);
}

adapter.close();
console.log(`\ncreated thread ${threadId} ("Backroom contract check") in project ${project.title}; delete it in T3 if you do not want to keep it.`);
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

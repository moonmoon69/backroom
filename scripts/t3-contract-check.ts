#!/usr/bin/env node
/**
 * Live adapter contract check against a real T3 Code server (PRD section 12 spike items 1–3).
 *
 *   npm run t3:check                 read-only: descriptor, auth policy, projects, catalog, threads
 *   npm run t3:check -- --write --project <projectId> [--model instanceId/model]
 *                                    also creates one thread, sends one short turn, waits for the correlated
 *                                    completion, reads the reply, and requests an interrupt on a second turn.
 *
 * Exit code 0 when every executed check passed. Nothing is deleted; created threads are titled "T3 Rooms contract check".
 */
import { randomUUID } from "node:crypto";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { resolveTurnForMessage } from "../src/adapter/correlate.ts";
import { T3Unavailable } from "../src/adapter/types.ts";
import { loadConfig } from "../src/config.ts";

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
    const detail = await adapter.getThreadDetail(longest.id, { turnLimit: 2 });
    const maxLength = Math.max(0, ...(detail?.messages.map((m) => m.text.length) ?? [0]));
    ok("thread detail", `${detail?.messages.length ?? 0} messages in the last 2 turns; longest ${maxLength} chars (no client-side cap)`);
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
try {
  await adapter.createThread({
    commandId: randomUUID(),
    threadId,
    projectId: project.id,
    title: "T3 Rooms contract check",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  const shell = await adapter.getThreadShell(threadId);
  if (shell) ok("thread.create", `thread ${threadId} visible in shell snapshot`);
  else fail("thread.create", "thread not visible after creation");
} catch (error) {
  fail("thread.create", (error as Error).message);
  process.exit(1);
}

const messageId = randomUUID();
const commandId = randomUUID();
try {
  await adapter.startTurn({
    commandId,
    threadId,
    messageId,
    text: "This is an automated contract check from T3 Rooms. Reply with exactly: CONTRACT-CHECK-OK. Do not run tools.",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    titleSeed: "T3 Rooms contract check",
  });
  ok("thread.turn.start", "accepted");
  // Idempotency: an identical resend must not create a second prompt.
  await adapter.startTurn({ commandId, threadId, messageId, text: "IGNORED DUPLICATE", modelSelection, runtimeMode: "approval-required", interactionMode: "default" });
  ok("thread.turn.start (identical resend)", "accepted without error");
} catch (error) {
  fail("thread.turn.start", (error as Error).message);
}

let turnId: string | null = null;
const startedAt = Date.now();
while (Date.now() - startedAt < 180_000) {
  await sleep(1500);
  const detail = await adapter.getThreadDetail(threadId, { turnLimit: 3 });
  if (!detail) continue;
  const userMessages = detail.messages.filter((m) => m.role === "user");
  if (userMessages.length > 1) fail("idempotent resend", `${userMessages.length} user messages exist; expected 1`);
  const resolution = resolveTurnForMessage(detail, messageId);
  if ((resolution.kind === "active" || resolution.kind === "resolved") && !turnId) {
    turnId = resolution.turnId;
    ok("turn correlation", `message ${messageId} → turn ${turnId} (${resolution.kind})`);
  }
  if (turnId && detail.shell.latestTurn?.turnId === turnId && detail.shell.latestTurn.state !== "running") {
    const reply = detail.messages.filter((m) => m.turnId === turnId && m.role === "assistant" && !m.streaming).map((m) => m.text).join("\n");
    const state = detail.shell.latestTurn.state;
    if (state === "completed") ok("turn completion", `state=${state}; reply ${JSON.stringify(reply.slice(0, 80))}`);
    else fail("turn completion", `state=${state} lastError=${detail.shell.session?.lastError ?? "none"}`);
    const checkpoint = detail.checkpoints.find((c) => c.turnId === turnId);
    if (checkpoint) ok("checkpoint", `status=${checkpoint.status} files=${checkpoint.files.length}`);
    break;
  }
}
if (!turnId) fail("turn correlation", "the user message never received a turn id within 3 minutes (is the provider signed in?)");

// Interrupt check on a second turn.
try {
  const secondMessage = randomUUID();
  await adapter.startTurn({
    commandId: randomUUID(),
    threadId,
    messageId: secondMessage,
    text: "Count slowly from 1 to 200, one number per line. Do not run tools.",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  let secondTurn: string | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !secondTurn) {
    await sleep(250);
    const detail = await adapter.getThreadDetail(threadId, { turnLimit: 2 });
    const second = detail ? resolveTurnForMessage(detail, secondMessage) : null;
    if (second && (second.kind === "active" || second.kind === "resolved")) secondTurn = second.turnId;
  }
  if (!secondTurn) throw new Error("second turn never started");
  await adapter.interruptTurn({ commandId: randomUUID(), threadId, turnId: secondTurn });
  let observed: string | null = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000 && !observed) {
    await sleep(1000);
    const shell = await adapter.getThreadShell(threadId);
    if (shell?.latestTurn?.turnId === secondTurn && shell.latestTurn.state !== "running") observed = shell.latestTurn.state;
  }
  if (observed === "interrupted") ok("thread.turn.interrupt", "observed state=interrupted");
  else if (observed) ok("thread.turn.interrupt", `turn finished before the interrupt took effect (state=${observed}); recorded as observed, not as interrupted`);
  else fail("thread.turn.interrupt", "no terminal state observed within 60s");
} catch (error) {
  fail("thread.turn.interrupt", (error as Error).message);
}

console.log(`\ncreated thread ${threadId} ("T3 Rooms contract check") in project ${project.title}; delete it in T3 if you do not want to keep it.`);
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

// Keep the T3Unavailable import referenced for clearer stack traces in --write mode.
void T3Unavailable;

#!/usr/bin/env node
/**
 * Live check of mid-turn delivery (steering) against a real T3 server. Creates one thread per model titled
 * "T3 Rooms steer check", starts a long turn, sends a second message while it runs, and reports whether T3
 * kept one turn (same turn id for both messages) and whether the final answer honoured the second message.
 *
 *   node scripts/t3-steer-check.ts --project <projectId> --model instance/model [--model instance/model ...]
 * Nothing is deleted.
 */
import { randomUUID } from "node:crypto";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { resolveTurnForMessage } from "../src/adapter/correlate.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { loadConfig } from "../src/config.ts";

const args = process.argv.slice(2);
const projectId = args[args.indexOf("--project") + 1];
const models = args.flatMap((arg, index) => (arg === "--model" ? [args[index + 1] as string] : []));
if (!projectId || models.length === 0) throw new Error("usage: --project <id> --model instance/model");
const config = loadConfig();
const stored = readStoredAuth(config.dataDir);
const adapter = new HttpT3Adapter({
  baseUrl: config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773",
  accessToken: config.t3AccessToken ?? stored?.accessToken ?? null,
  userDataDir: config.t3UserDataDir,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const spec of models) {
  const [instanceId, model] = spec.split("/") as [string, string];
  const threadId = randomUUID();
  await adapter.createThread({ commandId: randomUUID(), threadId, projectId, title: "T3 Rooms steer check", modelSelection: { instanceId, model }, runtimeMode: "approval-required", interactionMode: "default" });
  const first = randomUUID();
  await adapter.startTurn({
    commandId: randomUUID(), threadId, messageId: first, runtimeMode: "approval-required", interactionMode: "default",
    text: "Without using any tools, write a numbered list of 30 short facts about the ocean, one per line.",
  });
  // Wait until the first turn is running and has produced some output, then steer.
  let firstTurn: string | null = null;
  for (let i = 0; i < 60 && !firstTurn; i += 1) {
    await sleep(1000);
    const detail = await adapter.getThreadDetail(threadId, { turnLimit: 4 });
    const resolution = detail ? resolveTurnForMessage(detail, first) : null;
    if (resolution && (resolution.kind === "active" || resolution.kind === "resolved")) firstTurn = resolution.turnId;
    if (resolution?.kind === "resolved") break;
  }
  const shellBefore = await adapter.getThreadShell(threadId);
  const stillRunning = shellBefore?.session?.status === "running";
  const second = randomUUID();
  await adapter.startTurn({
    commandId: randomUUID(), threadId, messageId: second, runtimeMode: "approval-required", interactionMode: "default",
    text: "Also: after the list, end your answer with the single word BANANA on its own line.",
  });
  // Wait for everything to finish.
  let secondTurn: string | null = null;
  let finalText = "";
  let turnsSeen = new Set<string>();
  for (let i = 0; i < 180; i += 1) {
    await sleep(1000);
    const detail = await adapter.getThreadDetail(threadId, { turnLimit: 6 });
    if (!detail) continue;
    const resolution = resolveTurnForMessage(detail, second);
    if (resolution.kind === "active" || resolution.kind === "resolved") secondTurn = resolution.turnId;
    const idle = detail.shell.session?.status !== "running" && detail.shell.session?.status !== "starting";
    if (idle && secondTurn && detail.shell.latestTurn?.state !== "running") {
      const assistant = detail.messages.filter((m) => m.role === "assistant" && m.text.trim());
      finalText = assistant[assistant.length - 1]?.text ?? "";
      turnsSeen = new Set(detail.messages.filter((m) => m.role === "assistant").map((m) => m.turnId ?? "?"));
      break;
    }
  }
  console.log(
    JSON.stringify({
      model: spec,
      threadId,
      steeredWhileRunning: stillRunning,
      firstTurn: firstTurn?.slice(0, 8),
      secondTurn: secondTurn?.slice(0, 8),
      sameTurn: firstTurn !== null && firstTurn === secondTurn,
      assistantTurns: turnsSeen.size,
      finalEndsWithBanana: /BANANA\s*$/.test(finalText.trim()),
    }),
  );
}

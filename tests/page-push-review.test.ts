import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { T3Unavailable } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { createHttpApp } from "../src/server/http.ts";
import { connectionProblem } from "../web/src/t3Connection.ts";
import type { StatusResponse } from "../web/src/types.ts";

async function reviewStack(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-push-review-"));
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, changes: { shellMs: 60_000, headsMs: 60_000 } });
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: dir, T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  t.after(() => { stack.close(); rmSync(dir, { recursive: true, force: true }); });
  const command = (input: RoomCommandInput) => stack.service.execute(parseCommand(input));
  const { roomId } = await command({ type: "room.create", projectId: "project_demo", title: "push review" }) as { roomId: string };
  return { fake, stack, app, command, roomId };
}

test("review B: a shell event invalidates the room and overview shell memo before their pushed re-read", async (t) => {
  const s = await reviewStack(t);
  const created = await s.command({ type: "participant.create", roomId: s.roomId, alias: "worker", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } }) as { participantId: string };
  const threadId = s.stack.repos.currentBinding(created.participantId)!.threadId;
  s.fake.startExternalRun(threadId, "work typed in T3");
  const events: string[] = [];
  const stop = s.stack.changes.subscribe((event) => events.push(event.type));
  t.after(stop);
  await s.stack.changes.check();
  const overview = async () => await (await s.app.request("/api/overview")).json() as { rooms: Array<{ id: string; members: Array<{ status: { status: string } }> }> };
  const warm = await overview();
  assert.equal(warm.rooms.find(r => r.id === s.roomId)!.members[0]!.status.status, "running");
  s.fake.completeRun(threadId, { text: "Report: work is complete." });
  const before = events.length;
  await s.stack.changes.check();
  assert.ok(events.slice(before).includes("shell"), "the page is told to re-read now");
  const next = await overview();
  assert.equal(next.rooms.find(r => r.id === s.roomId)!.members[0]!.status.status, "completed", "a refresh caused by shell must not reuse the pre-event running shell for 1 s (no later event repairs it)");
  const snapshot = await (await s.app.request(`/api/rooms/${s.roomId}`)).json() as { participantStatus: Record<string, { status: string }> };
  assert.equal(snapshot.participantStatus[created.participantId]!.status, "completed");
});

test("review B: a pushed shell outage keeps the T3 chip in error even while the descriptor answers", async (t) => {
  const s = await reviewStack(t);
  await s.stack.changes.check();
  s.fake.listProjects = async () => { throw new T3Unavailable("orchestration shell unavailable; descriptor still answers"); };
  s.fake.listThreads = async () => { throw new T3Unavailable("orchestration shell unavailable; descriptor still answers"); };
  await s.stack.changes.check();
  assert.equal(s.stack.changes.status()!.up, false, "the pushed status says T3 is down");
  const status = await (await s.app.request("/api/status")).json() as StatusResponse;
  assert.equal(connectionProblem(status.t3).tone, "err", "the page's status re-read must not restore a green chip while the pushed shell status is down");
});

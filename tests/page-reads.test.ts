/**
 * What the page pulls over a slow link (#354): the service's answers are gzipped where they compress and the event
 * stream is not, the hashed assets are kept by the browser, and the overview's shelf reads a few fields of its threads
 * instead of T3's whole thread list.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

async function served(t: TestContext, webDist = "/nonexistent/dist") {
  const stack = await createTestStack();
  const dir = mkdtempSync(join(tmpdir(), "backroom-page-reads-"));
  t.after(() => {
    stack.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3") }), webDist);
  return { stack, app, dir };
}

const gzip = { "accept-encoding": "gzip, deflate, br" };

test("a JSON answer is gzipped for a client that takes it, and inflates to the same JSON; plain for one that does not", async (t) => {
  const { stack, app } = await served(t);
  const path = `/api/rooms/${stack.roomId}`;
  const plain = await app.request(path);
  assert.equal(plain.headers.get("content-encoding"), null, "no Accept-Encoding: plain");
  const json = await plain.text();
  assert.ok(json.length > 1024, `the snapshot is over the 1 KB threshold (${json.length} B)`);
  const zipped = await app.request(path, { headers: gzip });
  assert.equal(zipped.headers.get("content-encoding"), "gzip");
  assert.match(zipped.headers.get("vary") ?? "", /accept-encoding/i);
  const body = Buffer.from(await zipped.arrayBuffer());
  assert.ok(body.length < json.length, `smaller on the wire (${body.length} B against ${json.length} B)`);
  assert.deepEqual(JSON.parse(gunzipSync(body).toString("utf8")), JSON.parse(json));
});

test("GET /api/events is never compressed and its first event comes at once", async (t) => {
  const { app } = await served(t);
  const response = await app.request("/api/events", { headers: gzip });
  assert.equal(response.headers.get("content-encoding"), null);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  // A compressed stream holds its bytes until enough have come: the retry hint would not arrive on its own.
  const first = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
  assert.ok(first && !first.done, "a first chunk within a second");
  assert.match(new TextDecoder().decode(first.value), /^retry: 3000/);
});

test("a binary file is not compressed", async (t) => {
  const { app, dir } = await served(t);
  const png = join(dir, "shot.png");
  // A PNG's signature, then bytes that would compress well if anything tried.
  writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096)]));
  const response = await app.request(`/api/local-file?path=${encodeURIComponent(png)}`, { headers: gzip });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal((await response.arrayBuffer()).byteLength, 4096 + 8);
});

test("a hashed asset is cached for a year as immutable, gzipped; index.html is never stored", async (t) => {
  const dist = mkdtempSync(join(tmpdir(), "backroom-page-reads-dist-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), `<!doctype html><script src="/assets/index-abc123.js"></script>${"<!-- shell -->".repeat(100)}`);
  writeFileSync(join(dist, "assets", "index-abc123.js"), `console.log(${JSON.stringify("x".repeat(4000))});`);
  const { app } = await served(t, dist);
  const asset = await app.request("/assets/index-abc123.js", { headers: gzip });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("content-encoding"), "gzip");
  const shell = await app.request("/", { headers: gzip });
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.match(gunzipSync(Buffer.from(await shell.arrayBuffer())).toString("utf8"), /index-abc123\.js/);
});

test("the shelf query answers the settled and archived threads outside rooms, with a few fields each; the overview counts them", async (t) => {
  const { stack, app } = await served(t);
  const start = async (text: string) => ((await stack.run({ type: "thread.start", projectId: "project_demo", text })) as { threadId: string }).threadId;
  const settled = await start("settle me");
  const archived = await start("archive me");
  const active = await start("keep me");
  await stack.run({ type: "thread.lifecycle", threadId: settled, action: "settle" });
  await stack.run({ type: "thread.lifecycle", threadId: archived, action: "archive" });
  // A settled thread then seated in a room is the room's, not the shelf's.
  const seated = await start("seat me");
  await stack.run({ type: "thread.lifecycle", threadId: seated, action: "settle" });
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "seated", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "attach", threadId: seated } });
  assert.ok((await stack.adapter.listThreads()).find((thread) => thread.id === seated)?.settledAt, "still settled in T3 once seated");

  const shelf = (await (await app.request("/api/t3/threads?shelf=1&projectId=project_demo")).json()) as Array<Record<string, unknown>>;
  assert.deepEqual(shelf.map((row) => row.id).sort(), [settled, archived].sort(), "the settled and the archived loose threads, no active or seated one");
  for (const row of shelf) assert.deepEqual(Object.keys(row).sort(), ["archivedAt", "id", "model", "projectId", "settledAt", "title", "updatedAt"]);
  assert.ok(shelf.find((row) => row.id === archived)?.archivedAt);
  assert.ok(shelf.find((row) => row.id === settled)?.settledAt);
  assert.deepEqual(await (await app.request("/api/t3/threads?shelf=1&projectId=elsewhere")).json(), []);

  const overview = (await (await app.request("/api/overview")).json()) as { threads: Array<{ id: string }>; shelf: Array<{ projectId: string; settled: number; archived: number | null }> };
  assert.deepEqual(overview.shelf.find((count) => count.projectId === "project_demo"), { projectId: "project_demo", settled: 1, archived: 1 });
  assert.deepEqual(overview.threads.map((thread) => thread.id), [active], "the overview's threads are the active loose ones");
  // The pickers' list is unchanged: T3's active threads in full, without the shelf's.
  const full = (await (await app.request("/api/t3/threads?projectId=project_demo")).json()) as Array<{ id: string; boundToRoom: boolean; modelSelection: unknown }>;
  assert.ok(full.some((thread) => thread.id === active && thread.modelSelection));
  assert.ok(!full.some((thread) => thread.id === archived));
});

test("the overview lists every loose thread, beyond the forty it reads a line for", async (t) => {
  const { stack, app } = await served(t);
  const started = new Set<string>();
  for (let i = 0; i < 42; i += 1) {
    const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: `thread ${i}` })) as { threadId: string };
    stack.fake.completeRun(threadId, { text: `done ${i}` });
    started.add(threadId);
  }
  const overview = (await (await app.request("/api/overview")).json()) as { threads: Array<{ id: string; line: string | null }> };
  const listed = overview.threads.filter((thread) => started.has(thread.id));
  assert.equal(listed.length, 42);
  assert.equal(listed.filter((thread) => thread.line !== null).length, 40, "a line read for forty, each a read of the thread from T3");
});

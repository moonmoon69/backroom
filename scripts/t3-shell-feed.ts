#!/usr/bin/env node
/**
 * Read-only check of T3's shell streams against a real T3 Code server (`npm run t3:feed`), the source of the shell
 * feed (src/adapter/shellFeed.ts). It dispatches nothing: it asks for WebSocket tickets, subscribes, and reads.
 *
 *   1. The wire: subscribes to orchestration.subscribeShell and subscribeArchivedShell on a socket of its own and
 *      prints the frames T3 sends for `--seconds` (default 6), acknowledging each chunk, then interrupts both.
 *   2. The adapter: starts the adapter's feed, and once it is live compares its shell reads (projects, threads,
 *      archived threads, a thread by id) with the same reads made over HTTP by an adapter without the feed, and
 *      counts the HTTP shell snapshots the feed's reads made (none expected).
 *
 * The credential is Backroom's stored one (ROOMS_DATA_DIR, data/ by default) or T3_ACCESS_TOKEN. Exit code 0 when
 * every check passed.
 */
import { readStoredAuth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import type { T3ThreadShell } from "../src/adapter/types.ts";
import { ORCHESTRATION_PROTOCOL_VERSION } from "../src/adapter/types.ts";
import { loadConfig } from "../src/config.ts";

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1] ?? 6) || 6;
const config = loadConfig();
const stored = readStoredAuth(config.dataDir);
const baseUrl = config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773";
const accessToken = config.t3AccessToken ?? stored?.accessToken ?? null;

let failures = 0;
const ok = (name: string, detail = "") => console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
const fail = (name: string, detail: string) => {
  failures += 1;
  console.log(`FAIL ${name}: ${detail}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (value: unknown, max = 220) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
};

console.log(`T3 base URL: ${baseUrl}; credentials ${accessToken ? "present" : "missing"}`);

// ---------------- 1. the wire ----------------

async function wire(): Promise<void> {
  const ticketResponse = await fetch(`${baseUrl}/api/auth/websocket-ticket`, { method: "POST", headers: { accept: "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) } });
  if (!ticketResponse.ok) throw new Error(`websocket ticket: HTTP ${ticketResponse.status}`);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  const socket = new WebSocket(url);
  const started = Date.now();
  const at = () => `${String(Date.now() - started).padStart(5)} ms`;
  const tags: Record<string, string> = { "1": "orchestration.subscribeShell", "2": "orchestration.subscribeArchivedShell" };
  const chunks: Record<string, number> = { "1": 0, "2": 0 };
  const exits: Record<string, unknown> = {};
  let pong = false;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the socket failed to open")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const decoded = JSON.parse(String(event.data)) as unknown;
    for (const frame of (Array.isArray(decoded) ? decoded : [decoded]) as Array<{ _tag: string; requestId?: string; values?: unknown[]; exit?: unknown }>) {
      if (frame._tag === "Pong") {
        pong = true;
        console.log(`${at()} << Pong`);
      } else if (frame._tag === "Chunk" && frame.requestId) {
        chunks[frame.requestId] = (chunks[frame.requestId] ?? 0) + 1;
        const values = (frame.values ?? []) as Array<{ kind?: string; sequence?: number; location?: string; snapshot?: { snapshotSequence?: number; threads?: unknown[]; archivedThreads?: unknown[]; projects?: unknown[] }; resolvedRepositoryIdentityRoots?: unknown; thread?: { id?: string }; threadId?: string }>;
        const described = values.map((value) =>
          value.kind === "snapshot"
            ? `snapshot@${value.snapshot?.snapshotSequence} (${value.snapshot?.projects?.length ?? 0} projects, ${value.snapshot?.threads?.length ?? 0} threads, ${value.snapshot?.archivedThreads?.length ?? "no"} archived${value.resolvedRepositoryIdentityRoots ? ", enrichment" : ""})`
            : `${value.kind}@${value.sequence}${value.location ? ` ${value.location}` : ""} ${value.thread?.id ?? value.threadId ?? ""}`.trim(),
        );
        console.log(`${at()} << Chunk ${tags[frame.requestId]} [${described.join(", ")}] (${String(event.data).length} bytes)`);
        socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      } else if (frame._tag === "Exit" && frame.requestId) {
        exits[frame.requestId] = frame.exit;
        console.log(`${at()} << Exit ${tags[frame.requestId]} ${brief(frame.exit, 160)}`);
      } else console.log(`${at()} << ${brief(frame)}`);
    }
  });
  socket.send(JSON.stringify({ _tag: "Ping" }));
  for (const [id, tag] of Object.entries(tags)) {
    const request = { _tag: "Request", id, tag, payload: {}, headers: [] };
    console.log(`${at()} >> ${JSON.stringify(request)}`);
    socket.send(JSON.stringify(request));
  }
  await sleep(seconds * 1000);
  for (const id of Object.keys(tags)) socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
  await sleep(500);
  socket.close();
  if (pong) ok("wire: ping", "T3 answers a Ping with a Pong");
  else fail("wire: ping", "no Pong");
  if (chunks["1"]! >= 1 && chunks["2"]! >= 1) ok("wire: subscriptions", `${chunks["1"]} chunk(s) of the active shell and ${chunks["2"]} of the archived one in ${seconds} s, each acknowledged`);
  else fail("wire: subscriptions", `chunks ${JSON.stringify(chunks)}`);
  const interrupted = Object.values(exits).filter((exit) => JSON.stringify(exit).includes('"Interrupt"')).length;
  if (interrupted === 2) ok("wire: interrupt", "both streams ended with an Exit after Interrupt");
  else fail("wire: interrupt", `exits ${brief(exits)}`);
}

try {
  await wire();
} catch (error) {
  fail("wire", (error as Error).message);
}

// ---------------- 2. the adapter ----------------

let shellGets = 0;
const counting: typeof fetch = (input, init) => {
  if (new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname === "/api/orchestration/shell") shellGets += 1;
  return fetch(input, init);
};
const feed = new HttpT3Adapter({ baseUrl, accessToken, userDataDir: config.t3UserDataDir, fetchImpl: counting });
const overHttp = new HttpT3Adapter({ baseUrl, accessToken, userDataDir: config.t3UserDataDir });
try {
  const changes: Array<readonly string[] | null> = [];
  feed.onShellChange((change) => changes.push(change.threadIds));
  const startedAt = Date.now();
  feed.startFeed();
  while (feed.feed().state !== "connected" && Date.now() - startedAt < 30_000) await sleep(50);
  const status = feed.feed();
  if (status.state === "connected") ok("feed: live", `connected in ${Date.now() - startedAt} ms (since ${status.since})`);
  else throw new Error(`the feed is ${status.state}: ${status.error}`);

  // The same reads, from the feed and over HTTP. T3 moves on between them (running threads change every few seconds):
  // threads whose updatedAt differs between the two reads are counted apart, everything else must be equal.
  const before = shellGets;
  const fromFeed = { projects: await feed.listProjects(), threads: await feed.listThreads(), archived: await feed.listArchivedThreads() };
  const sample = fromFeed.threads.slice(-3).map((thread) => thread.id);
  const feedSample = await Promise.all(sample.map((id) => feed.getThreadShell(id)));
  if (shellGets === before) ok("feed: no HTTP snapshot", "projects, threads, archived threads and threads by id read from the feed");
  else fail("feed: no HTTP snapshot", `${shellGets - before} GET /api/orchestration/shell`);
  const fromHttp = { projects: await overHttp.listProjects(), threads: await overHttp.listThreads(), archived: await overHttp.listArchivedThreads() };
  const httpSample = await Promise.all(sample.map((id) => overHttp.getThreadShell(id)));

  if (JSON.stringify(fromFeed.projects) === JSON.stringify(fromHttp.projects)) ok("reads: projects", `${fromFeed.projects.length} projects, equal and in the same order`);
  else fail("reads: projects", `feed ${brief(fromFeed.projects)} http ${brief(fromHttp.projects)}`);
  const compare = (name: string, a: T3ThreadShell[], b: T3ThreadShell[]) => {
    const byId = new Map(b.map((thread) => [thread.id, thread]));
    const moved = new Set([...a, ...b].filter((thread) => byId.get(thread.id)?.updatedAt !== a.find((x) => x.id === thread.id)?.updatedAt).map((thread) => thread.id));
    const steadyA = a.filter((thread) => !moved.has(thread.id));
    const steadyB = b.filter((thread) => !moved.has(thread.id));
    if (JSON.stringify(steadyA) === JSON.stringify(steadyB)) ok(`reads: ${name}`, `${steadyA.length} equal and in the same order; ${moved.size} changed in T3 between the two reads`);
    else {
      const index = steadyA.findIndex((thread, i) => JSON.stringify(thread) !== JSON.stringify(steadyB[i]));
      fail(`reads: ${name}`, `first difference at ${index}: feed ${brief(steadyA[index], 400)} http ${brief(steadyB[index], 400)}`);
    }
  };
  compare("threads", fromFeed.threads, fromHttp.threads);
  compare("archived threads", fromFeed.archived, fromHttp.archived);
  compare(
    "threads by id",
    feedSample.filter((thread): thread is T3ThreadShell => thread !== null),
    httpSample.filter((thread): thread is T3ThreadShell => thread !== null),
  );

  // What T3 streams while it works, applied as it comes.
  const heard = changes.length;
  await sleep(seconds * 1000);
  const named = changes.slice(heard).flatMap((ids) => ids ?? []);
  ok("feed: changes", `${changes.length - heard} change(s) applied in ${seconds} s, naming ${new Set(named).size} thread(s); feed ${feed.feed().state}`);
  const after = shellGets;
  for (let i = 0; i < 20; i += 1) await feed.listThreads();
  if (shellGets === after) ok("feed: reads", "20 more thread lists, no HTTP snapshot");
  else fail("feed: reads", `${shellGets - after} GET /api/orchestration/shell`);
} catch (error) {
  fail("feed", (error as Error).message);
} finally {
  feed.close();
  overHttp.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Read-only check of T3's shell stream against a real T3 Code server (`npm run t3:feed`), the source of the shell
 * feed (src/adapter/shellFeed.ts). It dispatches nothing: it asks for WebSocket tickets, subscribes, and reads.
 *
 *   1. The wire: subscribes to orchestration.subscribeShell on a socket of its own, prints the frames T3 sends for
 *      `--seconds` (default 6), acknowledging each chunk, then interrupts it; and reads
 *      orchestration.getArchivedShellSnapshot once.
 *   2. The adapter: starts the adapter's feed, and once it is live compares its shell reads (projects, threads,
 *      archived threads, a thread by id) with the same reads made over HTTP by an adapter without the feed, and
 *      counts the HTTP shell snapshots the feed's reads made (none expected).
 *   3. With `--threads` (the thread feed, src/adapter/threadFeed.ts), for `--minutes` (default 1), on the threads the
 *      user's rooms seat (read-only from ROOMS_DATA_DIR/rooms.sqlite), or the ids given after `--threads`:
 *      a. The wire: one orchestration.subscribeThread after the sequence of the thread's bounded read: T3 replays
 *         what came since (no snapshot), sends its marker, then an event per change; a read after them is at least at
 *         the last event's sequence (one numbering).
 *      b. The reads: the adapter holds the threads as the engine host does, and plays the host's tick (every 1.5 s,
 *         each seat whose thread has a run going or whose shell changed: its bounded read, and its whole history when
 *         the window is partial) and a page with the room open (the desk: every member's bounded read, on each thread
 *         event and every 60 s; before, every 2.5 s while a member worked, else 10 s). It counts the reads T3 served
 *         against the reads the same callers made before (one per call), per minute.
 *
 * The credential is Backroom's stored one (ROOMS_DATA_DIR, data/ by default) or T3_ACCESS_TOKEN. Exit code 0 when
 * every check passed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import type { T3ThreadShell } from "../src/adapter/types.ts";
import { ORCHESTRATION_PROTOCOL_VERSION } from "../src/adapter/types.ts";
import { loadConfig } from "../src/config.ts";

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1] ?? 6) || 6;
const threadsAt = args.indexOf("--threads");
const minutes = Number(args[args.indexOf("--minutes") + 1] ?? 1) || 1;
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
  const tags: Record<string, string> = { "1": "orchestration.subscribeShell", "2": "orchestration.getArchivedShellSnapshot" };
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
  socket.send(JSON.stringify({ _tag: "Interrupt", requestId: "1" }));
  await sleep(500);
  socket.close();
  if (pong) ok("wire: ping", "T3 answers a Ping with a Pong");
  else fail("wire: ping", "no Pong");
  if (chunks["1"]! >= 1) ok("wire: subscription", `${chunks["1"]} chunk(s) of the shell in ${seconds} s, each acknowledged`);
  else fail("wire: subscription", `chunks ${JSON.stringify(chunks)}`);
  const archived = exits["2"] as { _tag?: string; value?: { threads?: unknown[] } } | undefined;
  if (archived?._tag === "Success" && Array.isArray(archived.value?.threads)) ok("wire: archived snapshot", `${archived.value!.threads!.length} archived thread(s)`);
  else fail("wire: archived snapshot", `exit ${brief(archived)}`);
  if (JSON.stringify(exits["1"] ?? null).includes('"Interrupt"')) ok("wire: interrupt", "the stream ended with an Exit after Interrupt");
  else fail("wire: interrupt", `exit ${brief(exits["1"])}`);
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
  if (shellGets === before) ok("feed: no HTTP snapshot", "projects, threads and threads by id read from the feed, archived threads over the RPC");
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

// ---------------- 3. the threads (--threads) ----------------

/** The threads to watch: those named after --threads, else those the user's rooms seat (their bindings, read-only). */
function seatedThreads(): string[] {
  const named = threadsAt >= 0 ? args.slice(threadsAt + 1).filter((arg, i, all) => !arg.startsWith("--") && (i === 0 || !all[i - 1]!.startsWith("--") || all[i - 1] === "--threads")) : [];
  if (named.length > 0) return named;
  const file = join(config.dataDir, "rooms.sqlite");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT DISTINCT thread_id FROM bindings WHERE retired_at IS NULL").all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
  } finally {
    db.close();
  }
}

const authorization: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
async function boundedSequence(threadId: string): Promise<number | null> {
  const response = await fetch(`${baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, { headers: { accept: "application/json", "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL_VERSION), ...authorization } });
  if (!response.ok) return null;
  const body = (await response.json()) as { snapshotSequence?: number };
  return typeof body.snapshotSequence === "number" ? body.snapshotSequence : null;
}

/** 3a: one thread's stream on a socket of its own, after its bounded read. */
async function threadWire(threadId: string): Promise<void> {
  const after = await boundedSequence(threadId);
  if (after === null) throw new Error(`no bounded read of ${threadId}`);
  const { ticket } = (await (await fetch(`${baseUrl}/api/auth/websocket-ticket`, { method: "POST", headers: { accept: "application/json", ...authorization } })).json()) as { ticket: string };
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the socket failed to open")), { once: true });
  });
  const started = Date.now();
  const at = () => `${String(Date.now() - started).padStart(5)} ms`;
  let synced = false;
  let snapshots = 0;
  let events = 0;
  let last = after;
  let exit: unknown = null;
  socket.addEventListener("message", (event) => {
    const decoded = JSON.parse(String(event.data)) as unknown;
    for (const frame of (Array.isArray(decoded) ? decoded : [decoded]) as Array<{ _tag: string; requestId?: string; values?: unknown[]; exit?: unknown }>) {
      if (frame._tag === "Chunk" && frame.requestId === "1") {
        const values = (frame.values ?? []) as Array<{ kind?: string; sequence?: number; snapshotSequence?: number; event?: { type?: string } }>;
        for (const value of values) {
          if (value.kind === "synchronized") synced = true;
          else if (value.kind === "snapshot") snapshots += 1;
          else if (value.kind === "event") {
            events += 1;
            last = Math.max(last, value.sequence ?? 0);
          }
        }
        const described = values.map((value) => (value.kind === "event" ? `event@${value.sequence} ${value.event?.type ?? ""}` : value.kind === "snapshot" ? `snapshot@${value.snapshotSequence}` : String(value.kind)));
        console.log(`${at()} << Chunk subscribeThread [${described.join(", ")}] (${String(event.data).length} bytes)`);
        socket.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
      } else if (frame._tag === "Exit" && frame.requestId === "1") {
        exit = frame.exit;
        console.log(`${at()} << Exit subscribeThread ${brief(frame.exit, 160)}`);
      }
    }
  });
  const request = { _tag: "Request", id: "1", tag: "orchestration.subscribeThread", payload: { threadId, afterSequence: after, acceptBoundedSnapshot: true, acceptCompactTurnItems: true, requestCompletionMarker: true }, headers: [] };
  console.log(`${at()} >> ${JSON.stringify(request)}`);
  socket.send(JSON.stringify(request));
  await sleep(seconds * 1000);
  const readAfter = await boundedSequence(threadId);
  socket.send(JSON.stringify({ _tag: "Interrupt", requestId: "1" }));
  await sleep(500);
  socket.close();
  if (synced && snapshots === 0) ok("threads wire: resumed", `subscribed after the bounded read's sequence ${after}: T3 replayed with no snapshot and sent its marker`);
  else fail("threads wire: resumed", `marker ${synced}, ${snapshots} snapshot(s)`);
  ok("threads wire: events", `${events} event(s) of ${threadId} in ${seconds} s, the last at ${last}`);
  if (readAfter !== null && readAfter >= last) ok("threads wire: one numbering", `a bounded read after them is at ${readAfter}, not behind the last event (${last})`);
  else fail("threads wire: one numbering", `read at ${readAfter}, last event ${last}`);
  if (JSON.stringify(exit).includes('"Interrupt"')) ok("threads wire: interrupt", "the stream ended with an Exit after Interrupt");
  else fail("threads wire: interrupt", `exit ${brief(exit)}`);
}

/** 3b: the engine host's tick and an open room's desk, through the adapter with the thread feed, for `minutes`. */
async function threadReads(seated: string[]): Promise<void> {
  const served = { bounded: 0, full: 0 };
  const counting: typeof fetch = (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    if (path.startsWith("/api/orchestration/threads/")) {
      if (path.endsWith("/bounded")) served.bounded += 1;
      else served.full += 1;
    }
    return fetch(input, init);
  };
  const adapter = new HttpT3Adapter({ baseUrl, accessToken, userDataDir: config.t3UserDataDir, fetchImpl: counting, log: (message, detail) => console.log(`  adapter: ${message} ${brief(detail)}`) });
  const before = { hostBounded: 0, hostFull: 0, desk: 0 };
  const events = new Map<string, number>();
  try {
    adapter.startFeed();
    const startedAt = Date.now();
    while (adapter.feed().state !== "connected" && Date.now() - startedAt < 30_000) await sleep(50);
    if (adapter.feed().state !== "connected") throw new Error(`the feed is ${adapter.feed().state}`);
    adapter.holdThreads("engine", seated);
    // The page: the desk reads every member's bounded detail, on their events (coalesced as the page does) and every 60 s.
    let deskDue: ReturnType<typeof setTimeout> | null = null;
    const desk = async () => {
      for (const id of seated) {
        adapter.leaseThread(id);
        await adapter.getThreadDetail(id, { bounded: true }).catch(() => null);
      }
    };
    adapter.onThreadChange((threadId) => {
      events.set(threadId, (events.get(threadId) ?? 0) + 1);
      deskDue ??= setTimeout(() => {
        deskDue = null;
        void desk();
      }, 150);
    });
    const shellKey = (shell: T3ThreadShell) => JSON.stringify([shell.latestRunId, shell.status, shell.latestUserMessageAt, shell.latestRunCompletedAt, shell.pendingBackgroundTasks.length]);
    const keys = new Map<string, string>();
    const windowMs = minutes * 60_000;
    const begin = Date.now();
    let ticks = 0;
    let running = 0;
    let lastDesk = -Infinity;
    let lastFallback = begin;
    await desk();
    const baseline = { ...served };
    while (Date.now() - begin < windowMs) {
      ticks += 1;
      const shells = new Map((await adapter.listThreads()).map((shell) => [shell.id, shell]));
      const working = seated.filter((id) => shells.get(id)?.activeRunId);
      running += working.length;
      // The host's tick: a seat with a run going, or whose shell moved, is read; its whole history when the window is partial.
      for (const id of seated) {
        const shell = shells.get(id);
        if (!shell) continue;
        const key = shellKey(shell);
        const due = shell.activeRunId !== null || keys.get(id) !== key;
        keys.set(id, key);
        if (!due) continue;
        before.hostBounded += 1;
        const bounded = await adapter.getThreadDetail(id, { bounded: true }).catch(() => null);
        if (bounded?.partial) {
          before.hostFull += 1;
          await adapter.getThreadDetail(id).catch(() => null);
        }
      }
      // Before: the desk read every member every 2.5 s while one worked, else every 10 s.
      const now = Date.now();
      if (now - lastDesk >= (working.length > 0 ? 2_500 : 10_000)) {
        before.desk += seated.length;
        lastDesk = now;
      }
      // After: its 60 s fallback.
      if (now - lastFallback >= 60_000) {
        lastFallback = now;
        await desk();
      }
      await sleep(1_500);
    }
    if (deskDue) clearTimeout(deskDue);
    const perMinute = (n: number) => Math.round((n / (Date.now() - begin)) * 60_000);
    const after = { bounded: served.bounded - baseline.bounded, full: served.full - baseline.full };
    const status = adapter.threadStreams();
    if (status.live === seated.length && status.refused === 0) ok("threads: streams", `${status.live} of ${seated.length} seated threads streamed on the feed's socket, none refused`);
    else fail("threads: streams", brief(status));
    console.log(`  ${ticks} ticks over ${Math.round((Date.now() - begin) / 1000)} s; on average ${(running / Math.max(1, ticks)).toFixed(1)} of ${seated.length} seated threads had a run going`);
    console.log(`  thread events heard (each after the read it caused): ${[...events].map(([id, n]) => `${id} ${n}`).join(", ") || "none"}`);
    console.log(`  before (one T3 read per call): host ${perMinute(before.hostBounded)} bounded + ${perMinute(before.hostFull)} full, desk ${perMinute(before.desk)} bounded: ${perMinute(before.hostBounded + before.hostFull + before.desk)} reads/min`);
    console.log(`  after (what T3 served): ${perMinute(after.bounded)} bounded + ${perMinute(after.full)} full: ${perMinute(after.bounded + after.full)} reads/min, plus ${seated.length} subscriptions held open`);
    if (after.bounded + after.full <= before.hostBounded + before.hostFull + before.desk) ok("threads: reads", `${after.bounded + after.full} reads served for ${before.hostBounded + before.hostFull + before.desk} calls`);
    else fail("threads: reads", `${after.bounded + after.full} reads for ${before.hostBounded + before.hostFull + before.desk} calls`);
  } finally {
    adapter.close();
  }
}

if (threadsAt >= 0) {
  try {
    const listed = new Map((await overHttp.listThreads()).map((shell) => [shell.id, shell]));
    const seated = seatedThreads().filter((id) => listed.has(id));
    if (seated.length === 0) throw new Error("no seated thread T3 lists (name some after --threads)");
    console.log(`threads: ${seated.join(", ")}`);
    const busiest = seated.find((id) => listed.get(id)?.activeRunId) ?? seated[0]!;
    await threadWire(busiest);
    await threadReads(seated);
  } catch (error) {
    fail("threads", (error as Error).message);
  }
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

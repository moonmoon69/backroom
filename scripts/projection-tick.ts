/**
 * How long one host tick takes over a large room (Bug room #22): the Tests room the user reported slow had 4,220 engine
 * events (7.8 MB) and 67 seats. A synthetic room of that size: `--seats` active seats and `--retired` retired ones, then
 * request/run/answer cycles in the commands the host itself issues, each with a briefing-sized dispatch, until the
 * journal holds `--events` events. Then, over the in-memory T3 fake: idle ticks (nothing to do), a dispatch tick (one
 * request to each of `--writers` seats: reserve, brief, send, accepted) and a finish tick (those turns end: output and
 * end). Each line gives the tick's time, the projection reads the host made from the store and how many whole
 * projections were copied (structuredClone of a projection). Reported, not gated.
 *
 *   node --no-warnings=ExperimentalWarning scripts/projection-tick.ts [--events 4000] [--seats 60] [--retired 20] [--writers 10] [--dir <folder>] [--profile <file.cpuprofile>]
 *
 * `--profile` writes a CPU profile of the ticks alone (not the room's setup), for Chrome DevTools.
 * The journal goes to a RAM file system (/dev/shm when there is one) and is removed when the script ends.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { Participant, Room } from "../src/domain/types.ts";
import { EngineStore } from "../src/engine/index.ts";
import { EngineHost, type BriefingSource } from "../src/runtime/index.ts";

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const EVENTS = arg("--events", 4000);
const ACTIVE = arg("--seats", 60);
const RETIRED = arg("--retired", 20);
const WRITERS = Math.min(arg("--writers", 10), ACTIVE - 1);
const dirAt = process.argv.indexOf("--dir");
const profileAt = process.argv.indexOf("--profile");
const base = resolve(dirAt >= 0 ? process.argv[dirAt + 1]! : existsSync("/dev/shm") ? "/dev/shm/backroom-projection-tick" : join(tmpdir(), "backroom-projection-tick"));
const ROOM = "tests";
const SYSTEM = "$system";

const seatIds = Array.from({ length: ACTIVE }, (_, i) => (i === 0 ? "C" : `W${i}`));
const retiredIds = Array.from({ length: RETIRED }, (_, i) => `R${i}`);
const threadOf = (seatId: string) => `${ROOM}:thread:${seatId}`;
const pad = (text: string, bytes: number) => text.padEnd(bytes, " lorem ipsum");

function source(): BriefingSource {
  const at = new Date(0).toISOString();
  const participant = (id: string): Participant => ({ id, roomId: ROOM, alias: id, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: at, updatedAt: at });
  const room: Room = { id: ROOM, projectId: "project_demo", environmentId: null, title: "Tests", nextSequence: 1, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: "C", createdAt: at, updatedAt: at };
  const everyone = new Map(seatIds.map((s) => [s, participant(s)]));
  return {
    standing: (_room, seatId) => ({ room, participant: participant(seatId), participantsById: everyone, board: { command: "rooms-board", as: `${seatId}.key` } }),
    alias: (_room, seatId) => seatId,
  };
}

/** One of the user's requests answered by one host run, in the host's own commands: seven events. */
function cycle(store: EngineStore, n: number, seatId: string): void {
  const q = `q${n}`, run = `run${n}`;
  store.execute(ROOM, { type: "request", actor: "$user", id: q, to: seatId, body: pad(`Request ${n} for ${seatId}: look into it.`, 1600) });
  store.execute(ROOM, { type: "reserve", actor: SYSTEM, id: `reserve:${run}`, seatId, runId: run, dispatchCommandId: `dc${n}`, dispatchMessageId: `dm${n}`, maxBytes: 4 * 1024 * 1024 });
  const frozen = { dispatch: `dc${n}`, text: pad(`[Backroom briefing for @${seatId}] request ${n}`, 5200), images: [], held: null };
  store.execute(ROOM, { type: "phase", actor: SYSTEM, id: `phase:${run}:sending`, runId: run, phase: "sending", evidence: JSON.stringify(frozen) });
  store.execute(ROOM, { type: "phase", actor: SYSTEM, id: `phase:${run}:accepted`, runId: run, phase: "accepted", evidence: `t3run:t3-${n} ordinal:${n + 1}`, providerRunId: `t3-${n}` });
  store.execute(ROOM, { type: "phase", actor: SYSTEM, id: `phase:${run}:running`, runId: run, phase: "running", evidence: `t3run:t3-${n}`, providerRunId: `t3-${n}` });
  store.execute(ROOM, { type: "output", actor: SYSTEM, id: `output:${run}`, author: seatId, sourceKey: `final:${run}`, association: { kind: "run", id: run }, body: pad(`Answer ${n} from ${seatId}.`, 2800), disposition: { kind: "answer", requestIds: [q] } });
  store.execute(ROOM, { type: "observe_end", actor: SYSTEM, id: `end:${run}`, runId: run, sourceKey: `final:${run}`, failure: null, evidence: `t3run:t3-${n} completed` });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main(): Promise<void> {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "run-"));
  const store = new EngineStore(join(dir, "board.sqlite"));
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  try {
    for (const seatId of [...seatIds, ...retiredIds]) store.execute(ROOM, { type: "seat", actor: "$user", id: `seat:${seatId}`, seatId, threadId: threadOf(seatId), orchestrator: seatId === "C" });
    const workers = [...seatIds.slice(1), ...retiredIds];
    let n = 0;
    while (store.heads().get(ROOM)! + 7 + RETIRED <= EVENTS) cycle(store, n, workers[n % workers.length]!), n++;
    for (const seatId of retiredIds) store.execute(ROOM, { type: "retire", actor: "$user", id: `retire:${seatId}`, seatId, evidence: "bench" });
    for (const seatId of seatIds) {
      await fake.launchThread({ commandId: `launch:${seatId}`, threadId: threadOf(seatId), projectId: "project_demo", title: `Tests · ${seatId}`, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
    }
    const bytes = store.load(ROOM).reduce((sum, e) => sum + JSON.stringify(e.data).length, 0);
    console.log(`room: ${store.heads().get(ROOM)} events (${(bytes / 1e6).toFixed(1)} MB of event data), ${ACTIVE} active seats, ${RETIRED} retired`);

    // Count what the host reads from the store, and every whole projection copied, whichever API the store has.
    let reads = 0, copies = 0;
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof structuredClone>[1]) => {
      if (value && typeof value === "object" && "seats" in value && "events" in value) copies += 1;
      return clone(value, options);
    }) as typeof structuredClone;
    const counted = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["project", "snapshot"]) {
      const original = counted[name];
      if (typeof original !== "function") continue;
      counted[name] = (...args: unknown[]) => { reads += 1; return original.apply(store, args); };
    }
    const host = new EngineHost({ store, adapter: fake, rooms: () => [ROOM], briefing: source(), log: () => {} });
    const timed = async (label: string) => {
      reads = 0; copies = 0;
      const start = performance.now();
      await host.tick();
      const ms = performance.now() - start;
      console.log(`  ${label}: ${ms.toFixed(1)} ms, ${reads} store reads, ${copies} whole-projection copies`);
      return ms;
    };
    const profiler = profileAt >= 0 ? new Session() : null;
    if (profiler) {
      profiler.connect();
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.start");
    }
    await timed("first tick (reads every thread once)");
    const idle: number[] = [];
    for (let i = 0; i < 3; i++) idle.push(await timed(`idle tick ${i + 1}`));
    const asked = seatIds.slice(1, 1 + WRITERS);
    for (const [i, seatId] of asked.entries()) host.request(ROOM, { actor: "C", id: `bench:${i}`, to: seatId, body: `Bench request ${i}.` });
    const dispatch = await timed(`dispatch tick (${WRITERS} requests: reserve, brief, send)`);
    const seats = store.project(ROOM).seats;
    const live = asked.filter((s) => seats.get(s)!.activeRunId);
    if (live.length !== WRITERS) throw new Error(`the dispatch tick reserved ${live.length} runs, not ${WRITERS}`);
    await timed("follow tick (running)");
    for (const seatId of asked) fake.completeRun(threadOf(seatId), { text: `Done ${seatId}.` });
    const finish = await timed(`finish tick (${WRITERS} turns end: output, end)`);
    globalThis.structuredClone = clone;
    if (profiler) writeFileSync(resolve(process.argv[profileAt + 1]!), JSON.stringify((await profiler.post("Profiler.stop")).profile));
    host.close();
    console.log(`idle median ${median(idle).toFixed(1)} ms; dispatch ${dispatch.toFixed(1)} ms; finish ${finish.toFixed(1)} ms (${store.heads().get(ROOM)} events)`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();

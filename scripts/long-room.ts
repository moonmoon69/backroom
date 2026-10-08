/**
 * L6's local performance regression check for long rooms, rebuilt from P4's method (Development D#316, D#366, D#400).
 * A proxy for local cost only: no provider, no model. One journal file, as the service's board.sqlite: a warm-up room
 * of 250 notes, then three rooms in turn, each seated and then given 2,000 notes of exactly 1 KiB through
 * `EngineStore.execute`, the call the host's member commands end in. Every append is timed. Then host ticks are timed
 * over the last room (the L1 reviewer's ask; about 100 ms at 2,000 events before L6): a tick with nothing to do, and a
 * tick that reserves, briefs and sends one request. Reported, not gated.
 *
 *   node --no-warnings=ExperimentalWarning scripts/long-room.ts [--dir <folder>] [--disk <folder>]
 *
 * The gate runs where P4 set its budgets, on a RAM file system (--dir; default /dev/shm when there is one): it measures
 * the engine, not the disk. It exits 0 only if the median total of the three rooms is at most 2,500 ms and the median
 * of their last-100-append means is at most 2.5 ms. The same workload then runs on the data disk (--disk; default
 * data/long-room), where every commit also waits for SQLite's fsync (synchronous=FULL), and is reported only.
 * Every journal file is removed when the script ends, and each folder too when nothing else is in it.
 */
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { Participant, Room } from "../src/domain/types.ts";
import { EngineStore } from "../src/engine/index.ts";
import { EngineHost, type BriefingSource } from "../src/runtime/index.ts";

const WARMUP = 250;
const NOTES = 2000;
const ROOMS = 3;
const TOTAL_BUDGET_MS = 2500;
const TAIL_BUDGET_MS = 2.5;
const SEATS = ["C", "W", "V"];

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1]! : null;
};
const diskDir = resolve(arg("--disk") ?? join(import.meta.dirname, "..", "data", "long-room"));
const gateDir = resolve(arg("--dir") ?? (existsSync("/dev/shm") ? "/dev/shm/backroom-long-room" : diskDir));
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const ms = (n: number): string => `${n.toFixed(3)} ms`;

function seat(store: EngineStore, room: string): void {
  for (const id of SEATS) store.execute(room, { type: "seat", actor: "$user", id: `seat:${id}`, seatId: id, threadId: `${room}:thread:${id}`, orchestrator: id === "C" });
}

/** `count` notes of exactly 1,024 bytes by C, journal notes that wake nobody; the time of each append. */
function notes(store: EngineStore, room: string, count: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const body = `note ${i} of ${room} `.padEnd(1024, "x");
    const start = performance.now();
    store.execute(room, { type: "post", actor: "C", id: `note:${i}`, intent: "note", body });
    times.push(performance.now() - start);
  }
  return times;
}

function source(roomId: string): BriefingSource {
  const at = new Date(0).toISOString();
  const participant = (id: string): Participant => ({ id, roomId, alias: id, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: at, updatedAt: at });
  const room: Room = { id: roomId, projectId: "project_demo", environmentId: null, title: "long room", nextSequence: 1, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: "C", createdAt: at, updatedAt: at };
  return {
    standing: (_room, seatId) => ({ room, participant: participant(seatId), participantsById: new Map(SEATS.map((s) => [s, participant(s)])), board: { command: "rooms-board", as: `${seatId}.key` } }),
    alias: (_room, seatId) => seatId,
  };
}

async function tickTimes(store: EngineStore, room: string): Promise<{ idle: number[]; dispatch: number; events: number }> {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  for (const id of SEATS) {
    await fake.launchThread({ commandId: `launch:${id}`, threadId: `${room}:thread:${id}`, projectId: "project_demo", title: `long room · ${id}`, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  }
  const host = new EngineHost({ store, adapter: fake, rooms: () => [room], briefing: source(room), log: () => {} });
  try {
    const idle: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await host.tick();
      idle.push(performance.now() - start);
    }
    host.request(room, { actor: "C", id: "bench:request", to: "W", body: "Summarise the notes." });
    const start = performance.now();
    await host.tick();
    const dispatch = performance.now() - start;
    if (!store.project(room).seats.get("W")!.activeRunId) throw new Error("the dispatch tick did not reserve a run for W");
    return { idle, dispatch, events: store.load(room).length };
  } finally {
    host.close();
  }
}

interface Measured { total: number; tail: number; ticks: { idle: number[]; dispatch: number; events: number } }

async function measure(base: string, label: string): Promise<Measured> {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "run-"));
  const store = new EngineStore(join(dir, "board.sqlite"));
  try {
    console.log(`${label} (${dir}):`);
    seat(store, "warmup");
    notes(store, "warmup", WARMUP);
    const rooms: { total: number; tail: number }[] = [];
    for (let r = 1; r <= ROOMS; r++) {
      const room = `room-${r}`;
      seat(store, room);
      const times = notes(store, room, NOTES);
      const upTo = (n: number) => times.slice(0, n).reduce((a, b) => a + b, 0);
      rooms.push({ total: upTo(NOTES), tail: mean(times.slice(-100)) });
      console.log(`  ${room}: 250 notes ${ms(upTo(250))}, 1000 ${ms(upTo(1000))}, 2000 ${ms(upTo(NOTES))}; last 100 appends mean ${ms(rooms.at(-1)!.tail)}`);
    }
    const measured = { total: median(rooms.map((r) => r.total)), tail: median(rooms.map((r) => r.tail)), ticks: await tickTimes(store, `room-${ROOMS}`) };
    console.log(`  median total of ${NOTES} notes ${ms(measured.total)}; median of last-100 means ${ms(measured.tail)}`);
    console.log(`  host tick over ${measured.ticks.events} events: idle median ${ms(median(measured.ticks.idle))} (${measured.ticks.idle.map((t) => t.toFixed(1)).join(", ")} ms); reserve, brief and send one request ${ms(measured.ticks.dispatch)}`);
    return measured;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    try {
      rmdirSync(base); // only when nothing else is in it
    } catch {
      // not empty: someone else's runs are there
    }
  }
}

async function main(): Promise<number> {
  const gate = await measure(gateDir, gateDir === diskDir ? "gate, on the data disk" : "gate, on a RAM file system as P4");
  if (gateDir !== diskDir) await measure(diskDir, "the same on the data disk (reported only)");
  const pass = gate.total <= TOTAL_BUDGET_MS && gate.tail <= TAIL_BUDGET_MS;
  console.log(`gate: median total ${ms(gate.total)} (budget ${TOTAL_BUDGET_MS} ms), median last-100 mean ${ms(gate.tail)} (budget ${TAIL_BUDGET_MS} ms): ${pass ? "PASS" : "FAIL"}`);
  return pass ? 0 : 1;
}

process.exitCode = await main();

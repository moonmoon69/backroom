/**
 * Golden files for the L6 carve-out, generated from the core as merged (K1, L2, L1, L3, L4a, L4b, L4c and H1 on engine at
 * 24961b1). Run once before the carve; the lean core is then checked against them by tests/engine/golden.test.ts.
 *
 *   GOLDEN_RAW=<folder for the raw recordings> node --no-warnings=ExperimentalWarning tests/engine/golden/generate.ts [--reuse-raw]
 *
 * 1. Record: each source suite runs under record.ts, which writes every `decide` and `EngineStore.execute` call as
 *    (state before, command, state after) to $GOLDEN_RAW/<source>.jsonl.
 * 2. Rebuild: the lines of one source form a tree of journal states rooted at the empty journal. Only kept commands
 *    (plan §6 and L4b: 18) and `control_phase` on a cancel's interrupt control are followed, without the dropped fields
 *    (`request.live`, activity generation/native source/declaration). A history is the path from the root to a leaf;
 *    commands that changed nothing (refused, duplicate, idle, replayed) are replayed at the state they were tried in,
 *    each once.
 * 3. Neutralise: a cancel that prepares an interrupt control is followed at once by the host's `control_phase obsolete`
 *    (§6, "until L6, the host neutralises it"): the recorded one is moved there, or one is added. Every `control_phase`
 *    is marked `leftOut` and control events are not part of the lean core; one the core then refuses (an `accepted`
 *    after the neutraliser) is kept with its refusal. A command refused only because the core's control left its
 *    author's seat stopping is dropped (the lean core has no such state). An output that echoes sync receipts (dropped
 *    with the protocol) is replayed as the host does it: a `confirm_sync` per receipt, then the same output without
 *    them; if a confirmation is refused, the output is not replayed.
 * 4. Replay each history from the empty journal with `decide`, and with an `EngineStore` in memory, and write: every
 *    command with the decision (`outcome`, `expectedSeq`, `events`) or its refusal, and the kept projection maps at the
 *    end in canonical JSON (maps as [key, value] pairs sorted by key; `events` is the concatenation of the decisions).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, fold, EngineStore } from "../../../src/engine/index.ts";
import type { Command, Decision, Projection, RoomEvent } from "../../../src/engine/index.ts";
import { canonical, stateOf } from "./digest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const RAW = process.env.GOLDEN_RAW ?? "";
if (!RAW) throw new Error("GOLDEN_RAW (the folder for the raw recordings) is required");
const CORE = "24961b1";

export const SOURCES: { name: string; file: string }[] = [
  { name: "domain", file: "tests/engine/domain.test.ts" },
  { name: "interleavings", file: "tests/engine/interleavings.test.ts" },
  { name: "incident", file: "tests/engine/incident.test.ts" },
  { name: "store", file: "tests/engine/store.test.ts" },
  { name: "seat-lifecycle", file: "tests/engine/seat-lifecycle.test.ts" },
  { name: "engine-seats", file: "tests/engine-seats.test.ts" },
  ...["answer-watermark", "background", "briefing", "cancel", "crash", "delivery", "flag", "h1-review-probes-r1", "h1-review-probes", "imports", "review-findings", "scenarios", "selection"]
    .map((name) => ({ name: `runtime-${name}`, file: `tests/runtime/${name}.test.ts` })),
];

export const KEPT = new Set(["seat", "retire", "designate", "request", "correct", "cancel", "post", "subscribe", "reserve", "phase",
  "sync", "confirm_sync", "output", "observe_end", "activity_start", "activity_status", "retry", "transfer"]);

/** Why a recorded command is not followed, or null when it is a kept command without dropped fields. */
function dropped(command: Command): string | null {
  if (command.type === "control_phase") return command.controlId.endsWith("/interrupt") ? null : "control_phase";
  if (!KEPT.has(command.type)) return command.type;
  if (command.type === "request" && command.live) return "request.live";
  if (command.type === "activity_start" && (command.generation !== undefined || command.nativeSource !== undefined || command.declaration !== undefined)) return "activity_start.provider";
  return null;
}

const plain = <T>(value: T): T => JSON.parse(canonical(value)) as T;

interface Tried { command: Command; loop: boolean; group?: number; neutraliser?: boolean }
interface Line { via: "decide" | "store"; before: string; after: string | null; command: Command; outcome?: string; error?: string }
export interface Step { command: Command; leftOut?: "control"; expect: { outcome: Decision["outcome"]; expectedSeq: number; events: RoomEvent[] } | { error: string }; store?: { error: string } | { outcome: string } }
export interface KeptMaps {
  seats: [string, unknown][]; requests: [string, unknown][]; runs: [string, unknown][]; activities: [string, unknown][];
  subscriptions: unknown[]; sourceKeys: [string, string][]; commandKeys: string[]; blocked: [string, string][]; orchestrator: string | null;
}
export interface Sequence { name: string; steps: Step[]; maps: KeptMaps }

export function keptMaps(p: Projection): KeptMaps {
  const sorted = <V>(map: Map<string, V>): [string, V][] => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, plain(v)]);
  return {
    seats: sorted(p.seats), requests: sorted(p.requests), runs: sorted(p.runs), activities: sorted(p.activities),
    subscriptions: plain(p.subscriptions), sourceKeys: sorted(p.sourceKeys), commandKeys: [...p.commandKeys].sort(), blocked: sorted(p.blocked),
    orchestrator: p.orchestrator,
  };
}

function record(source: { name: string; file: string }): void {
  const out = join(RAW, `${source.name}.jsonl`);
  if (existsSync(out)) writeFileSync(out, "");
  const run = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", join(here, "record.ts"), "--test-timeout=60000", source.file],
    { cwd: repo, env: { ...process.env, GOLDEN_RAW: RAW, GOLDEN_SOURCE: source.name, ROOMS_ENGINE: process.env.ROOMS_ENGINE ?? "" }, encoding: "utf8", maxBuffer: 1 << 28 });
  const summary = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(run.stdout);
  if (run.status !== 0 || !summary || summary[2] !== "0") throw new Error(`${source.file} failed while recording:\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-4000)}`);
  console.log(`recorded ${source.name}: ${summary[1]} tests pass`);
}

interface Report { receiptsSplit: number; controlRefused: number; storeOnly: number; lines: number; states: number; leaves: number; sequences: number; steps: number; cut: Record<string, number>; neutralised: number; moved: number; droppedStopping: number; storeDiffers: number; digestChecked: number }

/** Histories of one source: root-to-leaf paths over kept commands, each no-op command attached once. */
export function histories(lines: Line[], report: Report): { commands: Tried[]; leaf: string }[] {
  const edges = new Map<string, Map<string, { command: Command; after: string }>>();
  const loops = new Map<string, Map<string, Command>>();
  for (const line of lines) {
    const key = canonical(line.command);
    if (line.after !== null) {
      const out = edges.get(line.before) ?? new Map();
      const prior = out.get(key);
      if (prior && prior.after !== line.after) throw new Error(`nondeterministic decision for ${key}`);
      out.set(key, { command: line.command, after: line.after });
      edges.set(line.before, out);
    } else {
      const at = loops.get(line.before) ?? new Map();
      if (!at.has(key)) at.set(key, line.command);
      loops.set(line.before, at);
    }
  }
  // Follow kept commands only, from the empty journal.
  const parent = new Map<string, { from: string; command: Command } | null>([["root", null]]);
  const children = new Map<string, number>();
  const queue = ["root"];
  while (queue.length) {
    const state = queue.shift()!;
    for (const { command, after } of edges.get(state)?.values() ?? []) {
      const why = dropped(command);
      if (why) { report.cut[why] = (report.cut[why] ?? 0) + 1; continue; }
      if (parent.has(after)) continue;
      parent.set(after, { from: state, command });
      children.set(state, (children.get(state) ?? 0) + 1);
      queue.push(after);
    }
  }
  report.states = parent.size;
  const used = new Set<string>();
  const out: { commands: Tried[]; leaf: string }[] = [];
  for (const leaf of parent.keys()) {
    if (children.get(leaf)) continue;
    const path: { state: string; command: Command | null }[] = [{ state: leaf, command: null }];
    for (let at = parent.get(leaf); at; at = parent.get(at.from)) path.unshift({ state: at.from, command: at.command });
    const commands: Tried[] = [];
    for (const { state, command } of path) {
      for (const [key, loop] of loops.get(state) ?? []) {
        if (dropped(loop) || used.has(`${state}\u0000${key}`)) continue;
        used.add(`${state}\u0000${key}`);
        commands.push({ command: loop, loop: true });
      }
      if (command) commands.push({ command, loop: false });
    }
    if (commands.length) out.push({ commands, leaf });
  }
  report.leaves = out.length;
  return out;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Replay one history with `decide` from the empty journal, neutralising cancels' interrupt controls as the host does. */
export function replay(commands: Tried[], report: Report): { steps: Step[]; log: RoomEvent[]; modified: boolean } {
  let modified = false;
  // An output with receipts becomes a confirm_sync per receipt and the output without them, as one group.
  const pending: Tried[] = commands.flatMap((tried, group) => {
    const c = tried.command;
    if (c.type !== "output" || !c.receipts?.length) return [tried];
    report.receiptsSplit += 1;
    modified = true;
    const { receipts, ...output } = c;
    const runId = c.association.kind === "run" ? c.association.id : "";
    return [
      ...receipts.map((r, n): Tried => ({ command: { type: "confirm_sync", actor: "$system", id: `${c.id}:confirm:${n + 1}`, runId, receiptId: r.id, digest: r.digest, evidence: "exact sync receipt in the transcript" }, loop: tried.loop, group })),
      { command: output as Command, loop: tried.loop, group },
    ];
  });
  const failedGroups = new Set<number>();
  const steps: Step[] = [];
  let log: RoomEvent[] = [];
  while (pending.length) {
    const { command, loop, group, neutraliser } = pending.shift()!;
    if (group !== undefined && failedGroups.has(group)) continue;
    const leftOut = command.type === "control_phase";
    let decision: Decision;
    try {
      decision = decide(log, command);
    } catch (error) {
      const text = message(error);
      const p = fold(log);
      const stopping = (id: string | null | undefined) => id != null && p.seats.get(id)?.status === "stopping";
      if ((text === "author seat is not active" && stopping(command.actor))
        || (text === "orchestrator must be an active seat" && command.type === "designate" && stopping(command.seatId))) {
        report.droppedStopping += 1;
        modified = true;
        continue;
      }
      if (neutraliser) throw new Error(`a neutralising control_phase was refused: ${text}`);
      if (leftOut) report.controlRefused += 1;
      if (group !== undefined) failedGroups.add(group);
      steps.push({ command, ...(leftOut ? { leftOut: "control" as const } : {}), expect: { error: text } });
      continue;
    }
    if (loop && decision.events.length) {
      // Recorded as changing nothing, yet the core appends: the store refused it for its own state (a damaged index in a
      // store fault test), not for the room's. Not a decision of the core; left out.
      report.storeOnly += 1;
      if (group !== undefined) failedGroups.add(group);
      continue;
    }
    steps.push({ command, ...(leftOut ? { leftOut: "control" as const } : {}), expect: { outcome: decision.outcome, expectedSeq: decision.expectedSeq, events: plain(decision.events) } });
    log = [...log, ...decision.events];
    for (const event of decision.events) {
      if (event.data.kind !== "control.prepared" || event.data.control.kind !== "interrupt") continue;
      const controlId = event.data.control.id;
      const later = pending.findIndex(({ command: c }) => c.type === "control_phase" && c.controlId === controlId && c.phase === "obsolete");
      if (later >= 0) {
        if (later > 0) { report.moved += 1; modified = true; }
        pending.unshift({ ...pending.splice(later, 1)[0]!, neutraliser: true });
      } else {
        report.neutralised += 1;
        modified = true;
        pending.unshift({ command: { type: "control_phase", actor: "$system", id: `golden:obsolete:${controlId}`, controlId, phase: "obsolete", evidence: "lean: interrupt sent directly" }, loop: false, neutraliser: true });
      }
    }
  }
  return { steps, log, modified };
}

/** The same history through an EngineStore in memory: where it differs from `decide`, the step says what the store does. */
function throughStore(steps: Step[], log: RoomEvent[], report: Report): void {
  const store = new EngineStore(":memory:");
  try {
    for (const step of steps) {
      let got: { error: string } | { outcome: string; events: RoomEvent[] };
      try {
        const receipt = store.execute("golden", step.command);
        got = { outcome: receipt.replayed ? "replayed" : receipt.outcome, events: plain(receipt.events) };
      } catch (error) {
        got = { error: message(error) };
      }
      const want = step.expect;
      const same = "error" in want ? "error" in got && got.error === want.error
        : "outcome" in got && (got.outcome === want.outcome || got.outcome === "replayed" && want.outcome === "duplicate")
          && (got.outcome === "replayed" || canonical(got.events) === canonical(want.events));
      if (!same) {
        report.storeDiffers += 1;
        step.store = "error" in got ? { error: got.error } : { outcome: got.outcome };
      }
    }
    assert.equal(canonical(keptMaps(store.project("golden"))), canonical(keptMaps(fold(log))), "store and fold disagree on the kept maps");
  } finally {
    store.close();
  }
}

function main(): void {
  const reuse = process.argv.includes("--reuse-raw");
  const totals: Record<string, Report> = {};
  for (const source of SOURCES) {
    if (!reuse) record(source);
    const lines = readFileSync(join(RAW, `${source.name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
    const report: Report = { receiptsSplit: 0, controlRefused: 0, storeOnly: 0, lines: lines.length, states: 0, leaves: 0, sequences: 0, steps: 0, cut: {}, neutralised: 0, moved: 0, droppedStopping: 0, storeDiffers: 0, digestChecked: 0 };
    const sequences: Sequence[] = [];
    for (const [index, { commands, leaf }] of histories(lines, report).entries()) {
      const { steps, log, modified } = replay(commands, report);
      if (!modified) {
        assert.equal(stateOf(log), leaf, `${source.name}: the replayed history does not reach its recorded state`);
        report.digestChecked += 1;
      }
      if (!steps.some((s) => !("error" in s.expect) && s.expect.events.length)) continue;
      throughStore(steps, log, report);
      sequences.push({ name: `${source.name}#${index + 1}`, steps, maps: keptMaps(fold(log)) });
      report.steps += steps.length;
    }
    report.sequences = sequences.length;
    totals[source.name] = report;
    const body = sequences.map((s) => `  {"name":${JSON.stringify(s.name)},"steps":[\n${s.steps.map((step) => `    ${JSON.stringify(step)}`).join(",\n")}\n  ],"maps":${JSON.stringify(s.maps)}}`).join(",\n");
    writeFileSync(join(here, `${source.name}.json`), `{"source":${JSON.stringify(source.file)},"core":${JSON.stringify(CORE)},"sequences":[\n${body}\n]}\n`);
    console.log(`${source.name}: ${JSON.stringify(report)}`);
  }
  writeFileSync(join(RAW, "report.json"), `${JSON.stringify(totals, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

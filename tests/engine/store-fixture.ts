import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { EngineStore, fold } from "../../src/engine/index.ts";
import type { Command, CommitReceipt, Disposition, Run, StoreOptions } from "../../src/engine/index.ts";

type OptionalId<T> = T extends unknown ? Omit<T, "id"> & { id?: string } : never;
export class DiskRoom {
  readonly dir: string;
  readonly path: string;
  readonly room = "room";
  store: EngineStore;
  private serial = 0;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "backroom-engine-store-"));
    this.path = join(this.dir, "engine.sqlite");
    this.store = new EngineStore(this.path);
    for (const seatId of ["O", "W", "V", "X"]) this.add({ type: "seat", actor: "$user", seatId, threadId: `thread:${seatId}`, orchestrator: seatId === "O" });
  }
  id(prefix = "cmd"): string { return `${prefix}:${++this.serial}`; }
  add(command: OptionalId<Command>): CommitReceipt {
    return this.store.execute(this.room, { ...command, id: command.id ?? this.id() } as Command);
  }
  get p() { return this.store.project(this.room); }
  request(id: string, to = "W", actor = "O", parentId?: string): void {
    this.add({ id, type: "request", actor, to, body: `Content ${id}`, ...(parentId ? { parentId } : {}) });
  }
  reserveCommand(seatId = "W", id = this.id("reserve")): Command {
    return { type: "reserve", actor: "$system", id, seatId, runId: `run:${id}`, dispatchCommandId: `dispatch:${id}`, dispatchMessageId: `message:${id}`, maxBytes: 1_000_000 };
  }
  reserve(seatId = "W", accepted = true): Run {
    const c = this.reserveCommand(seatId) as Extract<Command, { type: "reserve" }>;
    this.add(c);
    if (accepted) this.add({ type: "phase", actor: "$system", runId: c.runId, phase: "accepted", evidence: "FAKE local provider receipt, no external guarantee" });
    return this.p.runs.get(c.runId)!;
  }
  outputCommand(run: Run, disposition: Disposition, extra: Partial<Extract<Command, { type: "output" }>> = {}): Command {
    const id = this.id("output");
    return { id, type: "output", actor: "$system", author: run.seatId, sourceKey: `source:${id}`, association: { kind: "run", id: run.id }, body: disposition.kind === "silent" ? "" : "Output", disposition, terminal: true, ...extra };
  }
  sync(run: Run): { id: string; digest: string } {
    const receiptId = this.id("receipt");
    this.add({ type: "sync", actor: "$system", runId: run.id, receiptId, maxBytes: 1_000_000 });
    const r = this.p.runs.get(run.id)!.receipts.find((r) => r.id === receiptId)!;
    return { id: r.id, digest: r.digest };
  }
  reopen(options?: StoreOptions): void { this.store.close(); this.store = new EngineStore(this.path, options); }
  parity(): void {
    assert.deepEqual(this.store.audit(this.room), { ok: true, mismatches: [], head: this.store.load(this.room).length });
    assert.deepEqual(this.p, fold(this.store.load(this.room)));
  }
  cleanup(): void { this.store.close(); rmSync(this.dir, { recursive: true, force: true }); }
}

export interface WorkerInput {
  path: string; room: string; command: Command;
  action?: "rebuild";
  fault?: string; marker?: string; ready?: string; go?: string; holdReady?: string; holdGo?: string;
}
export interface WorkerResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export function worker(input: WorkerInput): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", new URL("./store-worker.ts", import.meta.url).pathname, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s: Buffer) => { stdout += s.toString(); });
    child.stderr.on("data", (s: Buffer) => { stderr += s.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`worker timed out: ${stdout} ${stderr}`)); }, 12_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
export async function waitForFiles(paths: string[]): Promise<void> {
  const end = Date.now() + 8000;
  while (!paths.every(existsSync)) {
    if (Date.now() > end) throw new Error(`barrier timed out: ${paths.join(", ")}`);
    await delay(5);
  }
}

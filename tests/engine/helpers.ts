import assert from "node:assert/strict";
import { decide, fold, unread } from "../../src/engine/index.ts";
import type { Command, Decision, Disposition, Projection, RoomEvent, Run } from "../../src/engine/index.ts";

type OptionalId<T> = T extends unknown ? Omit<T, "id"> & { id?: string } : never;
export class Room {
  log: RoomEvent[] = [];
  private serial = 0;
  constructor() {
    for (const id of ["O", "W", "V", "X"]) this.add({ type: "seat", actor: "$user", seatId: id, threadId: `thread:${id}`, orchestrator: id === "O" });
  }
  id(prefix = "c"): string { return `${prefix}${++this.serial}`; }
  add(command: OptionalId<Command>): Decision {
    const full = { ...command, id: command.id ?? this.id() } as Command;
    const before = JSON.stringify(this.log);
    const decision = decide(this.log, full);
    assert.equal(JSON.stringify(this.log), before, "decision must not mutate existing events");
    assert.equal(decision.expectedSeq, this.log.length);
    this.log = [...this.log, ...decision.events];
    return decision;
  }
  get p(): Projection { return fold(this.log); }
  request(id: string, to = "W", actor = "O", parentId?: string): void {
    this.add({ type: "request", id, actor, to, body: `Content of ${id}`, ...(parentId ? { parentId } : {}) });
  }
  reserve(seatId: string, maxBytes = 1_000_000): Run | null {
    const id = this.id("run");
    const decision = this.add({ type: "reserve", actor: "$system", seatId, runId: id, maxBytes, dispatchCommandId: `dispatch:${id}`, dispatchMessageId: `message:${id}` });
    if (decision.outcome !== "appended") return null;
    this.add({ type: "phase", actor: "$system", runId: id, phase: "accepted", evidence: "fake durable dispatch receipt" });
    return this.p.runs.get(id)!;
  }
  output(run: Run, disposition: Disposition, terminal = true, extra: Partial<Extract<Command, { type: "output" }>> = {}): Decision {
    return this.add({ type: "output", actor: "$system", author: run.seatId, sourceKey: this.id("source"), association: { kind: "run", id: run.id },
      body: disposition.kind === "silent" ? "" : `Output from ${run.id}`, disposition, terminal, ...extra });
  }
  finish(run: Run, ...ids: string[]): Decision { return this.output(run, { kind: "answer", requestIds: ids }); }
  sync(run: Run): { id: string; digest: string } {
    const receiptId = this.id("receipt");
    this.add({ type: "sync", actor: run.seatId, runId: run.id, receiptId, maxBytes: 1_000_000 });
    const receipt = this.p.runs.get(run.id)!.receipts.find((r) => r.id === receiptId)!;
    return { id: receipt.id, digest: receipt.digest };
  }
  restart(): void { this.log = JSON.parse(JSON.stringify(this.log)) as RoomEvent[]; }
  idle(...seats: string[]): void {
    const before = JSON.stringify(this.log);
    for (let i = 0; i < 5; i++) for (const seat of seats) assert.equal(this.reserve(seat), null);
    assert.equal(JSON.stringify(this.log), before, "idle checks create no records");
    this.restart();
    for (const seat of seats) assert.equal(unread(this.p, seat).length, 0);
  }
}
export function outcomes(decision: Decision): string[] {
  return decision.events.flatMap((e) => e.data.kind === "output" ? e.data.claims.map((c) => c.outcome) : []);
}
export function assertions(r: Room): void {
  const p = r.p;
  for (const s of p.seats.values()) assert.ok([...p.runs.values()].filter((run) => run.seatId === s.id && run.phase !== "terminal").length <= 1);
  for (const q of p.requests.values()) assert.ok(r.log.flatMap((e) => e.data.kind === "output" ? e.data.claims : []).filter((c) => c.requestId === q.id && c.outcome === "answered").length <= 1);
  for (const run of p.runs.values()) assert.ok(run.envelope.inputs.length > 0, "only genuine board input reserves a run");
  assert.equal(new Set(p.sourceKeys.keys()).size, p.sourceKeys.size);
  assert.equal("tasks" in p || "inbox" in p || "queue" in p || "dependencies" in p, false);
  assert.equal(r.log.some((e) => /task|wake|return_job|dependency/.test(e.data.kind)), false, "zero synthetic task/return records");
}

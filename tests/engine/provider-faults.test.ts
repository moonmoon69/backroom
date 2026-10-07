import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DiskRoom } from "./store-fixture.ts";
import { FakeEngineProvider } from "../../src/adapter/engine-fake.ts";
import type { FakeProviderState } from "../../src/adapter/engine-fake.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import type { ReconcilerBoundary } from "../../src/engine/reconciler.ts";
import { unread } from "../../src/engine/index.ts";

async function killWorker(path: string, provider: string, boundary: ReconcilerBoundary, marker: string, action: string, runId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", new URL("./provider-worker.ts", import.meta.url).pathname,
      JSON.stringify({ path, provider, boundary, marker, action, runId })], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr.on("data", (b: Buffer) => { errors += b.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("provider worker timeout")); }, 8000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => { clearTimeout(timer); if (signal === "SIGKILL" && existsSync(marker)) resolve(); else reject(new Error(`worker failed code=${code} signal=${signal}: ${errors}`)); });
  });
}
for (const action of ["run", "control", "import"] as const) {
  const boundaries: ReconcilerBoundary[] = action === "import" ? ["after_import"] : ["after_freeze", "before_send", "after_send"];
  for (const boundary of boundaries) test(`SIGKILL actual reconciler ${action}/${boundary}: no new identity/blind replacement`, async () => {
    const d = new DiskRoom(), f = new FakeEngineProvider();
    try {
      d.request("A"); const r = d.reserve("W", false); const x = new EngineReconciler(d.store, f);
      if (boundary !== "after_freeze" || action !== "run") await x.prepareRun(d.room, r.id, { instanceId: "FAKE", model: "FAKE-model" });
      if (action !== "run") {
        await x.tick(d.room, "W"); await x.tick(d.room, "W");
        if (action === "control") {
          d.add({ id: "Q", type: "request", actor: "W", to: "O", body: "Question", parentId: "A", live: { runId: r.id, providerRequestId: "runtime:Q" } });
          d.add({ id: "reply", type: "runtime_reply", actor: "O", requestId: "Q", commandId: "response:Q", body: JSON.stringify({ answers: { choice: "yes" } }) });
          f.state.snapshots["thread:W"]!.questions.push({ id: "runtime:Q", runId: `FAKE:${r.dispatchMessageId}`, status: "pending", mode: "live", kind: "user_input" });
        } else {
          const s = f.state.snapshots["thread:W"]!; s.runs[0]!.status = "completed"; s.pending = []; s.idle = true;
          s.emissions.push({ id: "out", runId: s.runs[0]!.id, activityId: null, body: "done", disposition: { kind: "answer", requestIds: ["A"] }, complete: true, final: true, receipts: [] });
          d.request("B");
        }
      }
      const provider = join(d.dir, "provider.json"), marker = join(d.dir, "killed.txt"); writeFileSync(provider, JSON.stringify(f.state));
      await killWorker(d.path, provider, boundary, marker, action, r.id);
      d.reopen(); const recovered = new FakeEngineProvider(JSON.parse(readFileSync(provider, "utf8")) as FakeProviderState);
      const y = new EngineReconciler(d.store, recovered);
      await y.tick(d.room, "W"); await y.tick(d.room, "W");
      assert.equal(recovered.state.sends.length, action === "control" ? 2 : 1);
      assert.equal(d.p.runs.size, 1); assert.equal(d.p.runs.get(r.id)!.dispatchMessageId, r.dispatchMessageId);
      if (action === "control") assert.equal(d.p.controls.get("reply")!.phase, "accepted");
      if (action === "import") {
        assert.equal(d.p.runs.get(r.id)!.phase, "terminal");
        assert.deepEqual(unread(d.p, "W").map((i) => i.eventId), ["B"]);
        assert.equal(d.store.load(d.room).filter((e) => e.data.kind === "output").length, 1);
      }
      d.parity();
    } finally { d.cleanup(); }
  });
}

test("SIGKILL inside attempt/sending transaction leaves both records before or both after commit", async () => {
  const { worker } = await import("./store-fixture.ts");
  for (const fault of ["before_begin", "after_event:0", "after_event:1", "after_indices", "before_commit", "after_commit"]) {
    const d = new DiskRoom(), f = new FakeEngineProvider();
    try { d.request("A"); const r = d.reserve("W", false), x = new EngineReconciler(d.store, f);
      await x.prepareRun(d.room, r.id, { instanceId: "FAKE", model: "FAKE" });
      const marker = join(d.dir, "attempt-kill.txt");
      const result = await worker({ path: d.path, room: d.room, fault, marker,
        command: { type: "transport_attempt", id: "attempt", actor: "$system", target: { kind: "run", id: r.id }, expectedAttempts: 0, evidence: "FAKE first send precondition" } });
      assert.equal(result.signal, "SIGKILL"); assert.ok(existsSync(marker)); d.reopen();
      const recovered = d.p.runs.get(r.id)!;
      assert.equal(recovered.transport!.attempts, fault === "after_commit" ? 1 : 0);
      assert.equal(recovered.phase, fault === "after_commit" ? "sending" : "prepared");
      assert.equal(f.state.sends.length, 0); d.parity();
    } finally { d.cleanup(); }
  }
});

test("SIGKILL provider observation atomically retains sequence floor AND known native hold before stale recovery", async () => {
  const { worker } = await import("./store-fixture.ts");
  for (const fault of ["before_begin", "after_event:0", "after_event:1", "after_indices", "before_commit", "after_commit"]) {
    const d = new DiskRoom(), f = new FakeEngineProvider();
    try {
      const marker = join(d.dir, "observation-kill.txt");
      const observation = { seatId: "W", threadId: "thread:W", environmentId: "FAKE-env", serverVersion: "FAKE-version", contract: "FAKE-contract-v1", sequence: 12 };
      const result = await worker({ path: d.path, room: d.room, fault, marker,
        command: { type: "observe_provider", id: "observe", actor: "$system", observation, pending: ["background:pt:child"], settled: [] } });
      assert.equal(result.signal, "SIGKILL"); assert.ok(existsSync(marker)); d.reopen();
      const committed = fault === "after_commit";
      assert.equal(d.p.providerObservations.has("W"), committed);
      assert.equal([...d.p.providerHolds.values()].some((h) => h.held && h.code === "native_pending"), committed);
      f.state.snapshots["thread:W"] = { ...(await f.inspect("thread:W")), sequence: 2 };
      const y = new EngineReconciler(d.store, f);
      assert.equal((await y.quiescence(d.room, "W")).proven, !committed);
      assert.equal(f.state.sends.length, 0); d.parity();
    } finally { d.cleanup(); }
  }
});

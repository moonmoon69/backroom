import { readFileSync, writeFileSync } from "node:fs";
import { EngineStore } from "../../src/engine/store.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import type { ReconcilerBoundary } from "../../src/engine/reconciler.ts";
import { FakeEngineProvider } from "../../src/adapter/engine-fake.ts";
import type { FakeProviderState } from "../../src/adapter/engine-fake.ts";

const a = JSON.parse(process.argv[2]!) as { path: string; provider: string; boundary: ReconcilerBoundary; marker: string; action: "run" | "control" | "import"; runId: string };
const store = new EngineStore(a.path), f = new FakeEngineProvider(JSON.parse(readFileSync(a.provider, "utf8")) as FakeProviderState);
const save = () => writeFileSync(a.provider, JSON.stringify(f.state));
f.onCommit = save; // Fake acceptance lives separately from the room store before the worker dies.
const x = new EngineReconciler(store, f, { onBoundary(boundary) {
  if (boundary === a.boundary) {
    save(); writeFileSync(a.marker, boundary); process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not terminate worker");
  }
} });
if (a.boundary === "after_freeze" && a.action === "run") await x.prepareRun("room", a.runId, { instanceId: "FAKE", model: "FAKE-model" });
else await x.tick("room", "W");
save(); store.close(); throw new Error("fault boundary was not reached");

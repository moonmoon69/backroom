import { existsSync, writeFileSync } from "node:fs";
import { EngineStore } from "../../src/engine/index.ts";
import type { WorkerInput } from "./store-fixture.ts";

const input = JSON.parse(process.argv[2]!) as WorkerInput;
function waitFor(path: string): void {
  const end = Date.now() + 8000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`worker barrier timed out: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let store: EngineStore | undefined;
try {
  store = new EngineStore(input.path, { onBoundary(point, eventIndex) {
    const label = point === "after_event" ? `${point}:${eventIndex}` : point;
    if (label === input.fault) {
      if (input.marker) writeFileSync(input.marker, label);
      process.kill(process.pid, "SIGKILL");
    }
    if (point === "after_read" && input.holdReady && input.holdGo) {
      writeFileSync(input.holdReady, "writer lock held");
      waitFor(input.holdGo);
    }
  } });
  if (input.ready) writeFileSync(input.ready, "connection open");
  if (input.go) waitFor(input.go);
  const receipt = input.action === "rebuild" ? store.rebuild(input.room) : store.execute(input.room, input.command);
  process.stdout.write(JSON.stringify({ ok: true, receipt }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { store?.close(); }

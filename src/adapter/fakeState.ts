/**
 * A fake T3 that outlives the service (ROOMS_FAKE_STATE=<file>; scripts/rehearse.ts --step room kills the service and
 * starts it again). Real T3 is a process of its own: its threads, runs and command receipts are still there when
 * Backroom comes back. So the fake keeps them in a file, written after every call that may change them and read back
 * at start. Without the variable nothing is written and the fake stays in memory only.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { FakeState, FakeT3Adapter } from "./fake.ts";

/** Calls that only read (or touch state T3 would not keep): no write after them. */
const READS = /^(list|get|describe|versions|browse|default|report|refresh|state|feed|on[A-Z]|holdThreads$|leaseThread$|threadPushed$)/;

export function persistFake(fake: FakeT3Adapter, file: string): FakeT3Adapter {
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(fake.state()));
    renameSync(`${file}.tmp`, file);
  };
  // Calls the fake makes on itself are inside an outer call: only the outermost one writes, once it has returned.
  let depth = 0;
  const adapter = new Proxy(fake, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key !== "string") return value;
      return function (this: unknown, ...args: unknown[]) {
        depth += 1;
        try {
          return value.apply(this, args);
        } finally {
          depth -= 1;
          if (depth === 0 && !READS.test(key)) save();
        }
      };
    },
  });
  // Through the proxy, so the timers it arms for runs still going write the file when they end them.
  if (existsSync(file)) adapter.restore(JSON.parse(readFileSync(file, "utf8")) as FakeState);
  return adapter;
}

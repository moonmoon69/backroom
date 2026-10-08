/** The canonical bytes and chained journal digests the golden recorder and generator share. */
import { createHash } from "node:crypto";
import type { RoomEvent } from "../../../src/engine/index.ts";

/** Sorted keys, undefined dropped: the same bytes for a value however it was built or parsed. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((k) => object[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}

/** State digest of a journal prefix: each event chained onto the digest before it. The empty journal is "root". */
const memo = new WeakMap<object, { prev: string; digest: string }>();
export function stateOf(events: readonly RoomEvent[], length = events.length): string {
  let digest = "root";
  for (let i = 0; i < length; i++) {
    const event = events[i]!;
    const known = memo.get(event);
    if (known && known.prev === digest) {
      digest = known.digest;
      continue;
    }
    const next = createHash("sha256").update(digest).update(canonical({ id: event.id, seq: event.seq, commandKey: event.commandKey, data: event.data })).digest("hex");
    memo.set(event, { prev: digest, digest: next });
    digest = next;
  }
  return digest;
}

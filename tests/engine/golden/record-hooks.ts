/**
 * Module hook for record.ts (L6 step 1): wraps the core's `decide` as it loads, so every call a test makes is recorded.
 * The file on disk is untouched; only the module text this process runs gets a wrapper appended.
 */
import type { LoadHook } from "node:module";

export const load: LoadHook = async (url, context, nextLoad) => {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/src/engine/transitions.ts") || result.source === undefined) return result;
  const text = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source as Uint8Array);
  if (!text.includes("export function decide(")) throw new Error("golden recorder: decide not found in transitions.ts");
  const source = `${text.replace("export function decide(", "function goldenUnwrappedDecide(")}
export function decide(log: readonly RoomEvent[], command: Command): Decision {
  let decision: Decision | undefined;
  let failure: unknown;
  try { decision = goldenUnwrappedDecide(log, command); } catch (error) { failure = error; }
  (globalThis as { goldenRecord?: (...args: unknown[]) => void }).goldenRecord?.("decide", log, command, decision, failure);
  if (decision === undefined) throw failure;
  return decision;
}
`;
  return { ...result, source };
};

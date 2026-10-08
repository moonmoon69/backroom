import type { CommandResult } from "./types.ts";

type ThreadResult = Extract<CommandResult, { type: "room.deleted" }>["threads"][number];

/**
 * The toast after a room is deleted: each thread's result, neutral when every thread was done or kept, an error only
 * when T3 refused an action or had not answered it in time.
 */
export function roomDeletedToast(title: string, threads: ThreadResult[]): { message: string; kind: "info" | "error" } {
  const past = (action: string) => (action === "delete" ? "deleted" : `${action}d`);
  const settled = threads.filter((t) => t.result === "done" || t.result === "kept");
  const late = threads.filter((t) => t.result === "timeout").map((t) => `@${t.alias} ${t.action}`);
  const failed = threads.filter((t) => t.result === "failed").map((t) => `@${t.alias}: ${t.detail ?? "failed"}`);
  const allKept = settled.length > 0 && settled.every((t) => t.result === "kept" && !t.detail) && late.length === 0 && failed.length === 0;
  const parts = [
    `Deleted "${title}".`,
    allKept
      ? "Threads kept in T3."
      : settled.length > 0
        ? `Threads: ${settled.map((t) => (t.result === "done" ? `@${t.alias} ${past(t.action)}` : `@${t.alias} kept${t.detail ? ` (${t.detail})` : ""}`)).join(", ")}.`
        : "",
    late.length > 0 ? `Sent to T3, not confirmed in time (may still go through): ${late.join(", ")}.` : "",
    failed.length > 0 ? `Not changed in T3: ${failed.join("; ")}.` : "",
  ];
  return { message: parts.filter(Boolean).join(" "), kind: late.length > 0 || failed.length > 0 ? "error" : "info" };
}

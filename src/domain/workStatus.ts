/**
 * What is going on in a room, by what it asks of the user: things that need them, things being worked on, things
 * waiting their turn. The status bar above the conversation shows these; the service counts the first group for the
 * room's "needs you" badge in the sidebar with the same rule.
 */
import type { Task } from "./types.ts";

/**
 * Tasks that wait on the user: an approval or question (needs_input), work held until released or blocked until
 * unblocked, and a failure that is still the last thing its member was given (an older one was followed by other
 * work) and has not been dismissed.
 *
 * In a room that has a Consigliere, a worker's failure is his to deal with (he meets it when he gives that member
 * work, and it is on the board), so only his own failure waits on the user. What Backroom sent by itself (a seat
 * briefing) never does, beyond an approval or question it raised.
 */
export function tasksNeedingYou<T extends Pick<Task, "id" | "participantId" | "state" | "number" | "kind" | "dismissedAt">>(tasks: T[], consigliereId: string | null = null): T[] {
  const latest = new Map<string, number>();
  for (const task of tasks) latest.set(task.participantId, Math.max(latest.get(task.participantId) ?? 0, task.number));
  return tasks.filter((task) => {
    if (task.state === "needs_input") return true;
    if (task.kind === "seat") return false;
    if (task.state === "held" || task.state === "blocked") return true;
    if (task.state !== "failed" || task.dismissedAt !== null || latest.get(task.participantId) !== task.number) return false;
    return consigliereId === null || task.participantId === consigliereId;
  });
}

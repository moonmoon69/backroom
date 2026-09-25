/** Dependency-graph checks: self-edges, cycles, and revision-pinned references. */
import type { PrerequisiteRef, Task, TaskId } from "./types.ts";

export interface GraphIssue {
  code: "self_edge" | "cycle" | "missing" | "stale_prerequisite";
  message: string;
}

/**
 * Validate the prerequisite set for a task (existing or prospective) against the room's tasks.
 * `taskId` may be null for a task that does not exist yet.
 */
export function validatePrerequisites(
  taskId: TaskId | null,
  prerequisites: PrerequisiteRef[],
  tasks: ReadonlyMap<TaskId, Task>,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  for (const ref of prerequisites) {
    if (taskId !== null && ref.taskId === taskId) {
      issues.push({ code: "self_edge", message: "a task cannot depend on itself" });
      continue;
    }
    const target = tasks.get(ref.taskId);
    if (!target) {
      issues.push({ code: "missing", message: `prerequisite ${ref.taskId} does not exist in this room` });
      continue;
    }
    if (target.revision !== ref.revision) {
      issues.push({
        code: "stale_prerequisite",
        message: `prerequisite task${target.number} revision ${ref.revision} is stale; current revision is ${target.revision}`,
      });
    }
  }
  if (issues.length > 0) return issues;
  if (taskId !== null && hasCycle(taskId, prerequisites, tasks)) {
    issues.push({ code: "cycle", message: "prerequisites would create a dependency cycle" });
  }
  return issues;
}

function hasCycle(taskId: TaskId, prerequisites: PrerequisiteRef[], tasks: ReadonlyMap<TaskId, Task>): boolean {
  // DFS from each prerequisite following prerequisite edges; a path back to taskId is a cycle.
  const stack = prerequisites.map((ref) => ref.taskId);
  const seen = new Set<TaskId>();
  while (stack.length > 0) {
    const current = stack.pop() as TaskId;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const task = tasks.get(current);
    if (!task) continue;
    for (const ref of task.prerequisites) stack.push(ref.taskId);
  }
  return false;
}

/** Tasks whose prerequisite set references the given task (any revision). */
export function dependentsOf(taskId: TaskId, tasks: Iterable<Task>): Task[] {
  const result: Task[] = [];
  for (const task of tasks) {
    if (task.prerequisites.some((ref) => ref.taskId === taskId)) result.push(task);
  }
  return result;
}

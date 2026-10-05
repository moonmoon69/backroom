/**
 * Where a new thread works, as T3 is asked to launch it (orchestration.launchThread): the project folder; a worktree
 * that exists (checked here to belong to the project); or a new worktree, which T3 makes from the chosen base branch
 * when it creates the thread (fetch, checkout, the project's setup script). The folder exists, and every briefing
 * can name it, before any task is sent.
 */
import { T3CommandRejected, T3Unavailable, type T3Adapter, type WorkspaceStrategy } from "../adapter/types.ts";
import type { WorkspaceChoice } from "../domain/commands.ts";
import { RoomError } from "../domain/errors.ts";

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** A branch-name fragment from free text: lowercase letters, digits and dashes. */
export function branchSlug(text: string, fallback: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || fallback;
}

/**
 * The branch for a participant's new worktree when none was typed: named after the room and the participant (it does
 * many tasks, so no one task names it well). A thread of its own names none: T3 generates its branch from the first
 * message, as in T3 Code.
 */
function participantBranch(taken: ReadonlySet<string>, owner: { roomTitle: string; alias: string }): string {
  const base = `${branchSlug(owner.roomTitle, "room")}/${branchSlug(owner.alias, "agent")}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

const t3Error = (error: unknown, what: string): unknown => {
  if (error instanceof T3Unavailable) return new RoomError("t3_unavailable", error.message, 503);
  if (error instanceof T3CommandRejected) return new RoomError("worktree_failed", `T3 could not ${what}: ${error.message}`, 422);
  return error;
};

export async function resolveWorkspace(
  adapter: T3Adapter,
  projectId: string,
  choice: WorkspaceChoice | undefined,
  owner: { roomTitle: string; alias: string } | null,
): Promise<WorkspaceStrategy> {
  if (!choice || choice.mode === "local") return { type: "root" };
  let refs: Awaited<ReturnType<T3Adapter["listRefs"]>>;
  try {
    const project = (await adapter.listProjects()).find((p) => p.id === projectId);
    if (!project) throw new RoomError("unknown_project", `T3 project ${projectId} was not found`);
    refs = await adapter.listRefs(project.workspaceRoot);
  } catch (error) {
    throw t3Error(error, "read the project's branches");
  }
  if (!refs.isRepo) throw new RoomError("not_a_repository", "The project folder is not a git repository, so it has no worktrees; work in the project folder.", 422);

  if (choice.mode === "existing") {
    const wanted = trimSlash(choice.worktreePath);
    const ref = refs.refs.find((r) => r.worktreePath !== null && trimSlash(r.worktreePath) === wanted);
    if (!ref || !ref.worktreePath) throw new RoomError("unknown_worktree", `${choice.worktreePath} is not a worktree of this project with a branch checked out`, 422);
    return { type: "existing_worktree", worktreePath: ref.worktreePath, branch: ref.name };
  }

  if (!refs.refs.some((r) => r.name === choice.baseBranch)) throw new RoomError("worktree_failed", `T3 could not make a worktree: ${choice.baseBranch} is not a branch of this project`, 422);
  const branch = choice.branch ?? (owner ? participantBranch(new Set(refs.refs.map((r) => r.name)), owner) : undefined);
  if (branch && refs.refs.some((r) => r.name === branch)) throw new RoomError("worktree_failed", `T3 could not make a worktree: a branch named '${branch}' already exists`, 422);
  return { type: "worktree", baseRef: choice.baseBranch, ...(branch ? { branch } : {}) };
}

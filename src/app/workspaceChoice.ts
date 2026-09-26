/**
 * Where a new thread works, made ready before the thread is created (T3 then starts the agent in that folder): nothing
 * to do for the project folder; for an existing worktree, a check that it belongs to the project; for a new worktree,
 * T3 makes it (vcs.createWorktree) from the chosen base branch, in its worktrees folder.
 *
 * T3 Code itself makes a new thread's worktree when the first message is sent. The room makes it when the thread is
 * created instead, so the folder exists (and every briefing can name it) before any task, and the scheduler never
 * waits on a checkout. What that skips is T3's worktree setup script, which only runs on T3's own path.
 */
import { randomBytes } from "node:crypto";
import { T3CommandRejected, T3Unavailable, type T3Adapter } from "../adapter/types.ts";
import type { WorkspaceChoice } from "../domain/commands.ts";
import { RoomError } from "../domain/errors.ts";

export interface PreparedWorkspace {
  branch: string | null;
  worktreePath: string | null;
  /** The project folder the worktree was made from, when the room made it (to remove it if the thread fails). */
  madeFrom: string | null;
}

const LOCAL: PreparedWorkspace = { branch: null, worktreePath: null, madeFrom: null };

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** A branch-name fragment from free text: lowercase letters, digits and dashes. */
export function branchSlug(text: string, fallback: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || fallback;
}

/**
 * The branch for a new worktree when none was typed. A participant's is named after the room and the participant
 * (it does many tasks, so no one task names it well); a thread of its own gets T3's temporary name, which T3 replaces
 * with one generated from the first message, as in T3 Code.
 */
function defaultBranch(taken: ReadonlySet<string>, owner: { roomTitle: string; alias: string } | null): string {
  if (!owner) return `t3code/${randomBytes(4).toString("hex")}`;
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

export async function prepareWorkspace(
  adapter: T3Adapter,
  projectId: string,
  choice: WorkspaceChoice | undefined,
  owner: { roomTitle: string; alias: string } | null,
): Promise<PreparedWorkspace> {
  if (!choice || choice.mode === "local") return LOCAL;
  let root: string;
  let refs: Awaited<ReturnType<T3Adapter["listRefs"]>>;
  try {
    const project = (await adapter.listProjects()).find((p) => p.id === projectId);
    if (!project) throw new RoomError("unknown_project", `T3 project ${projectId} was not found`);
    root = project.workspaceRoot;
    refs = await adapter.listRefs(root);
  } catch (error) {
    throw t3Error(error, "read the project's branches");
  }
  if (!refs.isRepo) throw new RoomError("not_a_repository", "The project folder is not a git repository, so it has no worktrees; work in the project folder.", 422);

  if (choice.mode === "existing") {
    const wanted = trimSlash(choice.worktreePath);
    const ref = refs.refs.find((r) => r.worktreePath !== null && trimSlash(r.worktreePath) === wanted);
    if (!ref) throw new RoomError("unknown_worktree", `${choice.worktreePath} is not a worktree of this project with a branch checked out`, 422);
    return { branch: ref.name, worktreePath: ref.worktreePath, madeFrom: null };
  }

  const branch = choice.branch ?? defaultBranch(new Set(refs.refs.map((r) => r.name)), owner);
  try {
    const made = await adapter.createWorktree({ cwd: root, baseBranch: choice.baseBranch, branch });
    return { branch: made.branch, worktreePath: made.path, madeFrom: root };
  } catch (error) {
    throw t3Error(error, `make a worktree on ${branch} from ${choice.baseBranch}`);
  }
}

/** Undo a worktree the room made for a thread that then failed to be created. Best effort. */
export async function discardWorkspace(adapter: T3Adapter, prepared: PreparedWorkspace): Promise<void> {
  if (!prepared.madeFrom || !prepared.worktreePath) return;
  await adapter.removeWorktree({ cwd: prepared.madeFrom, path: prepared.worktreePath }).catch(() => undefined);
}

/**
 * Where a room's participants work: each one's folder (the T3 worktree its thread has, or else the project's folder,
 * which is where T3 starts the agent) and, read with git on this machine, the branch and commit checked out there.
 * The briefing tells every agent where everyone works, each finished task records where its work is, and the Git
 * tab groups the room by folder.
 */
import type { T3Adapter } from "../adapter/types.ts";
import type { Repos } from "../db/repos.ts";
import type { ArtifactRef, Participant } from "../domain/types.ts";
import { canonicalPath, readCheckoutSummary } from "./reader.ts";

/** A room folder and who works in it. */
export interface RoomFolder {
  path: string;
  participantIds: string[];
  isProjectRoot: boolean;
}

export interface Workspace {
  participantId: string;
  alias: string;
  /** Absolute folder; null when T3 names none (no project folder, thread unreadable). */
  folder: string | null;
  isProjectRoot: boolean;
  /** Branch checked out in the folder (git), else the branch T3 recorded for the thread. */
  branch: string | null;
  /** Full sha of the checked-out commit, when git can read the folder. */
  headSha: string | null;
  /** Uncommitted files in the folder; null when git can't read it here. */
  changed: number | null;
}

async function projectRootOf(adapter: T3Adapter, repos: Repos, roomId: string): Promise<string | null> {
  const room = repos.getRoom(roomId);
  if (!room) return null;
  const project = (await adapter.listProjects()).find((p) => p.id === room.projectId) ?? null;
  return project ? canonicalPath(project.workspaceRoot) : null;
}

/** Each active participant's folder and the branch T3 recorded for its thread. */
async function participantFolders(adapter: T3Adapter, repos: Repos, roomId: string): Promise<{ projectRoot: string | null; entries: Array<{ participant: Participant; folder: string | null; t3Branch: string | null }> }> {
  const projectRoot = await projectRootOf(adapter, repos, roomId);
  const entries = await Promise.all(
    repos.listActiveParticipants(roomId).map(async (participant) => {
      const binding = repos.currentBinding(participant.id);
      const shell = binding ? await adapter.getThreadShell(binding.threadId).catch(() => null) : null;
      return { participant, folder: shell?.worktreePath ? canonicalPath(shell.worktreePath) : projectRoot, t3Branch: shell?.branch ?? null };
    }),
  );
  return { projectRoot, entries };
}

/**
 * The room's folders: the ones participants work in (roster order), then the project's folder even when nobody
 * works there.
 */
export async function roomFolders(adapter: T3Adapter, repos: Repos, roomId: string): Promise<RoomFolder[]> {
  const { projectRoot, entries } = await participantFolders(adapter, repos, roomId);
  const folders = new Map<string, RoomFolder>();
  for (const { participant, folder } of entries) {
    if (!folder) continue;
    const entry = folders.get(folder) ?? { path: folder, participantIds: [], isProjectRoot: folder === projectRoot };
    entry.participantIds.push(participant.id);
    folders.set(folder, entry);
  }
  if (projectRoot && !folders.has(projectRoot)) folders.set(projectRoot, { path: projectRoot, participantIds: [], isProjectRoot: true });
  return [...folders.values()];
}

/** Where every active participant of the room works (or only `participantId`), each folder read with git once. */
export async function roomWorkspaces(adapter: T3Adapter, repos: Repos, roomId: string, options: { participantId?: string } = {}): Promise<Workspace[]> {
  const read = await participantFolders(adapter, repos, roomId);
  const projectRoot = read.projectRoot;
  const entries = options.participantId ? read.entries.filter((e) => e.participant.id === options.participantId) : read.entries;
  const folders = [...new Set(entries.map((e) => e.folder).filter((f): f is string => f !== null))];
  const summaries = new Map(await Promise.all(folders.map(async (folder) => [folder, await readCheckoutSummary(folder)] as const)));
  return entries.map(({ participant, folder, t3Branch }) => {
    const summary = folder ? summaries.get(folder) : undefined;
    const readable = Boolean(summary?.isRepo && !summary.error);
    return {
      participantId: participant.id,
      alias: participant.alias,
      folder,
      isProjectRoot: folder !== null && folder === projectRoot,
      branch: (readable ? summary!.branch : null) ?? t3Branch,
      headSha: readable ? summary!.headSha : null,
      changed: readable ? summary!.changed : null,
    };
  });
}

/** Where a participant's work is, as recorded with a finished task's reply. Null when the folder is unknown. */
export function workspaceArtifact(workspace: Workspace | undefined): ArtifactRef | null {
  if (!workspace?.folder) return null;
  return {
    kind: "workspace",
    path: workspace.folder,
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.headSha ? { commit: workspace.headSha } : {}),
    ...(workspace.changed !== null ? { note: workspace.changed === 0 ? "nothing uncommitted" : `${workspace.changed} file${workspace.changed === 1 ? "" : "s"} uncommitted` } : {}),
  };
}

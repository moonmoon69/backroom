/**
 * Projects and direct threads: T3 threads used on their own, outside any room. Nothing here is stored by the room
 * service; T3 holds the projects, threads and messages, and the room only forwards commands and reads them back.
 * A direct message goes to T3 exactly as typed (no briefing), like typing in T3 Code: it starts a run, or is steered
 * into the run in progress. A thread seated in a room is refused: the room coordinates it, and a message sent around
 * the room would bypass its queue. Reading a thread back is in threadView.ts.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { posix } from "node:path";
import type { Repos } from "../db/repos.ts";
import type { T3Adapter, T3ThreadShell, TurnImage } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable } from "../adapter/types.ts";
import type { InlineImage, RoomCommand } from "../domain/commands.ts";
import { RoomError, notFound } from "../domain/errors.ts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_TOTAL_BYTES } from "../domain/types.ts";
import { resolveWorkspace } from "./workspaceChoice.ts";

export type DirectCommand = Extract<
  RoomCommand,
  {
    type:
      | "project.create"
      | "thread.start"
      | "thread.send"
      | "thread.interrupt"
      | "thread.approval.respond"
      | "thread.userInput.respond"
      | "thread.model.set"
      | "thread.runtimeMode.set"
      | "thread.lifecycle";
  }
>;

export type DirectResult = { type: "project.created"; projectId: string } | { type: "thread.started"; threadId: string } | { type: "thread.updated"; threadId: string };

// A thread's browsers are the service's, like a room's: they live here, not in T3.
export const isDirectCommand = (command: RoomCommand): command is DirectCommand =>
  command.type === "project.create" || (command.type.startsWith("thread.") && command.type !== "thread.browser");

/** Run a T3 call, reporting an unreachable T3 as 503 and a refused command as 502, like the room commands do. */
async function t3<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
    if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
    throw error;
  }
}

/** A path as T3 stores it, for the duplicate check: ~ expanded, normalized, no trailing slash. */
export function comparableRoot(path: string): string {
  let value = path.trim();
  if (value === "~" || value.startsWith("~/")) value = homedir() + value.slice(1);
  value = posix.normalize(value);
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/** The folder name, as T3's own "add project" names a project. */
export function projectTitleFor(workspaceRoot: string): string {
  return comparableRoot(workspaceRoot).split("/").filter(Boolean).pop() ?? "project";
}

/** A thread's first title: the first line of the message, shortened. Sent as the title seed too, so T3 may replace it. */
export function threadTitleFor(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return "New thread";
  const flat = line.replace(/\s+/g, " ");
  if (flat.length <= 60) return flat;
  const cut = flat.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

/** Inline images as T3 upload attachments, checked against T3's limits (10 MB each, 80 MB per message). */
export function turnImages(images: InlineImage[]): TurnImage[] {
  let total = 0;
  return images.map((image) => {
    const comma = image.dataUrl.indexOf(",");
    const mimeType = image.dataUrl.slice(5, image.dataUrl.indexOf(";"));
    const base64 = image.dataUrl.slice(comma + 1);
    const sizeBytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (sizeBytes === 0) throw new RoomError("empty_attachment", `${image.name} is empty`);
    if (sizeBytes > ATTACHMENT_MAX_BYTES) throw new RoomError("attachment_too_large", `${image.name}: images can be up to 10 MB each`, 413);
    total += sizeBytes;
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) throw new RoomError("attachment_too_large", "images can total 80 MB per message", 413);
    return { name: image.name || "image", mimeType, sizeBytes, dataUrl: image.dataUrl };
  });
}

export class DirectThreads {
  private readonly repos: Repos;
  private readonly adapter: T3Adapter;

  constructor(repos: Repos, adapter: T3Adapter) {
    this.repos = repos;
    this.adapter = adapter;
  }

  async execute(command: DirectCommand): Promise<DirectResult> {
    switch (command.type) {
      case "project.create":
        return this.createProject(command);
      case "thread.start":
        return this.startThread(command);
      case "thread.send": {
        const shell = await this.requireLooseThread(command.threadId);
        await t3(() =>
          this.adapter.sendMessage({
            commandId: randomUUID(),
            threadId: shell.id,
            messageId: randomUUID(),
            text: command.text,
            images: turnImages(command.images),
            // A live session only switches model when the message names one (see Scheduler.send).
            modelSelection: shell.modelSelection,
            // Into the run in progress, as T3 Code's composer does by default; otherwise it starts a run (T3 queues
            // it when a run is being prepared or waits on a request).
            mode: shell.status === "running" && shell.activeRunId ? { type: "steer", runId: shell.activeRunId } : { type: "start" },
          }),
        );
        return { type: "thread.updated", threadId: shell.id };
      }
      case "thread.interrupt": {
        const shell = await this.requireLooseThread(command.threadId);
        await t3(() => this.adapter.interruptRun({ commandId: randomUUID(), threadId: shell.id, runId: shell.activeRunId }));
        return { type: "thread.updated", threadId: shell.id };
      }
      case "thread.approval.respond": {
        const shell = await this.requireLooseThread(command.threadId);
        await t3(() => this.adapter.respondApproval({ commandId: randomUUID(), threadId: shell.id, requestId: command.requestId, decision: command.decision }));
        return { type: "thread.updated", threadId: shell.id };
      }
      case "thread.userInput.respond": {
        const shell = await this.requireLooseThread(command.threadId);
        await t3(() => this.adapter.respondUserInput({ commandId: randomUUID(), threadId: shell.id, requestId: command.requestId, answers: command.answers }));
        return { type: "thread.updated", threadId: shell.id };
      }
      case "thread.model.set": {
        const shell = await this.requireLooseThread(command.threadId);
        if (command.modelSelection.instanceId !== shell.modelSelection.instanceId) {
          throw new RoomError("provider_fixed", `This thread runs on ${shell.modelSelection.instanceId}; a thread cannot switch provider. Start a new thread instead.`, 409);
        }
        await t3(() => this.adapter.setThreadModel({ commandId: randomUUID(), threadId: shell.id, modelSelection: command.modelSelection }));
        return { type: "thread.updated", threadId: shell.id };
      }
      case "thread.runtimeMode.set": {
        const shell = await this.requireLooseThread(command.threadId);
        await t3(() => this.adapter.setRuntimeMode({ commandId: randomUUID(), threadId: shell.id, runtimeMode: command.runtimeMode }));
        return { type: "thread.updated", threadId: shell.id };
      }
      case "thread.lifecycle": {
        const shell = await this.requireLooseThread(command.threadId);
        await t3(() => this.adapter.setThreadLifecycle({ commandId: randomUUID(), threadId: shell.id, action: command.action }));
        return { type: "thread.updated", threadId: shell.id };
      }
    }
  }

  /** The thread, when it exists in T3 and no room participant is bound to it. */
  private async requireLooseThread(threadId: string): Promise<T3ThreadShell> {
    if (this.repos.listActiveBindings().some((binding) => binding.threadId === threadId)) {
      throw new RoomError("thread_in_room", "This thread is seated in a room; talk to it from the room", 409);
    }
    // T3 only lists an archived thread in its archived snapshot.
    const shell =
      (await t3(() => this.adapter.getThreadShell(threadId))) ??
      (await t3(async () => (await this.adapter.listArchivedThreads?.())?.find((thread) => thread.id === threadId) ?? null));
    if (!shell || shell.deletedAt) throw notFound("T3 thread", threadId);
    return shell;
  }

  private async createProject(command: Extract<DirectCommand, { type: "project.create" }>): Promise<DirectResult> {
    const workspaceRoot = command.workspaceRoot.trim();
    // T3 resolves a relative path against its own working directory, which is never what was meant.
    if (!/^(~|\/|[A-Za-z]:[\\/])/.test(workspaceRoot)) {
      throw new RoomError("invalid_path", "Give the full path of the folder on the T3 machine (starting with / or ~)");
    }
    const projects = await t3(() => this.adapter.listProjects());
    const existing = projects.find((project) => comparableRoot(project.workspaceRoot) === comparableRoot(workspaceRoot));
    if (existing) throw new RoomError("project_exists", `The project "${existing.title}" already uses ${existing.workspaceRoot}`, 409);
    const projectId = randomUUID();
    try {
      await this.adapter.createProject({
        commandId: randomUUID(),
        projectId,
        title: command.title?.trim() || projectTitleFor(workspaceRoot),
        workspaceRoot,
        createIfMissing: command.createIfMissing,
      });
    } catch (error) {
      // T3 answers a folder it cannot use with a bare "invalid_command", and a folder another project took with a 500.
      if (error instanceof T3CommandRejected) {
        throw new RoomError(
          "project_rejected",
          command.createIfMissing
            ? `T3 could not create or use ${workspaceRoot} on its machine. Check the path and permissions.`
            : `T3 could not use ${workspaceRoot}: the folder must already exist on the T3 machine (or tick "Create the folder").`,
          422,
        );
      }
      if (error instanceof T3Unavailable) {
        if (await this.adapter.describe().then(() => true, () => false)) {
          throw new RoomError("project_rejected", `T3 refused to add ${workspaceRoot}. Another project may already use that folder.`, 422);
        }
        throw new RoomError("t3_unavailable", error.message, 503);
      }
      throw error;
    }
    return { type: "project.created", projectId };
  }

  private async startThread(command: Extract<DirectCommand, { type: "thread.start" }>): Promise<DirectResult> {
    const images = turnImages(command.images);
    const projects = await t3(() => this.adapter.listProjects());
    if (!projects.some((project) => project.id === command.projectId)) {
      throw new RoomError("unknown_project", `T3 project ${command.projectId} was not found on the connected server`);
    }
    const modelSelection = command.modelSelection ?? (await t3(() => this.adapter.defaultModelSelection(command.projectId)));
    if (!modelSelection) throw new RoomError("no_model", "T3 has no default model for this project; pick one");
    const threadId = command.threadId ?? randomUUID();
    const title = threadTitleFor(command.text);
    // One call: T3 creates the thread, makes its worktree (naming the branch from this message when none was typed),
    // and starts the agent on the message. The title stands until T3 names the thread from the message.
    const workspace = await resolveWorkspace(this.adapter, command.projectId, command.workspace, null);
    await t3(() =>
      this.adapter.launchThread({
        commandId: randomUUID(),
        threadId,
        projectId: command.projectId,
        title,
        generateTitle: true,
        modelSelection,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        workspace,
        initialMessage: { messageId: randomUUID(), text: command.text, images },
      }),
    );
    return { type: "thread.started", threadId };
  }
}

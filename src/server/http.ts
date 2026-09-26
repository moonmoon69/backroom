/**
 * HTTP API for the room UI. Every mutation goes through POST /api/commands using the shared command contract.
 * Live updates use Server-Sent Events; the UI refetches the room snapshot on each notification.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppStack } from "../app/bootstrap.ts";
import type { HttpT3Adapter } from "../adapter/http.ts";
import { exchangePairingCredential, parsePairingUrl, readStoredAuth, writeStoredAuth } from "../adapter/auth.ts";
import { T3Unavailable } from "../adapter/types.ts";
import type { T3Activity, T3Message } from "../adapter/types.ts";
import { promptForTurn } from "../adapter/correlate.ts";
import { latestContextWindow, openRequests, threadTranscript } from "../app/direct.ts";
import { CommandValidationError, parseCommand } from "../domain/commands.ts";
import { RoomError } from "../domain/errors.ts";
import type { BrowserListItem, RoomSnapshot } from "../domain/types.ts";
import { effectiveBrowser, roomsUsingBrowser } from "../browser/catalog.ts";
import { browserSection } from "../briefing/assemble.ts";
import { BrowserToolError, type BrowserTools } from "../browser/tools.ts";
import { parseExplicit } from "../parser/explicit.ts";
import { resolveLocalImage } from "./localImage.ts";
import { canonicalPath, readCheckoutSummary, readFileDiff, readGitView, worktreePathsOf } from "../git/reader.ts";
import { roomFolders as listRoomFolders } from "../git/workspaces.ts";
import type { Config } from "../config.ts";

export function buildRoomSnapshot(stack: AppStack, roomId: string, eventLimit = 500): RoomSnapshot | null {
  const room = stack.repos.getRoom(roomId);
  if (!room) return null;
  const participants = stack.repos.listParticipants(roomId);
  const participantIds = participants.map((p) => p.id);
  const participantStatus: RoomSnapshot["participantStatus"] = {};
  for (const participant of participants) participantStatus[participant.id] = stack.scheduler.participantStatus(participant.id);
  return {
    room,
    participants,
    roles: stack.repos.listRoles(),
    bindings: stack.repos.listBindings(participantIds),
    tasks: stack.repos.listTasks(roomId),
    runs: stack.repos.listRunsForRoom(roomId).map((run) => ({ ...run, briefing: "" })),
    events: stack.repos.listRecentEvents(roomId, eventLimit),
    nativeRequests: stack.repos.listOpenNativeRequests(participantIds),
    participantStatus,
    browser: (() => {
      const browser = stack.browsers ? effectiveBrowser(stack.repos, room) : null;
      return browser && stack.browsers ? { browser, status: stack.browsers.status(browser.id) } : null;
    })(),
  };
}

/** Agents' browser tools (bin/rooms-browser): the engine, the token the CLI presents, and the command briefings name. */
export interface BrowserToolsHttp {
  tools: BrowserTools | null;
  token: string;
  command: string;
}

export function createHttpApp(stack: AppStack, config: Config, webDistDir: string, browserTools?: BrowserToolsHttp): Hono {
  const app = new Hono();
  const httpAdapter = stack.adapter.kind === "http" ? (stack.adapter as HttpT3Adapter) : null;

  app.onError((error, c) => {
    if (error instanceof CommandValidationError) return c.json({ error: "invalid_command", message: error.message, issues: error.issues }, 400);
    if (error instanceof RoomError) return c.json({ error: error.code, message: error.message }, error.status as 400);
    if (error instanceof T3Unavailable) return c.json({ error: "t3_unavailable", message: error.message }, 503);
    console.error(error);
    return c.json({ error: "internal", message: (error as Error).message }, 500);
  });

  // ---- status & T3 ----
  app.get("/api/status", async (c) => {
    const stored = readStoredAuth(config.dataDir);
    let environment: unknown = null;
    let auth: unknown = null;
    let error: string | null = stack.scheduler.lastAdapterError;
    if (stack.adapter.kind === "fake" || (httpAdapter && httpAdapter.hasCredentials)) {
      try {
        environment = await stack.adapter.describe();
        if (httpAdapter) auth = await httpAdapter.authSession();
      } catch (caught) {
        error = (caught as Error).message;
      }
    } else if (httpAdapter) {
      try {
        environment = await stack.adapter.describe();
        auth = await httpAdapter.authSession();
      } catch (caught) {
        error = (caught as Error).message;
      }
    }
    // The built UI's entry script (hashed name). The page compares it with what it loaded to offer a reload.
    let uiBuild: string | null = null;
    try {
      uiBuild = /assets\/(index-[^"']+\.js)/.exec(readFileSync(join(webDistDir, "index.html"), "utf8"))?.[1] ?? null;
    } catch {
      uiBuild = null;
    }
    return c.json({
      adapter: stack.adapter.kind,
      uiBuild,
      t3: {
        baseUrl: config.t3BaseUrl,
        paired: stack.adapter.kind === "fake" ? true : Boolean(httpAdapter?.hasCredentials),
        pairedAt: stored?.pairedAt ?? null,
        tokenExpiresAt: stored?.expiresAt ?? null,
        environment,
        auth,
        error,
      },
    });
  });

  app.post("/api/t3/pair", async (c) => {
    if (!httpAdapter) throw new RoomError("fake_adapter", "pairing is not available with the fake adapter");
    const body = (await c.req.json()) as { pairingUrl?: string };
    if (!body.pairingUrl) throw new RoomError("missing_pairing_url", "pairingUrl is required");
    const { baseUrl, credential } = parsePairingUrl(body.pairingUrl);
    if (config.t3BaseUrl && new URL(config.t3BaseUrl).host !== new URL(baseUrl).host) {
      // Allow pairing to a different host, but say so: the adapter is bound to the configured base URL.
      throw new RoomError("base_url_mismatch", `pairing URL host ${new URL(baseUrl).host} does not match configured T3 ${config.t3BaseUrl}; set T3_BASE_URL and restart`);
    }
    const auth = await exchangePairingCredential(baseUrl, credential);
    writeStoredAuth(config.dataDir, auth);
    httpAdapter.setAccessToken(auth.accessToken);
    return c.json({ paired: true, scope: auth.scope, expiresAt: auth.expiresAt });
  });

  app.get("/api/t3/projects", async (c) => c.json(await stack.adapter.listProjects()));
  app.get("/api/t3/catalog", async (c) => c.json(await stack.adapter.listCatalog()));
  app.get("/api/t3/providers", async (c) => c.json(await stack.adapter.listProviders()));
  app.get("/api/t3/projects/:projectId/default-model", async (c) => c.json({ modelSelection: await stack.adapter.defaultModelSelection(c.req.param("projectId")) }));
  /**
   * What a new thread of the project can work in: its branches (with the worktree each is checked out in), the project
   * folder, and T3's default for new threads (project folder or new worktree).
   */
  app.get("/api/t3/projects/:projectId/refs", async (c) => {
    const project = (await stack.adapter.listProjects()).find((p) => p.id === c.req.param("projectId"));
    if (!project) throw new RoomError("not_found", "project not found", 404);
    const { isRepo, refs } = await stack.adapter.listRefs(project.workspaceRoot);
    return c.json({ workspaceRoot: project.workspaceRoot, defaultMode: project.defaultThreadEnvMode ?? null, isRepo, refs });
  });
  app.get("/api/t3/threads", async (c) => {
    const projectId = c.req.query("projectId");
    const bound = new Set(stack.repos.listActiveBindings().map((b) => b.threadId));
    const threads = (await stack.adapter.listThreads(projectId || undefined)).filter((t) => t.archivedAt === null);
    // ?includeArchived=1 adds T3's archived threads (the sidebar's Archived sections). Their read is best effort: the
    // live list is still served when it fails.
    if (c.req.query("includeArchived") === "1" && stack.adapter.listArchivedThreads) {
      try {
        threads.push(...(await stack.adapter.listArchivedThreads()).filter((t) => !projectId || t.projectId === projectId));
      } catch (error) {
        console.warn(`[rooms] archived threads not read: ${(error as Error).message}`);
      }
    }
    return c.json(threads.map((t) => ({ ...t, boundToRoom: bound.has(t.id) })));
  });

  /**
   * One T3 thread used directly, outside any room: the conversation (last 30 turns), the running turn as it streams,
   * the approvals and questions it waits on, and its latest context reading. Read from T3 on every call.
   */
  app.get("/api/threads/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    const [detail, listed, projects] = await Promise.all([
      stack.adapter.getThreadDetail(threadId, { turnLimit: 30 }),
      stack.adapter.getThreadShell(threadId),
      stack.adapter.listProjects(),
    ]);
    if (!detail || detail.shell.deletedAt) throw new RoomError("not_found", "thread not found in T3", 404);
    const shell = detail.shell;
    const running = shell.session?.status === "running" || shell.session?.status === "starting" ? shell.session.activeTurnId : null;
    const items = threadTranscript(detail, running);
    return c.json({
      // The per-thread read omits background liveness; the thread list carries it.
      thread: { ...shell, backgroundLiveness: listed?.backgroundLiveness ?? shell.backgroundLiveness, boundToRoom: stack.repos.listActiveBindings().some((b) => b.threadId === threadId) },
      project: projects.find((p) => p.id === shell.projectId) ?? null,
      items,
      requests: openRequests(detail.activities),
      running: running ? { turnId: running, feed: buildLiveFeed(detail.messages, detail.activities, running) } : null,
      contextWindow: latestContextWindow(detail.activities),
      // T3 holds turns older than the window read here.
      partial: new Set(items.filter((i) => i.kind === "reply").map((i) => (i.kind === "reply" ? i.turnId : ""))).size >= 30,
    });
  });

  // ---- crew library ----
  app.get("/api/roles", (c) => c.json(stack.repos.listRoles()));

  // ---- rooms ----
  app.get("/api/rooms", (c) => {
    const rooms = stack.repos.listRooms().map((room) => {
      const tasks = stack.repos.listTasks(room.id);
      return {
        ...room,
        participantCount: stack.repos.listParticipants(room.id).length,
        working: tasks.filter((t) => t.state === "running" || t.state === "dispatching").length,
        waiting: tasks.filter((t) => t.state === "queued" || t.state === "held" || t.state === "blocked" || t.state === "needs_input").length,
        // Live state of the room's threads from the scheduler's last poll (no T3 call): who is mid-turn, who has
        // background work running (so a quiet thread is waiting, not done), who is only monitoring, who needs you.
        activity: stack.repos.listActiveParticipants(room.id).reduce(
          (acc, participant) => {
            const status = stack.scheduler.participantStatus(participant.id);
            if (status.pendingApprovals || status.pendingUserInput) acc.needsInput += 1;
            else if (status.session === "running" || status.session === "starting") acc.turn += 1;
            else if (status.background === "working") acc.background += 1;
            else if (status.background === "monitoring") acc.monitoring += 1;
            return acc;
          },
          { turn: 0, background: 0, monitoring: 0, needsInput: 0 },
        ),
      };
    });
    return c.json(rooms);
  });

  app.get("/api/rooms/:roomId", (c) => {
    const snapshot = buildRoomSnapshot(stack, c.req.param("roomId"));
    if (!snapshot) throw new RoomError("not_found", "room not found", 404);
    return c.json(snapshot);
  });

  app.get("/api/rooms/:roomId/runs/:runId", (c) => {
    const run = stack.repos.getRun(c.req.param("runId"));
    if (!run) throw new RoomError("not_found", "run not found", 404);
    return c.json(run);
  });

  /**
   * Desk view for one participant: everything T3 Code shows for the thread that is readable over HTTP.
   * Session state, model and options, permission mode, branch/worktree, pull requests, plan progress,
   * context-window usage, compactions, checkpoints with changed files, proposed plans, tool activity,
   * and the active turn's streaming text. Read-only; nothing here is persisted in the room.
   */
  // Provider list is reused across the desks in one request burst; refreshed every 30s.
  let providersMemo: { at: number; value: Awaited<ReturnType<typeof stack.adapter.listProviders>> } | null = null;
  const providersCached = async () => {
    if (providersMemo && Date.now() - providersMemo.at < 30_000) return providersMemo.value;
    const value = await stack.adapter.listProviders();
    providersMemo = { at: Date.now(), value };
    return value;
  };

  const deskFor = async (participantId: string): Promise<Record<string, unknown>> => {
    const participant = stack.repos.getParticipant(participantId);
    if (!participant) throw new RoomError("not_found", "participant not found", 404);
    const binding = stack.repos.currentBinding(participant.id);
    const empty = {
      participantId: participant.id,
      threadId: binding?.threadId ?? null,
      projectId: stack.repos.getRoom(participant.roomId)?.projectId ?? null,
      bindingGeneration: participant.bindingGeneration,
      title: null,
      session: null,
      latestTurn: null,
      modelSelection: participant.modelSelection,
      runtimeMode: participant.runtimeMode,
      interactionMode: participant.interactionMode,
      branch: null,
      worktreePath: null,
      pullRequests: [],
      linkedPullRequest: null,
      planProgress: null,
      backgroundLiveness: null,
      latestUserMessageAt: null,
      settledAt: null,
      contextWindow: null,
      contextReporting: null,
      autoCompactWindow: null,
      lastCompaction: null,
      compactions: [],
      checkpoints: [],
      changedFiles: [],
      proposedPlan: null,
      toolSummary: { started: 0, completed: 0, errors: 0, lastTool: null as string | null },
      streamingText: "",
      liveFeed: [] as LiveFeedItem[],
      runningTurn: null,
      backgroundTasks: [] as BackgroundTask[],
      subagents: [] as SubagentUsage[],
      activities: [] as unknown[],
      partial: false,
    };
    if (!binding) return empty;
    const detail = await stack.adapter.getThreadDetail(binding.threadId, { turnLimit: 4 });
    if (!detail) return empty;
    const shell = detail.shell;
    const activeTurn = shell.session?.activeTurnId ?? shell.latestTurn?.turnId ?? null;
    const streamingText = detail.messages.filter((m) => m.turnId === activeTurn && m.role === "assistant").map((m) => m.text).join("\n\n");
    const activities = detail.activities.slice(-80);
    const liveFeed = buildLiveFeed(detail.messages, detail.activities, activeTurn);
    const backgroundTasks = openBackgroundTasks(detail.activities);
    const subagents = subagentUsage(detail.activities);
    // The running turn, if any: whether the room started it, and (for turns typed in T3) the prompt that started it.
    const runningTurnId = shell.session?.status === "running" || shell.session?.status === "starting" ? shell.session.activeTurnId : null;
    const startedByRoom = runningTurnId ? stack.repos.isRunTurn(binding.threadId, runningTurnId) || stack.scheduler.participantStatus(participant.id).activeRunId !== null : false;
    const runningTurn = runningTurnId
      ? {
          turnId: runningTurnId,
          startedByRoom,
          prompt: startedByRoom ? null : promptForTurn(detail.messages, runningTurnId) ?? runningPromptBeforeOutput(detail.messages, runningTurnId),
        }
      : null;

    let contextWindow: { usedTokens: number; maxTokens: number; percent: number; inputTokens?: number; outputTokens?: number; totalProcessedTokens?: number; at: string } | null = null;
    const compactions: Array<{ beforeTokens: number; afterTokens: number; at: string }> = [];
    const toolSummary = { started: 0, completed: 0, errors: 0, lastTool: null as string | null };
    for (const activity of detail.activities) {
      const payload = (activity.payload ?? {}) as Record<string, unknown>;
      if (activity.kind === "context-window.updated" && typeof payload.usedTokens === "number" && typeof payload.maxTokens === "number" && payload.maxTokens > 0) {
        contextWindow = {
          usedTokens: payload.usedTokens,
          maxTokens: payload.maxTokens,
          percent: Math.round((payload.usedTokens / payload.maxTokens) * 1000) / 10,
          ...(typeof payload.inputTokens === "number" ? { inputTokens: payload.inputTokens } : {}),
          ...(typeof payload.outputTokens === "number" ? { outputTokens: payload.outputTokens } : {}),
          ...(typeof payload.totalProcessedTokens === "number" ? { totalProcessedTokens: payload.totalProcessedTokens } : {}),
          at: activity.createdAt,
        };
      }
      if (activity.kind === "context-compaction" && typeof payload.beforeTokens === "number" && typeof payload.afterTokens === "number") {
        compactions.push({ beforeTokens: payload.beforeTokens, afterTokens: payload.afterTokens, at: activity.createdAt });
      }
      if (activity.kind === "tool.started") toolSummary.started += 1;
      if (activity.kind === "tool.completed") {
        toolSummary.completed += 1;
        const data = payload.data as { toolName?: string } | undefined;
        toolSummary.lastTool = data?.toolName ?? (typeof payload.title === "string" ? payload.title : activity.summary);
      }
      if (activity.tone === "error") toolSummary.errors += 1;
    }
    const checkpoints = detail.checkpoints.slice(-6).map((checkpoint) => ({
      turnId: checkpoint.turnId,
      status: checkpoint.status,
      completedAt: checkpoint.completedAt,
      files: checkpoint.files,
      additions: checkpoint.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: checkpoint.files.reduce((sum, file) => sum + file.deletions, 0),
    }));
    // Every file the thread's turns changed, with when a turn last did (the Git tab uses it to say who changed an
    // uncommitted file: a participant whose turn touched it after the last commit).
    const changedFiles = new Map<string, { path: string; kind: string; additions: number; deletions: number; turns: number; lastAt: string | null }>();
    for (const checkpoint of detail.checkpoints) {
      for (const file of checkpoint.files) {
        const existing = changedFiles.get(file.path);
        if (existing) {
          existing.additions += file.additions;
          existing.deletions += file.deletions;
          existing.turns += 1;
          existing.kind = file.kind;
          if (checkpoint.completedAt && (!existing.lastAt || checkpoint.completedAt > existing.lastAt)) existing.lastAt = checkpoint.completedAt;
        } else {
          changedFiles.set(file.path, { ...file, turns: 1, lastAt: checkpoint.completedAt ?? null });
        }
      }
    }
    const latestPlan = detail.proposedPlans[detail.proposedPlans.length - 1] ?? null;
    // Provider-level context facts: whether readings exist at all, and any explicit auto-compaction window set in T3.
    let contextReporting: boolean | null = null;
    let autoCompactWindow: number | null = null;
    try {
      const provider = (await providersCached()).find((p) => p.instanceId === shell.modelSelection.instanceId);
      if (provider) {
        contextReporting = provider.reportsContextWindow;
        autoCompactWindow = provider.autoCompactWindow;
      }
    } catch {
      // Provider info is a decoration; the desk still renders without it.
    }
    const lastCompaction = compactions[compactions.length - 1] ?? null;
    return {
      contextReporting,
      autoCompactWindow,
      lastCompaction,
      participantId: participant.id,
      threadId: binding.threadId,
      projectId: stack.repos.getRoom(participant.roomId)?.projectId ?? null,
      bindingGeneration: participant.bindingGeneration,
      title: shell.title,
      session: shell.session,
      latestTurn: shell.latestTurn,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      pullRequests: shell.pullRequests,
      linkedPullRequest: shell.linkedPullRequest,
      planProgress: shell.planProgress,
      // The per-thread read omits liveness; the thread list (polled by the scheduler) carries it.
      backgroundLiveness: shell.backgroundLiveness ?? stack.scheduler.participantStatus(participant.id).background,
      latestUserMessageAt: shell.latestUserMessageAt,
      settledAt: shell.settledAt,
      contextWindow,
      compactions,
      checkpoints,
      changedFiles: [...changedFiles.values()],
      proposedPlan: latestPlan ? { id: latestPlan.id, turnId: latestPlan.turnId, implementedAt: latestPlan.implementedAt, createdAt: latestPlan.createdAt, markdown: latestPlan.planMarkdown } : null,
      toolSummary,
      streamingText,
      liveFeed,
      runningTurn,
      backgroundTasks,
      subagents,
      activities,
      // A window of recent history (last four turns, last 80 activities); T3 holds the complete record.
      partial: detail.activities.length > activities.length || detail.checkpoints.length > checkpoints.length || shell.latestTurn !== null,
    };
  };

  app.get("/api/rooms/:roomId/participants/:participantId/live", async (c) => {
    const participant = stack.repos.getParticipant(c.req.param("participantId"));
    if (!participant || participant.roomId !== c.req.param("roomId")) throw new RoomError("not_found", "participant not found", 404);
    return c.json(await deskFor(participant.id));
  });

  /** All participants' desks in one call, for the inspector rail. Participants whose T3 read fails are reported, not fatal. */
  app.get("/api/rooms/:roomId/desk", async (c) => {
    const roomId = c.req.param("roomId");
    if (!stack.repos.getRoom(roomId)) throw new RoomError("not_found", "room not found", 404);
    const participants = stack.repos.listParticipants(roomId);
    const desks: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    await Promise.all(
      participants.map(async (participant) => {
        try {
          desks[participant.id] = await deskFor(participant.id);
        } catch (error) {
          errors[participant.id] = (error as Error).message;
        }
      }),
    );
    return c.json({ participants: desks, errors, fetchedAt: new Date().toISOString() });
  });

  const roomFolders = (roomId: string) => {
    if (!stack.repos.getRoom(roomId)) throw new RoomError("not_found", "room not found", 404);
    return listRoomFolders(stack.adapter, stack.repos, roomId);
  };

  /** A folder a git read may name: one of the room's folders, or another worktree of their repositories. */
  const readableFolder = async (folders: Array<{ path: string }>, requested: string): Promise<boolean> => {
    const wanted = canonicalPath(requested);
    if (folders.some((folder) => folder.path === wanted)) return true;
    const worktrees = await Promise.all(folders.map((folder) => worktreePathsOf(folder.path)));
    return worktrees.flat().some((path) => canonicalPath(path) === wanted);
  };

  /**
   * The Git tab: every room folder in brief (branch, upstream, uncommitted count), and for one of them (?path=, else
   * the first) the full view: uncommitted files, recent commits (?commits=N), and the repository's worktrees.
   * ?summary=1 skips the full view (the header's count).
   */
  app.get("/api/rooms/:roomId/git", async (c) => {
    const folders = await roomFolders(c.req.param("roomId"));
    const summaries = await Promise.all(folders.map(async (folder) => ({ ...(await readCheckoutSummary(folder.path)), participantIds: folder.participantIds, isProjectRoot: folder.isProjectRoot })));
    if (c.req.query("summary") === "1") return c.json({ folders: summaries, view: null, home: homedir(), fetchedAt: new Date().toISOString() });
    const requested = c.req.query("path");
    const selected = requested && (await readableFolder(folders, requested)) ? canonicalPath(requested) : (folders[0]?.path ?? null);
    const commitLimit = Number(c.req.query("commits") ?? 30);
    const view = selected ? await readGitView(selected, { commitLimit: Number.isFinite(commitLimit) ? commitLimit : 30 }) : null;
    return c.json({ folders: summaries, view, home: homedir(), fetchedAt: new Date().toISOString() });
  });

  /** One file's diff in a room folder: uncommitted against HEAD, or its change in ?commit=. */
  app.get("/api/rooms/:roomId/git/diff", async (c) => {
    const folder = c.req.query("path") ?? "";
    const file = c.req.query("file") ?? "";
    if (!folder || !(await readableFolder(await roomFolders(c.req.param("roomId")), folder))) throw new RoomError("forbidden", "not one of this room's folders", 403);
    try {
      return c.json(
        await readFileDiff(canonicalPath(folder), {
          path: file,
          origPath: c.req.query("from") || null,
          commit: c.req.query("commit") || null,
          untracked: c.req.query("untracked") === "1",
        }),
      );
    } catch (error) {
      throw new RoomError("bad_request", (error as Error).message, 400);
    }
  });

  app.get("/api/rooms/:roomId/events", (c) => {
    const roomId = c.req.param("roomId");
    const from = Number(c.req.query("from") ?? 1);
    const to = Number(c.req.query("to") ?? Number.MAX_SAFE_INTEGER);
    return c.json(stack.repos.listEvents(roomId, from, to));
  });

  // Today's usage per model across all threads (T3 does not split usage by thread). ?tz= IANA zone for the day.
  app.get("/api/t3/usage/today", async (c) => {
    if (!stack.adapter.usageSummary) return c.json({ available: false, buckets: [], pricing: null, readAt: null });
    const timeZone = c.req.query("tz") || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const day = new Date().toLocaleDateString("en-CA", { timeZone });
    const summary = await stack.adapter.usageSummary({ day, timeZone });
    return c.json({ available: true, day, timeZone, ...summary });
  });

  app.post("/api/rooms/:roomId/parse", async (c) => {
    const roomId = c.req.param("roomId");
    const room = stack.repos.getRoom(roomId);
    if (!room) throw new RoomError("not_found", "room not found", 404);
    const body = (await c.req.json()) as { text?: string };
    const tasks = stack.repos.listTasks(roomId);
    const busyByParticipant = new Set(
      tasks.filter((t) => t.state === "dispatching" || t.state === "running" || t.state === "needs_input" || t.state === "queued").map((t) => t.participantId),
    );
    const participants = stack.repos.listActiveParticipants(roomId).map((p) => {
      const status = stack.scheduler.participantStatus(p.id);
      return { id: p.id, alias: p.alias, busy: busyByParticipant.has(p.id) || status.externalActivity || status.activeRunId !== null || status.threadMissing };
    });
    const roles = stack.repos.listRoles().map((r) => ({ id: r.id, name: r.name }));
    return c.json(parseExplicit(body.text ?? "", participants, tasks, roles));
  });

  // Images for the composer: raw bytes in, attachment record out. Referenced by id from message.create.
  app.post("/api/rooms/:roomId/attachments", async (c) => {
    const data = new Uint8Array(await c.req.arrayBuffer());
    const name = decodeURIComponent(c.req.header("x-file-name") ?? "image");
    const mimeType = (c.req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
    return c.json(stack.service.storeAttachment({ roomId: c.req.param("roomId"), name, mimeType, data }));
  });

  // Images attached to messages typed in T3 Code live as files under T3's userdata/attachments, named by id.
  // Those ids appear on t3.message events; they are served here when the id is not a room attachment.
  const t3Attachment = (id: string): { path: string; mimeType: string } | null => {
    if (!/^[A-Za-z0-9-]{1,120}$/.test(id)) return null;
    for (const [ext, mimeType] of [[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]] as const) {
      const path = join(config.t3UserDataDir, "attachments", `${id}${ext}`);
      if (existsSync(path)) return { path, mimeType };
    }
    return null;
  };

  app.get("/api/attachments/:attachmentId", (c) => {
    const id = c.req.param("attachmentId");
    const attachment = stack.repos.getAttachment(id);
    const data = stack.repos.getAttachmentData(id);
    if (!attachment || !data) {
      const fromT3 = t3Attachment(id);
      if (!fromT3) throw new RoomError("not_found", "attachment not found", 404);
      return new Response(readFileSync(fromT3.path), {
        headers: { "content-type": fromT3.mimeType, "cache-control": "private, max-age=31536000, immutable" },
      });
    }
    return new Response(data, {
      headers: {
        "content-type": attachment.mimeType,
        "content-length": String(data.byteLength),
        "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      },
    });
  });

  // Images agents saved to disk and referenced from a reply (`![shot](/tmp/shot.png)`), like T3 Code renders them.
  // Only image files under the allowed roots are served; see localImage.ts.
  app.get("/api/local-image", (c) => {
    const resolved = resolveLocalImage(c.req.query("path") ?? "");
    if (!resolved.ok) {
      const code = resolved.status === 404 ? "not_found" : resolved.status === 400 ? "invalid_path" : "forbidden";
      throw new RoomError(code, `local image: ${resolved.reason}`, resolved.status);
    }
    return new Response(readFileSync(resolved.path), {
      headers: {
        "content-type": resolved.mimeType,
        "content-length": String(resolved.size),
        // Files under /tmp get overwritten (a re-run screenshot), so revalidate rather than cache forever.
        "cache-control": "private, no-cache",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(resolved.path))}`,
      },
    });
  });

  // ---- browsers (a list named by purpose; processes on this machine) ----
  app.get("/api/browser/environment", (c) => c.json(stack.browsers ? stack.browsers.environment() : null));
  const browserItem = (browser: ReturnType<typeof stack.repos.listBrowsers>[number]): BrowserListItem | null =>
    stack.browsers
      ? { ...browser, status: stack.browsers.status(browser.id), usedBy: roomsUsingBrowser(stack.repos, browser.id).map((room) => ({ roomId: room.id, title: room.title })) }
      : null;
  const requireBrowsers = () => {
    if (!stack.browsers) throw new RoomError("browser_unavailable", "This room service does not run browsers", 409);
    return stack.browsers;
  };
  const requireBrowserRecord = (browserId: string) => {
    const browser = stack.repos.getBrowser(browserId);
    if (!browser) throw new RoomError("not_found", "browser not found", 404);
    return browser;
  };
  app.get("/api/browsers", (c) => c.json(stack.repos.listBrowsers().map(browserItem).filter(Boolean)));
  app.get("/api/browsers/:browserId", (c) => {
    const browser = requireBrowserRecord(c.req.param("browserId"));
    const item = browserItem(browser);
    if (!item) throw new RoomError("browser_unavailable", "This room service does not run browsers", 409);
    return c.json({ ...item, profileBytes: requireBrowsers().profileBytes(browser.id) });
  });
  app.post("/api/browsers/:browserId/start", async (c) => {
    const browser = requireBrowserRecord(c.req.param("browserId"));
    try {
      return c.json(await requireBrowsers().ensure(browser.id));
    } catch (error) {
      throw new RoomError("browser_failed", (error as Error).message, 409);
    }
  });
  app.post("/api/browsers/:browserId/stop", async (c) => {
    const browser = requireBrowserRecord(c.req.param("browserId"));
    await requireBrowsers().stop(browser.id);
    return c.json(requireBrowsers().status(browser.id));
  });
  // Wipes logins, history and saved tabs; the browser keeps its name, purpose and address.
  app.post("/api/browsers/:browserId/reset", async (c) => {
    const browser = requireBrowserRecord(c.req.param("browserId"));
    await requireBrowsers().resetProfile(browser.id);
    return c.json(requireBrowsers().status(browser.id));
  });
  // rooms-browser: the CLI posts its command line with the token from data/browser-api.json. The tools can run scripts
  // in logged-in browsers, so they need the token even though the rest of the API does not.
  app.post("/api/browser-tools", async (c) => {
    if (!browserTools?.tools) throw new RoomError("browser_unavailable", "This room service does not run browsers", 409);
    if (c.req.header("authorization") !== `Bearer ${browserTools.token}`) {
      return c.json({ error: "unauthorized", message: "rooms-browser could not authenticate: the service was restarted or this is not its data folder" }, 401);
    }
    const body = (await c.req.json()) as { argv?: unknown; as?: unknown; force?: unknown };
    const argv = Array.isArray(body.argv) ? body.argv.filter((a): a is string => typeof a === "string") : [];
    try {
      const text = await browserTools.tools.run(argv, { as: typeof body.as === "string" && body.as.trim() ? body.as.trim() : null, force: body.force === true });
      return c.json({ text });
    } catch (error) {
      if (error instanceof BrowserToolError) return c.json({ error: "browser_tool", message: error.message }, error.status as 400);
      throw error;
    }
  });

  /**
   * The browsers section for a thread outside any room: every browser, with `browserId` as the default (started now),
   * and the thread's own key. The UI adds it to the user's next message.
   */
  app.get("/api/browser-briefing", async (c) => {
    const as = c.req.query("as") ?? "";
    if (!/^thread\.[A-Za-z0-9-]{4,}$/.test(as)) throw new RoomError("invalid_key", "as must be thread.<id>");
    const browser = requireBrowserRecord(c.req.query("browserId") ?? "");
    const started = await requireBrowsers().briefingFor(browser);
    if (!started) throw new RoomError("browser_failed", `"${browser.name}" could not start`, 409);
    return c.json({
      text: browserSection({
        audience: "thread",
        command: browserTools?.command ?? "rooms-browser",
        as,
        started,
        browsers: stack.repos.listBrowsers().map((b) => ({
          name: b.name,
          description: b.description,
          isDefault: b.id === browser.id,
          running: b.id === browser.id || requireBrowsers().status(b.id).state === "running",
        })),
      }),
    });
  });

  // A room's Start and Stop act on the room's effective browser.
  const roomBrowser = (roomId: string) => {
    const room = stack.repos.getRoom(roomId);
    if (!room) throw new RoomError("not_found", "room not found", 404);
    const browser = effectiveBrowser(stack.repos, room);
    if (!browser) throw new RoomError("no_browser", "This room has no browser; create one first", 409);
    return browser;
  };
  app.post("/api/rooms/:roomId/browser/start", async (c) => {
    const browser = roomBrowser(c.req.param("roomId"));
    try {
      return c.json(await requireBrowsers().ensure(browser.id));
    } catch (error) {
      throw new RoomError("browser_failed", (error as Error).message, 409);
    }
  });
  app.post("/api/rooms/:roomId/browser/stop", async (c) => {
    const browser = roomBrowser(c.req.param("roomId"));
    await requireBrowsers().stop(browser.id);
    return c.json(requireBrowsers().status(browser.id));
  });

  app.post("/api/commands", async (c) => {
    const command = parseCommand(await c.req.json());
    const result = await stack.service.execute(command);
    // A deleted browser's process and profile (logins, history) go with it. Rooms never take a browser with them.
    if (command.type === "browser.delete") await stack.browsers?.remove(command.browserId);
    // Let the scheduler react promptly to new work without waiting for the next interval.
    void stack.scheduler.tick();
    return c.json(result);
  });

  app.get("/api/rooms/:roomId/stream", (c) => {
    const roomId = c.req.param("roomId");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = stack.hub.subscribe(roomId, () => {
        if (!closed) void stream.writeSSE({ event: "room.changed", data: JSON.stringify({ roomId, at: Date.now() }) });
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ roomId }) });
      while (!closed) {
        await stream.sleep(15000);
        if (!closed) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
    });
  });

  // An API path nothing above handles is a 404, never the app shell (a UI newer than the service would read HTML as data).
  app.all("/api/*", (c) => c.json({ error: "not_found", message: `no route for ${c.req.method} ${c.req.path}` }, 404));

  // ---- static UI ----
  if (existsSync(join(webDistDir, "index.html"))) {
    const distRoot = webDistDir.replace(process.cwd() + "/", "");
    app.use("/assets/*", serveStatic({ root: distRoot }));
    app.use("/icons/*", serveStatic({ root: distRoot }));
    // PWA shell files live at the site root. They are revalidated on every load so an updated worker or manifest
    // is picked up without a hard refresh.
    const rootFiles: Record<string, string> = {
      "/manifest.webmanifest": "application/manifest+json",
      "/sw.js": "text/javascript; charset=utf-8",
      "/favicon.svg": "image/svg+xml",
      "/apple-touch-icon.png": "image/png",
    };
    for (const [path, type] of Object.entries(rootFiles)) {
      app.get(path, (c) => {
        const file = join(webDistDir, path);
        if (!existsSync(file)) return c.notFound();
        return new Response(readFileSync(file), { headers: { "content-type": type, "cache-control": "no-cache" } });
      });
    }
    // Read per request so a rebuilt bundle is served without restarting the service, and never let the browser
    // cache the shell: asset file names are hashed, so a stale index.html is the only way to run old code.
    app.get("*", (c) => {
      c.header("Cache-Control", "no-store");
      return c.html(readFileSync(join(webDistDir, "index.html"), "utf8"));
    });
  } else {
    app.get("/", (c) =>
      c.text("T3 Rooms service is running. Build the UI with `npm run build:web` or run the Vite dev server in web/.", 200),
    );
  }
  return app;
}

type LiveFeedItem =
  | { kind: "message"; id: string; text: string; streaming: boolean; at: string }
  | { kind: "tools"; count: number; errors: number; labels: string[]; at: string };

/**
 * The turn as T3 shows it: each assistant message separately, with the tool calls between them collapsed into one
 * item per burst ("ran 4 tools: Read, Bash, ..."). Messages and tool activity are ordered by time.
 */
function buildLiveFeed(messages: T3Message[], activities: T3Activity[], turnId: string | null): LiveFeedItem[] {
  if (!turnId) return [];
  const entries: Array<{ at: string; message?: T3Message; activity?: T3Activity }> = [
    ...messages.filter((m) => m.turnId === turnId && m.role === "assistant" && m.text.trim().length > 0).map((message) => ({ at: message.createdAt, message })),
    ...activities.filter((a) => a.turnId === turnId && (a.kind === "tool.completed" || (a.tone === "error" && a.kind.startsWith("tool")))).map((activity) => ({ at: activity.createdAt, activity })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const feed: LiveFeedItem[] = [];
  for (const entry of entries) {
    if (entry.message) {
      feed.push({ kind: "message", id: entry.message.id, text: entry.message.text, streaming: entry.message.streaming, at: entry.at });
      continue;
    }
    const activity = entry.activity as T3Activity;
    const payload = (activity.payload ?? {}) as { title?: unknown; data?: { toolName?: unknown } };
    const label = typeof payload.data?.toolName === "string" ? payload.data.toolName : typeof payload.title === "string" ? payload.title : activity.summary;
    const last = feed[feed.length - 1];
    const burst = last?.kind === "tools" ? last : null;
    if (burst) {
      burst.count += 1;
      if (activity.tone === "error") burst.errors += 1;
      if (!burst.labels.includes(label) && burst.labels.length < 6) burst.labels.push(label);
      burst.at = entry.at;
    } else {
      feed.push({ kind: "tools", count: 1, errors: activity.tone === "error" ? 1 : 0, labels: [label], at: entry.at });
    }
  }
  return feed.slice(-40);
}

/** A running turn with no output yet: its prompt is a user message after the previous turn's last output, if any. */
function runningPromptBeforeOutput(messages: T3Message[], turnId: string): string | null {
  if (messages.some((m) => m.turnId === turnId && m.role !== "user")) return null;
  const last = messages[messages.length - 1];
  return last?.role === "user" ? last.text : null;
}

interface BackgroundTask {
  taskId: string;
  title: string;
  /** "agent" (a subagent) or "background" (a shell job), as T3 reports it. */
  kind: string;
  /** T3's taskType, e.g. local_agent or local_bash. */
  type: string | null;
  detail: string | null;
  lastTool: string | null;
  startedAt: string;
  updatedAt: string;
}

/**
 * Background work still running on a thread, from T3's task.* activities: started and not yet completed. Only the
 * activity window read for the desk is visible, so a job started many turns ago may be missing from the list; the
 * thread's backgroundLiveness stays the authoritative "is anything running" signal.
 */
function openBackgroundTasks(activities: T3Activity[]): BackgroundTask[] {
  const open = new Map<string, BackgroundTask>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = (activity.payload ?? {}) as { taskId?: string; title?: string; detail?: string; agentKind?: string; taskType?: string; lastToolName?: string; status?: string };
    if (!payload.taskId) continue;
    if (activity.kind === "task.completed" || (activity.kind === "task.updated" && payload.status && payload.status !== "running" && payload.status !== "in_progress")) {
      open.delete(payload.taskId);
      continue;
    }
    const existing = open.get(payload.taskId);
    if (activity.kind === "task.started") {
      open.set(payload.taskId, {
        taskId: payload.taskId,
        title: payload.title ?? payload.detail ?? "background task",
        kind: payload.agentKind ?? "background",
        type: payload.taskType ?? null,
        detail: null,
        lastTool: null,
        startedAt: activity.createdAt,
        updatedAt: activity.createdAt,
      });
    } else if (existing) {
      if (activity.kind === "task.progress" && payload.detail) existing.detail = payload.detail;
      if (payload.lastToolName) existing.lastTool = payload.lastToolName;
      existing.updatedAt = activity.createdAt;
    }
  }
  return [...open.values()];
}

interface SubagentUsage {
  taskId: string;
  title: string;
  model: string | null;
  tokens: number;
  toolUses: number;
  durationMs: number;
  status: "running" | "completed" | "failed";
}

/** Subagents and background jobs seen in the desk's activity window, with the usage T3 reports for each. */
function subagentUsage(activities: T3Activity[]): SubagentUsage[] {
  const byId = new Map<string, SubagentUsage>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = (activity.payload ?? {}) as { taskId?: string; title?: string; model?: string; status?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } };
    if (!payload.taskId) continue;
    const entry = byId.get(payload.taskId) ?? { taskId: payload.taskId, title: payload.title ?? "task", model: payload.model ?? null, tokens: 0, toolUses: 0, durationMs: 0, status: "running" as const };
    if (payload.title) entry.title = payload.title;
    if (payload.usage) {
      entry.tokens = Math.max(entry.tokens, payload.usage.total_tokens ?? 0);
      entry.toolUses = Math.max(entry.toolUses, payload.usage.tool_uses ?? 0);
      entry.durationMs = Math.max(entry.durationMs, payload.usage.duration_ms ?? 0);
    }
    if (activity.kind === "task.completed") entry.status = payload.status === "failed" ? "failed" : "completed";
    byId.set(payload.taskId, entry);
  }
  return [...byId.values()].filter((entry) => entry.tokens > 0 || entry.status === "running");
}

/**
 * Backroom's HTTP API for its UI. Every mutation goes through POST /api/commands using the shared command contract.
 * Live updates use Server-Sent Events; the UI refetches the room snapshot on each notification.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppStack } from "../app/bootstrap.ts";
import type { HttpT3Adapter } from "../adapter/http.ts";
import { exchangePairingCredential, parsePairingUrl, readStoredAuth, writeStoredAuth } from "../adapter/auth.ts";
import { ORCHESTRATION_PROTOCOL_VERSION, T3CommandRejected, T3ProtocolMismatch, T3Unavailable, backgroundOf, isRunActive, runPrompt } from "../adapter/types.ts";
import type { T3ThreadDetail } from "../adapter/types.ts";
import {
  backgroundTasks,
  changedFiles,
  compactions,
  contextReading,
  liveFeed,
  planProgress,
  proposedPlan,
  recentActivity,
  recentCheckpoints,
  requestCards,
  runningRun,
  streamingText,
  subagentRows,
  threadTranscript,
  toolSummary,
  type BackgroundTask,
  type LiveFeedItem,
  type SubagentRow,
} from "../app/threadView.ts";
import { CommandValidationError, parseCommand } from "../domain/commands.ts";
import { RoomError } from "../domain/errors.ts";
import { tasksNeedingYou } from "../domain/workStatus.ts";
import type { BrowserListItem, RoomSnapshot } from "../domain/types.ts";
import { browsersForRoom, effectiveBrowser, roomsUsingBrowser, threadKey } from "../browser/catalog.ts";
import { browserSection } from "../briefing/assemble.ts";
import { BrowserToolError, type BrowserTools } from "../browser/tools.ts";
import { BoardError } from "../app/board.ts";
import { boardFor } from "../app/boardEngine.ts";
import { CONSIGLIERE_PRESET_KEY, CONSIGLIERE_RULES_KEY, DEFAULT_CONSIGLIERE_RULES, ENGINE_DEFAULT_CONSIGLIERE_RULES, consigliereRules, designationWarnings, retireThreadChoice } from "../app/consigliere.ts";
import { parseExplicit } from "../parser/explicit.ts";
import { resolveLocalImage } from "./localImage.ts";
import { previewFile } from "./filePreview.ts";
import { canonicalPath, readCheckoutSummary, readFileDiff, readGitView, readRoomCompare, worktreePathsOf } from "../git/reader.ts";
import { roomFolders as listRoomFolders } from "../git/workspaces.ts";
import type { Config } from "../config.ts";
import { ThreadCosts } from "../usage/threadCosts.ts";
import type { ContextMeter } from "../domain/contextMeter.ts";
import { SEEN_KEY, isAfter, markSeen, seenMarks } from "../app/seen.ts";
import { roomStateView } from "../app/roomState.ts";
import { orderProjects } from "../app/service.ts";
import type { SpeechSynth } from "../speech/kokoro.ts";
import { mountEngineView } from "./engineView.ts";

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
    state: roomStateView(stack.repos, roomId),
  };
}

/** Agents' browser tools (bin/rooms-browser): the engine, the token the CLI presents, and the command briefings name. */
export interface BrowserToolsHttp {
  tools: BrowserTools | null;
  token: string;
  command: string;
}

export function createHttpApp(stack: AppStack, config: Config, webDistDir: string, browserTools?: BrowserToolsHttp, speech?: SpeechSynth | null): Hono {
  const app = new Hono();
  const httpAdapter = stack.adapter.kind === "http" ? (stack.adapter as HttpT3Adapter) : null;
  const costs = new ThreadCosts({
    // T3's Orchestrator V2 database (its V1 database, state.sqlite, stays beside it untouched).
    t3StateDb: join(config.t3UserDataDir, "statev2.sqlite"),
    ratesPath: join(config.t3UserDataDir, "usage-model-rates.json"),
    claudeProjectsDir: config.usage.claudeProjectsDir,
    codexSessionsDir: config.usage.codexSessionsDir,
    modelManifestPath: join(config.t3UserDataDir, "model-manifest.json"),
    remember: (threadId, provider, sessionId) => {
      // Only a session not yet known is written: this runs on every read.
      if (!stack.repos.listThreadSessions(threadId).some((known) => known.sessionId === sessionId)) stack.repos.rememberThreadSession(threadId, provider, sessionId);
    },
    remembered: (threadId) => stack.repos.listThreadSessions(threadId),
  });

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
    // The scheduler's last error until its next good tick, or this request's own check of T3 when that fails.
    let error: string | null = stack.scheduler.lastAdapterError;
    let errorAt: string | null = stack.scheduler.lastAdapterErrorAt;
    if (stack.adapter.kind === "fake" || httpAdapter) {
      try {
        const described = await stack.adapter.describe();
        environment = described;
        if (httpAdapter) auth = await httpAdapter.authSession();
        // A server on another orchestration protocol (T3's V1) answers, but nothing in a room can work against it:
        // say so here even when no room has asked it for anything yet. Its update is still offered under Updates.
        if (described.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION) {
          error = new T3ProtocolMismatch(described.serverVersion, described.orchestrationProtocolVersion).message;
          errorAt = new Date().toISOString();
        }
      } catch (caught) {
        error = (caught as Error).message;
        errorAt = new Date().toISOString();
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
        errorAt,
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

  app.get("/api/t3/projects", async (c) => c.json(orderProjects(stack.repos, await stack.adapter.listProjects())));
  app.get("/api/t3/catalog", async (c) => c.json(await stack.adapter.listCatalog()));
  app.get("/api/t3/providers", async (c) => c.json(await stack.adapter.listProviders()));
  // Ask T3 to check again now: every provider or one, and with `models` look for new models too (T3 opens an agent
  // session for that, so it waits for someone to ask). Answers with the providers as T3 then has them.
  app.post("/api/t3/providers/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { instanceId?: unknown; models?: unknown };
    const instanceId = typeof body.instanceId === "string" && body.instanceId ? body.instanceId : undefined;
    await stack.adapter.refreshProviders({ ...(instanceId ? { instanceId } : {}), ...(body.models === true ? { refreshModels: true } : {}) });
    return c.json(await stack.adapter.listProviders());
  });
  // Each open page says whether it is in view; Backroom holds T3's client lease for them (see T3Presence).
  app.post("/api/t3/presence", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { pageId?: unknown; visible?: unknown; focused?: unknown; interactedAt?: unknown; closed?: unknown };
    if (typeof body.pageId !== "string" || !body.pageId || body.pageId.length > 64) throw new RoomError("missing_page", "pageId is required");
    void stack.presence.page({
      pageId: body.pageId,
      visible: body.visible === true,
      focused: body.focused === true,
      interactedAt: typeof body.interactedAt === "number" && Number.isFinite(body.interactedAt) ? body.interactedAt : null,
      closed: body.closed === true,
    });
    return c.json({ ok: true });
  });
  // Updates for T3 and its harnesses. Nothing updates by itself: each POST starts the one update the user clicked.
  app.get("/api/t3/updates", async (c) => c.json(await stack.updates.view(c.req.query("fresh") === "1")));
  app.post("/api/t3/updates/check", async (c) => c.json(await stack.updates.check()));
  app.post("/api/t3/updates/harness", async (c) => {
    const body = (await c.req.json()) as { instanceId?: unknown };
    if (typeof body.instanceId !== "string" || !body.instanceId) throw new RoomError("missing_instance", "instanceId is required");
    return c.json(await stack.updates.updateHarness(body.instanceId));
  });
  app.post("/api/t3/updates/server", async (c) => {
    const body = (await c.req.json()) as { targetVersion?: unknown };
    if (typeof body.targetVersion !== "string" || !body.targetVersion) throw new RoomError("missing_version", "targetVersion is required");
    return c.json(await stack.updates.updateServer(body.targetVersion));
  });
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
  /**
   * Folders on the T3 machine for the New project dialog's path as it is typed: the subfolders of the folder named
   * when the path ends in "/", otherwise those of its parent whose names start with the last segment (T3's own
   * folder picker does the same). A folder T3 cannot read answers with an empty list and the reason.
   */
  app.get("/api/t3/folders", async (c) => {
    const path = (c.req.query("path") ?? "").trim();
    if (!/^(~|\/|[A-Za-z]:[\\/])/.test(path)) throw new RoomError("invalid_path", "Give the full path of a folder on the T3 machine (starting with / or ~)");
    try {
      return c.json({ ...(await stack.adapter.browseFolders(path)), unreadable: null });
    } catch (error) {
      if (error instanceof T3CommandRejected) return c.json({ parentPath: null, entries: [], unreadable: "T3 cannot read that folder on its machine." });
      throw error;
    }
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
        console.warn(`[backroom] archived threads not read: ${(error as Error).message}`);
      }
    }
    // A thread outside rooms has news when its last run finished (or failed) after you last looked at it. A seated
    // thread's runs are the room's news; settled and archived threads are done with.
    const seen = seenMarks(stack.repos);
    const news = (t: (typeof threads)[number]) => {
      const at = t.latestRunCompletedAt;
      if (bound.has(t.id) || t.archivedAt || t.settledAt || !at || (t.status !== "completed" && t.status !== "failed")) return null;
      return isAfter(at, seen.of(`thread:${t.id}`)) ? { at, state: t.status === "failed" ? "error" : "completed" } : null;
    };
    return c.json(threads.map((t) => ({ ...t, backgroundLiveness: backgroundOf(t), boundToRoom: bound.has(t.id), news: news(t) })));
  });

  /**
   * One T3 thread used directly, outside any room: the conversation (T3's recent window of it), the run in progress
   * as it streams, the approvals and questions it waits on, and its latest context reading. Read from T3 on every call.
   */
  // A thread's browsers as its header shows them: off until chosen, like a new room's; the default is the one it uses.
  const threadBrowsersView = (threadId: string) => {
    const access = stack.repos.getThreadBrowsers(threadId);
    if (!access) return { enabled: false, defaultBrowserId: effectiveBrowser(stack.repos, { defaultBrowserId: null, allowedBrowserIds: null })?.id ?? null, allowedBrowserIds: null };
    return { enabled: access.browserEnabled, defaultBrowserId: effectiveBrowser(stack.repos, access)?.id ?? null, allowedBrowserIds: access.allowedBrowserIds };
  };

  app.get("/api/threads/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    const [detail, projects] = await Promise.all([stack.adapter.getThreadDetail(threadId, { bounded: true }), stack.adapter.listProjects()]);
    if (!detail || detail.shell.deletedAt) throw new RoomError("not_found", "thread not found in T3", 404);
    const shell = detail.shell;
    const running = runningRun(detail);
    return c.json({
      thread: { ...shell, backgroundLiveness: backgroundOf(shell), boundToRoom: stack.repos.listActiveBindings().some((b) => b.threadId === threadId) },
      project: projects.find((p) => p.id === shell.projectId) ?? null,
      items: threadTranscript(detail),
      requests: requestCards(detail),
      running: running ? { runId: running.id, feed: liveFeed(detail, running.id) } : null,
      contextWindow: contextReading(detail),
      usage: await threadUsage(detail),
      browsers: threadBrowsersView(threadId),
      // T3 holds runs older than the window read here.
      partial: detail.partial,
    });
  });

  /**
   * What the thread has used, for the thread's usage card and the foot of each reply, as a room shows for a member:
   * the lifetime total, a figure per reply (everything the thread used since its previous reply: the turn that
   * produced it, subagents included) and what it has used since its last reply (the turn in progress). Replies are
   * keyed as GET /api/threads/:threadId lists them.
   */
  app.get("/api/t3/threads/:threadId/costs", async (c) => {
    const threadId = c.req.param("threadId");
    const detail = await stack.adapter.getThreadDetail(threadId, { bounded: true });
    if (!detail || detail.shell.deletedAt) throw new RoomError("not_found", "thread not found in T3", 404);
    const replies = threadTranscript(detail)
      .filter((item): item is Extract<typeof item, { kind: "reply" }> => item.kind === "reply")
      .map((item) => ({ id: item.id, at: Date.parse(item.at) }))
      .filter((reply) => Number.isFinite(reply.at))
      .sort((a, b) => a.at - b.at);
    const byReply: Record<string, ReturnType<ThreadCosts["cost"]>> = {};
    replies.forEach((reply, index) => {
      const part = costs.costBetween([threadId], index === 0 ? 0 : (replies[index - 1] as { at: number }).at + 1, reply.at);
      if (part.available && part.total.calls > 0) byReply[reply.id] = part;
    });
    const last = replies.reduce((max, reply) => Math.max(max, reply.at), 0);
    const open = costs.costBetween([threadId], last + 1, Date.now());
    return c.json({
      readAt: new Date().toISOString(),
      pricesFetchedAt: costs.pricesFetchedAt(),
      total: costs.cost([threadId]),
      replies: byReply,
      openTurn: open.available && open.total.calls > 0 ? open : null,
    });
  });

  // ---- crew library ----
  app.get("/api/presets", (c) => c.json(stack.repos.listPresets()));

  // With ROOMS_ENGINE=1 the room routes read the engine journal (src/server/engineView.ts, L4c). Registered before the
  // old ones below, they answer first; without the flag nothing is registered and every route is as before.
  mountEngineView(app, stack, costs);

  // ---- rooms ----
  app.get("/api/rooms", (c) => {
    const seen = seenMarks(stack.repos);
    const rooms = stack.repos.listRooms().map((room) => {
      const tasks = stack.repos.listTasks(room.id);
      // A removed member's old tasks ask nothing of anyone.
      const seated = new Set(stack.repos.listActiveParticipants(room.id).map((p) => p.id));
      // What finished since you last looked at the room (on any device), newest first.
      const finishes = stack.repos.listRoomFinishes(room.id, seen.of(`room:${room.id}`), 100, room.consigliereId);
      const newest = finishes[0];
      const alias = newest?.participantId ? (stack.repos.getParticipant(newest.participantId)?.alias ?? null) : null;
      return {
        ...room,
        // Who is seated now: a removed participant stays in the record (its messages and tasks name it) but is not crew.
        participantCount: stack.repos.listActiveParticipants(room.id).length,
        working: tasks.filter((t) => t.state === "running" || t.state === "dispatching").length,
        waiting: tasks.filter((t) => t.state === "queued" || t.state === "held" || t.state === "blocked" || t.state === "needs_input").length,
        // Live state of the room's threads from the scheduler's last poll (no T3 call): who is mid-turn, who has
        // background work running (so a quiet thread is waiting, not done), who is only monitoring, who needs you.
        activity: stack.repos.listActiveParticipants(room.id).reduce(
          (acc, participant) => {
            const status = stack.scheduler.participantStatus(participant.id);
            if (status.pendingApprovals || status.pendingUserInput) acc.needsInput += 1;
            else if (status.status !== "unknown" && isRunActive(status.status)) acc.turn += 1;
            else if (status.background === "working") acc.background += 1;
            else if (status.background === "monitoring") acc.monitoring += 1;
            return acc;
          },
          // Tasks that wait on you besides an approval or question (those are counted per member below): held,
          // blocked, or a failure nobody has followed up. The status bar above the conversation lists the same.
          { turn: 0, background: 0, monitoring: 0, needsInput: tasksNeedingYou(tasks.filter((task) => seated.has(task.participantId)), room.consigliereId).filter((task) => task.state !== "needs_input").length },
        ),
        news: { unseen: finishes.length, latest: newest ? { at: newest.at, alias, kind: newest.kind, preview: newest.text } : null },
      };
    });
    return c.json(rooms);
  });

  // A room or thread was on screen up to `at` (the newest finish it showed): its news is seen, on every device.
  app.post("/api/seen", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; at?: unknown } | null;
    const key = typeof body?.key === "string" ? body.key : "";
    const at = typeof body?.at === "string" ? body.at : "";
    if (!SEEN_KEY.test(key) || Number.isNaN(Date.parse(at))) throw new RoomError("invalid_seen", "key must be room:<id> or thread:<id>, and at an ISO time");
    return c.json({ key, at: markSeen(stack.repos, key, at) });
  });

  app.get("/api/rooms/:roomId", (c) => {
    const snapshot = buildRoomSnapshot(stack, c.req.param("roomId"));
    if (!snapshot) throw new RoomError("not_found", "room not found", 404);
    return c.json(snapshot);
  });

  // The room state alone (the snapshot carries it too): the Consigliere's summary, who wrote it and when; null until one is written.
  app.get("/api/rooms/:roomId/state", (c) => {
    const roomId = c.req.param("roomId");
    if (!stack.repos.getRoom(roomId)) throw new RoomError("not_found", "room not found", 404);
    const state = roomStateView(stack.repos, roomId);
    return c.json(state ? { roomId, state } : { roomId, state: null, message: "This room has no state yet: its Consigliere writes it with rooms-board state." });
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

  /**
   * The facts a thread's usage card shows besides its context and spend, read from what T3 reports about the thread:
   * its compactions, subagents, the files its turns changed, and whether its provider reports context at all.
   */
  const threadUsage = async (detail: T3ThreadDetail) => {
    const compacted = compactions(detail);
    const files = changedFiles(detail);
    let contextReporting: boolean | null = null;
    try {
      contextReporting = (await providersCached()).find((p) => p.instanceId === detail.shell.modelSelection.instanceId)?.reportsContextWindow ?? null;
    } catch {
      // Provider info is a decoration.
    }
    return {
      lastCompaction: compacted[compacted.length - 1] ?? null,
      subagents: subagentRows(detail),
      changedFiles: {
        count: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      },
      contextReporting,
    };
  };

  const deskFor = async (participantId: string): Promise<Record<string, unknown>> => {
    const participant = stack.repos.getParticipant(participantId);
    if (!participant) throw new RoomError("not_found", "member not found", 404);
    const binding = stack.repos.currentBinding(participant.id);
    const empty = {
      participantId: participant.id,
      threadId: binding?.threadId ?? null,
      projectId: stack.repos.getRoom(participant.roomId)?.projectId ?? null,
      bindingGeneration: participant.bindingGeneration,
      title: null,
      status: null,
      activeRunId: null,
      latestRun: null,
      lastError: null,
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
      runningRun: null,
      backgroundTasks: [] as BackgroundTask[],
      subagents: [] as SubagentRow[],
      activities: [] as unknown[],
      partial: false,
    };
    if (!binding) return empty;
    // The recent window of the thread: its runs and requests in full, its latest items and messages.
    const detail = await stack.adapter.getThreadDetail(binding.threadId, { bounded: true });
    if (!detail) return empty;
    const shell = detail.shell;
    const running = runningRun(detail);
    const latest = detail.runs.find((run) => run.id === shell.latestRunId) ?? null;
    const shownRunId = running?.id ?? latest?.id ?? null;
    // The run in progress, if any: whether the room sent it, and (for runs typed in T3) the prompt that started it.
    // A room run is written before its message is sent, so the message that started the run tells from the first read.
    const promptMessage = running ? runPrompt(detail, running) : null;
    const startedByRoom = running
      ? stack.repos.isRunT3Run(binding.threadId, running.id) || stack.repos.isRunMessage(binding.threadId, running.userMessageId) || stack.scheduler.participantStatus(participant.id).activeRunId !== null
      : false;
    const runningRunView = running
      ? {
          runId: running.id,
          startedByRoom,
          prompt: startedByRoom ? null : (promptMessage?.text ?? null),
          promptImages: startedByRoom ? [] : (promptMessage?.attachments ?? []).filter((a) => a.type === "image").map((a) => a.id),
        }
      : null;
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
    const compacted = compactions(detail);
    return {
      contextReporting,
      autoCompactWindow,
      lastCompaction: compacted[compacted.length - 1] ?? null,
      participantId: participant.id,
      threadId: binding.threadId,
      projectId: stack.repos.getRoom(participant.roomId)?.projectId ?? null,
      bindingGeneration: participant.bindingGeneration,
      title: shell.title,
      status: shell.status,
      activeRunId: shell.activeRunId,
      latestRun: latest ? { runId: latest.id, status: latest.status, completedAt: latest.completedAt } : null,
      lastError: shell.lastError,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      pullRequests: shell.pullRequests,
      linkedPullRequest: shell.linkedPullRequest,
      planProgress: planProgress(detail),
      backgroundLiveness: backgroundOf(shell) ?? stack.scheduler.participantStatus(participant.id).background,
      latestUserMessageAt: shell.latestUserMessageAt,
      settledAt: shell.settledAt,
      contextWindow: contextReading(detail),
      compactions: compacted,
      checkpoints: recentCheckpoints(detail),
      changedFiles: changedFiles(detail),
      proposedPlan: proposedPlan(detail),
      toolSummary: toolSummary(detail),
      streamingText: streamingText(detail, shownRunId),
      liveFeed: liveFeed(detail, shownRunId),
      runningRun: runningRunView,
      backgroundTasks: backgroundTasks(detail),
      subagents: subagentRows(detail),
      activities: recentActivity(detail),
      // A window of recent history; T3 holds the complete record.
      partial: detail.partial,
    };
  };

  app.get("/api/rooms/:roomId/participants/:participantId/live", async (c) => {
    const participant = stack.repos.getParticipant(c.req.param("participantId"));
    if (!participant || participant.roomId !== c.req.param("roomId")) throw new RoomError("not_found", "member not found", 404);
    return c.json(await deskFor(participant.id));
  });

  /**
   * What the room's threads have used and what that is worth at list price: per participant (every thread it has been
   * bound to, removed participants too), per reply (the turn that produced it) and for the room.
   */
  app.get("/api/rooms/:roomId/costs", (c) => {
    const roomId = c.req.param("roomId");
    if (!stack.repos.getRoom(roomId)) throw new RoomError("not_found", "room not found", 404);
    const participants = stack.repos.listParticipants(roomId);
    const bindings = stack.repos.listBindings(participants.map((p) => p.id));
    const threadsOf = (participantId: string) => [...new Set(bindings.filter((b) => b.participantId === participantId).map((b) => b.threadId))];
    const byParticipant: Record<string, ReturnType<ThreadCosts["cost"]>> = {};
    for (const participant of participants) byParticipant[participant.id] = costs.cost(threadsOf(participant.id));

    // A reply's spend is everything its thread used since the thread's previous reply: the turn that produced it,
    // with its subagents' work meanwhile. Replies to the room and turns typed in T3 alike, so a thread's replies
    // divide its spend between them. What the thread has used since its last reply is the turn in progress.
    const byReply: Record<string, ReturnType<ThreadCosts["cost"]>> = {};
    const openTurns: Record<string, ReturnType<ThreadCosts["cost"]>> = {};
    const now = Date.now();
    const threadOfBinding = new Map(bindings.map((b) => [b.id, b.threadId]));
    const replies = new Map<string, Array<{ eventId: string; at: number }>>();
    for (const event of stack.repos.listEvents(roomId)) {
      if ((event.kind !== "assistant.reply" && event.kind !== "t3.turn") || event.speaker.type !== "participant") continue;
      const threadId = threadOfBinding.get(event.speaker.bindingId);
      const at = Date.parse(event.createdAt);
      if (!threadId || !Number.isFinite(at)) continue;
      replies.set(threadId, [...(replies.get(threadId) ?? []), { eventId: event.id, at }]);
    }
    for (const [threadId, list] of replies) {
      list.sort((a, b) => a.at - b.at);
      list.forEach((reply, index) => {
        const part = costs.costBetween([threadId], index === 0 ? 0 : (list[index - 1] as { at: number }).at + 1, reply.at);
        if (part.available && part.total.calls > 0) byReply[reply.eventId] = part;
      });
    }
    for (const participant of participants) {
      if (participant.retiredAt) continue;
      const threadId = stack.repos.currentBinding(participant.id)?.threadId;
      if (!threadId) continue;
      const last = replies.get(threadId)?.reduce((max, reply) => Math.max(max, reply.at), 0) ?? 0;
      const part = costs.costBetween([threadId], last + 1, now);
      if (part.available && part.total.calls > 0) openTurns[participant.id] = part;
    }

    // Each seated member's context meter, on the thread it is bound to now (an earlier thread's context is gone).
    const contexts: Record<string, ContextMeter> = {};
    for (const participant of participants) {
      if (participant.retiredAt) continue;
      const threadId = stack.repos.currentBinding(participant.id)?.threadId;
      if (threadId) contexts[participant.id] = costs.context([threadId], participant.modelSelection);
    }

    const room = costs.cost([...new Set(bindings.map((b) => b.threadId))]);
    return c.json({
      readAt: new Date().toISOString(),
      pricesFetchedAt: costs.pricesFetchedAt(),
      room,
      /** Participants with no estimate (a provider without readable usage): the room's figure leaves them out. */
      withoutEstimate: participants.filter((p) => !byParticipant[p.id]?.available).map((p) => p.id),
      participants: byParticipant,
      replies: byReply,
      /** What each participant's thread has used since its last reply: the turn in progress. */
      openTurns,
      /** Per seated participant: its context meter (Claude threads only; the others say why there is none). */
      contexts,
    });
  });

  /** The same for one thread used on its own. */
  app.get("/api/t3/threads/:threadId/cost", (c) => c.json({ readAt: new Date().toISOString(), pricesFetchedAt: costs.pricesFetchedAt(), cost: costs.cost([c.req.param("threadId")]) }));

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
    const [view, room] = await Promise.all([
      selected ? readGitView(selected, { commitLimit: Number.isFinite(commitLimit) ? commitLimit : 30 }) : Promise.resolve(null),
      readRoomCompare(folders.map((f) => f.path)),
    ]);
    return c.json({ folders: summaries, view, compares: room.compares, overlaps: room.overlaps, home: homedir(), fetchedAt: new Date().toISOString() });
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
    return c.json(parseExplicit(body.text ?? "", participants, tasks, { consigliereId: room.consigliereId, engine: stack.engine !== null }));
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
  /**
   * A media file an agent wrote to disk and referenced from a reply (image, video or audio under the home or temp
   * folder), streamed with byte ranges so a video seeks and plays on every browser. /api/local-image is the older
   * name for the same route.
   */
  const localFile = (c: Context) => {
    const resolved = resolveLocalImage(c.req.query("path") ?? "");
    if (!resolved.ok) {
      const code = resolved.status === 404 ? "not_found" : resolved.status === 400 ? "invalid_path" : "forbidden";
      throw new RoomError(code, `local file: ${resolved.reason}`, resolved.status);
    }
    const headers: Record<string, string> = {
      "content-type": resolved.mimeType,
      "accept-ranges": "bytes",
      // Files under /tmp get overwritten (a re-run screenshot), so revalidate rather than cache forever.
      "cache-control": "private, no-cache",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(resolved.path))}`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    let start = 0;
    let end = resolved.size - 1;
    let status = 200;
    if (range && resolved.size > 0) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else if (range[2]) {
        start = Math.max(0, resolved.size - Number(range[2]));
      }
      if (!Number.isFinite(start) || start > end || start >= resolved.size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${resolved.size}` } });
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${resolved.size}`;
    }
    headers["content-length"] = String(end - start + 1);
    if (c.req.method === "HEAD" || resolved.size === 0) return new Response(null, { status, headers });
    return new Response(Readable.toWeb(createReadStream(resolved.path, { start, end })) as ReadableStream, { status, headers });
  };
  app.get("/api/local-file", localFile);
  app.get("/api/local-image", localFile);

  /**
   * A file a reply names, to preview it: its text (up to a size), or where to fetch it for an image or a recording.
   * Read only inside T3's project folders, its threads' worktrees and the temp folder; see filePreview.ts. `base` is
   * the folder the reply was written in, where a relative path is looked for first.
   */
  app.get("/api/file-preview", async (c) => {
    const [projects, threads] = await Promise.all([stack.adapter.listProjects(), stack.adapter.listThreads()]);
    const roots = [...projects.map((project) => project.workspaceRoot), ...threads.flatMap((thread) => (thread.worktreePath ? [thread.worktreePath] : [])), tmpdir(), "/tmp"];
    const preview = previewFile(c.req.query("path") ?? "", { base: c.req.query("base") || null, roots });
    if (!preview.ok) throw new RoomError(preview.status === 404 ? "not_found" : preview.status === 400 ? "invalid_path" : "forbidden", preview.reason, preview.status);
    return c.json(preview);
  });

  // ---- browsers (a list named by purpose; processes on this machine) ----
  app.get("/api/browser/environment", (c) => c.json(stack.browsers ? stack.browsers.environment() : null));
  const browserItem = (browser: ReturnType<typeof stack.repos.listBrowsers>[number]): BrowserListItem | null =>
    stack.browsers
      ? { ...browser, status: stack.browsers.status(browser.id), usedBy: roomsUsingBrowser(stack.repos, browser.id).map((room) => ({ roomId: room.id, title: room.title })) }
      : null;
  const requireBrowsers = () => {
    if (!stack.browsers) throw new RoomError("browser_unavailable", "This Backroom does not run browsers", 409);
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
    if (!item) throw new RoomError("browser_unavailable", "This Backroom does not run browsers", 409);
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
    if (!browserTools?.tools) throw new RoomError("browser_unavailable", "This Backroom does not run browsers", 409);
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

  // rooms-board: the same CLI contract and token as rooms-browser. It reads a room's posts and seats saved crew.
  // With ROOMS_ENGINE=1 the board is the engine's journal (src/app/boardEngine.ts).
  const board = boardFor(stack.engine, {
    repos: stack.repos,
    execute: (command) => stack.service.execute(parseCommand(command)),
    statusOf: (participantId) => stack.scheduler.participantStatus(participantId),
    standing: (participantId) => (stack.seats ? stack.seats.standingText(participantId) : stack.scheduler.standingText(participantId)),
    // A new room state reaches open pages through the room's stream, like any change.
    notify: (roomId) => stack.hub.notify(roomId),
    contextOf: (participant) => {
      const threadId = stack.repos.currentBinding(participant.id)?.threadId;
      return threadId ? costs.context([threadId], participant.modelSelection) : null;
    },
    // Two ticks: one may already be in flight and past its dispatch; the second sends the seat briefing for certain.
    afterSeat: async () => {
      await stack.scheduler.tick();
      await stack.scheduler.tick();
    },
  }, stack.seats);
  app.post("/api/board-tools", async (c) => {
    if (!browserTools || c.req.header("authorization") !== `Bearer ${browserTools.token}`) {
      return c.json({ error: "unauthorized", message: "rooms-board could not authenticate: the service was restarted or this is not its data folder" }, 401);
    }
    const body = (await c.req.json()) as { argv?: unknown; as?: unknown };
    const argv = Array.isArray(body.argv) ? body.argv.filter((a): a is string => typeof a === "string") : [];
    try {
      return c.json({ text: await board.run(argv, typeof body.as === "string" && body.as.trim() ? body.as.trim() : null) });
    } catch (error) {
      if (error instanceof BoardError) return c.json({ error: "board", message: error.message }, error.status as 400);
      throw error;
    }
  });

  /**
   * The whole of Backroom on one page (Look → Overview): every room with its members, what each is doing now in one
   * line, and what needs you. Member state comes from the scheduler's last poll; the live line of a member mid-turn is
   * read from T3 (bounded), the last reply of an idle one from the room's record.
   */
  app.get("/api/overview", async (c) => {
    const rooms = stack.repos.listRooms();
    const out = await Promise.all(
      rooms.map(async (room) => {
        const participants = stack.repos.listActiveParticipants(room.id);
        const tasks = stack.repos.listTasks(room.id);
        const events = stack.repos.listRecentEvents(room.id, 200);
        const seated = new Set(participants.map((p) => p.id));
        const needs = tasksNeedingYou(tasks.filter((task) => seated.has(task.participantId)), room.consigliereId).length + stack.repos.listOpenNativeRequests(participants.map((p) => p.id)).length;
        const members = await Promise.all(
          participants.map(async (participant) => {
            const status = stack.scheduler.participantStatus(participant.id);
            const binding = stack.repos.currentBinding(participant.id);
            const busy = status.activeRunId !== null || status.externalActivity || (status.status !== "unknown" && isRunActive(status.status));
            let live: string | null = null;
            if (busy && binding) {
              try {
                const detail = await stack.adapter.getThreadDetail(binding.threadId, { bounded: true });
                const running = detail ? runningRun(detail) : null;
                const last = detail && running ? liveFeed(detail, running.id).at(-1) : undefined;
                if (last?.kind === "message") live = last.text;
                else if (last?.kind === "tools") live = last.running.length > 0 ? `running ${last.running.join(", ")}` : `ran ${last.count} tool${last.count === 1 ? "" : "s"}`;
                else if (last?.kind === "notice") live = last.text;
              } catch {
                live = null;
              }
            }
            // What the member last said, for a member between turns.
            const reply = [...events].reverse().find((e) => (e.kind === "assistant.reply" || e.kind === "t3.turn") && e.speaker.type === "participant" && e.speaker.participantId === participant.id && e.text.trim().length > 0);
            const task = [...tasks].reverse().find((t) => t.participantId === participant.id && (t.state === "running" || t.state === "dispatching" || t.state === "needs_input"));
            return {
              id: participant.id,
              alias: participant.alias,
              modelSelection: participant.modelSelection,
              presetId: participant.presetId,
              consigliere: room.consigliereId === participant.id,
              status,
              live,
              doing: task ? task.instruction : null,
              lastReply: reply ? { at: reply.createdAt, text: reply.text.slice(0, 400) } : null,
            };
          }),
        );
        // The room state's first line is the tile's blurb.
        const state = roomStateView(stack.repos, room.id);
        return { id: room.id, projectId: room.projectId, title: room.title, consigliereId: room.consigliereId, needs, members, state: state ? { line: state.line, by: state.by, at: state.at } : null, updatedAt: room.updatedAt };
      }),
    );
    // Threads outside rooms, shown as rooms of one: the agent's live line while it works, else what it last said.
    const bound = new Set(stack.repos.listActiveBindings().map((b) => b.threadId));
    const loose = (await stack.adapter.listThreads()).filter((t) => !bound.has(t.id) && !t.archivedAt && !t.settledAt && !t.deletedAt && t.lineage.relationshipToParent !== "subagent").slice(0, 40);
    const threads = await Promise.all(
      loose.map(async (thread) => {
        let line: string | null = null;
        try {
          const detail = await stack.adapter.getThreadDetail(thread.id, { bounded: true });
          const running = detail ? runningRun(detail) : null;
          if (detail && running) {
            const last = liveFeed(detail, running.id).at(-1);
            if (last?.kind === "message") line = last.text;
            else if (last?.kind === "tools") line = last.running.length > 0 ? `running ${last.running.join(", ")}` : `ran ${last.count} tool${last.count === 1 ? "" : "s"}`;
            else if (last?.kind === "notice") line = last.text;
          } else if (detail) {
            const said = [...detail.messages].reverse().find((m) => m.role === "assistant" && !m.streaming && m.text.trim().length > 0);
            line = said ? said.text.slice(0, 400) : null;
          }
        } catch {
          line = null;
        }
        // News as the sidebar has it: the last run finished (or failed) after the thread was last looked at.
        const finishedAt = thread.latestRunCompletedAt;
        const news =
          finishedAt && (thread.status === "completed" || thread.status === "failed") && isAfter(finishedAt, seenMarks(stack.repos).of(`thread:${thread.id}`))
            ? { at: finishedAt, state: thread.status === "failed" ? ("error" as const) : ("completed" as const) }
            : null;
        return { id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, status: thread.status, pendingRequest: thread.pendingRequest, backgroundLiveness: backgroundOf(thread), latestRunCompletedAt: thread.latestRunCompletedAt, updatedAt: thread.updatedAt, line, news };
      }),
    );
    return c.json({ rooms: out, threads, readAt: new Date().toISOString() });
  });

  // ---- the Consigliere ----
  /** App-wide settings the page reads: which saved crew member is the Consigliere of new conversations. */
  app.get("/api/settings", (c) => {
    const presetId = stack.repos.getKv(CONSIGLIERE_PRESET_KEY);
    const saved = stack.repos.getKv(CONSIGLIERE_RULES_KEY);
    // On the engine its own default wording is in force (the board's mechanics are added after it, whatever the wording).
    const defaultText = stack.engine !== null ? ENGINE_DEFAULT_CONSIGLIERE_RULES : DEFAULT_CONSIGLIERE_RULES;
    return c.json({
      consiglierePresetId: presetId && stack.repos.getPreset(presetId) ? presetId : null,
      // The rules every Consigliere is given: the user's wording when they saved one, and Backroom's to go back to.
      consigliereRules: { text: saved && saved.trim() ? consigliereRules(saved) : defaultText, custom: Boolean(saved && saved.trim()), defaultText },
      // What happens to a member's T3 thread when the Consigliere retires it or a reseat retires the old seat.
      retireThread: retireThreadChoice(stack.repos),
    });
  });
  /** What to tell the user before a member is made Consigliere: reasons it may not work. It is allowed all the same. */
  app.get("/api/rooms/:roomId/participants/:participantId/consigliere-warnings", async (c) => {
    const participant = stack.repos.getParticipant(c.req.param("participantId"));
    if (!participant || participant.roomId !== c.req.param("roomId")) throw new RoomError("not_found", "member not found", 404);
    let driver: string | null = null;
    try {
      driver = (await stack.adapter.listCatalog()).find((entry) => entry.instanceId === participant.modelSelection.instanceId)?.driver ?? null;
    } catch {
      // Without T3's catalog the instance name stands in for the harness.
    }
    return c.json({ warnings: designationWarnings(participant, driver) });
  });

  // ---- Backroom's voice ----
  /**
   * Whether the service can read aloud, and how it is doing: asking also starts loading the model, so the first
   * reply read after the UI opens does not wait for it.
   */
  app.get("/api/speech/status", (c) => {
    if (!speech) return c.json({ available: false, state: "off", error: null, voices: [], defaultVoice: null });
    speech.warm();
    return c.json({ available: true, ...speech.status() });
  });
  /** A sentence or two as WAV, in the voice and at the speed asked for. */
  app.post("/api/speech", async (c) => {
    if (!speech) throw new RoomError("speech_off", "This Backroom does not read aloud (ROOMS_SPEECH=off)", 503);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; voice?: unknown; speed?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new RoomError("invalid_text", "text is required");
    if (text.length > 1200) throw new RoomError("invalid_text", "text is too long for one piece; send it in pieces", 413);
    try {
      const wav = await speech.synthesize(text, typeof body.voice === "string" ? body.voice : speech.status().defaultVoice, typeof body.speed === "number" ? body.speed : 1);
      return new Response(new Uint8Array(wav), { status: 200, headers: { "content-type": "audio/wav", "cache-control": "private, max-age=3600" } });
    } catch (error) {
      throw new RoomError("speech_failed", `The voice could not be produced: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  /**
   * The browsers section for a thread outside any room, as a room's agents get it: the browsers the thread may use,
   * its default (started now), and the thread's own key. The UI adds it to the user's next message.
   */
  app.get("/api/threads/:threadId/browser-briefing", async (c) => {
    const threadId = c.req.param("threadId");
    const access = stack.repos.getThreadBrowsers(threadId);
    if (!access?.browserEnabled) throw new RoomError("browsers_off", "Browsers are off for this thread; turn them on first", 409);
    const browser = effectiveBrowser(stack.repos, access);
    if (!browser) throw new RoomError("no_browser", "This thread has no browser; create one first", 409);
    const started = await requireBrowsers().briefingFor(browser);
    if (!started) throw new RoomError("browser_failed", `"${browser.name}" could not start`, 409);
    return c.json({
      text: browserSection({
        audience: "thread",
        command: browserTools?.command ?? "rooms-browser",
        as: threadKey(threadId),
        started,
        browsers: browsersForRoom(stack.repos, access).map((b) => ({
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
      "/favicon.png": "image/png",
      "/apple-touch-icon.png": "image/png",
      // The sidebar's mark.
      "/logo.png": "image/png",
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
      c.text("Backroom service is running. Build the UI with `npm run build:web` or run the Vite dev server in web/.", 200),
    );
  }
  return app;
}

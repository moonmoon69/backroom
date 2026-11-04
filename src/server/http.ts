/**
 * Backroom's HTTP API for its UI. Every mutation goes through POST /api/commands using the shared command contract.
 * Live updates use Server-Sent Events; the UI refetches the room snapshot on each notification.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { compress } from "hono/compress";
import { serveStatic } from "@hono/node-server/serve-static";
import { readRoster } from "../app/skillRoster.ts";
import type { AppStack } from "../app/bootstrap.ts";
import type { T3Credential } from "../app/t3Credential.ts";
import type { HttpT3Adapter } from "../adapter/http.ts";
import { exchangePairingCredential, parsePairingUrl, readStoredAuth, sameT3Host, writeStoredAuth } from "../adapter/auth.ts";
import { ORCHESTRATION_PROTOCOL_VERSION, T3CommandRejected, T3ProtocolMismatch, T3ScopeMissing, T3Unavailable, backgroundOf, runPrompt } from "../adapter/types.ts";
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
  queueOf,
} from "../app/threadView.ts";
import { CommandValidationError, parseCommand } from "../domain/commands.ts";
import { RoomError } from "../domain/errors.ts";
import type { BrowserListItem } from "../domain/types.ts";
import { browsersForRoom, effectiveBrowser, roomsUsingBrowser, threadKey } from "../browser/catalog.ts";
import { browserSection } from "../briefing/assemble.ts";
import { BrowserToolError, type BrowserTools } from "../browser/tools.ts";
import { BoardError } from "../app/board.ts";
import { BoardEngine } from "../app/boardEngine.ts";
import { CONSIGLIERE_PRESET_KEY, CONSIGLIERE_RULES_KEY, ENGINE_DEFAULT_CONSIGLIERE_RULES, designationWarnings, retireThreadChoice } from "../app/consigliere.ts";
import { AGENTS_FILE_SETTING_KEY, agentsTemplate } from "../app/agentsFile.ts";
import { parseExplicit } from "../parser/explicit.ts";
import { resolveLocalImage } from "./localImage.ts";
import { previewFile } from "./filePreview.ts";
import { canonicalPath, readCheckoutSummary, readFileDiff, readGitView, readRoomCompare, worktreePathsOf } from "../git/reader.ts";
import { roomFolders as listRoomFolders } from "../git/workspaces.ts";
import type { Config } from "../config.ts";
import { ThreadCosts } from "../usage/threadCosts.ts";
import type { ContextMeter } from "../domain/contextMeter.ts";
import { SEEN_KEY, markSeen } from "../app/seen.ts";
import { roomStateView } from "../app/roomState.ts";
import { orderProjects } from "../app/service.ts";
import { isLoose, mountEngineView, shelfThread, startedByHost } from "./engineView.ts";
import { seatsWithLiveRuns } from "../runtime/index.ts";

/** Agents' browser tools (bin/rooms-browser): the engine, the token the CLI presents, and the command briefings name. */
export interface BrowserToolsHttp {
  tools: BrowserTools | null;
  token: string;
  command: string;
}

export function createHttpApp(stack: AppStack, config: Config, webDistDir: string, browserTools?: BrowserToolsHttp, t3Credential?: T3Credential | null): Hono {
  const app = new Hono();
  // gzip for what compresses (JSON, scripts, styles, HTML) when the client takes it; the event streams and binary files
  // are left as they are (Hono's content-type filter).
  app.use(compress());
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
    if (error instanceof T3ScopeMissing) return c.json({ error: "t3_scope_missing", message: error.message }, 403);
    console.error(error);
    return c.json({ error: "internal", message: (error as Error).message }, 500);
  });

  // ---- status & T3 ----
  // What T3 last said of itself (its descriptor, its session), shown while an outage already known is answered at once.
  let lastSaid: { environment: unknown; auth: unknown } = { environment: null, auth: null };
  app.get("/api/status", async (c) => {
    const stored = readStoredAuth(config.dataDir);
    let environment: unknown = null;
    let auth: unknown = null;
    // This request's own check of T3, when it fails.
    let error: string | null = null;
    let errorAt: string | null = null;
    if (stack.adapter.kind === "fake" || httpAdapter) {
      // Whether T3 answers is one truth, the one pages are pushed (src/app/changes.ts): T3's feed with the HTTP adapter,
      // the pages' check with the fake. T3 answering its descriptor while its shell does not (a restart half done, #8)
      // is T3 not answering, on the chip as on the banner. Never waited on, and an outage it already knows is answered
      // at once, with no request to T3 waited on: one T3 holds up would hold the chip back behind the banner as long
      // (reviews #201, #266). Not known yet, a check starts, and what it finds is pushed to the pages, which read this
      // again.
      const known = stack.changes.status();
      if (!known) void stack.changes.check();
      if (known && !known.up) ({ environment, auth } = lastSaid);
      else {
        try {
          const described = await stack.adapter.describe();
          environment = described;
          if (httpAdapter) auth = await httpAdapter.authSession();
          lastSaid = { environment, auth };
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
      // An outage known by now, the one before the requests or one that came during them, is the answer.
      const reach = stack.changes.status();
      if (reach && !reach.up) {
        error = reach.error ?? "T3 is not answering";
        errorAt = reach.at;
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
        credential: t3Credential?.status() ?? null,
        // Whether T3's shell reaches Backroom as T3 streams it, or by HTTP snapshots while the stream is not live.
        feed: stack.adapter.feed(),
        // The threads watched (seated, or shown by a page in the last minute), how many of their streams are live, and
        // how many T3 refuses (src/adapter/threadFeed.ts); null on the fake T3, which has no streams.
        threads: httpAdapter ? httpAdapter.threadStreams() : null,
        environment,
        auth,
        error,
        errorAt,
      },
    });
  });

  /**
   * What changed, pushed to each open page (src/app/changes.ts), one stream per page: `rooms` (a room changed), `room`
   * with { roomId } (that room's snapshot), `shell` (T3's projects or threads), `thread` with { threadId } (a watched
   * thread's detail), `status` (T3 reachable or not, as { up, error, at }; sent at once while T3 is down). A comment every 20 s keeps the stream open; `retry` tells the
   * browser how soon to reconnect. The page reads again on each event, and everything again on each (re)connect.
   */
  app.get("/api/events", (c) => {
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let closed = false;
      // Written one after another: a write is not started before the one before it has gone.
      let queue: Promise<unknown> = Promise.resolve();
      const write = (text: string) => {
        queue = queue.then(() => (closed ? undefined : stream.write(text))).catch(() => undefined);
        return queue;
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let unsubscribe: (() => void) | null = null;
      let wake: (() => void) | null = null;
      // The page went away, or the service is shutting down: the stream ends and stops listening.
      const end = () => {
        closed = true;
        unsubscribe?.();
        wake?.();
      };
      unsubscribe = stack.changes.subscribe((event) => {
        if (event.type === "rooms") void send("rooms", {});
        else if (event.type === "room") void send("room", { roomId: event.roomId });
        else if (event.type === "shell") void send("shell", {});
        else if (event.type === "thread") void send("thread", { threadId: event.threadId });
        else if (event.type === "status") void send("status", event.status);
        else end();
      });
      stream.onAbort(end);
      if (closed) return;
      await write("retry: 3000\n\n");
      // A page assumes T3 answers until told otherwise: told at once when it does not.
      const known = stack.changes.status();
      if (known && !known.up) await send("status", known);
      while (!closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, stack.changes.heartbeatMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (!closed) await write(`: heartbeat ${Date.now()}\n\n`);
      }
    });
  });

  app.post("/api/t3/pair", async (c) => {
    if (!httpAdapter) throw new RoomError("fake_adapter", "pairing is not available with the fake adapter");
    const body = (await c.req.json()) as { pairingUrl?: string };
    if (!body.pairingUrl) throw new RoomError("missing_pairing_url", "pairingUrl is required");
    const { baseUrl, credential } = parsePairingUrl(body.pairingUrl);
    if (config.t3BaseUrl && !sameT3Host(config.t3BaseUrl, baseUrl)) {
      // Allow pairing to a different host, but say so: the adapter is bound to the configured base URL.
      throw new RoomError("base_url_mismatch", `pairing URL host ${new URL(baseUrl).host} does not match configured T3 ${config.t3BaseUrl}; set T3_BASE_URL and restart`);
    }
    const auth = await exchangePairingCredential(baseUrl, credential);
    writeStoredAuth(config.dataDir, auth);
    httpAdapter.setAccessToken(auth.accessToken);
    t3Credential?.paired();
    return c.json({ paired: true, scope: auth.scope, expiresAt: auth.expiresAt });
  });

  // A project's setting for its new rooms, as a room's browsers read (the default is the one they would use); null without one.
  const projectBrowsersView = (projectId: string) => {
    const record = stack.repos.getProjectBrowsers(projectId);
    return record ? { enabled: record.browserEnabled, defaultBrowserId: effectiveBrowser(stack.repos, record)?.id ?? null, allowedBrowserIds: record.allowedBrowserIds } : null;
  };
  app.get("/api/t3/projects", async (c) =>
    c.json(orderProjects(stack.repos, await stack.adapter.listProjects()).map((project) => ({ ...project, browsers: projectBrowsersView(project.id) }))),
  );
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
      if (error instanceof T3CommandRejected) return c.json({ parentPath: null, entries: [], unreadable: error instanceof T3ScopeMissing ? error.message : "T3 cannot read that folder on its machine." });
      throw error;
    }
  });
  /**
   * T3's active threads, for the pickers. ?shelf=1 answers instead the overview's shelf (Overview.tsx, ThreadShelf):
   * the settled and archived threads outside rooms, a few fields each; its archived part is best effort. With
   * &threadId= it is that thread's row alone, if it is on the shelf (the open thread's lifecycle, App.tsx).
   */
  app.get("/api/t3/threads", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const bound = new Set(stack.repos.listActiveBindings().map((b) => b.threadId));
    const threads = (await stack.adapter.listThreads(projectId)).filter((t) => t.archivedAt === null);
    if (c.req.query("shelf") === "1") {
      const archived = await stack.adapter.listArchivedThreads().catch((error: unknown) => {
        console.warn(`[backroom] archived threads not read: ${(error as Error).message}`);
        return [];
      });
      const threadId = c.req.query("threadId");
      const shelved = [...threads.filter((t) => t.settledAt), ...archived.filter((t) => !projectId || t.projectId === projectId)];
      return c.json(shelved.filter((t) => isLoose(t, bound) && (!threadId || t.id === threadId)).map(shelfThread));
    }
    return c.json(threads.map((t) => ({ ...t, backgroundLiveness: backgroundOf(t), boundToRoom: bound.has(t.id) })));
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
    // A page shows it: watched for a minute (each read renews it), its changes pushed as `thread` events.
    stack.adapter.leaseThread(threadId);
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
      queue: queueOf(detail),
      backgroundTasks: backgroundTasks(detail, Date.now(), await stack.watchedChecks(detail.shell)),
      contextWindow: contextReading(detail),
      usage: await threadUsage(detail),
      browsers: threadBrowsersView(threadId),
      // T3 holds runs older than the window read here.
      partial: detail.partial,
      // Its changes come as `thread` events on GET /api/events: the page's timer only backs them up.
      pushed: stack.adapter.threadPushed(threadId),
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
    stack.adapter.leaseThread(threadId);
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

  // The room routes read the rooms' journal (src/server/engineView.ts, L4c).
  mountEngineView(app, stack, costs);

  // A thread outside rooms was on screen up to `at` (the newest finish it showed): its news is seen, on every device. A
  // room's mark is a journal sequence, taken before this by src/server/engineView.ts.
  app.post("/api/seen", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; at?: unknown } | null;
    const key = typeof body?.key === "string" ? body.key : "";
    const at = typeof body?.at === "string" ? body.at : "";
    if (!SEEN_KEY.test(key) || Number.isNaN(Date.parse(at))) throw new RoomError("invalid_seen", "key must be thread:<id> with at an ISO time, or room:<id> with seq a journal sequence");
    return c.json({ key, at: markSeen(stack.repos, key, at) });
  });

  // The room state alone (the snapshot carries it too): the Consigliere's summary, who wrote it and when; null until one is written.
  app.get("/api/rooms/:roomId/state", (c) => {
    const roomId = c.req.param("roomId");
    if (!stack.repos.getRoom(roomId)) throw new RoomError("not_found", "room not found", 404);
    const state = roomStateView(stack.repos, roomId);
    return c.json(state ? { roomId, state } : { roomId, state: null, message: "This room has no state yet: its Consigliere writes it with rooms-board state." });
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
      usageLimit: null,
      queue: null,
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
    // A page shows it: watched for a minute (each read renews it), its changes pushed as `thread` events.
    stack.adapter.leaseThread(binding.threadId);
    // The recent window of the thread: its runs and requests in full, its latest items and messages.
    const detail = await stack.adapter.getThreadDetail(binding.threadId, { bounded: true });
    if (!detail) return { ...empty, pushed: stack.adapter.threadPushed(binding.threadId) };
    const shell = detail.shell;
    const running = runningRun(detail);
    const latest = detail.runs.find((run) => run.id === shell.latestRunId) ?? null;
    const shownRunId = running?.id ?? latest?.id ?? null;
    // The run in progress, if any: whether the room sent it (from the journal), and for any other the prompt that started it.
    const promptMessage = running ? runPrompt(detail, running) : null;
    const startedByRoom = running ? startedByHost(stack.engine.view(participant.roomId), binding.id, running.id, detail) : false;
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
      usageLimit: shell.usageLimit,
      queue: queueOf(detail),
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      pullRequests: shell.pullRequests,
      linkedPullRequest: shell.linkedPullRequest,
      planProgress: planProgress(detail),
      backgroundLiveness: backgroundOf(shell),
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
      backgroundTasks: backgroundTasks(detail, Date.now(), await stack.watchedChecks(detail.shell)),
      subagents: subagentRows(detail),
      activities: recentActivity(detail),
      // A window of recent history; T3 holds the complete record.
      partial: detail.partial,
      // Its changes come as `thread` events on GET /api/events: the page's timer only backs them up.
      pushed: stack.adapter.threadPushed(binding.threadId),
    };
  };

  app.get("/api/rooms/:roomId/participants/:participantId/live", async (c) => {
    const participant = stack.repos.getParticipant(c.req.param("participantId"));
    if (!participant || participant.roomId !== c.req.param("roomId")) throw new RoomError("not_found", "member not found", 404);
    return c.json(await deskFor(participant.id));
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
    // Every member's thread pushes its changes: the page's desk timer only backs them up.
    const pushed = Object.values(desks).every((desk) => (desk as { threadId?: unknown }).threadId === null || (desk as { pushed?: unknown }).pushed === true);
    return c.json({ participants: desks, errors, fetchedAt: new Date().toISOString(), pushed: pushed && Object.keys(errors).length === 0 });
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
    // Busy, for alias pools (@sol → a free member of sol1, sol2, …): its seat has a live run.
    const live = seatsWithLiveRuns(stack.engine.view(roomId));
    const participants = stack.repos.listActiveParticipants(roomId).map((p) => ({ id: p.id, alias: p.alias, busy: live.has(stack.repos.currentBinding(p.id)?.id ?? "") }));
    return c.json(parseExplicit(body.text ?? "", participants, { consigliereId: room.consigliereId }));
  });

  // Images for the composer: raw bytes in, attachment record out. Referenced by id from message.create.
  app.post("/api/rooms/:roomId/attachments", async (c) => {
    const data = new Uint8Array(await c.req.arrayBuffer());
    const name = decodeURIComponent(c.req.header("x-file-name") ?? "image");
    const mimeType = (c.req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
    return c.json(stack.service.storeAttachment({ roomId: c.req.param("roomId"), name, mimeType, data }));
  });

  // Images attached to messages typed in T3 Code live as files under T3's userdata/attachments, named by id.
  // Those ids appear on notes typed in T3; they are served here when the id is not a room attachment.
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

  /**
   * A media file an agent wrote to disk and referenced from a reply (`![shot](/tmp/shot.png)`), like T3 Code renders
   * them: an image, video or audio file wherever the service can read it (localImage.ts), streamed with byte ranges so
   * a video seeks and plays on every browser. /api/local-image is the older name for the same route.
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
   * Any file the service can read, never a secret; see filePreview.ts. `base` is the folder the reply was written in,
   * where a relative path is looked for first, then in the projects and their threads' worktrees.
   */
  app.get("/api/file-preview", async (c) => {
    const [projects, threads] = await Promise.all([stack.adapter.listProjects(), stack.adapter.listThreads()]);
    const folders = [...projects.map((project) => project.workspaceRoot), ...threads.flatMap((thread) => (thread.worktreePath ? [thread.worktreePath] : []))];
    const preview = previewFile(c.req.query("path") ?? "", { base: c.req.query("base") || null, folders });
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

  // rooms-board: the same CLI contract and token as rooms-browser. The board is the room's journal (src/app/boardEngine.ts).
  const board = new BoardEngine({
    repos: stack.repos,
    host: stack.engine,
    execute: (command) => stack.service.execute(parseCommand(command)),
    seats: stack.seats,
    standing: (participantId) => stack.seats.standingText(participantId),
    memberState: (threadId, ownRun) => stack.memberState(threadId, ownRun),
    // A new room state reaches open pages through the room's stream, like any change.
    notify: (roomId) => stack.hub.notify(roomId),
    contextOf: (participant) => {
      const threadId = stack.repos.currentBinding(participant.id)?.threadId;
      return threadId ? costs.context([threadId], participant.modelSelection) : null;
    },
    // Two ticks: one may already be in flight and past its dispatch; the second sends the seat briefing for certain.
    afterSeat: async () => {
      await stack.engine.tick();
      await stack.engine.tick();
    },
  });
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

  // ---- the Consigliere ----
  /** App-wide settings the page reads: which saved crew member is the Consigliere of new rooms. */
  app.get("/api/settings", (c) => {
    const presetId = stack.repos.getKv(CONSIGLIERE_PRESET_KEY);
    const saved = stack.repos.getKv(CONSIGLIERE_RULES_KEY);
    // Backroom's default wording (the board's mechanics are added after it, whatever the wording).
    const defaultText = ENGINE_DEFAULT_CONSIGLIERE_RULES;
    return c.json({
      consiglierePresetId: presetId && stack.repos.getPreset(presetId) ? presetId : null,
      // The rules every Consigliere is given: the user's wording when they saved one, and Backroom's to go back to.
      consigliereRules: { text: saved && saved.trim() ? saved.trim() : defaultText, custom: Boolean(saved && saved.trim()), defaultText },
      // What happens to a member's T3 thread when the Consigliere retires it or a reseat retires the old seat.
      retireThread: retireThreadChoice(stack.repos),
      // Settings → Agents file: whether a new room writes the default agents file in its project's folder (src/app/agentsFile.ts).
      agentsFile: stack.repos.getKv(AGENTS_FILE_SETTING_KEY) !== "off",
      // The template it writes, {checks} filled per project: the user's when they saved one, and Backroom's to go back to.
      agentsFileText: agentsTemplate(stack.repos),
    });
  });
  /**
   * Settings → Skills and the composer's "/" list: the roster (src/app/skillRoster.ts), the skill folders with who reads
   * each, and the packs (src/app/packs.ts). T3 unreadable: the rows it reports are missing and t3Error says why.
   */
  app.get("/api/skills", async (c) => {
    const roster = await readRoster({ packs: stack.packs, adapter: stack.adapter, repos: stack.repos });
    return c.json({ rows: roster.rows, t3Error: roster.t3Error, folders: stack.packs?.folders() ?? [], packs: stack.packs?.states() ?? [] });
  });
  /** What a pack's update brings (?commit=, the commit the page was told of): stat, files, description changes, the diff. */
  app.get("/api/skills/packs/:name/update", async (c) => {
    if (!stack.packs) throw new RoomError("pack_refused", "this service keeps no skill packs", 409);
    const commit = c.req.query("commit") ?? "";
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new RoomError("bad_request", "commit must be a full commit id");
    return c.json(await stack.packs.updateDetail(c.req.param("name"), commit));
  });
  /**
   * Every project folder where Backroom wrote AGENTS.md, each with its file's state against the saved template rendered
   * for it (same, differs, removed, blocked) and the project's title when T3 still has it. A few file reads per call.
   */
  app.get("/api/agents-files", async (c) => {
    const files = stack.service.agentsFiles;
    if (!files) return c.json([]);
    const projects = await stack.adapter.listProjects().catch(() => null);
    return c.json(files.list(projects));
  });
  /** One project's AGENTS.md (?projectId= or ?folder=) against the saved template rendered for it, with the digests Apply takes back. */
  app.get("/api/agents-files/diff", async (c) => {
    const files = stack.service.agentsFiles;
    if (!files) throw new RoomError("agents_file_refused", "this service writes no agents files", 409);
    const projectId = c.req.query("projectId");
    const folder = c.req.query("folder");
    if (!projectId === !folder) throw new RoomError("bad_request", "give a projectId or a folder");
    return c.json(await files.diff(projectId ? { projectId } : { folder: folder! }));
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
    // Unreadable JSON is refused without the parser's message, which quotes the body (a secret's answer among them).
    const body: unknown = await c.req.json().catch(() => {
      throw new RoomError("invalid_json", "the command is not valid JSON");
    });
    const command = parseCommand(body);
    const result = await stack.service.execute(command);
    // A deleted browser's process and profile (logins, history) go with it. Rooms never take a browser with them.
    if (command.type === "browser.delete") await stack.browsers?.remove(command.browserId);
    // Let the engine host react promptly to new work without waiting for the next interval.
    void stack.engine.tick();
    return c.json(result);
  });

  // An API path nothing above handles is a 404, never the app shell (a UI newer than the service would read HTML as data).
  app.all("/api/*", (c) => c.json({ error: "not_found", message: `no route for ${c.req.method} ${c.req.path}` }, 404));

  // ---- static UI ----
  if (existsSync(join(webDistDir, "index.html"))) {
    const distRoot = webDistDir.replace(process.cwd() + "/", "");
    // Asset file names carry their content's hash: a rebuilt bundle has new names, so a copy kept a year is never stale.
    app.use(
      "/assets/*",
      async (c, next) => {
        await next();
        if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
      serveStatic({ root: distRoot }),
    );
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

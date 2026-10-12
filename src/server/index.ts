/** Service entry point: loads config, builds the adapter, starts the engine host and the HTTP API. */
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStoredAuth } from "../adapter/auth.ts";
import { FakeT3Adapter } from "../adapter/fake.ts";
import { persistFake } from "../adapter/fakeState.ts";
import { HttpT3Adapter } from "../adapter/http.ts";
import type { T3Adapter } from "../adapter/types.ts";
import { createStack } from "../app/bootstrap.ts";
import { T3Credential, localT3Cli } from "../app/t3Credential.ts";
import { RoomBrowsers } from "../browser/roomBrowsers.ts";
import { accessForKey, browserBusy, reconcileBrowserCatalog, roomsMayUseBrowser } from "../browser/catalog.ts";
import { seatsWithLiveRuns } from "../runtime/index.ts";
import { mainCheckoutData } from "../browser/ports.ts";
import { BrowserTools } from "../browser/tools.ts";
import { loadConfig, readT3RuntimeOrigin } from "../config.ts";
import { KokoroSpeech } from "../speech/kokoro.ts";
import { withFakeControls } from "./fakeControls.ts";
import { createHttpApp } from "./http.ts";

const config = loadConfig();
const log = (message: string, detail?: unknown) => {
  const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`[backroom] ${new Date().toISOString()} ${message}${suffix}`);
};

let adapter: T3Adapter;
let credential: T3Credential | null = null;
if (config.adapter === "fake") {
  // ROOMS_FAKE_PROJECT_DIR points the demo project at a folder of the caller's (a scratch repository for a rehearsal).
  const fake = new FakeT3Adapter({ autoCompleteMs: 4000, ...(process.env.ROOMS_FAKE_PROJECT_DIR ? { projectRoot: process.env.ROOMS_FAKE_PROJECT_DIR } : {}) });
  // Kept in a file when asked, so its threads outlive a restart of the service as T3's do (scripts/rehearse.ts --step room).
  const stateFile = process.env.ROOMS_FAKE_STATE;
  adapter = stateFile ? persistFake(fake, stateFile) : fake;
  log(`using the fake T3 adapter (demo mode${stateFile ? `, kept in ${stateFile}` : ""}; the demo project's folder is ${fake.projects[0]!.workspaceRoot})`);
} else {
  const stored = readStoredAuth(config.dataDir);
  const baseUrl = config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773";
  const http = new HttpT3Adapter({
    baseUrl,
    accessToken: config.t3AccessToken ?? stored?.accessToken ?? null,
    userDataDir: config.t3UserDataDir,
    onCredentialRejected: (token) => credential?.rejected(token),
  });
  adapter = http;
  // A token given in T3_ACCESS_TOKEN is the user's to keep; otherwise Backroom keeps its own (src/app/t3Credential.ts).
  if (!config.t3AccessToken) {
    credential = new T3Credential({
      dataDir: config.dataDir,
      baseUrl,
      localOrigin: readT3RuntimeOrigin(config.t3UserDataDir),
      cli: localT3Cli(config.t3Home, config.t3Cli),
      use: (token) => http.setAccessToken(token),
      verify: (token) => http.accepts(token),
      log,
    });
  }
  const renewal = credential ? (credential.automatic ? "renewed by Backroom with T3's CLI" : "renewed by pairing again") : "from T3_ACCESS_TOKEN";
  log(`T3 base URL ${baseUrl}; credentials ${config.t3AccessToken || stored ? "present" : "missing"}, ${renewal}`);
}

// Agents run bin/rooms-browser from their shell; it finds the service through data/browser-api.json (URL and a token
// written at every start). With a data directory elsewhere, the briefing passes that file's path along.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const browserApiFile = join(config.dataDir, "browser-api.json");
const quote = (path: string) => (/\s/.test(path) ? `'${path}'` : path);
const browserCommand = `${resolve(config.dataDir) === join(repoRoot, "data") ? "" : `ROOMS_BROWSER_API=${quote(browserApiFile)} `}${quote(join(repoRoot, "bin", "rooms-browser"))}`;
const boardCommand = `${resolve(config.dataDir) === join(repoRoot, "data") ? "" : `ROOMS_BROWSER_API=${quote(browserApiFile)} `}${quote(join(repoRoot, "bin", "rooms-board"))}`;
let browserTools: BrowserTools | null = null;
// A Backroom run from a worktree (a throwaway for tests and rehearsals) also records the ports of the browsers in the
// main checkout's data folder, the user's Backroom's, even before that one runs a version that records them itself.
const userData = mainCheckoutData(repoRoot);
const knownDataDirs = userData && resolve(userData) !== resolve(config.dataDir) ? [userData] : [];

const stack = createStack({
  dbPath: config.dbPath,
  adapter,
  briefingBudgetChars: config.briefingBudgetChars,
  threadActionTimeoutMs: config.threadActionTimeoutMs,
  keepAliveMs: config.keepAliveMs,
  // A throwaway service on the fake T3 writes agents files only in its own data folder and ROOMS_FAKE_PROJECT_DIR: a real
  // folder added to it as a project is never written in (and it does not know what the user's Backroom wrote there).
  agentsFile: config.adapter === "fake" ? { onlyUnder: [config.dataDir, ...(process.env.ROOMS_FAKE_PROJECT_DIR ? [process.env.ROOMS_FAKE_PROJECT_DIR] : [])] } : true,
  browserCommand,
  boardCommand,
  log,
  browsers: ({ repos, notify }) =>
    new RoomBrowsers({
      dataDir: config.dataDir,
      ...config.browser,
      knownDataDirs,
      // Busy while a room using it as its default has a seat with a live run, or an agent with work in flight has a tab
      // open in it; changes are shown in the rooms using it.
      isBusy: (browserId) =>
        browserBusy(repos, browserId, {
          roomBusy: (roomId) => seatsWithLiveRuns(stack.engine.view(roomId)).size > 0,
          threadBusy: async (threadId) => {
            const shell = await adapter.getThreadShell(threadId);
            return Boolean(shell && (shell.activeRunId !== null || shell.pendingBackgroundTasks.length > 0));
          },
          agentsWithTabs: async (id) => (browserTools ? browserTools.agentsWithTabs(id) : []),
        }),
      onChange: (browserId) => {
        browserTools?.browserChanged(browserId);
        // Every room that may use it shows it (its Browser button and panel), not only the rooms it is the default of.
        for (const room of roomsMayUseBrowser(repos, browserId)) notify(room.id);
      },
      log,
    }),
});
// Profile folders from before browsers were a list become browsers (the running ones are adopted under the same id).
for (const browser of stack.db.transaction(() => reconcileBrowserCatalog(stack.repos, config.dataDir))) log(`browser "${browser.name}" adopted from ${browser.id}`);
stack.browsers?.start();
if (stack.browsers) {
  browserTools = new BrowserTools({
    browsers: stack.browsers,
    findBrowser: (nameOrId) => stack.repos.getBrowserByName(nameOrId.toLowerCase()) ?? stack.repos.getBrowser(nameOrId),
    accessFor: (key) => accessForKey(stack.repos, key),
    log,
  });
}
const browserApiToken = randomBytes(24).toString("base64url");
{
  const environment = stack.browsers?.environment();
  if (environment) log(`room browsers: ${environment.mode ?? "unavailable"}${environment.missing.length > 0 ? ` (missing ${environment.missing.join(", ")})` : ""}`);
}

if (adapter instanceof FakeT3Adapter) {
  // Demo mode keeps simulated threads in memory; recreate them for bindings persisted by an earlier run.
  let restored = 0;
  for (const binding of stack.repos.listActiveBindings()) {
    const participant = stack.repos.getParticipant(binding.participantId);
    const room = participant ? stack.repos.getRoom(participant.roomId) : null;
    if (!participant || !room || adapter.threads.has(binding.threadId)) continue;
    await adapter.launchThread({
      commandId: `restore:${binding.threadId}`,
      threadId: binding.threadId,
      projectId: room.projectId,
      title: `${room.title} · ${participant.alias}`,
      modelSelection: participant.modelSelection,
      runtimeMode: participant.runtimeMode,
      interactionMode: participant.interactionMode,
      workspace: { type: "root" },
    });
    restored += 1;
  }
  if (restored > 0) log(`restored ${restored} simulated thread(s) for existing participants`);
}
// Backroom's voice: loaded when the UI first asks (the model is fetched once into data/models), off with ROOMS_SPEECH=off.
const speech = config.speech.enabled ? new KokoroSpeech({ modelsDir: join(config.dataDir, "models"), defaultVoice: config.speech.voice, log }) : null;
const app = createHttpApp(stack, config, config.webDistDir, { tools: browserTools, token: browserApiToken, command: browserCommand }, speech, credential);
credential?.start();
// T3's shell as T3 streams it: the engine's and the page's shell reads come from it while it is live.
if (adapter instanceof HttpT3Adapter) adapter.startFeed();
stack.engine.start(config.tickMs);

// The fake T3's test controls (scripts/rehearse.ts) answer under /api/fake/ on a fake adapter only.
const fetch = adapter instanceof FakeT3Adapter ? withFakeControls(app.fetch, adapter) : app.fetch;
const server = serve({ fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  log(`listening on http://127.0.0.1:${info.port} (db ${config.dbPath})`);
  // rooms-board needs the file too, so it is written whether or not this service runs browsers.
  {
    writeFileSync(browserApiFile, `${JSON.stringify({ url: `http://127.0.0.1:${info.port}`, token: browserApiToken }, null, 2)}\n`, { mode: 0o600 });
  }
});

const shutdown = () => {
  log("shutting down");
  server.close();
  credential?.stop();
  browserTools?.closeAll();
  stack.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

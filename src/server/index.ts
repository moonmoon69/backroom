/** Service entry point: loads config, builds the adapter, starts the scheduler and the HTTP API. */
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { readStoredAuth } from "../adapter/auth.ts";
import { FakeT3Adapter } from "../adapter/fake.ts";
import { HttpT3Adapter } from "../adapter/http.ts";
import type { T3Adapter } from "../adapter/types.ts";
import { createStack } from "../app/bootstrap.ts";
import { RoomBrowsers } from "../browser/roomBrowsers.ts";
import { reconcileBrowserCatalog, roomsUsingBrowser } from "../browser/catalog.ts";
import { loadConfig } from "../config.ts";
import { createHttpApp } from "./http.ts";

const config = loadConfig();
const log = (message: string, detail?: unknown) => {
  const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`[rooms] ${new Date().toISOString()} ${message}${suffix}`);
};

let adapter: T3Adapter;
if (config.adapter === "fake") {
  adapter = new FakeT3Adapter({ autoCompleteMs: 4000 });
  log("using the fake T3 adapter (demo mode)");
} else {
  const stored = readStoredAuth(config.dataDir);
  const baseUrl = config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773";
  adapter = new HttpT3Adapter({
    baseUrl,
    accessToken: config.t3AccessToken ?? stored?.accessToken ?? null,
    userDataDir: config.t3UserDataDir,
  });
  log(`T3 base URL ${baseUrl}; credentials ${config.t3AccessToken || stored ? "present" : "missing (pair from the UI)"}`);
}

const stack = createStack({
  dbPath: config.dbPath,
  adapter,
  briefingBudgetChars: config.briefingBudgetChars,
  log,
  browsers: ({ repos, notify }) =>
    new RoomBrowsers({
      dataDir: config.dataDir,
      ...config.browser,
      // Busy while any room using the browser has work in flight; changes are shown in those rooms.
      isBusy: (browserId) =>
        roomsUsingBrowser(repos, browserId).some((room) => repos.listTasks(room.id).some((t) => t.state === "running" || t.state === "dispatching" || t.state === "needs_input")),
      onChange: (browserId) => {
        for (const room of roomsUsingBrowser(repos, browserId)) notify(room.id);
      },
      log,
    }),
});
// Profile folders from before browsers were a list become browsers (the running ones are adopted under the same id).
for (const browser of stack.db.transaction(() => reconcileBrowserCatalog(stack.repos, config.dataDir))) log(`browser "${browser.name}" adopted from ${browser.id}`);
stack.browsers?.start();
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
    await adapter.createThread({
      commandId: `restore:${binding.threadId}`,
      threadId: binding.threadId,
      projectId: room.projectId,
      title: `${room.title} · ${participant.alias}`,
      modelSelection: participant.modelSelection,
      runtimeMode: participant.runtimeMode,
      interactionMode: participant.interactionMode,
    });
    restored += 1;
  }
  if (restored > 0) log(`restored ${restored} simulated thread(s) for existing participants`);
}
const app = createHttpApp(stack, config, resolve("web/dist"));
stack.scheduler.start(config.tickMs);

const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  log(`listening on http://127.0.0.1:${info.port} (db ${config.dbPath})`);
});

const shutdown = () => {
  log("shutting down");
  server.close();
  stack.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

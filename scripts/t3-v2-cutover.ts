#!/usr/bin/env node
/**
 * Move this machine to T3's Orchestrator V2, with the Backroom that speaks it, in one go.
 *
 *   npm run t3:v2             wait until no T3 thread is working, then switch
 *   npm run t3:v2 -- --now    switch without waiting (running turns are cut off)
 *   npm run t3:v2 -- --dry-run   read T3's version and what is working, say what would be done, change nothing
 *
 * Backroom and T3 have to change together: this Backroom speaks only V2, and T3's move is one way (it copies its V1
 * database and migrates the copy; see "Moving a server from T3's V1 to V2" in the README). The steps:
 *
 *   1. wait until no thread on the T3 server is in a turn (a turn running during the move is cut off)
 *   2. build the new UI aside and copy the rooms database (nothing is changed yet)
 *   3. start T3's update to its newest release through Backroom, and wait for T3 to answer on protocol 2;
 *      then put the new UI in place and restart the Backroom service (systemd user unit `backroom.service`, or
 *      --unit <name>). T3 goes first: if its update fails, T3 stays on V1 and Backroom is left as it was.
 *   4. pair again if T3 no longer takes the credential, then check that projects and threads read
 *
 * Under systemd the script hands itself to a unit of its own first, so it outlives the turn or service that started
 * it (an agent asked to run it is itself a child of the T3 server being restarted). Progress goes to
 * data/t3-v2-cutover.log. The UI it replaces is kept in data/ui-previous, the rooms database in
 * data/rooms.before-t3-v2.sqlite.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { ORCHESTRATION_PROTOCOL_VERSION } from "../src/adapter/types.ts";
import { loadConfig } from "../src/config.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};
const now = args.includes("--now");
const dryRun = args.includes("--dry-run");
const unit = flag("--unit") ?? "backroom.service";
const config = loadConfig();
const backroom = `http://127.0.0.1:${config.port}`;
const logPath = join(config.dataDir, "t3-v2-cutover.log");
mkdirSync(config.dataDir, { recursive: true });

const say = (message: string): void => {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
};
const stop = (message: string): never => {
  say(`STOPPED: ${message}`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command: string, commandArgs: string[], inherit = false) => spawnSync(command, commandArgs, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });

// A unit of its own, so a restart of the T3 service (whose child an agent's shell is) does not take this with it.
if (!dryRun && !args.includes("--attached") && process.env.XDG_RUNTIME_DIR && sh("systemd-run", ["--version"]).status === 0) {
  const name = `backroom-t3-v2-${Date.now()}`;
  const started = sh("systemd-run", [
    "--user",
    "--collect",
    "--unit",
    name,
    "--working-directory",
    process.cwd(),
    "--setenv",
    `PATH=${process.env.PATH ?? ""}`,
    ...["ROOMS_PORT", "ROOMS_DATA_DIR", "T3_BASE_URL", "T3_USERDATA_DIR", "T3CODE_HOME"].flatMap((key) => (process.env[key] ? ["--setenv", `${key}=${process.env[key]}`] : [])),
    process.execPath,
    "--no-warnings=ExperimentalWarning",
    "scripts/t3-v2-cutover.ts",
    "--attached",
    ...args,
  ]);
  if (started.status === 0) {
    console.log(`Started as ${name}. It ${now ? "switches now" : "waits for running turns to end, then switches"}; follow it with: tail -f ${logPath}`);
    process.exit(0);
  }
  console.log(`systemd-run did not start a unit (${(started.stderr ?? "").trim() || "unknown reason"}); running here instead.`);
}

const json = async (url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Left as text.
  }
  return { status: response.status, body };
};
const t3Base = (config.t3BaseUrl ?? readStoredAuth(config.dataDir)?.baseUrl ?? "http://127.0.0.1:3773").replace(/\/$/, "");
const t3Environment = async (): Promise<{ serverVersion: string; protocol: number } | null> => {
  try {
    const { status, body } = await json(`${t3Base}/.well-known/t3/environment`);
    return status === 200 ? { serverVersion: String(body.serverVersion), protocol: typeof body.orchestrationProtocolVersion === "number" ? body.orchestrationProtocolVersion : 1 } : null;
  } catch {
    return null;
  }
};

say(`T3 at ${t3Base}; Backroom at ${backroom}`);
const before = await t3Environment();
if (!before) stop(`T3 does not answer at ${t3Base}; start it first`);
say(`T3 ${before!.serverVersion} speaks orchestration protocol ${before!.protocol}`);

// ---- 1. nothing in a turn
if (before!.protocol !== ORCHESTRATION_PROTOCOL_VERSION && !now) {
  const token = config.t3AccessToken ?? readStoredAuth(config.dataDir)?.accessToken ?? null;
  if (!token) stop("no T3 credential stored, so running turns cannot be seen; pair Backroom first, or pass --now");
  const working = async (): Promise<string[]> => {
    const { status, body } = await json(`${t3Base}/api/orchestration/shell`, { headers: { authorization: `Bearer ${token}` } });
    if (status !== 200) throw new Error(`T3 answered ${status} for its thread list`);
    // The V1 shell: a thread in a turn has a running (or starting) session.
    return (body.threads as Array<{ title: string; session: { status: string } | null }>).filter((thread) => thread.session?.status === "running" || thread.session?.status === "starting").map((thread) => thread.title);
  };
  const deadline = Date.now() + 60 * 60_000;
  let quiet = 0;
  let last = "";
  if (dryRun) {
    const titles = await working();
    say(titles.length === 0 ? "no thread is working: the switch would start at once" : `the switch would wait for ${titles.length} working thread(s): ${titles.slice(0, 5).join("; ")}`);
    quiet = 3;
  }
  while (quiet < 3) {
    let titles: string[];
    try {
      titles = await working();
    } catch (error) {
      stop(`could not read T3's threads: ${(error as Error).message}`);
      throw error;
    }
    quiet = titles.length === 0 ? quiet + 1 : 0;
    const line = titles.length === 0 ? "no thread is working" : `waiting for ${titles.length} working thread(s): ${titles.slice(0, 5).join("; ")}`;
    if (line !== last) say(line);
    last = line;
    if (Date.now() > deadline) stop("threads were still working after an hour; run again later, or pass --now to cut them off");
    if (quiet < 3) await sleep(5000);
  }
}

// ---- 2. everything that can fail without changing anything: the new UI, built beside the one being served
const uiNext = join(config.dataDir, "ui-next");
if (dryRun) {
  const active = sh("systemctl", ["--user", "is-active", unit]).stdout?.trim() === "active";
  say(
    `dry run: would build the UI aside, back up the rooms database, ${before!.protocol === ORCHESTRATION_PROTOCOL_VERSION ? "leave T3 as it is (already on protocol 2)" : "update T3 to its newest release through Backroom"}, then put the new UI in place and ${active ? `restart ${unit}` : `wait for you to restart Backroom (${unit} is not an active systemd user unit)`}`,
  );
  process.exit(0);
}
say("building the UI aside");
rmSync(uiNext, { recursive: true, force: true });
if (sh("npm", ["--workspace", "web", "run", "build", "--", "--outDir", uiNext, "--emptyOutDir"], true).status !== 0 || !existsSync(join(uiNext, "index.html"))) stop("the UI did not build; nothing was changed");
if (existsSync(config.dbPath)) {
  // The rooms as they stand, should the move have to be undone (the service migrates its database when it restarts).
  const backup = join(config.dataDir, "rooms.before-t3-v2.sqlite");
  rmSync(backup, { force: true });
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    say(`rooms database copied to ${backup}`);
  } finally {
    db.close();
  }
}

const onNewCode = async (): Promise<boolean> => {
  try {
    const { status, body } = await json(`${backroom}/api/status`);
    // The V2 Backroom reports the server's protocol version in its status; the one before it did not.
    return status === 200 && body?.t3?.environment !== null && typeof body.t3.environment === "object" && "orchestrationProtocolVersion" in body.t3.environment;
  } catch {
    return false;
  }
};
const backroomAnswers = async (): Promise<boolean> => json(`${backroom}/api/status`).then((r) => r.status === 200, () => false);

/** T3's update to its newest release, started through Backroom (the route is the same before and after its own change). */
const updateT3 = async (): Promise<void> => {
  if ((await t3Environment())?.protocol === ORCHESTRATION_PROTOCOL_VERSION) return;
  const view = (await json(`${backroom}/api/t3/updates?fresh=1`)).body as { server?: { version: string | null; latest: string | null; newer: boolean; canUpdate: boolean; manual: string | null } };
  const target = view.server?.latest ?? null;
  if (!target || !view.server?.newer) stop(`no newer T3 release is known (T3 runs ${view.server?.version ?? "an unknown version"}); update T3 on its machine with \`t3 update\``);
  if (!view.server?.canUpdate) stop(`this T3 cannot update itself from here${view.server?.manual ? ` (${view.server.manual})` : ""}; run \`t3 update\` on its machine`);
  say(`starting T3's update to ${target}`);
  const started = await json(`${backroom}/api/t3/updates/server`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetVersion: target }) });
  if (started.status !== 200) stop(`Backroom could not start T3's update: ${JSON.stringify(started.body).slice(0, 300)}`);
  const deadline = Date.now() + 25 * 60_000;
  for (;;) {
    await sleep(4000);
    const environment = await t3Environment();
    if (environment?.protocol === ORCHESTRATION_PROTOCOL_VERSION) {
      say(`T3 ${environment.serverVersion} answers on orchestration protocol ${environment.protocol}`);
      return;
    }
    const job = ((await json(`${backroom}/api/t3/updates`).catch(() => ({ body: null }))).body as { server?: { job?: { state: string; error: string | null } | null } } | null)?.server?.job;
    if (job?.state === "failed") stop(`T3's update failed: ${job.error ?? "no reason given"}. T3 is still on its old version; Backroom was not changed.`);
    if (Date.now() > deadline) stop("T3 did not come back on protocol 2 within 25 minutes; check the T3 service (its V1 database is untouched)");
  }
};

/** The new UI in place, and the service restarted on the code in this folder. */
const switchBackroom = async (): Promise<void> => {
  const dist = config.webDistDir;
  const previous = join(config.dataDir, "ui-previous");
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, previous);
  renameSync(uiNext, dist);
  if (sh("systemctl", ["--user", "is-active", unit]).stdout?.trim() === "active") {
    say(`restarting ${unit}`);
    if (sh("systemctl", ["--user", "restart", unit], true).status !== 0) stop(`systemctl could not restart ${unit}`);
  } else {
    say(`${unit} is not an active systemd user unit: restart Backroom yourself now; waiting for it to come up on the new code`);
  }
  const deadline = Date.now() + 3 * 60_000;
  while (!(await onNewCode())) {
    if (Date.now() > deadline) stop(`Backroom at ${backroom} did not come up on the new code within 3 minutes; check the service`);
    await sleep(2000);
  }
  say("Backroom is up on the new code");
};

// ---- 3. T3 first, so that a T3 update that fails leaves Backroom working as it was; then Backroom
if (await backroomAnswers()) {
  await updateT3();
  await switchBackroom();
} else {
  // No Backroom is running to ask T3 through: bring this one up first.
  await switchBackroom();
  await updateT3();
}

// ---- 4. the credential, and a read of what came across
const status = async (): Promise<{ error: string | null }> => ((await json(`${backroom}/api/status`)).body as { t3: { error: string | null } }).t3;
await sleep(3000);
if (/pair Backroom again|rejected the credential/i.test((await status()).error ?? "")) {
  say("T3 no longer takes Backroom's credential; pairing again");
  const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const statePath = join(home, "runtime", "service-state.json");
  const active = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { activeVersion?: string }).activeVersion : undefined;
  const binary = active ? join(home, "runtime", "versions", active, "t3") : "t3";
  const minted = sh(binary, ["pair", "--label", "Backroom"]);
  const url = /Pairing URL:\s*(\S+)/.exec(minted.stdout ?? "")?.[1];
  if (!url) stop(`could not mint a pairing link with \`${binary} pair\`; run \`t3 pair\` on the T3 machine and paste the link into Backroom`);
  const paired = await json(`${backroom}/api/t3/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingUrl: url }) });
  if (paired.status !== 200) stop(`pairing failed: ${JSON.stringify(paired.body).slice(0, 300)}`);
  say("paired again");
}
const threads = await json(`${backroom}/api/t3/threads`);
const rooms = await json(`${backroom}/api/rooms`);
if (threads.status !== 200) stop(`Backroom cannot read T3's threads: ${JSON.stringify(threads.body).slice(0, 300)}`);
const problem = (await status()).error;
say(`done: T3 lists ${(threads.body as unknown[]).length} threads, Backroom has ${Array.isArray(rooms.body) ? rooms.body.length : "?"} rooms${problem ? `; T3 status says: ${problem}` : ""}`);
say("Every other T3 client (desktop, phone) has to be on V2 as well. A member's first message starts a fresh harness session with the earlier conversation handed over.");

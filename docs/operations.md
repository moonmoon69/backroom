# Operations

How Backroom connects to T3 Code, the settings it reads, how to run, update and back it up, and what to do when something fails.

## Connect to T3 Code

Backroom is a third-party client of your T3 server, so it needs a credential: a bearer token with the permissions listed below. It is stored in `data/t3-auth.json` with owner-only permissions (0600) and is never sent to the browser.

### 1. On T3's machine: nothing to do

When Backroom runs on the machine where T3 runs as a service, it gets its own credential from T3's command line. It runs `t3 auth session issue` with exactly the permissions below, for 30 days, labeled "Backroom". Backroom uses the version of T3 that T3's service runs (`~/.t3/runtime/versions/<version>/t3`), or the binary named by `T3_CLI`. The service log says which way it keeps its credential: `credentials present, renewed by Backroom with T3's CLI`.

### 2. Anywhere else: pair with a link

When Backroom runs elsewhere, or T3 runs without its service (the desktop app, a dev checkout), T3 hands out credentials through **one-time pairing links**:

- **Headless server** (`t3 serve` or the installed service): run `t3 pair` on T3's machine. Its links hold every permission Backroom asks for.
- **Desktop app:** open **Settings → Connections** and turn on **Network access** (the app restarts). Then create a pairing link on the same screen. On loopback only, the Desktop server runs under the `desktop-managed-local` auth policy and offers no pairing links. That is why Network access is required.

Treat pairing links like passwords. They expire within minutes and work only once. Paste the link into the pairing panel: Backroom shows it in place of the rooms while it has no credential, and the **T3** status button in the overview's header opens it later. Or use the command line, then restart the service:

```sh
npm run t3:pair -- "http://127.0.0.1:3773/pair?token=..."
```

The command prints only the scope and expiry, and names any permission the link did not hold.

### What Backroom asks for, and why

| Permission | What needs it |
| --- | --- |
| `orchestration:read`, `orchestration:operate` | reading projects and threads, sending messages, launching threads, adding projects |
| `providers:manage` | a harness's **Update** |
| `environment:maintain` | T3's **Update** |
| `diagnostics:read` | today's usage in a member's usage card |
| `filesystem:read` | the folder list in the New project dialog |

It asks for nothing broader: not T3's settings, terminals, previews, source control, file writes, or the management of other clients.

### How the credential is kept

- **On T3's machine, Backroom renews it.** It checks at start and every hour. It gets a new credential when it has none, when it lacks a permission it asks for, when it has less than 7 days left, or when T3 no longer takes it (HTTP 401: a revoked, expired or reset session). A refusal for a missing permission (HTTP 403) is not a reason: a new credential with the same permissions would be refused too. Backroom checks that T3 takes the new credential, switches to it and revokes the session it replaced, so T3's client list keeps one "Backroom". Revoking Backroom in T3's client list does not lock it out from that machine: it issues itself a new session. To stop it, stop the service, or set `T3_CLI=off`.
- **A renewal that fails** is tried again by itself 5 minutes later, and every 5 minutes after that until one succeeds. From the first failure, the **T3** status button says "renewal failed", and the T3 panel says why and how to pair by hand. Within 7 days of expiry the panel leads with the date.
- **Elsewhere, renewing is yours.** T3 gives a paired client 30 days and offers it no way to renew. Its token exchange takes no longer lifetime and has no refresh token, and minting a new link over HTTP needs `access:write`, the permission to manage every client. From 7 days before expiry, the **T3** status button says "pair again soon", and the T3 panel says when the credential expires and how to pair again.
- A token given in `T3_ACCESS_TOKEN` is used as it is and never renewed.

### When T3 refuses for a missing permission

Backroom says so where it happened: on the row in **Updates**, in the folder list, or in the usage card. The message names the permission: "Backroom's pairing with T3 does not allow this (it lacks the "environment:maintain" permission): run `t3 pair` on T3's machine and paste the link it prints into the T3 panel …". On T3's machine Backroom fixes this itself at its next check, within the hour or at a restart. Elsewhere, pair again with a link from `t3 pair`. If pairing again does not help, T3 wants a permission Backroom does not ask for yet, and Backroom itself needs updating.

### Verify (optional but recommended)

```sh
npm run t3:check                                   # read-only: server descriptor, auth policy, projects, models, threads
npm run t3:check -- --write --project <projectId>  # launches one thread, follows its run, then checks a resend, queue, steer and interrupt
```

The `--write` check leaves one thread titled "Backroom contract check" in T3; delete it there when you are done. Copy a project id from a room's **⋯** menu, its **Open in T3** dialog, or from T3 itself.

## Configuration

The service reads environment variables only; it does **not** load `.env`. Set variables inline, for example `ROOMS_PORT=4500 npm start`, or in the systemd unit.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROOMS_PORT` | `4400` | UI/API port (always bound to 127.0.0.1) |
| `ROOMS_DATA_DIR` | the copy's `data` folder | Database, stored credential, images, skill packs and browser profiles ([Where the data lives](#where-the-data-lives)) |
| `ROOMS_DB_PATH` | `$ROOMS_DATA_DIR/rooms.sqlite` | Database file, if it should live elsewhere |
| `ROOMS_ADAPTER` | `http` | `fake` for demo mode |
| `ROOMS_PSTACK_REPO` | `https://github.com/cursor/plugins` | Where the pstack pack ([Skills](agents-file-and-skills.md#skills)) is cloned from: a URL, or a local path (taken from the working directory). The tests and the rehearsal give a local bare repository |
| `ROOMS_SKILLS_HOME` | your home folder; `<data>/home` on the fake T3 | The home folder whose skill folders (`.claude/skills`, `.agents/skills`, `.grok/skills`) [Skills](agents-file-and-skills.md#skills) links into, so a throwaway service never links into your harnesses |
| `ROOMS_FAKE_STATE` | none | Demo mode: a file the fake T3 keeps its threads, runs and command receipts in, so they outlive a restart of the service, as a real T3's do; without it the fake keeps them in memory only |
| `ROOMS_FAKE_PROJECT_DIR` | `/tmp/demo` | Demo mode: the demo project's folder (never created), a scratch git repository to try [the agents file](agents-file-and-skills.md#the-agents-file) |
| `T3_BASE_URL` | from `~/.t3/userdata/server-runtime.json`, else the paired server, else `http://127.0.0.1:3773` | T3 server origin |
| `T3_ACCESS_TOKEN` | stored credential | Overrides the paired token (used as it is, never renewed) |
| `T3_CLI` | the T3 binary of T3's service (`~/.t3/runtime/versions/<active>/t3`) | T3's CLI Backroom keeps its credential with; `off` for none (then pair with a link) |
| `T3CODE_HOME` | the folder above `T3_USERDATA_DIR` (`~/.t3`) | T3's home, where its service keeps its versions |
| `T3_USERDATA_DIR` | `~/.t3/userdata` | Where to find T3's runtime file and local model catalog |
| `ROOMS_TICK_MS` | `1500` | How often, at the latest, the engine host reads the members' threads and sends what is waiting (a change T3 streams to a member's thread wakes it at once) |
| `ROOMS_WEB_DIST` | the copy's own `web/dist` | The built UI the service serves (a second instance can serve another build) |
| `ROOMS_BRIEFING_BUDGET` | `60000` | Characters per delivery before older room context is condensed |
| `ROOMS_KEEPALIVE_MS` | `3300000` | How long a seat with work in flight may go without a wake before it gets a keep-alive (55 minutes). It must be from 60000 (a minute) to 3599999, under the prompt cache's hour, or the service refuses to start; `0` turns keep-alives off in rooms that set no interval of their own (`rooms-board keepalive every <minutes>`) |
| `ROOMS_THREAD_ACTION_TIMEOUT_MS` | `5000` | How long deleting a room waits for T3 to settle, archive or delete each member's thread. All are sent at once, so the page waits at most this long; an action still unanswered then is reported as timed out and may still go through (a dispatch itself waits up to 60 s; its late outcome goes to the service log). 60 s or more never fires |
| `ROOMS_BROWSER_MODE` | `auto` | Room browser: `vnc` (Xvfb + noVNC), `window`, `headless`, or `off`. `auto` picks `vnc` on Linux with the tools installed, otherwise `window` (macOS or a Linux desktop) or `headless` |
| `ROOMS_BROWSER_CHROME` | found automatically | Path to Chrome or Chromium |
| `ROOMS_BROWSER_BIND` | `127.0.0.1` | Address noVNC listens on (for example a Tailscale IP) |
| `ROOMS_BROWSER_HOST` | the bind address | Host used in watch links given to agents; if unset with a wildcard bind, the UI uses the host you opened it on |
| `ROOMS_BROWSER_NOVNC_DIR` | `/usr/share/novnc` | noVNC web files |
| `ROOMS_BROWSER_IDLE_MINUTES` | `30` | Stop a browser after this long without tab changes or agent use, unless it is in use: a room with it as its default has work in flight, or an agent with work in flight has a tab open in it (`0` = never) |
| `ROOMS_BROWSER_PORTS_DIR` | `~/.local/state/backroom/browser-ports` (`$XDG_STATE_HOME` if set) | Where this machine's Backrooms record which browser ports and displays each keeps, so none takes another's; `off` keeps to this Backroom's own |
| `ROOMS_BROWSER_SCOPE` | on under systemd | `0` keeps browser processes in the service's own cgroup (a service restart then kills them) |
| `ROOMS_BROWSER_AS` | none | Read by `bin/rooms-browser` and `bin/rooms-board`: the agent's key when a command has no `--as` |
| `ROOMS_BROWSER_API` | `data/browser-api.json` | Read by `bin/rooms-browser` and `bin/rooms-board` to find the service; briefings pass it along when the data folder is elsewhere |

## Running, updating and backing up

### Where the data lives

Every copy of Backroom is a git checkout, installed by `install.sh` or cloned by hand, and started with `npm start`. It keeps its data in its own `data` folder, whatever folder it is started from, unless `ROOMS_DATA_DIR` names another; these docs write that folder `data/`. It holds `rooms.sqlite`, the rooms' journal `board.sqlite`, `t3-auth.json`, the skill packs under `skills/`, the browsers' profiles under `browsers/`, and `browser-api.json`. The page it serves is its own build in its `web/dist`, unless `ROOMS_WEB_DIST` names another.

### Updating

A release is a tag `v<version>` on Backroom's repository. Backroom's row in the overview's **Updates** popup shows the version running and the newest release. It reads the newest release from the tags of the copy's `origin` remote, with `git ls-remote`, once an hour and on **Check now**; git asks for no credential, and a remote that does not answer within 10 seconds is reported on the row, as is a copy without an `origin`. A prerelease tag (`v0.3.0-beta.1`) counts only for a copy that runs a prerelease.

When a newer release is out, the row offers **Update**, beside the same update as a command to run on the machine: `sh <folder>/install.sh <folder>`, with the copy's real folder, then a restart. **Update** asks first, naming the members with a running turn or a tab open in a room browser. Backroom then runs the copy's own `install.sh` on the copy's own folder, with the Node that runs Backroom first on `PATH`; nothing from the page's request reaches the command. When the script succeeds, Backroom reads the version now in the copy's `package.json`, says so on the page and in its log, and stops. A service manager that restarts it, such as the unit in [Remote setup](../README.md#remote-setup) with `Restart=always`, brings it back on the new version. A copy started by hand must be started again with `npm start` in its folder. Turns that are running carry on in T3 and are picked up after the start; a `rooms-browser` command running during the update can fail.

`install.sh` decides whether the copy may move, by hand and from the page alike:

- It updates only a copy that sits on a release or on commits a release contains. A copy with work of its own, meaning uncommitted changes or commits the newest release does not contain, is left as it is: the script says so, and the row shows that as the reason.
- It fetches the copy's `origin`, checks out the newest release tag, and runs `npm ci` and `npm run build:web`.
- When either step fails, it puts the copy back on the commit it was on, runs `npm ci` there and restores the page it served, then says what failed. The row shows the script's last lines, and Backroom runs on as it was.

The page is rebuilt in place, so while the update runs, a page loaded then can fail to load. Database migrations run at startup.

### Running and backing up

- **Restarting is safe.** The room's journal is on disk: requests not yet sent go out after the restart, and turns in flight are matched back to their T3 runs. A turn that finished while the service was down is picked up on the next poll.
- **A new page** reaches open pages on their next read: they show "Backroom was updated" and offer a reload. A change to the service needs a restart.
- **Back up** by copying the data folder while the service is stopped. Keep the copy private: the T3 credential and every browser's logins are inside.
- **Keep it running** with any process manager: the systemd user unit in [Remote setup](../README.md#remote-setup), a `launchd` agent, `pm2`, a tmux pane. The service needs no special privileges.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Status says "not paired", and the pairing panel mentions `desktop-managed-local` | The Desktop server on loopback does not issue pairing links. Turn on Settings → Connections → Network access in T3 Code, then create a link. |
| Pairing returns HTTP 4xx | Links are one-time and expire within minutes. Create a fresh one. |
| Status says "pair Backroom again" | The stored token expired or was revoked in T3 (Settings → Connections → clients). On T3's machine, Backroom issues itself a new one within seconds. Elsewhere, pair again. Work not yet sent is untouched. |
| An update, the folder list or today's usage says "Backroom's pairing with T3 does not allow this" | The credential lacks the permission it names (see [When T3 refuses for a missing permission](#when-t3-refuses-for-a-missing-permission)). On T3's machine, Backroom replaces it at its next hourly check, or right away when you restart the service. Elsewhere, run `t3 pair` on T3's machine and paste the link into the T3 panel. |
| The T3 button says "pair again soon" | The credential expires within 7 days, and nothing will renew it: Backroom runs on another machine, or without T3's CLI. Pair again with a link from `t3 pair`. |
| The T3 button says "renewal failed" | Backroom could not renew its credential with T3's CLI. The T3 panel says why. It tries again every 5 minutes; the credential it has keeps working until it expires or T3 refuses it. Fix the cause, or pair by hand with a link from `t3 pair`. |
| The service logs a T3 base URL that is wrong | T3 wasn't running when the service started, or runs elsewhere. Start T3 first, or set `T3_BASE_URL`. |
| A member's turn stays "sending" or "starting" and then fails with "provider failed to start" | The harness behind that member isn't signed in, or its CLI is missing. Fix it in T3, then press **Retry** on the failed turn's notice. |
| A member shows "working on its own" | Its thread is in a turn the room did not start: it woke itself, another agent messaged it, or someone typed in T3 Code. What the room has for it waits for that turn to end. |
| The T3 status says "T3 … speaks orchestration protocol 1; Backroom needs protocol 2" | The T3 server is older than 0.0.46 (it runs T3's V1 orchestrator). Update it: **Updates** in the overview's header still reaches it. |
| A turn failed with "T3 no longer has this run" | The thread was rolled back in T3 past that run. Press **Retry** on the failed turn's notice. |
| `/name is not a T3 command for @x` | That member's provider doesn't offer the command. Type `@x /` to see what it has. |
| The model picker is empty | The catalog comes from T3's server config. With the RPC unavailable, it falls back to `~/.t3/userdata` and existing threads. Create one thread in T3 with the model you want, or type the instance id and model manually. |
| A member shows "thread deleted in T3" | Its thread was deleted in T3 Code. Backroom keeps the member and its past replies, and new work for it fails. Remove it and seat another. Settling or archiving a thread does not cause this. |
| A browser's status says "Chrome exited during start: No usable sandbox" | Chrome's sandbox can't run, which is typical inside Docker. Run the container with `--security-opt seccomp=unconfined`, or use Google Chrome's package on the host. Each tool's output is in `data/browsers/<browserId>/*.log`. |
| `rooms-browser` says "Browsers are turned off for the room" or "can't use" a browser | The room's Browser tab (the globe in its header): turn browsers on, or tick that browser. |
| A panel says "Backroom's service is older than this page" | The UI was rebuilt (`npm run build:web` goes live on the next load) but the service still runs the old server code. Restart it: `systemctl --user restart backroom.service`. |
| `rooms-browser` can't reach the service | Backroom isn't running, or runs with another data folder. Start it; with a non-default `ROOMS_DATA_DIR`, briefings pass `ROOMS_BROWSER_API` along. |
| The page stops updating | The service stopped. Restart it with `npm start`; nothing is lost. |
| Backroom's update failed | The row says why, from the install script's last lines, and the copy runs on as it was. A copy with changes or commits of its own is never moved: commit or remove the changes, or keep the copy as it is. A failed `npm ci` or build put the copy back on the commit it was on; fix the cause, such as a registry that is not reachable, and click **Update** again. |
| Backroom's row says "this copy has no origin remote" or "origin did not answer" | The copy was cloned without an `origin`, or `origin` cannot be reached. Add the repository with `git remote add origin https://github.com/moonmoon69/backroom.git`, or check the network, then **Check now**. |

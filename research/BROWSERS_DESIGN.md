# Browsers: design

Status: agreed 2026-09-25; built 2026-09-26. Step 1: browsers table, migration, Browsers section, browser view, room
default. Step 2: `bin/rooms-browser`, the chrome-devtools-mcp engine, tab ownership, briefings listing every browser,
per-room allowed browsers; verified with a real Claude thread and a real Codex thread in one room (own tabs, no
harness configuration). Step 3: Browser button for threads outside rooms, browser choice when starting a thread.

## Goal

Agents in any harness (Claude, Codex, Gemini, Cursor, …) can use a real, logged-in Chrome on the box, managed from T3
Rooms, without any harness configuration. Browsers are shared, persistent and named by purpose; you watch and take over
through noVNC.

## Findings this rests on

- **T3's own browser is on the Mac.** T3's preview tools are routed by the T3 server to a desktop client that hosts a
  Chromium `<webview>` ("The preview is desktop-only"). With the Mac app closed, every call fails with "No preview
  automation host is available". It cannot reach the box's `127.0.0.1`. Not usable for unattended work on the box.
- **T3 cannot add tools to its sessions.** It injects exactly one MCP server (its own `t3-code`) into every harness:
  Claude via the SDK option, Codex via `-c mcp_servers.t3-code.url=…`, ACP harnesses via the session request. There is
  no setting for more, thread commands have no MCP field, and no thread id reaches the harness environment. Adding MCP
  would mean editing each harness's own config: rejected.
- **Every harness has a shell.** So the universal interface is a command-line tool.
- **chrome-devtools-mcp** (Google, 1.10.1) attaches to a running Chrome (`--browserUrl`), sees existing tabs and the
  profile's logins, and requires a `pageId` on every page call. **Playwright MCP** also attaches (`--cdp-endpoint`) but
  acts on the "current" tab (its first navigate took over an existing tab) and writes files into `.playwright-mcp/`.
  **agent-browser** (0.38) attaches and works well for one agent, but its sessions share the active tab: after agent B
  opened a tab, agent A's next command acted on B's page. A shared browser needs explicit tab ids.
- **Chrome must quit cleanly** (Browser.close) to commit history and save its tabs, and browser processes must live in
  their own systemd scope, or a restart of `t3rooms.service` SIGKILLs them. Both are done (roomBrowsers.ts).

## Design

### Browsers are a list, named by purpose

- A browser: `name` (slug: `general`, `t3-rooms-testing`), a `description` written for agents ("Logged into staging
  T3 Rooms as the test user; use for integration tests"), a persistent profile, stable ports, mode (vnc / window /
  headless). Table `browsers`; files under `data/browsers/<browserId>/`.
- `general` exists from the start and is the fallback default.
- A room: browsers on or off (`browser_enabled`) and a **default browser** (`default_browser_id`). Agents see the
  whole list with descriptions and pick by purpose; the default is used unless the task calls for another.
- Several rooms may share a browser. Deleting a room does not delete browsers.
- Migration: each existing room browser becomes a browser with the room's id (directory, ports and a running Chrome
  stay put), named after the room, and becomes that room's default. Profile directories without a room become
  unassigned browsers, so no logins are lost.

### `rooms-browser`: the agents' tool

`bin/rooms-browser` in this repo, plain Node; the briefing gives its absolute path.

```
rooms-browser list
rooms-browser <browser> tabs
rooms-browser <browser> open <url> --agent <alias>      # opens the agent's own tab, prints its id
rooms-browser <browser> <tab> snapshot                  # page as text with element ids
rooms-browser <browser> <tab> click <uid> | fill <uid> <text> | press <key> | navigate <url> | wait-for <text>
rooms-browser <browser> <tab> eval <js> | console | network
rooms-browser <browser> <tab> screenshot                # saves a PNG, prints the path
rooms-browser <browser> <tab> close                     # own tabs only
```

- Every page command names its tab. Tabs are owned by the `--agent` that opened them (the participant's alias from the
  briefing); acting on another's tab, or one opened by the user, needs `--force`.
- A stopped browser starts on first use.
- The CLI calls the service over its local HTTP API (127.0.0.1, token in `data/`). The service runs one
  chrome-devtools-mcp per running browser as its internal engine (pinned dependency). Harnesses never see MCP.

### Telling agents

- Rooms: the briefing's "Room browser" section, sent with every assignment and rebuilt from live state, lists the
  browsers with descriptions, marks the room's default, and gives the command. Room notes stay for one-off guidance.
- Threads outside rooms: a Browser button in the thread view adds the same lines to the user's next message.

### UI

- Sidebar: a folding **Browsers** section (dot, name, tabs or "off", used by N) and **+ New browser**.
- Browser view: Start / Stop, Open screen (noVNC), description, used by, tabs (with owners, step 2), DevTools address,
  profile size, Edit, Reset profile (wipes logins), Delete (refused while a room uses it).
- Room header Browser button: on/off and the default browser, with its status and watch link.

## Steps

1. Browsers as objects: table, migration, manager keyed by browser, sidebar section and browser view, per-room
   default. The briefing names the room's default browser (DevTools address, as today).
2. `rooms-browser` and the service engine (chrome-devtools-mcp), tab ownership, the briefing lists all browsers and
   the command. Verify with a real Claude thread and a real Codex thread, no harness changes.
3. Browser button for threads outside rooms; polish.

# T3 Rooms

A local companion for [T3 Code](https://github.com/pingdotgg/t3code). A **room** is one shared conversation with several T3 threads in it. Each thread takes part under a short alias (`@claude`, `@grok`, …). You address them in plain text. The room queues the work, waits where one task depends on another, and passes each finished answer to whoever needs it next. You don't have to copy anything between threads yourself.

The room owns conversation and coordination. T3 owns execution: every participant is a real T3 thread, with its own model, permissions and worktree, and you can still open it in T3 Code. No model reads your input on the room's side: every action is a direct control or a small explicit syntax, and the composer shows the plan before you send.

See [`PRD.md`](PRD.md) for the product definition and [`research/`](research/) for feasibility notes and live findings.

---

## Contents

1. [Requirements](#requirements)
2. [Install](#install)
3. [Connect to T3 Code](#connect-to-t3-code)
4. [A headless box over Tailscale](#a-headless-box-over-tailscale)
5. [Try it without T3 (demo mode)](#try-it-without-t3-demo-mode)
6. [Your first room](#your-first-room)
7. [Projects, and threads without a room](#projects-and-threads-without-a-room)
8. [Writing messages](#writing-messages)
9. [Sending while someone is working](#sending-while-someone-is-working)
10. [T3 slash commands](#t3-slash-commands)
11. [Room browser](#room-browser)
12. [What the room shows](#what-the-room-shows)
13. [Managing rooms, participants and roles](#managing-rooms-participants-and-roles)
14. [Configuration](#configuration)
15. [Running, updating and backing up](#running-updating-and-backing-up)
16. [Troubleshooting](#troubleshooting)
17. [Development](#development)
18. [How it works](#how-it-works)

---

## Requirements

- **Node 24 or newer.** The service runs TypeScript directly through Node's type stripping and stores data with the built-in `node:sqlite`, so it has no build step. Only the web UI is built. Check with `node --version`.
- **npm** (bundled with Node).
- **T3 Code**, with a server the room can reach over HTTP. Either of these works:
  - the **T3 Code Desktop app**, with **Settings → Connections → Network access** turned on (see below);
  - a headless server started with `t3 serve`, or installed with `t3 service install`.
- The harnesses you want in rooms (Claude, Codex, Cursor, Grok, OpenCode, …) are set up and signed in **inside T3**. The room never talks to a harness directly.

Tested on macOS against T3 Code 0.0.43.

## Install

```sh
git clone https://github.com/moonmoon69/t3code-rooms.git
cd t3code-rooms
npm install          # installs the service and the web workspace
npm run build:web    # builds the UI into web/dist (the service serves it)
npm start            # http://127.0.0.1:4400
```

Open <http://127.0.0.1:4400>. The service binds to `127.0.0.1` only, so it is not reachable from other machines.

At startup the service logs the T3 address it will use and whether it has credentials:

```
[rooms] … T3 base URL http://127.0.0.1:3773; credentials missing (pair from the UI)
[rooms] … listening on http://127.0.0.1:4400 (db /…/t3code-rooms/data/rooms.sqlite)
```

The T3 address is found automatically from `~/.t3/userdata/server-runtime.json`, which T3 writes while it runs. Set `T3_BASE_URL` if your server is elsewhere.

## Connect to T3 Code

The room is a third-party client of your T3 server, so it needs a credential. T3 hands out credentials through **one-time pairing links**.

### 1. Get a pairing link

- **Desktop app:** open **Settings → Connections** and turn on **Network access** (the app restarts). Then create a pairing link on the same screen. On loopback only, the Desktop server runs under the `desktop-managed-local` auth policy and offers no pairing links. That is why Network access is required.
- **Headless server** (`t3 serve` or the installed service): run `t3 pair`.

Treat pairing links like passwords. They expire within minutes and work only once.

### 2. Pair

Either paste the link into the room UI, or use the command line. While the room is unpaired, the UI shows the pairing panel in place of the rooms. Later you can reach it from the **T3** status button at the foot of the sidebar.

From the command line:

```sh
npm run t3:pair -- "http://127.0.0.1:3773/pair?token=..."
```

The link is exchanged for a bearer token, which is stored in `data/t3-auth.json` with owner-only permissions (0600). The token is never sent to the browser. The command prints only the scope and expiry.

### 3. Verify (optional but recommended)

```sh
npm run t3:check                                   # read-only: server descriptor, auth policy, projects, models, threads
npm run t3:check -- --write --project <projectId>  # creates one thread, sends one turn, checks correlation and interrupt
```

The `--write` check leaves one thread titled "T3 Rooms contract check" in T3; delete it there when you are done. Copy a project id from a room's **⋯** menu, its **Open in T3** dialog, or from T3 itself.

## A headless box over Tailscale

The setup this was built on, and the one Theo describes for his own "bb-1": a headless Linux box runs the T3 Code server and T3 Rooms as background services, and you work from a Mac or a phone anywhere on your tailnet. Nothing listens on the public internet.

**1. T3 Code on the box.** Install the server as a user service and pair it over Tailscale:

```bash
npx t3 service install          # runs `t3 serve` at boot, as your user
npx t3 pair --tailscale         # publishes it on Tailscale Serve (HTTPS) and prints a pairing link + QR code
```

Open that pairing link in the T3 Code desktop app on your Mac (or scan the QR code on the phone). The link is a password: it only ever travels inside the tailnet.

**2. T3 Rooms on the box.** Run it as a user service too, and let user services run without a login session:

```bash
loginctl enable-linger "$USER"
mkdir -p ~/.config/systemd/user
"$EDITOR" ~/.config/systemd/user/t3rooms.service   # contents below
systemctl --user enable --now t3rooms.service
```

```ini
[Unit]
Description=T3 Rooms
After=t3code.service
Wants=t3code.service

[Service]
Type=simple
WorkingDirectory=%h/Projects/t3code-rooms
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=ROOMS_PORT=4400
Environment=ROOMS_BROWSER_MODE=vnc
Environment=ROOMS_BROWSER_BIND=100.x.y.z
Environment=ROOMS_BROWSER_HOST=box.tailnet-name.ts.net
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillMode=mixed

[Install]
WantedBy=default.target
```

`ROOMS_BROWSER_BIND` is the box's Tailscale IP (`tailscale ip -4`) and `ROOMS_BROWSER_HOST` its MagicDNS name (`tailscale status`). Adjust `WorkingDirectory` and the `npm` path to where you cloned it and how you installed Node. `t3code.service` is the unit `t3 service install` creates.

**3. Reach the room from the tailnet.** The room listens on `127.0.0.1` only. Publish it over HTTPS with Tailscale Serve on a port of its own (T3 Code's pairing already took 443):

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4400
tailscale serve status    # https://box.tailnet-name.ts.net:8443 -> http://127.0.0.1:4400 (tailnet only)
```

Open `https://box.tailnet-name.ts.net:8443` on the Mac or the phone. HTTPS matters on the phone: it is what lets the room install as an app and keep its shell offline (see [On a phone](#on-a-phone)).

**What is exposed where:** T3 Code and T3 Rooms stay on loopback, reached only through Tailscale Serve. The room browser's noVNC viewer listens on the Tailscale IP because the watch link is meant to be opened from another device; its DevTools port stays on loopback. Update the room with `git pull && npm install && npm run build:web && systemctl --user restart t3rooms.service`.

## Try it without T3 (demo mode)

```sh
ROOMS_ADAPTER=fake npm start
```

A simulated T3 takes the place of the real one. Its agents reply after about four seconds, and it offers sample slash commands (`/compact`, `/review`). Pairing is disabled in this mode. Use a separate data directory so demo rooms stay out of your real database:

```sh
ROOMS_ADAPTER=fake ROOMS_PORT=4401 ROOMS_DATA_DIR=/tmp/rooms-demo npm start
```

## Your first room

1. **Create a room.** Click **+ New → New room** in the sidebar (or **+ → New room** on a project), give it a title, and pick the T3 project it works in. Every participant's thread belongs to that project.
2. **Add a participant.** Click the people button (two-person icon) in the room header, then **+ Add participant**, and choose one of:
   - **New thread:** pick an alias and a model. T3's default for the project is prefilled. You can also set a role and the permission mode. The room creates the thread in T3.
   - **Attach existing:** pick one of the project's threads. The participant continues that thread and keeps its model, options and permission mode.

   The alias is what you type after `@`, and it exists only inside this room.
3. **Send work.** Type `@claude fix the failing parser test` and press **Enter**. The plan under the composer shows the result before you send: who receives what, and whether it starts now or waits.
4. **Watch it run.** Your message appears on the left and the participant's reply on the right. Progress notes stream in while the turn runs. When it ends, the final answer becomes the reply.

The composer placeholder cycles through examples built from your room's actual participants, so every example can be sent as is.

## Projects, and threads without a room

The sidebar lists T3's projects. Under each one are its rooms, then its T3 threads that no room holds, most recently used first (five, then **show more**). Below those, **Settled · N** and **Archived · N** fold open to T3's settled and archived threads for the project. Click a project's name to fold it.

A thread is in one of three states in T3:

- **Active:** in the main list.
- **Settled:** T3's "done for now" list. It opens and reads as usual; sending it a message makes it active again. **Unsettle** in its ⋯ menu does the same without a message.
- **Archived:** hidden in T3 and reversible. T3 does not serve an archived thread's conversation, so opening one shows **Unarchive** and **Delete** instead.

Deleted threads are gone: T3 keeps no record a client can list or restore.

- **A thread on its own.** Pick **+ → New thread** on a project (or **+ New → New thread**), choose the model and permission mode, and type. The first message creates the thread in T3 and starts it; T3 then names it. Messages go to T3 exactly as typed, with no room briefing and no queue, like typing in T3 Code. While a turn runs you can **Stop** it, or send another message and T3 handles it as its own client would. Approvals and questions appear in the conversation. Images work as in a room.
- **Threads started in T3 Code** show up in the same list and open the same way.
- **The ⋯ menu** on an open thread changes its model and permission mode, **adds it to a room** of the same project (it becomes a participant under an alias and keeps its history), or settles (or unsettles), archives or deletes it in T3.
- **A new project.** **+ New → New project** adds a T3 project for a folder on the machine T3 runs on. The folder must exist unless you tick **Create the folder**; T3 refuses a folder another project already uses. The title defaults to the folder name.

The thread view reads the last 30 turns from T3 each time it polls; older turns stay in T3 Code. Nothing about a thread outside a room is stored by the room service.

## Writing messages

The text you type is the whole instruction. The buttons around the composer only edit that text. Above the field, one chip per participant (plus **@all**) inserts `@name` at the cursor when clicked; chips the message already addresses are highlighted, and a dot marks anyone mid-turn. As you type, the composer highlights mentions and commands, then shows the **plan**: one row per assignment, with its recipients, instruction and timing ("now", "next", "after @x", "held").

| Key | Action |
| --- | --- |
| **Enter** | Send (however many lines the draft has). A message for someone mid-turn waits for that turn unless it says `/steer` (see [below](#sending-while-someone-is-working)) |
| **Shift+Enter** | New line |
| `@` | Mention autocomplete (participants and `@all`) |
| **Backspace** right after a mention (**Delete** right before one) | Removes the whole `@name` at once; ⌘/Ctrl+Z brings it back. Partly typed or unknown names delete letter by letter |
| `/` | Command menu (room commands, and T3 commands after an `@name`) |

On a touch keyboard Enter is a new line and the **Send** button sends.

### How a message becomes tasks

No model reads your message. The composer and the server run the same fixed rules (`src/parser/explicit.ts`), and the plan under the field shows exactly what will happen before you send. There are three steps.

**1. Split into assignments.** An assignment is one or more recipients plus an instruction. Each recipient gets its own task (`task41`, `task42`, …), so `@claude @grok review the diff` is two tasks with the same text. Text before the first address (for example "The build is red.") is context that every recipient receives. The rules for where one assignment ends and the next begins are under [How an @mention is read](#several-assignments-in-one-message).

**2. Decide when each assignment starts.** The first row that applies wins:

| Timing | How you write it | Plan shows |
| --- | --- | --- |
| Held until you release it | `/hold` | held |
| Start now, ignoring any implied wait | `/now` | now |
| After tasks that already exist | `/after task41` or `/after @claude` (claude's open task, or claude's assignment in this message) | after task41 |
| After an earlier assignment in this message | one of the implied waits below | after @claude |
| As soon as possible | nothing | now, or next if the recipient is mid-turn |

Implied waits. Each is on an assignment that comes *earlier in the same message*, except the two conditions, which fall back to work that already exists:

- **Sequence words:** "then", "after that", "once that's done": `@claude build it, then @grok deploy it`.
- **Naming an earlier recipient** in the instruction, with or without `@`, possessive or spoken: `@grok check claude's work`.
- **A condition before the address:** `when @grok finishes, @claude write the summary`. The room removes the condition from claude's instruction, because the room already waits for it.
- **A condition after it:** `@grok deploy it when claude finishes`. The condition stays in the text.

  For either condition, the room waits for the named participant's assignment in this message if there is one. Otherwise it waits for their open task. If they have neither, the plan says "@grok has no task to wait for" and the message can't be sent until you change it.
- **Pronouns:** "once she's done", "when it's finished" wait for the previous assignment; "once they're finished", "when both are done" wait for all earlier ones.

What never creates a wait:

- Naming someone who has no assignment in the message; the plan suggests `/after @name` if they have open work.
- A condition the room can't observe ("when the tests pass"). It stays in the instruction and the plan says so.
- An assignment that comes later in the same message. The plan asks you to move it first.

**3. Deliver and release.** A task with nothing to wait for goes to its participant's thread straight away, or after that thread's current turn ends. A task that waits starts only when **every** task it waits for has **succeeded**, and its briefing then includes their final answers under "Completed prerequisites". The waiting task becomes **blocked**, with the reason on its card, in two cases:

- A prerequisite failed, was stopped or was cancelled. Retry the prerequisite, or edit or unblock the waiting task.
- A prerequisite was edited after the wait was set up. Edit's "carry dependents" option re-points them.

### Addressing

```
@claude review the diff                        one participant
@claude @grok review the diff                  the same instruction for both (two independent tasks)
@all review the release notes                  everyone in the room ("all" cannot be used as an alias)
Claude, review the parser                      the spoken form works at the start of a sentence
```

In a room with one participant, a message that addresses nobody goes to that participant: `review the diff`, `/compact` and `/hold save this for later` need no `@name`. A name that is not in the room is still an error.

### Several assignments in one message

```
@claude fix the login bug @grok update the docs
                                               two assignments, both start now
@claude fix the login bug. @grok check claude's work
                                               grok waits for claude: the text names claude
@claude build it, then @grok deploy it         grok waits for claude ("then")
@claude build it. @grok /now read the notes    /now: grok starts immediately anyway
when @grok finishes, @claude write the summary claude waits for grok ("when/once/after … finishes")
@grok deploy it when claude finishes           same, with the condition at the end (or claude's open task)
@claude fix it and once she's done @grok test it
                                               grok waits for the previous assignment ("she", "it", "that")
@claude build the API. @grok build the UI. @codex review both once they're finished
                                               codex waits for both earlier assignments ("they", "both")
The build is red. @claude fix it. @grok find the cause
                                               "The build is red." is context for both, not an assignment
```

How an @mention is read:

- **At the start of a message, line or sentence, it addresses.** Mentions side by side (`@a @b`, `@a and @b`) share one assignment.
- **Later in a sentence it starts a new assignment,** unless it reads as a reference:
  - possessive (`@claude's`);
  - after a linking word (`with @claude`, `what @claude did`, `the @claude branch`);
  - after a one-word lead (`review @claude changes`);
  - with nothing after it (`…and tell @claude`).

  URLs and paths containing `@` are ignored.
- **The plan row offers one-click fixes that rewrite the text.** "It's a reference" drops the `@`, "Make it a new assignment" moves the mention onto a new line, and "Don't wait" inserts `/now`.

The rules don't understand negation: in "@grok don't touch claude's files", grok still waits for claude. They also can't wait on a later assignment (see [How a message becomes tasks](#how-a-message-becomes-tasks)). Unknown aliases and ambiguous task references leave the draft unresolved rather than guessed. `research/JEV_SPLIT_FINDINGS.md` compares these rules with a language-model interpreter on the cases they miss; the room doesn't use one.

### Directives and room commands

Type `/` at the start of the message to see these, each with a description:

```
/after task41 @grok review the implementation  wait for existing work (a task picker opens after /after)
/after @claude @grok review it                 wait for claude's open task
/hold @grok save this for later                held until you release it from the task card or board
/now @grok …                                   start now, even if the text implies a wait
/steer @grok also cover the edge cases         deliver into grok's running turn (see below)
/note preserve the public API                  a room note everyone sees; no task
/add alice                                     seat a new participant on a new thread (T3's default model)
/add alice role accountant                     same, with a role
/role @alice accountant                        assign a role ("none" clears it)
/remove @alice                                 retire a participant (asks about its pending tasks)
```

### Notes

A **note** is a message to the room rather than to anyone in it. Click **Note** in the composer toolbar (it toggles a `/note` prefix on the text) and send. The note appears in the timeline with a dashed border, creates no task and starts no turn, and from then on every participant receives it in their briefings as shared room context, like your messages and other participants' replies. Use it for decisions, constraints and facts you want everyone to have without asking anyone to act: "we keep the public API as it is", "the deploy window is Friday". Notes are text only; a message with images cannot be a note.

### Images

Paste, drop, or attach PNG, JPEG, GIF or WebP images (T3's limits: up to 10 MB each, 80 MB per message). Every assignment in the message receives them. A resend or retry delivers the same bytes. A message with images can have an empty instruction.

### Quoting and escaping

Text inside code blocks, `` `inline code` ``, or lines starting with `> ` is read literally: its @names and /commands address nobody. `\@name` escapes a single mention. When you paste several lines containing @names or /commands (a transcript, a log), the composer wraps them in a code block for you. Undo removes the wrapping.

## Sending while someone is working

A plain send to a participant who is mid-turn **waits**. The task starts when the current turn ends, and the plan shows "next". Delivering into the running turn instead is called steering, and there are two ways to do it:

- add `/steer` to the message;
- pick **Send into the running turn** on the plan row.

This works like T3's own "steer" follow-up setting. The mid-turn message carries only your words and images, not the full room briefing. It is never sent while the agent is waiting on an approval or a question, or before the thread's first room briefing.

Providers handle a steered message differently (verified live with `scripts/t3-steer-check.ts`):

- **Cursor, Grok, OpenCode** take it into the running turn. One reply answers both messages and links back to both ("↩ your 3:49 and 3:50 PM messages").
- **Claude** starts a separate turn for it straight away. You get two replies, each linked to its own message.

## T3 slash commands

T3 publishes each provider's slash commands and skills. Claude exposes dozens (`/compact`, `/autocompact`, installed skills, …). Codex has `/compact` and `/feedback`, and Cursor has `/compact`. Grok and OpenCode currently expose none.

- **Browse:** type `@claude /` to list the room directives plus claude's T3 commands, labelled "T3 · @claude", each with a description and argument hint. Typing narrows the list. With several recipients (or `@all`), only the commands they all have are listed.
- **Send:** `@claude /compact focus on the parser` is sent to claude's thread exactly as typed, with no room briefing around it, because a harness only runs a slash command when it is the first thing in the message. The plan row marks it **T3 command**.
- **Unknown commands are blocked.** The plan and the server both refuse a command the recipient's provider doesn't have.
- **Limits:** a T3 command can't be combined with `/steer`, and it doesn't count as the participant having seen the room. Its next normal task still gets the full briefing.

## Room browser

Agents can use shared Chrome browsers on this machine for browser work. You can watch one and take over: close tabs, type a password, click through a login.

- **Browsers are a list, named by purpose**, under **Browsers** in the sidebar: `general` exists from the start; add others such as `t3-rooms-testing` with **+**, and describe what each is for and which logins it holds (agents read that). Each browser's page has **Start browser** / **Stop browser** at the top, the screen link, open tabs, the rooms using it, its profile size, **Reset profile** (wipes logins, history and tabs) and **Delete**.
- **Turn it on for a room** with the **Browser** button in the room header, which opens the side panel on the room's browser. The panel goes in the order it matters to agents:
  1. **Let this room's agents use browsers.** While it is off (the default for a new room), agents aren't told about browsers and `rooms-browser` refuses the room's agents.
  2. **Browsers they can use:** one checkbox per browser, each showing its name and description, which is exactly what agents read. **Edit** changes both right there; the change reaches agents with the next task. **make default** picks the browser that starts before each task (`general` unless you choose another); the default stays ticked. With every browser ticked, browsers you add later are included too.
  3. The default browser's status, watch link and tabs, with **Start browser** / **Stop browser** at the bottom, for example to log in before a task.

  Several rooms can share a browser. Agents get the list as `- name (this room's default): description` lines in each task's instructions, and `rooms-browser list` prints the same.
- **Threads outside rooms:** the **Browser** button in a thread's header adds the browsers' instructions to your next message (a thread outside a room gets no briefing), once; add them again if the agent loses track. When starting a new thread, pick a browser in the form and they go with the first message.
- **When it runs:** it starts when you turn it on or press Start, and before each task in the room is sent (slash commands excepted). It stops after `ROOMS_BROWSER_IDLE_MINUTES` with no tab changes, but never while the room has work in flight.
- **Stable address:** each browser keeps its own ports and profile under `data/browsers/<id>/`, so logins survive stop, start and service restarts. The profile is the browser's own: none of your everyday Chrome's logins are in it. Deleting a room leaves browsers alone; a browser can't be deleted while a room uses it as its default. (A room's browser from before browsers were a list became a browser named after the room, with its logins.)
- **Stop and start keep your tabs:** Stop asks Chrome to quit normally, so it saves its open tabs, history and cookies; the next start reopens those tabs.
- **Service restarts don't touch it:** browsers keep running when the room service restarts, and the service picks them up again. Under systemd each browser process runs in its own transient scope (`systemd-run --user --scope`), because restarting a unit kills everything in its cgroup. Set `ROOMS_BROWSER_SCOPE=0` to turn that off.
- **How agents use them: `bin/rooms-browser`.** Every briefing in the room gets a "Browsers" section listing the browsers the room may use, what each is for, and which is the default, with the command and the agent's own key. Every harness has a shell, so there is nothing to configure or install:

  ```sh
  bin/rooms-browser list
  bin/rooms-browser general open https://example.com --as sol1.2fa05e45   # opens the agent's own tab, prints its id
  bin/rooms-browser general 3 snapshot --as sol1.2fa05e45                  # the page as text, with element uids
  bin/rooms-browser general 3 click 1_4 --as sol1.2fa05e45                 # fill, press, navigate, wait-for, screenshot, eval, console, close…
  bin/rooms-browser help
  ```

  The service drives the browsers through [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (one per running browser, with usage statistics off); agents never see MCP. Each command names its tab, and a tab belongs to the agent that opened it: acting on another agent's tab, or on one you opened yourself, is refused unless the agent adds `--force` (the service logs it). The command finds the service through `data/browser-api.json` (address and a token written at every start, readable only by you; `ROOMS_BROWSER_API` points it elsewhere). Screenshots go to `/tmp/rooms-browser/`. The DevTools address stays in the briefing as a fallback for agents that prefer Playwright's `connectOverCDP`.
- **What you see depends on the machine:**

  | Machine | What runs | How you watch |
  | --- | --- | --- |
  | Linux with `Xvfb`, `x11vnc`, `websockify` and noVNC installed | Chrome on a virtual screen | The panel's **Open the browser screen** link opens noVNC with mouse and keyboard. Agents also get the link, so they can hand it to you. |
  | macOS, or Linux with a desktop | A normal Chrome window with the room's own profile | Use the window directly |
  | Linux without those tools and no desktop | Headless Chrome | Agents only; nothing to watch |

  Ubuntu packages: `sudo apt install xvfb x11vnc websockify novnc` plus Google Chrome or Chromium.
- **Watching from another device:** noVNC listens on `127.0.0.1` by default. To open it from your Mac or iPad over Tailscale, set `ROOMS_BROWSER_BIND` to the box's Tailscale IP. Leave the DevTools port on localhost: anyone who reaches it controls the browser and its logins. The room UI itself is bound to `127.0.0.1` too; to use it from a phone, put Tailscale Serve (or another reverse proxy) in front of `ROOMS_PORT` (see [On a phone](#on-a-phone)).
- **Same machine:** the room browser runs on the machine running the room service, so run the service next to the T3 server whose agents use it.

## What the room shows

### Timeline

- **The layout is a chat.** Your messages are on the left, and participants' replies on the right, labelled with their alias. Each reply links back to the message(s) it answers.
- **Progress, then the final answer.** T3 keeps each message an agent writes during a turn separately. While a turn runs, the room streams those progress notes, with the tool calls between them collapsed ("ran 4 tools · Read, Bash, Edit"). When the turn ends, the reply is the turn's final answer, and the notes sit under a collapsed "progress updates" disclosure. Dependent tasks receive only the final answer, which is why the briefing asks every agent to end with a **Handoff** section.
- **Changed files** from a turn are listed under the reply, with line counts, collapsed by default.
- **Turns typed directly in T3 Code** also appear. Your prompt shows as your bubble, and the answer as the participant's. A turn the agent started on its own, such as a background job finishing, is marked "↻ continued on its own". These turns are for awareness only: other participants never receive them in briefings, and they never satisfy a room dependency.
- **Notes typed into a running room turn** in T3 Code (Claude delivers them inside the turn, so the reply answers them too) appear as your bubble tagged "in T3", with any images, ahead of the reply. Like direct turns, they are for awareness only and never enter briefings.
- **Replies render richly.** Code blocks have a copy button. Inline code that names a file (`src/parser.ts:42`) shows as a chip with a type badge and the basename; hover for the full path, click to copy it. Images an agent saves to disk and references by path (`![shot](/tmp/shot.png)`) render inline; the room serves only image files under your home directory or the temp directory, resolving symlinks first.

### Room header

The header carries the room's own controls. On the right, **People** (a two-person icon with the number seated; hover for who is doing what), **Browser** (the room's browser settings, status and tabs; its dot is green while the room's default browser runs, with the tab count, and red if it failed; see [Room browser](#room-browser)), **Board** (with a count, and "need input" when T3 is waiting on you) and **Changes** open the side panel on that tab; clicking the tab already showing closes it. The **⋯** menu shows the room's T3 project (name and id, with a copy button) and holds **Rename…** and **Delete room…**. The panel stays open or closed, on its last tab, across reloads.

While the sidebar is showing, it names the open room, thread or browser (highlighted), so the page header leaves the name out; it shows the name when the sidebar is hidden, and on phones.

### People

The **People** tab of the side panel lists everyone seated, with **+ Add participant** and the total context across the crew. Each participant shows status (idle, working, waiting on you, busy in T3), model, and context usage (for example `348k / 1M · 35%`). Claude and Codex report context to T3; Cursor and Antigravity do not.

**Click a participant** for its menu, headed by the usage card. The card shows:

- the thread's context window and token totals;
- today's usage for that model across all threads, with an API-equivalent cost (T3 does not split cost by thread);
- the provider's plan limits.

All of it comes from T3. The menu has:

- **Open in T3:** thread and project ids.
- **Thread details…:** branch, worktree, pull requests, plan, checkpoints and the tool log.
- **Settings…:** alias, role, model, options and permission mode, in one dialog. Model and permission changes apply to the T3 thread itself.
- **Rebind thread…:** point the participant at another thread.
- **Remove from room…**

### Background status

A turn can end while subagents, background shells or watch loops keep running. T3 reports this, and the room shows it on the participant and in the sidebar, so a quiet thread doesn't look finished or dead.

### Sidebar and header

The sidebar holds projects, each with its rooms and its threads that are not in a room (see [Projects, and threads without a room](#projects-and-threads-without-a-room)). Its foot has the app-wide controls: the **T3** connection status ("T3 connected", or the problem; hover for host, version and pairing; click for the pairing and providers panel), **Roles** and the theme menu (System, Light, Dark). The header above each page carries only that page's controls.

The sidebar button next to **+ New** hides the sidebar, and the same button at the left of the header brings it back (**⌘B** / **Ctrl+B** toggles it too). It stays hidden across reloads. While it is hidden, a red dot on that button means T3 is not paired or reports an error.

Each room shows activity pills:

- mid-turn;
- between turns with background work;
- only watch loops running;
- waiting for your approval or answer.

A thread shows a dot: filled and pulsing while it works, a ring with background work, violet when it needs you, red after an error.

Drag rooms to reorder them within their project. The **⋯** menu renames or deletes a room.

### Board and Changes (side panel)

- **Board:** the queue as lanes (needs input, running, waiting, held, blocked). Native T3 approvals and questions can be answered in place. Running cards show what the thread is doing: plan step, tool calls and the last tool, and branch, plus its live output. The Running lane also lists participants busy outside the queue: a turn typed directly in T3, or background work and monitoring between turns.
- **Changes:** files changed across the room, grouped by participant. A path touched by two participants is marked "also: @alias".

**Thread details…** in a participant's menu covers what T3 reports about the thread that isn't shown elsewhere:

- session detail and errors;
- branch, worktree and thread id;
- pull requests;
- the latest proposed plan;
- per-turn checkpoints with changed files;
- the tool log.

Status, model, role and context are on the participant's row in **People** and its usage card.

Terminals, the browser preview and full diff text stay in T3 Code.

### On a phone

The room works on a phone. Below about 760px the room list becomes a drawer behind the ☰ button (a red dot on it means a T3 connection problem), participant menus and dialogs open as bottom sheets, the side panel covers the area under the header, and the composer sits above the keyboard. On a touch keyboard, Enter inserts a newline and the **Send** button sends.

It also installs as an app. Open the room over HTTPS (for example a Tailscale Serve address; the offline shell only registers on a secure origin), then:

- **iPhone or iPad:** in Safari, tap Share, then **Add to Home Screen**. Chrome on iOS 16.4 or later offers the same from its share menu.
- **Android:** in Chrome, open the menu and choose **Install app** (or accept the install banner).
- **Desktop Chrome or Edge:** click the install icon at the right end of the address bar.

The installed app opens full screen, keeps its icon, and shows the last loaded shell when offline. Live data is never cached, so it always reflects the server once connected.

## Managing rooms, participants and roles

- **Participants mirror their thread.** Change the model or effort in T3 Code and the room updates. Change it from the room and the thread is updated through T3. The provider never changes, because a thread belongs to one harness; to switch provider, rebind to a new thread.
- **Removing a participant** asks what happens to its queued, held and blocked tasks (cancel them, or keep them blocked so you can reassign them) and to its T3 thread: **Keep in T3** (the default), **Settle**, **Archive**, or **Delete** in T3. Deleting asks for a confirmation. A thread also seated in another room is always kept, and when T3 no longer has the thread the choice is skipped. Removal is refused while it has a run in progress. If T3 refuses the thread action, the participant is still removed and the reason is shown.
- **Deleting a room** removes the room's own record: messages, tasks and stored images. For each participant's thread you choose **Keep in T3** (the default), **Settle**, **Archive**, or **Delete** in T3. Turns still running keep running in T3; the room just stops following them.
- **Roles** are named sets of rules ("accountant: reconcile every figure twice"). Manage them under **Roles** at the foot of the sidebar, and assign them from a participant's Settings or with `/role`. A participant's role rules are delivered as plain text with each of its assignments. Editing a role changes future deliveries for everyone holding it.

## Configuration

The service reads environment variables only. It does **not** load `.env`, which is used only by the optional research scripts. Set variables inline, for example `ROOMS_PORT=4500 npm start`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROOMS_PORT` | `4400` | UI/API port (always bound to 127.0.0.1) |
| `ROOMS_DATA_DIR` | `./data` | Database, stored credential and images |
| `ROOMS_DB_PATH` | `$ROOMS_DATA_DIR/rooms.sqlite` | Database file, if it should live elsewhere |
| `ROOMS_ADAPTER` | `http` | `fake` for demo mode |
| `T3_BASE_URL` | from `~/.t3/userdata/server-runtime.json`, else the paired server, else `http://127.0.0.1:3773` | T3 server origin |
| `T3_ACCESS_TOKEN` | stored credential | Overrides the paired token |
| `T3_USERDATA_DIR` | `~/.t3/userdata` | Where to find T3's runtime file and local model catalog |
| `ROOMS_TICK_MS` | `1500` | Scheduler poll interval |
| `ROOMS_BRIEFING_BUDGET` | `60000` | Characters per delivery before older room context is condensed |
| `ROOMS_BROWSER_MODE` | `auto` | Room browser: `vnc` (Xvfb + noVNC), `window`, `headless`, or `off`. `auto` picks `vnc` on Linux with the tools installed, otherwise `window` (macOS or a Linux desktop) or `headless` |
| `ROOMS_BROWSER_CHROME` | found automatically | Path to Chrome or Chromium |
| `ROOMS_BROWSER_BIND` | `127.0.0.1` | Address noVNC listens on (for example a Tailscale IP) |
| `ROOMS_BROWSER_HOST` | the bind address | Host used in watch links given to agents; if unset with a wildcard bind, the UI uses the host you opened it on |
| `ROOMS_BROWSER_NOVNC_DIR` | `/usr/share/novnc` | noVNC web files |
| `ROOMS_BROWSER_IDLE_MINUTES` | `30` | Stop a room's browser after this long without tab changes (`0` = never) |
| `ROOMS_BROWSER_SCOPE` | on under systemd | `0` keeps browser processes in the service's own cgroup (a service restart then kills them) |
| `ROOMS_BROWSER_API` | `data/browser-api.json` | Read by `bin/rooms-browser` to find the service; briefings pass it along when the data folder is elsewhere |

## Running, updating and backing up

- **Restarting is safe.** Queued tasks resume, and in-flight runs are matched back to their T3 turns. A turn that finished while the service was down is picked up on the next poll.
- **Update the UI** by rebuilding it with `npm run build:web`. Open pages show "The room UI was updated" and offer a reload. After changing server code, restart `npm start`. Database migrations run automatically at startup.
- **Back up** by copying the `data/` directory while the service is stopped. It contains `rooms.sqlite` and `t3-auth.json`. Keep the copy private, since the credential is inside.
- **Keep it running** with any process manager (a `launchd` agent, `pm2`, a tmux pane). The service needs no special privileges.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Status says "not paired", and the pairing panel mentions `desktop-managed-local` | The Desktop server on loopback does not issue pairing links. Turn on Settings → Connections → Network access in T3 Code, then create a link. |
| Pairing returns HTTP 4xx | Links are one-time and expire within minutes. Create a fresh one. |
| Status says "re-pair the room service" | The stored token expired or was revoked in T3 (Settings → Connections → clients). Pair again; queued work is untouched. |
| The service logs a T3 base URL that is wrong | T3 wasn't running when the service started, or runs elsewhere. Start T3 first, or set `T3_BASE_URL`. |
| A task sits in "dispatching" and then fails with "provider failed to start" | The harness behind that participant isn't signed in, or its CLI is missing. Fix it in T3, then press Retry on the task card. |
| A participant shows "busy in T3" | Someone is driving that thread directly in T3 Code. The room waits for that turn to end. |
| A task card shows "previous attempt: T3 no longer reports this turn" | T3 briefly stopped listing the turn. The room rechecks for a while and revives the run if the turn reappears, so a retry doesn't deliver the work twice. Retry only if the thread really shows no such turn. |
| `/name is not a T3 command for @x` | That participant's provider doesn't offer the command. Type `@x /` to see what it has. |
| The model picker is empty | The catalog comes from T3's server config. With the RPC unavailable, it falls back to `~/.t3/userdata` and existing threads. Create one thread in T3 with the model you want, or type the instance id and model manually. |
| A participant shows "thread deleted in T3" | Its thread was deleted in T3 Code. The room keeps the participant and its past replies, and new work for it is blocked. Rebind it to another thread or remove it. Settling or archiving a thread does not cause this. |
| A browser's status says "Chrome exited during start: No usable sandbox" | Chrome's sandbox can't run, which is typical inside Docker. Run the container with `--security-opt seccomp=unconfined`, or use Google Chrome's package on the host. Each tool's output is in `data/browsers/<room>/*.log`. |
| The page stops updating | The service stopped. Restart it with `npm start`; nothing is lost. |

## Development

```sh
npm run typecheck                # service types
npm --workspace web run typecheck
npm test                         # acceptance tests against the fake adapter
npm run check                    # typecheck + tests
npm run dev                      # service with --watch
npm --workspace web run dev      # Vite on :5173, proxying /api to :4400
```

Tests never touch a real T3 server. To try UI changes safely, run a demo instance on another port (`ROOMS_ADAPTER=fake ROOMS_PORT=4401 ROOMS_DATA_DIR=/tmp/rooms-demo npm start`).

| Path | Purpose |
| --- | --- |
| `src/domain` | Room records, the versioned command contract (zod), dependency-graph checks |
| `src/db` | SQLite persistence (`node:sqlite`, WAL) and migrations |
| `src/app/service.ts` | The single command handler behind every input path |
| `src/parser` | Composer syntax: mentions, assignments, waits, directives, slash commands (shared with the UI) |
| `src/scheduler` | Durable queue: dependencies, dispatch outbox, steering, turn correlation, reconciliation |
| `src/browser` | Room browsers: starts, adopts and stops each room's Chrome (and Xvfb/x11vnc/noVNC on Linux) |
| `src/briefing` | Exact context assembled for each delivery |
| `src/adapter` | T3 boundary: HTTP + WebSocket RPC adapter with pairing, and an in-memory fake |
| `src/server` | HTTP API and Server-Sent Events for the UI |
| `web/` | React UI |
| `scripts/t3-pair.ts` | Pair from the command line |
| `scripts/t3-contract-check.ts` | Live adapter check (`npm run t3:check`) |
| `scripts/t3-steer-check.ts` | Live check of mid-turn delivery per model (creates scratch threads) |
| `scripts/repair-replies.ts` | One-off repair of stored final answers and prompts from T3's record (`--dry-run` first) |
| `scripts/probe-jev-split.ts` | Research: compares the parser with a hosted interpreter (needs `JEV_API_KEY` in `.env`) |
| `tests/` | Acceptance tests driven through the fake adapter |

## How it works

- **Delivery.** Each task goes to its participant's thread as one T3 turn. The turn's message is a **briefing**: the room messages the participant hasn't seen, the finished answers of the tasks it waited on, its role rules, and its assignment. Each message is delivered once. If a message was addressed only to this participant and is already the assignment, it isn't repeated in the context.
- **Completion.** T3 has no "turn completed" event and never stamps a turn id on the message that started a turn. The scheduler polls each thread and matches its own message to the turn exactly: the turn's `requestedAt` equals the message's `createdAt`. It then reads that turn's state and final answer. A steered message has no turn of its own. An outcome is decided from the freshest T3 read, with a grace period, so a stale list can't end a run early.
- **Direct turns** started in T3 Code are imported into the timeline for awareness. They mark the participant busy but never satisfy a room dependency.

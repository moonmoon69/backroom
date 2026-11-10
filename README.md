# Backroom

![The boss at the head of the table, the crew in the shadows](assets/banner.jpg)

Backroom is the back room where the boss hands out the work. It is a local companion for [T3 Code](https://github.com/pingdotgg/t3code): a **room** is one shared conversation, and the **members** seated in it are T3 threads, each under a short alias (`@claude`, `@grok`, …). You address them in plain text, or talk to one of them, the **Consigliere**, who hands out the work and reports back. Every message becomes a numbered request on the room's board, each member's final reply is its answer, and the answer reaches whoever asked. You don't have to copy anything between threads yourself.

Your **crew** are the people you bring into rooms: a name with a model and its options, a permission mode and a place to work. Drag one onto a room and they are seated on a new thread.

Backroom owns conversation and coordination. T3 owns execution: every member is a real T3 thread, with its own model, permissions and worktree, and you can still open it in T3 Code. No model reads your input on Backroom's side: every action is a direct control or a small explicit syntax, and the composer shows the plan before you send. [How it works](docs/development.md#how-it-works) at the end describes the delivery, correlation and completion rules.

**Why Backroom.** T3 Code is a cockpit for each agent: a thread, a conversation, its terminal, diffs and worktree, and it can start several agents at once and tell you when each finishes. Its agents can hand work to each other (an agent can delegate a task to a child agent on another model, and read or message other threads), but who does what is the agent's own decision as it goes, and each thread stays its own conversation. A room is one conversation for several agents that you direct: you address them by name, or let your Consigliere hand out the work and sequence it, and each answer goes to whoever asked, with where the work is. T3 still runs every turn, and every member stays a thread you can open in T3 Code.

---

## Contents

1. [What Backroom adds to T3 Code](#what-backroom-adds-to-t3-code)
2. [Requirements](#requirements)
3. [Install](#install)
4. [A headless box over Tailscale](#a-headless-box-over-tailscale)
5. [Try it without T3 (demo mode)](#try-it-without-t3-demo-mode)
6. [Your first room](#your-first-room)
7. [Keyboard](#keyboard)
8. [Operations](docs/operations.md)
9. [Messages and requests](docs/messages.md)
10. [The Consigliere and the board](docs/consigliere.md)
11. [Room browsers](docs/browsers.md)
12. [Rooms and the overview](docs/room.md)
13. [The agents file and skills](docs/agents-file-and-skills.md)
14. [Development](docs/development.md)

---

## What Backroom adds to T3 Code

Each part below starts from what T3 Code does (read from [its source and docs](https://github.com/pingdotgg/t3code)), then shows what Backroom adds. The screenshots come from a demo room: the fake T3 with scripted replies and the usage records a harness would leave.

### Agents that work together

In T3 Code each thread is its own conversation. An agent can involve others: it can delegate a task to a child agent on any provider and wait for the result, and T3's tools let it read, message and start other threads. What gets delegated, to whom and in what order is decided by that agent while it works, and you see it in its thread afterwards.

In a room, several threads share one conversation, and you decide who does what, or tell your Consigliere what you want and let him decide. Each request is a numbered post on the room's board, and each member's final reply answers it, ending with a Handoff that says where the work is (folder, branch, commit). Nothing waits on other work by itself: the Consigliere sends the next step when the one it builds on has answered.

### The plan before anything runs

T3 Code sends what you type to one agent. Backroom reads a message with fixed rules, not a model, and shows what will happen before you send it: who gets which instruction. A message to a member who is working goes into its running turn, as typing into its harness does. A mention that may only be a reference gets a one-click fix, and a message that would wait on other work says so before it is sent.

### A crew instead of settings each time

T3 Code remembers the last model, has favorites, custom models and a project default. A Backroom crew member bundles a model and its options, a permission mode and where they work. Drag one onto a room, or pick several in the Add member dialog and seat them at once.

![Add member with two crew members picked, and what each joins with](assets/readme/crew.png)

### What finished, room by room

T3 Code notifies you, per thread, when an agent finishes, fails or needs you, and marks unread threads. In Backroom one room holds several threads, so the overview says it per room: a count of new replies on the room's tile, and the tile moves forward among the rest. Threads on their own get a **new** (or **failed**) mark the same way. What you have seen is kept by the service, so looking on your phone clears it on your Mac, and **Notifications** in the settings menu in the overview's header adds system notifications. See [What finished while you were away](docs/room.md#what-finished-while-you-were-away).

### Browsers on the box, chosen per room

T3 Code's agent browser runs inside its desktop app: it works while that app is open and connected, and a headless server has no browser of its own. Backroom runs named Chrome browsers on the machine itself. They keep their logins, every harness drives them with one command, you can watch and take over through a link, and each room (or thread) decides which ones its agents may use and which starts by default. See [Room browser](docs/browsers.md).

![A room's browsers: two of three allowed, staging the default; each ticked one with its status, and its watch link and tabs while it runs](assets/readme/browsers.png)

### What each thread and each reply cost

T3 Code's Usage page reports tokens and estimated cost by day, provider and model, across every thread: it can't say what one thread cost, or one answer. Backroom works that out from what is already on the machine (T3's record of each thread's harness sessions, the harnesses' own transcripts, T3's price table), priced the way T3 prices its totals, so the two agree.

- **Every reply** carries what the turn behind it used: the cost, tokens in and out, the number of calls, and a row per model, subagents included. When several turns answered one message, it also shows the running total since that message.
- **Every member** shows what its thread has used, and the room shows the total for everyone it ever seated. A thread on its own shows the same in its bar.
- **A member's card** splits the thread's spend into its own calls and its subagents', per model.

So you can see what a task cost before you ask for the next one, and which model is worth it for which job: here the review on GPT-6 Sol cost about $0.18, against $1.27 for Opus's build. The figures are list prices, a measure of consumption, not what a subscription charges. See [Estimated spend](docs/room.md#estimated-spend).

![Opus's reply with what its turn cost, and each member's spend with the room's total](assets/readme/costs.png)

<img src="assets/readme/cost-card.png" alt="A member's card: the thread's estimated spend, split into its own calls and its subagents', per model" width="311">

### What stays in T3 Code

Running every turn, terminals, the preview browser with its annotations and recordings, simulators, pull requests and rewinding a conversation are T3 Code's. Backroom never takes a thread away from it: any member or thread opens in T3 Code as it is.

---

## Requirements

- **Node 24 or newer.** The service runs TypeScript directly through Node's type stripping and stores data with the built-in `node:sqlite`, so it has no build step. Only the web UI is built. Check with `node --version`.
- **npm** (bundled with Node).
- **T3 Code**, with a server Backroom can reach over HTTP. Either of these works:
  - the **T3 Code Desktop app**, with **Settings → Connections → Network access** turned on (see below);
  - a headless server started with `t3 serve`, or installed with `t3 service install`.
- The harnesses you want in rooms (Claude, Codex, Cursor, Grok, OpenCode, …) are set up and signed in **inside T3**. Backroom never talks to a harness directly.

Backroom speaks T3 Code's **Orchestrator V2** (orchestration protocol 2): it needs a T3 server on **0.0.46 or newer**. Against an older server it says so in the T3 status in the overview's header and still offers T3's update there. Tested against T3 Code 0.1.8-nightly.20261107.4314 on a headless Ubuntu box (see [A headless box over Tailscale](#a-headless-box-over-tailscale)).

## Install

```sh
git clone https://github.com/moonmoon69/backroom.git
cd backroom
npm install          # installs the service and the web workspace
npm run build:web    # builds the UI into web/dist (the service serves it)
npm start            # http://127.0.0.1:4400
```

Open <http://127.0.0.1:4400>. The service binds to `127.0.0.1` only, so it is not reachable from other machines.

At startup the service logs the T3 address it will use and whether it has credentials:

```
[backroom] … T3 base URL http://127.0.0.1:3773; credentials missing (pair from the UI)
[backroom] … listening on http://127.0.0.1:4400 (db /…/backroom/data/rooms.sqlite)
```

The T3 address is found automatically from `~/.t3/userdata/server-runtime.json`, which T3 writes while it runs. Set `T3_BASE_URL` if your server is elsewhere.

## A headless box over Tailscale

The setup this was built on, and the one Theo describes for his own "bb-1": a headless Linux box runs the T3 Code server and Backroom as background services, and you work from a Mac or a phone anywhere on your tailnet. Nothing listens on the public internet.

**1. T3 Code on the box.** Install the server as a user service and pair it over Tailscale:

```bash
npx t3 service install          # runs `t3 serve` at boot, as your user
npx t3 pair --tailscale         # publishes it on Tailscale Serve (HTTPS) and prints a pairing link + QR code
```

Open that pairing link in the T3 Code desktop app on your Mac (or scan the QR code on the phone). The link is a password: it only ever travels inside the tailnet.

**2. Backroom on the box.** Run it as a user service too, and let user services run without a login session:

```bash
loginctl enable-linger "$USER"
mkdir -p ~/.config/systemd/user
"$EDITOR" ~/.config/systemd/user/backroom.service   # contents below
systemctl --user enable --now backroom.service
```

```ini
[Unit]
Description=Backroom
After=t3code.service
Wants=t3code.service

[Service]
Type=simple
WorkingDirectory=%h/Projects/backroom
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

**3. Reach Backroom from the tailnet.** It listens on `127.0.0.1` only. Publish it over HTTPS with Tailscale Serve on a port of its own (T3 Code's pairing already took 443):

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4400
tailscale serve status    # https://box.tailnet-name.ts.net:8443 -> http://127.0.0.1:4400 (tailnet only)
```

Open `https://box.tailnet-name.ts.net:8443` on the Mac or the phone. HTTPS matters on the phone: it is what lets Backroom install as an app and keep its shell offline (see [On a phone](docs/room.md#on-a-phone)).

**What is exposed where:** T3 Code and Backroom stay on loopback, reached only through Tailscale Serve. The browsers' noVNC viewers listen on the Tailscale IP because their watch links are meant to be opened from another device; their DevTools ports stay on loopback. Update Backroom with `git pull && npm install && npm run build:web && systemctl --user restart backroom.service`.

## Try it without T3 (demo mode)

```sh
ROOMS_ADAPTER=fake npm start
```

A simulated T3 takes the place of the real one. Its agents reply after about four seconds, and it offers sample slash commands (`/compact`, `/review`). Pairing is disabled in this mode. Use a separate data directory so demo rooms stay out of your real database:

```sh
ROOMS_ADAPTER=fake ROOMS_PORT=4401 ROOMS_DATA_DIR=/tmp/rooms-demo npm start
```

The demo project's folder is `/tmp/demo`, which need not exist. `ROOMS_FAKE_PROJECT_DIR=<folder>` points it at a folder of yours, a scratch git repository say, to see [the agents file](docs/agents-file-and-skills.md#the-agents-file) written, kept out of git and copied into a new worktree. In demo mode Backroom writes agents files only inside its data folder and `ROOMS_FAKE_PROJECT_DIR`: a real folder added to a demo instance as a project is never written in.

## Your first room

1. **Create a room.** Click **+** beside a project's name on the overview and give the room a title (the dialog has the project picked; you can change it). Every member's thread belongs to that project. When a Consigliere is chosen in Settings he is seated in the new room at once, as its Consigliere (see [The Consigliere](docs/consigliere.md)). When the project has no instructions for agents yet, Backroom writes the default ones into its folder, kept out of git and copied into new worktrees (see [The agents file](docs/agents-file-and-skills.md#the-agents-file)).
2. **Bring in a member.** Click the members button (two-person icon) in the room header, then the add button at the top of the Members panel (a person with a plus), and choose one of:
   - **New:** the member gets a new thread. Pick an alias, then the thread's T3 settings in one row, as in T3 Code's composer: the model (T3's default for the project is prefilled), its options (reasoning effort, context window and so on, in one dropdown) and the permission mode (Supervised, Auto-accept edits, Auto, Full access). Backroom creates the thread in T3.

     The model button opens a picker laid out like T3 Code's. A rail on the left lists your favorites and one icon per provider; the list beside it shows that provider's models, with its sign-in and usage above them (windows of one family, such as Antigravity's "Gemini · 5-hour" and "Gemini · Weekly", share a row: the family named once, then a short meter for each; the tooltip names the whole window) and older models behind a **Legacy models** row. Typing searches every provider at once. The star on a row keeps the model under favorites (stored in this browser; T3's own favorites live in its app and are not shared). Keys: **↑/↓** move, **Enter** chooses, **←/→** change provider while the search field is empty, **Alt+1…9** (⌥ on a Mac) choose by position, **Esc** closes.

     **Where it works** (as in T3 Code's new-thread toolbar): the **Project folder** (the project's own checkout, on whatever branch it has, shared with anyone else working there), a **New worktree** (a folder and branch of its own, made in T3's worktrees folder from the base branch you pick), or one of the project's **existing worktrees**. A new worktree's branch is named after the room and the member (`payments/builder`) unless you type a name, because a member does many tasks and no single one names it well. T3 makes the worktree when you add the member (it fetches, checks out and runs the project's setup script, as for its own threads), so the folder exists before any task and every briefing can name it. The choice starts on T3's default for the project, and the worktree stays when the member is removed (the Git tab lists it).
   - **Existing:** pick one of the project's threads. The member continues that thread and keeps its model, options and permission mode.

   The alias is what you type after `@`, and it exists only inside this room.

   Quicker, once you have a crew: drag someone from **Crew** on the overview onto the room's tile, or pick them at the top of this dialog, several at once if you like (see [Crew](docs/room.md#crew)).
3. **Send work.** Type `@claude fix the failing parser test` and press **Enter**. The plan under the composer shows the result before you send: who receives what. If claude is working, the message goes into its running turn.
4. **Watch it run.** Your message appears on the left and the member's reply on the right. Progress notes stream in while the turn runs. When it ends, the final answer becomes the reply.

The composer placeholder cycles through examples built from your room's actual members, so every example can be sent as is.

## Keyboard

- `↑` `↓` `←` `→`: move the ring to the nearest item that way; they press nothing (an action strip or a chip's choices the ring leaves fold, and → off a room's conversation unfolds the side panel to go into it).
- `Enter`: go in: open what the ring is on (a tile, a status chip's choices, a post's or a member's actions), press a button.
- `Backspace`: back out one step: what is in front, then a member's thread, the side panel, the room; the one key that leaves a room (in a text field it deletes).
- `Esc`: close what is in front (a menu, an action strip, a dialog, the composer with its draft kept, these keys), and nothing else.

The whole page works without a mouse: those four keys are all it takes, and the key bar at the foot of the page says what each does where the ring is. Any key that types a character opens a room's composer and types it (`@` and `/` open their lists there, with ↑ ↓ Enter Esc of their own). Tab and Shift+Tab still reach every button, link and field in order (Retry, Dismiss, Cancel, Correct…, the composer, Settings and every menu), for assistive technology and for the forms inside dialogs. A menu opened from the keyboard takes the focus into it, with ↑ ↓ between its items, and closes when Tab leaves it; while a dialog is open the page under it is out of reach, Tab goes round inside the dialog, and a dialog whose text runs longer than the window takes the focus too, so the keys scroll it. The ring shows in both looks (in the pixel look a post, a running turn and a member are in blinking brackets, as a tile is, and smaller things in a dashed ring), and what it is on is named to a screen reader (for a post its number, who wrote it to whom, where it stands and how it starts; in the composer's @ and / lists the option chosen).

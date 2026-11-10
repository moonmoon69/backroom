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

T3 Code's agent browser runs inside its desktop app: it works while that app is open and connected, and a headless server has no browser of its own. Backroom runs named Chrome browsers on the machine itself. They keep their logins, every harness drives them with one command, you can watch and take over through a link, and each room (or thread) decides which ones its agents may use and which starts by default. See [Room browser](docs/browsers.md#room-browser).

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

Backroom speaks T3 Code's **Orchestrator V2** (orchestration protocol 2): it needs a T3 server on **0.0.46 or newer**. Against an older server it says so in the T3 status in the overview's header and still offers T3's update there (see [Moving a server from T3's V1 to V2](docs/operations.md#moving-a-server-from-t3s-v1-to-v2)). Tested against T3 Code 0.1.7-nightly.20261101.4048 on a headless Ubuntu box (see [A headless box over Tailscale](#a-headless-box-over-tailscale)).

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

1. **Create a room.** Click **+** beside a project's name on the overview and give the room a title (the dialog has the project picked; you can change it). Every member's thread belongs to that project. When a Consigliere is chosen in Settings he is seated in the new room at once, as its Consigliere (see [The Consigliere](docs/consigliere.md#the-consigliere)). When the project has no instructions for agents yet, Backroom writes the default ones into its folder, kept out of git and copied into new worktrees (see [The agents file](docs/agents-file-and-skills.md#the-agents-file)).
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

**The overview** is a grid of rows, as on a game screen: the header's buttons (+ project, Arrange, T3, Updates, Settings), then for each section its head (the + beside its name, and a project's globe) and its tiles: each project's rooms and threads, its settled and archived threads, the crew, the browsers. The tiles are the stops, not the members drawn on them: a room's members are read on its tile and acted on in the room, where Members has them (the mouse agrees: a member's line takes no hover or click of its own, and a click on it opens the room). ↓ goes to the nearest row below, across sections, to the item in the column you are going down in (a section's head, one + at the far right, is passed on the way without pulling the ring across), and ↑ the same upwards, up to the header; ← → go along the row and stop at its ends, and Home and End go to them. With nothing focused, the first arrow lands on the first tile that needs you, else the first tile. A tile a poll moves (it needs you now, or has news) keeps the ring. Enter on a crew member opens their Edit dialog, whose **Seat in a room…** lists the rooms: Enter on one seats them there, as dragging them onto its tile does.

**A room** reads in two columns. Its conversation reads top to bottom in lanes: its header (×, the chat and the board, Members, Browser, Git and the room's options), the room state, the status chips (those with choices: an approval, a question, a failed turn, a running turn), the posts and the composer's strip. ↑ ↓ go lane to lane, and post to post in the posts lane: past the first post the earlier posts load, then the ring reaches the status chips, the room state and the header, and the key bar names each as it gets there. A lane with nothing to do is not a stop (no room state yet, chips with nothing to open). ← → go along the header and the status chips, stopping at their ends; Enter presses what the ring is on there: a tab shows its view, Members, Browser or Git opens its panel with the ring in it (Backspace brings it back), × leaves the room. Elsewhere → goes into the side panel (below). Home and End go to the first and the last post from every lane. When a room opens the ring is on the first status chip that needs you (an approval, a question, a failed turn), else on the newest post if it shows, else on the running turn's chip (a working turn's live bubble can push the newest post out of view), else on the composer's strip; opening never moves the board, which stays at its bottom following a turn, and typing anywhere still opens the composer. Coming back into a lane comes back to the item you were on there. Past the newest post ↓ goes on to the turns running now (each member's live bubble; one with nothing to press yet, a turn still being prepared on no request, is passed over), then the composer's strip; End stays the newest post.

**The side panel** is the room's second column, a column of rows as the overview is: its head (the tabs Members, Browser and Git, + Add member on Members, ×), then the members, or the Browser and Git panes' buttons in the rows they are drawn in (Browser: the switch, each browser's allow, make default, Edit and Page, its Start or Stop; Git: each folder, uncommitted file, commit and its files, Show older commits, each worktree). → from the conversation goes to its item nearest in height, unfolding Members if the panel is folded; in the panel ↑ ↓ go row to row (↑ into the head lands on the tab showing), ← → along a row, stopping at its right end, and ← from a row's first goes back to the conversation's item nearest in height, the panel left open. Enter on a tab shows its panel, on + opens the Add member dialog (its ring on New: ↓ goes to the crew under it, ← → along the crew in order across its lines, stopping at its ends, Enter or Space picks or unpicks the one the ring is on as a click does, one filling in the settings and several added at once, ↑ back to New and Existing, ↓ on to the fields), on × folds the panel, and on a Browser or Git row's button presses it (a folder shows its state, a file its diff, a commit its files). Enter on a member opens **its action strip**, as a post's: Open thread, Settings…, Thread details…, Open in T3, Make Consigliere (or Remove as Consigliere), Remove from room…, the ring on the first; ← → choose, Enter presses (the key bar names it), Esc or Backspace closes the strip with the ring back on the member, ↑ ↓ close it and move on. Open thread opens the member's thread over the room, and Backspace there comes back to the member; the dialogs (Settings…, Remove from room…) give the ring back to their button when they close, and a member removed passes it to the next. Backspace in the room, with nothing in front, folds the panel and puts the ring back on the conversation's item it came from.

**A post's actions.** Enter on a post (or a running turn's live bubble) opens its **action strip**: one row under it holding every button a mouse finds on that post, the ring on the first. ← → choose between them and stop at the ends, Enter presses the one the ring is on (the key bar names it: "Enter Correct…"), and Esc (or Backspace) closes the strip with the ring back on the post; ↑ ↓ close it and move on as from the post. The order is fixed: your open request's Correct… and Cancel, a failed turn's Retry and Dismiss, a running turn's Stop and the choices of an approval or question it shows; then Copy, each #ref, each file chip (its preview), each image (named with its alt text), "turn in T3" and "sent to T3"; then what else is on the post (a link, a code block's Copy, a folded text, a live feed's earlier part); and Detail last, the post's detail (who wrote it to whom, when, where it stands, the post with its folded text open). Correct… opens its box in place with the field focused: Enter sends the correction (Shift+Enter a new line), Esc closes the box, and either way the ring is back on Correct…. A button that opens something over the page (Detail, a file's or an image's preview) gets the ring back when that closes. A live bubble has no Detail (there is no post behind it yet). When a running turn ends with the ring on it or in its strip, the ring goes to the newest post, the turn's reply; after a click in it the page moves neither the focus nor the board.

**A status chip's choices.** Enter on a status chip opens it under the bar, as a click does, with its choices in an action strip under it and the ring on the first: an approval's Accept, Accept for session, Always accept, Decline and Cancel turn (or the choices the request offers, in its order and words, as an MCP server's form request does); a question's options, the answer of your own and Custom answer (Enter goes into its field; Esc there comes back), then Submit answers (passed over until there is an answer) and Dismiss; a secret's field (Enter goes into it, Enter there saves, Esc comes back without declining), Save securely (passed over until something is typed) and Decline; a failed turn's Retry and Dismiss; a running turn's Stop, Stop everything and each subagent's Stop ("Stop subagent: …"); a member's background work's Stop everything; a paused member's Resume now (before the reset it asks first: Resume anyway continues, Keep waiting sends nothing) and, until the reset, Don't resume; a held queue's Resume queue; then "show #n" for each post it is about that the view draws (the failed turn's notice, the request the turn works on), which takes the ring to that post. ← → choose, Enter presses (the key bar names the choice; a held Enter presses nothing, so the Enter that opened the strip, held down, never presses Accept), and Esc or Backspace folds the chip with the ring back on it, leaving what it asks waiting; ↑ goes back to the chip and ↓ on to the posts, the chip folded, as does a click elsewhere (a click on the chip itself folds it as always). Each button presses the choice's own control, the one a mouse clicks, so it does what a click does; with two requests drawn each button is named with what it asks ("Accept 2: run tests"), and each belongs to its request: when one is answered elsewhere its buttons go, and the ring is never moved onto another request's. An approval or a question a running turn shows in its live bubble too is one request in both places: what you choose in one shows in the other, and either answers it. A chip with nothing to press (a turn still being prepared, or one T3 refused, on no request) is no stop; a click still opens it. When the chip goes (answered, retried, dismissed, its turn ended) with the ring in its strip, the ring goes where it goes when a room opens, on something in view and without moving the board: the next chip that needs you, else the newest post if it shows, else a running turn's chip, else the composer's strip.

**Esc and Backspace.** Esc closes what is in front and nothing else: a menu, an action strip, the composer (its draft kept), a status chip's choices, a Correct… box, a dialog, these keys; it never closes the room, a member's thread or the side panel, so a reflex Esc never costs you your place. Backspace outside a text field goes back one step: what is in front first (as Esc), then a member's thread, then the side panel, then the room to its card; it is the only key that leaves a room, and the focus lands where you were. In a text field Backspace deletes as always; a fresh press in an empty composer closes the composer, and a held one stops at the empty field.

**The key bar** at the foot of the page (not on a phone) says what the ring is on, in words ("Improvement", "#33 · you to @opus, open", "writing a message"), then the keys that do something there, each named by what it does there and then: "Enter open the room" on a room's tile, "Backspace back to the overview" in a room, "Esc close it, the draft kept" in the composer, "Enter not now" on a button that waits for something (Seat in a room… while its form has a change); "? all keys" stays at its right end. It changes as the ring moves. Every key on it is shown whole: in a narrow window those that do not fit are left out from the end of the line, the ones needed least first (Home and End come last), and "? all keys" stays. **?** shows every key by place (outside a text field). The bar, **?** and the tables below are drawn from one table (`web/src/keyOrder.ts`, `KEYS`), so the three say the same; after a change to it, `node scripts/keys-readme.ts` draws the tables below again.

The arrows keep their own meaning wherever they already have one: in text fields and selects, in the composer's suggestion lists, the model list, menus, dialogs (Add member's New, Existing and crew aside, above) and the Arrange dialog (Alt+↑ ↓), and with any modifier (Alt+← stays the browser's back).

**Everywhere**

| On | Keys | What they do |
|---|---|---|
| anywhere | `?` | All keys (outside a text field) |
|  | `Tab` `Shift+Tab` | Every button, link and field, in order |
|  | `Enter` | Not now (the button waits for something, said beside it; on a button that cannot be pressed now) |

**Overview**

| On | Keys | What they do |
|---|---|---|
| a tile or a button in a row | `↑` `↓` | The row above or below (the nearest item there, across sections: the header's buttons, each section's +, its tiles, then the crew's and the browsers'; a run of ↑ ↓ keeps to the column it began in) |
|  | `←` `→` | Along the row (stops at the row's ends) |
|  | `Home` `End` | First or last in the row |
|  | `Backspace` | Nothing to go back to (the overview is the top) |
| a room's tile | `Enter` | Open the room (its members are read on the tile, not visited; in the room, Members has them) |
| a thread's tile | `Enter` | Open the thread |
| a crew member | `Enter` | Edit them (the dialog's Seat in a room… seats them, as dragging them onto a room's tile does) |
| a browser | `Enter` | Open its page |
| settled or archived threads | `Enter` | Show or hide them |
| a button in the header or a section's head | `Enter` | Press it |
| a tile's ⋯, or another button | `↑` `↓` `←` `→` | As from its tile (a button outside a tile: to the tiles) |
|  | `Enter` | Press it |
| nothing | `↑` `↓` `←` `→` | To the tiles (the first that needs you, else the first) |

**In a room**

| On | Keys | What they do |
|---|---|---|
| anywhere in it | `Esc` `Backspace` | Close composer (the draft kept; while the composer is open) |
|  | `Esc` `Backspace` | Fold the choices (a status chip's; while a status chip's choices are open) |
|  | `Esc` `Backspace` | Close correction (Correct…'s box, its text kept; while a correction is open) |
|  | `Backspace` | Fold the side panel (the ring back on the conversation; while the side panel is open) |
|  | `Backspace` | Back to the overview (the ring back on the room's tile; Esc never leaves a room) |
|  | `a–z` | Start writing (any key that types a character, space aside, opens the composer and goes in) |
| the conversation (its lanes) | `→` | The side panel (its item nearest in height; folded, Members unfolds; along the header and the status chips → moves along them instead) |
| the header (any of its buttons) | `←` `→` | Along the header (×, the chat and the board, Members, Browser, Git, the room's options; it stops at its ends) |
|  | `↓` | The lane below (the room state, the status chips or the posts, the first there is) |
|  | `Home` `End` | First or last post |
| × in the header | `Enter` | Back to the overview |
| a view's tab in the header | `Enter` | Show this view (the chat with the Consigliere, or the board) |
| Members, Browser or Git in the header | `Enter` | Open or fold its panel (opened, the ring goes into it; Backspace there brings it back) |
| the room's options (⋯) in the header | `Enter` | Its menu (read new replies aloud, rename, delete) |
| the room state | `↑` `↓` | The lane above or below |
|  | `Home` `End` | First or last post |
|  | `Enter` | Open or fold it |
| a status chip | `↑` `↓` | The lane above or below |
|  | `←` `→` | Between the chips (those with choices; it stops at the ends) |
|  | `Home` `End` | First or last post |
|  | `Enter` | Its choices (in a row under the bar, the ring on the first: an approval's Accept…, a question's options, a secret's field, a failed turn's Retry, a running turn's Stop and Stop everything, a paused member's Resume now and Don't resume, a held queue's Resume queue, then the posts it is about) |
| a post, or a turn running (its live bubble) | `↑` `↓` | Previous or next post (past the first, the earlier posts load, then the status chips, the room state and the header; past the newest, the turns running now, then the composer's strip) |
|  | `Home` `End` | First or last post |
|  | `Enter` | Its actions (in a row under it, the ring on the first: every button the post has, then Detail, its detail) |
| a post's actions | `↑` `↓` | Previous or next post (the actions close) |
|  | `←` `→` | Choose (between its buttons; it stops at the ends) |
|  | `Enter` | Press it (the bar names the button the ring is on) |
|  | `Esc` `Backspace` | Close (the ring back on the post) |
|  | `Home` `End` | First or last post |
| a status chip's choices | `↑` `↓` | Chip or posts (↑ back to the chip, ↓ on to the posts; the choices fold) |
|  | `←` `→` | Choose (between its buttons; it stops at the ends) |
|  | `Enter` | Press it (the bar names the button the ring is on; Custom answer and a secret's field go into the field, Esc there comes back; Enter in a secret's field saves it; a held Enter presses nothing) |
|  | `Esc` `Backspace` | Leave it waiting (the choices fold, the ring back on the chip; the approval, question or secret still waits for you; on an approval's, a question's or a secret's choices) |
|  | `Esc` `Backspace` | Fold the choices (the ring back on the chip) |
|  | `Home` `End` | First or last post |
| the composer's strip | `↑` | The posts (the post you were on, else the newest) |
|  | `Home` `End` | First or last post |
|  | `Enter` | Write a message |
| anywhere in the side panel | `↑` `↓` | Row above or below (its head (its tabs, + Add member, ×), then its members or rows; it stops at the ends) |
|  | `←` `→` | Along the row (it stops at the right end; ← from the row's first: back to the conversation, to its item nearest in height, the panel left open) |
|  | `Home` `End` | First or last in the panel (under its head) |
| the side panel itself | `Enter` | Write a message |
| the side panel's head | `←` `→` | Along its head (Members, Browser, Git, + Add member (on Members), ×; ← from Members: back to the conversation) |
| Members, Browser or Git in the panel's head | `Enter` | Show its panel |
| + Add member in the panel's head | `Enter` | Add a member (its dialog: ↓ from New and Existing to the crew, ← → along it, Enter or Space picks; Tab between the fields, Enter in one adds) |
| × in the panel's head | `Enter` | Fold the panel (the ring back on the conversation) |
| a member, in Members | `↑` `↓` | Previous or next member (↑ from the first: the panel's head) |
|  | `←` | The conversation (back to its item nearest in height, the panel left open) |
|  | `Home` `End` | First or last member |
|  | `Enter` | Its actions (in a row under it, the ring on the first: Open thread, Settings…, Thread details…, Open in T3, Make or Remove as Consigliere, Remove from room…) |
| a member's actions | `↑` `↓` | Previous or next member (the actions close) |
|  | `←` `→` | Choose (between its buttons; it stops at the ends) |
|  | `Enter` | Press it (the bar names the button the ring is on; Open thread opens it over the room, Backspace there comes back to the member) |
|  | `Esc` `Backspace` | Close (the ring back on the member) |
|  | `Home` `End` | First or last member |
| a row of the Browser or Git panel | `Enter` | Press it (Browser: a switch, a browser's allow, make default, Edit, Page, Start or Stop; Git: a folder shows its state, a file its diff, a commit its files) |
| another button in the side panel | `Enter` | Press it |
| a button on a post | `↑` `↓` | Previous or next item (from the post it is on) |
|  | `Enter` | Press it |
| another button | `↑` `↓` | The item above or below (in its lane, else the lane above or below; outside the lanes, the posts) |
|  | `Home` `End` | First or last post |
|  | `Enter` | Press it |
| nothing in it | `↑` `↓` | To the posts |
|  | `Home` `End` | First or last post |
|  | `Enter` | Write a message |
| a member's thread | `↑` `↓` | Scroll it |
|  | `Backspace` | Back to the room (Members open, the ring on the member) |

**A thread or a browser**

| On | Keys | What they do |
|---|---|---|
| anywhere in a thread | `Esc` `Backspace` | Close composer (the draft kept; while the composer is open) |
|  | `Backspace` | Back to the overview |
|  | `a–z` | Start writing |
| the composer's strip | `↑` | The conversation |
|  | `Enter` | Write a message |
| the conversation | `↑` `↓` | Scroll it |
|  | `Enter` | Write a message |
| a button in a thread | `Enter` | Press it |
| nothing in a thread | `Enter` | Write a message |
| a browser's page | `Backspace` | Back to the overview |
| a button on it | `Enter` | Press it |

**Writing**

| On | Keys | What they do |
|---|---|---|
| the message | `Enter` | Send |
|  | `Shift+Enter` | New line |
|  | `Esc` | Close it, the draft kept |
|  | `Backspace` | Close it (on a fresh press, not a held one's repeats; in an empty field) |
| the message, in a room | `@` | Mention a member |
|  | `/` | A command |
| the @ or / list | `↑` `↓` | Choose |
|  | `Enter` `Tab` | Take it |
|  | `Esc` | Close the list |
| a correction | `Enter` | Send it (back to Correct…) |
|  | `Shift+Enter` | New line |
|  | `Tab` | On to Send correction |
|  | `Esc` | Close it, back to Correct… (the post's actions' Correct… when they are open) |
| another text field | `Esc` | Leave the field (the ring goes to the item it is in) |

**Dialogs and menus**

| On | Keys | What they do |
|---|---|---|
| a dialog | `Tab` `Shift+Tab` | Next or previous button or field (round inside the dialog) |
|  | `Enter` | Press it (outside a text field) |
|  | `Enter` | Not now (the button waits for something, said beside it; on a button that cannot be pressed now) |
|  | `Esc` | Close it (the ring back where it was) |
|  | `Backspace` | Close it (outside a text field) |
|  | `?` | Close the keys (while this list is open) |
| New or Existing, in Add member | `↓` | The crew (the crew member the ring was last on, else the first; under Existing, the threads) |
|  | `←` `→` | Choose New or Existing (the form under them changes with it) |
| a crew member, in Add member | `↑` `↓` | Out of the crew (↑ back to New and Existing; ↓ on to the fields, Name, or with several picked the buttons) |
|  | `←` `→` | Along it (along the crew, in order, across its lines; it stops at the ends) |
|  | `Home` `End` | First or last of the crew |
|  | `Enter` `Space` | Pick or unpick (as a click does: one picked fills in the settings below, several are added at once; the form is not sent, and a held Enter picks once) |
| a menu | `↑` `↓` | Previous or next item |
|  | `Home` `End` | First or last item |
|  | `Enter` | Choose it |
|  | `Esc` `Backspace` | Close it |
|  | `Tab` | Close it and go on |
| the model list | `↑` `↓` | The models |
|  | `←` `→` | The providers (with the search empty) |
|  | `Enter` | Choose it |
|  | `Shift+Enter` | Star or unstar it (favorites) |
|  | `Alt+1…9` | Pick by number (the first nine in the list; Ctrl or ⌘ with the digit too) |
|  | `Alt+R` | Find new models (T3 looks for models it has not listed yet) |
|  | `Esc` | Close the list |

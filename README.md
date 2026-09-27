# Backroom

![The boss at the head of the table, the crew in the shadows](assets/banner.jpg)

Backroom is the back room where the boss hands out the work. It is a local companion for [T3 Code](https://github.com/pingdotgg/t3code): a **room** is one shared conversation, and the **members** seated in it are T3 threads, each under a short alias (`@claude`, `@grok`, …). You address them in plain text. Backroom queues the work, waits where one task depends on another, and passes each finished answer to whoever needs it next. You don't have to copy anything between threads yourself.

Your **crew** are the people you bring into rooms: a name with a model and its options, a permission mode, a role and a place to work. Drag one onto a room and they are seated on a new thread; click one and a thread starts on its own.

Backroom owns conversation and coordination. T3 owns execution: every member is a real T3 thread, with its own model, permissions and worktree, and you can still open it in T3 Code. No model reads your input on Backroom's side: every action is a direct control or a small explicit syntax, and the composer shows the plan before you send. [How it works](#how-it-works) at the end describes the delivery, correlation and completion rules.

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
13. [Managing rooms, members and roles](#managing-rooms-members-and-roles)
14. [Configuration](#configuration)
15. [Running, updating and backing up](#running-updating-and-backing-up)
16. [Troubleshooting](#troubleshooting)
17. [Development](#development)
18. [How it works](#how-it-works)

---

## Requirements

- **Node 24 or newer.** The service runs TypeScript directly through Node's type stripping and stores data with the built-in `node:sqlite`, so it has no build step. Only the web UI is built. Check with `node --version`.
- **npm** (bundled with Node).
- **T3 Code**, with a server Backroom can reach over HTTP. Either of these works:
  - the **T3 Code Desktop app**, with **Settings → Connections → Network access** turned on (see below);
  - a headless server started with `t3 serve`, or installed with `t3 service install`.
- The harnesses you want in rooms (Claude, Codex, Cursor, Grok, OpenCode, …) are set up and signed in **inside T3**. Backroom never talks to a harness directly.

Tested against T3 Code 0.0.43, on macOS and on a headless Ubuntu box (see [A headless box over Tailscale](#a-headless-box-over-tailscale)).

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

## Connect to T3 Code

Backroom is a third-party client of your T3 server, so it needs a credential. T3 hands out credentials through **one-time pairing links**.

### 1. Get a pairing link

- **Desktop app:** open **Settings → Connections** and turn on **Network access** (the app restarts). Then create a pairing link on the same screen. On loopback only, the Desktop server runs under the `desktop-managed-local` auth policy and offers no pairing links. That is why Network access is required.
- **Headless server** (`t3 serve` or the installed service): run `t3 pair`.

Treat pairing links like passwords. They expire within minutes and work only once.

### 2. Pair

Either paste the link into Backroom, or use the command line. While Backroom is unpaired, it shows the pairing panel in place of the rooms. Later you can reach it from the **T3** status button at the foot of the sidebar.

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

The `--write` check leaves one thread titled "Backroom contract check" in T3; delete it there when you are done. Copy a project id from a room's **⋯** menu, its **Open in T3** dialog, or from T3 itself.

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

Open `https://box.tailnet-name.ts.net:8443` on the Mac or the phone. HTTPS matters on the phone: it is what lets Backroom install as an app and keep its shell offline (see [On a phone](#on-a-phone)).

**What is exposed where:** T3 Code and Backroom stay on loopback, reached only through Tailscale Serve. The browsers' noVNC viewers listen on the Tailscale IP because their watch links are meant to be opened from another device; their DevTools ports stay on loopback. Update Backroom with `git pull && npm install && npm run build:web && systemctl --user restart backroom.service`.

## Try it without T3 (demo mode)

```sh
ROOMS_ADAPTER=fake npm start
```

A simulated T3 takes the place of the real one. Its agents reply after about four seconds, and it offers sample slash commands (`/compact`, `/review`). Pairing is disabled in this mode. Use a separate data directory so demo rooms stay out of your real database:

```sh
ROOMS_ADAPTER=fake ROOMS_PORT=4401 ROOMS_DATA_DIR=/tmp/rooms-demo npm start
```

## Your first room

1. **Create a room.** Click **+ New → New room** in the sidebar (or **+ → New room** on a project), give it a title, and pick the T3 project it works in. Every member's thread belongs to that project.
2. **Bring in a member.** Click the members button (two-person icon) in the room header, then the add button at the top of the Members panel (a person with a plus), and choose one of:
   - **New:** the member gets a new thread. Pick an alias, then the thread's T3 settings in one row, as in T3 Code's composer: the model (T3's default for the project is prefilled), its options (reasoning effort, context window and so on, in one dropdown) and the permission mode (Supervised, Auto-accept edits, Auto, Full access). A role is optional; it is the only part Backroom adds. Backroom creates the thread in T3.

     The model button opens a picker laid out like T3 Code's. A rail on the left lists your favorites and one icon per provider; the list beside it shows that provider's models, with its sign-in and usage above them and older models behind a **Legacy models** row. Typing searches every provider at once. The star on a row keeps the model under favorites (stored in this browser; T3's own favorites live in its app and are not shared). Keys: **↑/↓** move, **Enter** chooses, **←/→** change provider while the search field is empty, **Alt+1…9** (⌥ on a Mac) choose by position, **Esc** closes.

     **Where it works** (as in T3 Code's new-thread toolbar): the **Project folder** (the project's own checkout, on whatever branch it has, shared with anyone else working there), a **New worktree** (a folder and branch of its own, made in T3's worktrees folder from the base branch you pick), or one of the project's **existing worktrees**. A new worktree's branch is named after the room and the member (`payments/builder`) unless you type a name, because a member does many tasks and no single one names it well. The worktree is made when you add the member, so the folder exists before any task and every briefing can name it; T3's worktree setup script (T3 runs it only when it makes the worktree at a thread's first message) is not run. The choice starts on T3's default for the project, and the worktree stays when the member is removed (the Git tab lists it).
   - **Existing:** pick one of the project's threads. The member continues that thread and keeps its model, options and permission mode.

   The alias is what you type after `@`, and it exists only inside this room.

   Quicker, once you have a crew: drag someone from **Crew** in the sidebar onto the room, or pick them at the top of this dialog (see [Crew](#crew)).
3. **Send work.** Type `@claude fix the failing parser test` and press **Enter**. The plan under the composer shows the result before you send: who receives what, and whether it starts now or waits.
4. **Watch it run.** Your message appears on the left and the member's reply on the right. Progress notes stream in while the turn runs. When it ends, the final answer becomes the reply.

The composer placeholder cycles through examples built from your room's actual members, so every example can be sent as is.

## Projects, and threads without a room

The sidebar lists T3's projects. Under each one are its rooms, then its T3 threads that no room holds, most recently used first (five, then **show more**). Below those, **Settled · N** and **Archived · N** fold open to T3's settled and archived threads for the project. Click a project's name to fold it.

A thread is in one of three states in T3:

- **Active:** in the main list.
- **Settled:** T3's "done for now" list. It opens and reads as usual; sending it a message makes it active again. **Unsettle** in its ⋯ menu does the same without a message.
- **Archived:** hidden in T3 and reversible. T3 does not serve an archived thread's conversation, so opening one shows **Unarchive** and **Delete** instead.

Deleted threads are gone: T3 keeps no record a client can list or restore.

- **A thread on its own.** Pick **+ → New thread** on a project (or **+ New → New thread**), choose the model and permission mode (or click someone in your **crew** above the settings: theirs are filled in, a line under the row says so, and clicking them again goes back to the defaults; a thread started with them shows their name in its bar), and where it works (the project folder, a new worktree, or an existing one, as for a member; a new worktree's branch gets T3's temporary name, which T3 replaces with one made from your first message), and type. The first message creates the thread in T3 and starts it; T3 then names it. Until then nothing exists in T3: **×** in the page header or on the "New thread" row in the sidebar, or **Esc** while nothing is typed, cancels and returns to where you were. Messages go to T3 exactly as typed, with no room briefing and no queue, like typing in T3 Code. While a turn runs you can **Stop** it, or send another message and T3 handles it as its own client would. Approvals and questions appear in the conversation. Images work as in a room.
- **Threads started in T3 Code** show up in the same list and open the same way.
- **The ⋯ menu** on an open thread changes its model and permission mode, **adds it to a room** of the same project (it becomes a member under an alias and keeps its history), or settles (or unsettles), archives or deletes it in T3.
- **A new project.** **+ New → New project** adds a T3 project for a folder on the machine T3 runs on. Type the path or browse: the list under the field shows the folders T3 finds for what is typed (a path ending in `/` lists that folder's subfolders; otherwise the folders whose names start with the last part), click one to go into it and `..` to go up; folders that are projects already say so. The folder the path names is the one added, so browsing into it and pressing **Add project** adds it. The folder must exist unless you tick **Create the folder**; T3 refuses a folder another project already uses. The title defaults to the folder name. Cloning from a Git URL or GitHub is T3 Code's own; a project added there shows here.

The thread view reads the last 30 turns from T3 each time it polls; older turns stay in T3 Code. Nothing about a thread outside a room is stored by Backroom.

## Writing messages

The text you type is the whole instruction. The buttons around the composer only edit that text. Above the field, one chip per member (plus **@all**) inserts `@name` at the cursor when clicked; chips the message already addresses are highlighted, and a dot marks anyone mid-turn. As you type, the composer highlights mentions and commands, then shows the **plan**: one row per assignment, with its recipients, instruction and timing ("now", "next", "after @x", "held").

| Key | Action |
| --- | --- |
| **Enter** | Send (however many lines the draft has). A message for someone mid-turn waits for that turn unless it says `/steer` (see [below](#sending-while-someone-is-working)) |
| **Shift+Enter** | New line |
| `@` | Mention autocomplete (members and `@all`) |
| **Backspace** right after a mention (**Delete** right before one) | Removes the whole `@name` at once; ⌘/Ctrl+Z brings it back. Partly typed or unknown names delete letter by letter |
| `/` | Command menu (room commands, and T3 commands after an `@name`; in a room with one member, its T3 commands at the start too) |

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
- **A condition before the address:** `when @grok finishes, @claude write the summary`. Backroom removes the condition from claude's instruction, because it already waits for it.
- **A condition after it:** `@grok deploy it when claude finishes`. The condition stays in the text.

  For either condition, Backroom waits for the named member's assignment in this message if there is one. Otherwise it waits for their open task. If they have neither, the plan says "@grok has no task to wait for" and the message can't be sent until you change it.
- **Pronouns:** "once she's done", "when it's finished" wait for the previous assignment; "once they're finished", "when both are done" wait for all earlier ones.
- **`@all` in a condition:** "when @all finished", "once @all are done" wait for all earlier assignments, so `@all do X. @alice cross check when @all finished` waits for every task of the `@all` assignment, including alice's own. With nothing earlier in the message, it waits for everyone else's open tasks; if nobody has any, the plan says so and the message can't be sent.

What never creates a wait:

- Naming someone who has no assignment in the message; the plan suggests `/after @name` if they have open work.
- A condition Backroom can't observe ("when the tests pass"). It stays in the instruction and the plan says so.
- An assignment that comes later in the same message. The plan asks you to move it first.

**3. Deliver and release.** A task with nothing to wait for goes to its member's thread straight away, or after that thread's current turn ends. A task that waits starts only when **every** task it waits for has **succeeded**, and its briefing then includes their final answers under "Completed prerequisites". The waiting task becomes **blocked**, with the reason on its card, in two cases:

- A prerequisite failed, was stopped or was cancelled. Retry the prerequisite, or edit or unblock the waiting task.
- A prerequisite was edited after the wait was set up. Edit's "carry dependents" option re-points them.

### Addressing

```
@claude review the diff                        one member
@claude @grok review the diff                  the same instruction for both (two independent tasks)
@all review the release notes                  everyone in the room ("all" cannot be used as an alias)
Claude, review the parser                      the spoken form works at the start of a sentence
```

In a room with one member, a message that addresses nobody goes to that member: `review the diff`, `/compact` and `/hold save this for later` need no `@name`. A name that is not in the room is still an error.

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
@all draft a plan. @claude merge them when @all finished
                                               claude waits for everyone's draft, including its own ("@all")
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

The rules don't understand negation: in "@grok don't touch claude's files", grok still waits for claude. They also can't wait on a later assignment (see [How a message becomes tasks](#how-a-message-becomes-tasks)). Unknown aliases and ambiguous task references leave the draft unresolved rather than guessed. No language model is involved: the rules are the whole interpreter.

### Directives and room commands

Type `/` at the start of the message to see these, each with a description:

```
/after task41 @grok review the implementation  wait for existing work (a task picker opens after /after)
/after @claude @grok review it                 wait for claude's open task
/hold @grok save this for later                held until you release it from its card (in the chat or under Tasks)
/now @grok …                                   start now, even if the text implies a wait
/steer @grok also cover the edge cases         deliver into grok's running turn (see below)
/note preserve the public API                  a room note everyone sees; no task
/add alice                                     seat a new member on a new thread (T3's default model)
/add alice role accountant                     same, with a role
/role @alice accountant                        assign a role ("none" clears it)
/remove @alice                                 retire a member (asks about its pending tasks)
```

### Notes

A **note** is a message to the room rather than to anyone in it. Click the note button under the composer (a page with a folded corner; it toggles a `/note` prefix on the text) and send. The note appears in the timeline with a dashed border, creates no task and starts no turn, and from then on every member receives it in their briefings as shared room context, like your messages and other members' replies. Use it for decisions, constraints and facts you want everyone to have without asking anyone to act: "we keep the public API as it is", "the deploy window is Friday". Notes are text only; a message with images cannot be a note.

### Images

Paste, drop, or attach PNG, JPEG, GIF or WebP images (T3's limits: up to 10 MB each, 80 MB per message). Every assignment in the message receives them. A resend or retry delivers the same bytes. A message with images can have an empty instruction.

### Quoting and escaping

Text inside code blocks, `` `inline code` ``, or lines starting with `> ` is read literally: its @names and /commands address nobody. `\@name` escapes a single mention. When you paste several lines containing @names or /commands (a transcript, a log), the composer wraps them in a code block for you. Undo removes the wrapping.

## Sending while someone is working

A plain send to a member who is mid-turn **waits**. The task starts when the current turn ends, and the plan shows "next". Delivering into the running turn instead is called steering, and there are two ways to do it:

- add `/steer` to the message;
- pick **Send into the running turn** on the plan row.

This works like T3's own "steer" follow-up setting. The mid-turn message carries only your words and images, not the full room briefing. It is never sent while the agent is waiting on an approval or a question, or before the thread's first room briefing.

Providers handle a steered message differently (verified live with `scripts/t3-steer-check.ts`):

- **Cursor, Grok, OpenCode** take it into the running turn. One reply answers both messages and links back to both ("↩ your 3:49 and 3:50 PM messages").
- **Claude** starts a separate turn for it straight away. You get two replies, each linked to its own message.

## T3 slash commands

T3 publishes each provider's slash commands and skills. Claude exposes dozens (`/compact`, `/autocompact`, installed skills, …). Codex has `/compact` and `/feedback`, and Cursor has `/compact`. Grok and OpenCode currently expose none.

- **Browse:** type `@claude /` to list the room directives plus claude's T3 commands, labelled "T3 · @claude", each with a description and argument hint. Typing narrows the list. With several recipients (or `@all`), only the commands they all have are listed. In a room with one member, `/` at the start of the message lists its commands too, and `/compact` needs no `@name`.
- **Send:** `@claude /compact focus on the parser` is sent to claude's thread exactly as typed, with no room briefing around it, because a harness only runs a slash command when it is the first thing in the message. The plan row marks it **T3 command**.
- **Unknown commands are blocked.** The plan and the server both refuse a command the recipient's provider doesn't have.
- **Limits:** a T3 command can't be combined with `/steer`, and it doesn't count as the member having seen the room. Its next normal task still gets the full briefing.

## Room browser

Agents can use shared Chrome browsers on this machine for browser work. You can watch one and take over: close tabs, type a password, click through a login.

- **Browsers are a list, named by purpose**, under **Browsers** in the sidebar: `general` exists from the start; add others such as `backroom-testing` with **+**, and describe what each is for and which logins it holds (agents read that). Each browser's page has **Start browser** / **Stop browser** at the top and a **⋯** menu (**Edit name and purpose…**, **Reset profile…**, which wipes logins, history and tabs, and **Delete browser…**), then the screen link, open tabs, the rooms using it and its profile size.
- **Turn it on for a room** with the **Browser** button (the globe) in the room header, which opens the side panel on the room's browser. The panel goes in the order it matters to agents:
  1. **Let this room's agents use browsers.** While it is off (the default for a new room), agents aren't told about browsers and `rooms-browser` refuses the room's agents.
  2. **Browsers they can use:** one checkbox per browser, each showing its name and description, which is exactly what agents read. **Edit** changes both right there; the change reaches agents with the next task. **make default** picks the browser that starts before each task (`general` unless you choose another). Any browser can be unticked, `general` and the default included: unticking the default makes the next ticked browser the default. One browser stays ticked; to give a room none, turn browsers off. With every browser ticked, browsers you add later are included too.
  3. The default browser's status, watch link and tabs, with **Start browser** / **Stop browser** at the bottom, for example to log in before a task.

  Several rooms can share a browser. Agents get the list as `- name (this room's default): description` lines in each task's instructions, and `rooms-browser list` prints the same.
- **Threads outside rooms:** the **Browser** button (the globe) in a thread's header adds the browsers' instructions to your next message (a thread outside a room gets no briefing), once (the globe shows a green check until that message is sent); add them again if the agent loses track. When starting a new thread, pick a browser in the form and they go with the first message. In the conversation the instructions sit folded ("browser instructions") above the message they went with.
- **When it runs:** a browser starts when you press **Start browser**, when an agent first uses it, and (for a room's default) before each task in the room is sent, slash commands excepted. Turning browsers on for a room doesn't start one by itself. It stops after `ROOMS_BROWSER_IDLE_MINUTES` with no tab changes, but never while the room has work in flight.
- **Stable address:** each browser keeps its own ports and profile under `data/browsers/<id>/`, so logins survive stop, start and service restarts. The profile is the browser's own: none of your everyday Chrome's logins are in it. Deleting a room leaves browsers alone; a browser can't be deleted while a room uses it as its default. (A room's browser from before browsers were a list became a browser named after the room, with its logins.)
- **Stop and start keep your tabs:** Stop asks Chrome to quit normally, so it saves its open tabs, history and cookies; the next start reopens those tabs.
- **Service restarts don't touch it:** browsers keep running when Backroom restarts, and it picks them up again. Under systemd each browser process runs in its own transient scope (`systemd-run --user --scope`), because restarting a unit kills everything in its cgroup. Set `ROOMS_BROWSER_SCOPE=0` to turn that off.
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
- **Watching from another device:** noVNC listens on `127.0.0.1` by default. To open it from your Mac or iPad over Tailscale, set `ROOMS_BROWSER_BIND` to the box's Tailscale IP. Leave the DevTools port on localhost: anyone who reaches it controls the browser and its logins. Backroom itself is bound to `127.0.0.1` too; to use it from a phone, put Tailscale Serve (or another reverse proxy) in front of `ROOMS_PORT` (see [On a phone](#on-a-phone)).
- **Same machine:** browsers run on the machine running Backroom, so run it next to the T3 server whose agents use them.
- **Not T3 Code's own browser.** T3 Code's preview browser (its `preview_*` tools) lives inside the T3 desktop app: any thread can use it, but only while a desktop app is connected to the T3 server, and it reaches what that computer reaches. These browsers run on the box instead and work with no app open.

## What the room shows

### Timeline

- **The layout is a chat.** Your messages are on the left, and members' replies on the right, labelled with their alias. Each reply links back to the message(s) it answers.
- **Progress, then the final answer.** T3 keeps each message an agent writes during a turn separately. While a turn runs, Backroom streams those progress notes, with the tool calls between them collapsed ("ran 4 tools · Read, Bash, Edit"). When the turn ends, the reply is the turn's final answer, and the notes sit under a collapsed "progress updates" disclosure. Dependent tasks receive only the final answer, which is why the briefing asks every agent to end with a **Handoff** section.
- **Changed files** from a turn are listed under the reply, with line counts, collapsed by default, headed by where the work is: the folder, branch and commit when the task finished.
- **Branch tags.** Once the room's replies come from more than one branch (members in different worktrees), each reply names the branch it was made on, so "I added X" isn't read as being in your checkout.
- **Turns typed directly in T3 Code** also appear. Your prompt shows as your bubble, and the answer as the member's. A turn the agent started on its own, such as a background job finishing, is marked "↻ continued on its own". These turns are for awareness only: other members never receive them in briefings, and they never satisfy a room dependency.
- **Notes typed into a running room turn** in T3 Code (Claude delivers them inside the turn, so the reply answers them too) appear as your bubble tagged "in T3", with any images, ahead of the reply. Like direct turns, they are for awareness only and never enter briefings.
- **Replies render richly.** Code blocks have a copy button. Inline code that names a file (`src/parser.ts:42`) shows as a chip with a type badge and the basename; hover for the full path, click to copy it. Files an agent saves to disk and references by path render inline: an image (`![shot](/tmp/shot.png)`) as a picture, a recording (`![demo](/home/me/demo.mp4)`) with a video player, a sound with an audio player. Backroom serves only image, video and audio files under your home directory or the temp directory, resolving symlinks first, and streams video in ranges so it seeks and plays on a phone.

### Room header

The header carries the room's own controls. On the right, **Members** (a two-person icon with the number seated; hover for who is doing what), **Browser** (a globe, with a green check while the room's agents may use browsers, the tab count while its default browser runs, and a red dot if it failed to start; it opens the room's browser settings, status and tabs, see [Room browser](#room-browser)), **Tasks** (a checklist, with the count, and a violet "need input" pill when T3 is waiting on you) and **Git** (a branch, with the number of uncommitted files in the room's folders) open the side panel on that tab. They are icons; hover any of them for what it is and its counts. Clicking the tab already showing closes it. The **⋯** menu shows the room's T3 project (name and id, with a copy button) and holds **Rename…** and **Delete room…**. The panel stays open or closed, on its last tab, across reloads.

Every page's header names what is open as a small breadcrumb: `project / room` (or thread; `Browsers / name` for a browser), so switching from the sidebar or the collapsed rail shows where you landed. Phones show the name alone.

### Members

The **Members** tab of the side panel lists everyone seated, with the total context across them; the button at its top (a person with a plus) brings in a member. Each member shows status (idle, working, waiting on you, busy in T3), model, and context usage (for example `348k / 1M · 35%`). Claude and Codex report context to T3; Cursor and Antigravity do not.

**Click a member** for its menu, headed by the usage card. The card shows:

- the thread's context window and token totals;
- **estimated spend for this thread**: its total at list price, split into the thread's own calls and its subagents', then a row per model with input tokens, output tokens and cost (see [Estimated spend](#estimated-spend));
- today's usage for that model across all threads, with an API-equivalent cost (T3 does not split cost by thread);
- the provider's plan limits.

The menu has:

- **Open in T3:** thread and project ids.
- **Thread details…:** branch, worktree, pull requests, plan, checkpoints and the tool log.
- **Settings…:** alias, role, model, options and permission mode, in one dialog. Model and permission changes apply to the T3 thread itself.
- **Rebind thread…:** point the member at another thread.
- **Remove from room…**

### Estimated spend

T3 reports usage per day and model, never per thread. Backroom fills that gap from what is on the machine: T3's record of which harness session each thread runs, the harness's own transcripts (one per session, plus one per subagent), and T3's price table. Priced the same way, the same calls give T3's daily totals to the cent, so Backroom's figures and T3's usage page agree.

| Where | What it shows |
| --- | --- |
| A member's row in **Members** | The thread's total, with own and subagent shares on hover |
| The member's usage card | The total, the own and subagent split, and a row per model with input tokens, output tokens and cost |
| The **Total** line under **Members** | Every thread ever seated in the room, removed members included |
| The foot of a reply, in a room's timeline or a thread's conversation | What the turn behind it used: everything the thread used since its previous reply, subagents included, with tokens in and out, the number of calls and the running total since your last message. When several models were used or subagents ran, a row per model follows, saying whose calls they were. Turns the agent continued on its own carry their own figure |
| A member's row, while it works | What its thread has used since its last reply: the turn in progress |
| A thread's bar, outside any room | Its total, and the turn in progress while it works; click it for the same card a member has (context, compactions, subagents, files changed, estimated spend, the model's usage today and the provider's plan limits) |

What to know when reading them:

- **List price, not your bill.** The figures are what the calls would cost at the provider's API prices. A subscription charges its plan price instead; treat the estimate as a measure of consumption.
- **Providers.** Claude and Codex threads have estimates. Cursor reports usage through its account rather than per session, and Antigravity's records T3 prices only in part: their threads show "no estimate", and a room total with such threads reads "≥".
- **Per reply, not per task.** A thread's replies divide its spend between them, so nothing is counted twice. A message sent into a running turn shares that turn's reply and its figure. A turn typed directly in T3 on the thread carries its figure too. The first reply's figure includes whatever the thread used before it, which for an attached thread may be a lot.
- **A thread's whole life.** An attached thread's estimate includes what it used before it joined the room. T3 keeps only a thread's current session; Backroom remembers every session it has seen a thread on, so a thread given a new session keeps its earlier spend.
- **Where it reads.** T3's database (read-only) and `~/.claude/projects` and `~/.codex/sessions`, or `$CLAUDE_CONFIG_DIR/projects` and `$CODEX_HOME/sessions` when those are set. T3's database and the transcripts are not public interfaces; a change in them shows as "no estimate", never as a wrong number.

### Read aloud

Backroom can read replies to you, in its own voice: a small neural model ([Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)) runs inside the service on the box's CPU and the audio plays on whatever device you are using, so a phone hears the same voice as a Mac. The model (about 90 MB) is downloaded once, into `data/models/`, when a Backroom page first opens after install; until it is there, and on a service without it, the browser's own built-in voice reads instead.

- **One reply:** the speaker button at the foot of any reply bubble, in a room or a thread on its own, reads that reply in full and turns into a stop button while it does. The alias is said first, then the reply with its markup gone: a code block or a table is named rather than read, a path is its file name, and a link is its text.
- **New replies as they arrive:** **Read new replies aloud** in a room's or a thread's **⋯** menu. From then on each new reply is read when it lands, and so is each new request for your approval or an answer ("claude needs your approval"). A reply read this way is its **Handoff** section when it has one, otherwise its opening sentences, with a word that the rest is on screen. What was already there when you turned it on is not read. The setting is per room or thread and per browser.
- **Voice and speed:** the speaker button at the foot of the sidebar. **Backroom's voice on the box** lists Kokoro's voices with its grades (Heart, Bella, Nicole and Emma are the good ones; `ROOMS_SPEECH_VOICE` sets the default). **This browser's voice** uses the device's own list instead, which each device keeps for itself. **Try it** reads a sentence. The speed applies to both.

Replies are read in sentence-sized pieces: the box makes the next piece while the current one plays (about twice real time on a desktop CPU), and each piece is kept for a while so a replay costs nothing. A browser only plays sound after you have tapped or clicked in the page once, and an iPhone stops the page's work when the app is in the background, so nothing is read while the screen is off. `ROOMS_SPEECH=off` turns the box voice off; the browser's stays.

### Background status

A turn can end while subagents, background shells or watch loops keep running. T3 reports this, and Backroom shows it on the member and in the sidebar, so a quiet thread doesn't look finished or dead.

### Sidebar and header

The sidebar holds projects, each with its rooms and its threads that are not in a room (see [Projects, and threads without a room](#projects-and-threads-without-a-room)), then the **Browsers** list (see [Room browser](#room-browser)). Its foot has the app-wide controls: the **T3** connection status ("T3 connected", or the problem; hover for host, version and pairing; click for the pairing and providers panel), **Roles**, the **Voice** replies are read aloud in (see [Read aloud](#read-aloud)) and the theme menu (System, Light, Dark). The header above each page carries only that page's controls.

The sidebar button next to **+ New** collapses the sidebar to a narrow rail (**⌘B** / **Ctrl+B** toggles it too; it stays collapsed across reloads). The rail keeps a tile per room, grouped by project, with a dot when a room needs you (violet), is working (blue) or has background work (ring), so switching rooms is one click. The T3 connection's dot sits at its foot. The button at the top of the rail brings the full sidebar back, with threads, browsers and **+ New**.

Controls that open, close, toggle or add something are icons with a hover name (people, globe, checklist, branch, ⋯, ×, +, image, note, theme); actions that change something (**Send**, **Start browser**, **Release**) are words. Each page's **⋯** menu holds its less frequent actions, the destructive one last and in red.

Each room shows activity pills:

- mid-turn;
- between turns with background work;
- only watch loops running;
- waiting for your approval or answer.

A thread shows a dot: filled and pulsing while it works, a ring with background work, violet when it needs you, red after an error.

Drag rooms to reorder them within their project. The **⋯** menu renames or deletes a room.

### Tasks and Git (side panel)

- **Tasks:** the queue as lanes (needs input, running, waiting, held, blocked). Native T3 approvals and questions can be answered in place. Running cards show what the thread is doing: plan step, tool calls and the last tool, and branch, plus its live output. The Running lane also lists members busy outside the queue: a turn typed directly in T3, or background work and monitoring between turns.
- **Git:** the git state of the folders the room's threads work in: each member's T3 worktree, or the project's folder (shown even when nobody works there). When members work in more than one folder, the tab opens with the room across them:
  - **Where everyone works:** one row per folder with its branch, who works there, how far it is ahead of or behind the main branch (origin's default, else `main` or `master`) and what is uncommitted. Click a row to show that folder below.
  - **Changed in more than one place:** files two folders both changed since their branches parted, committed or not, with a chip per folder. Merging those branches may conflict there. Branches that share a long history are compared from where they split, so the shared part is never flagged.

  For the folder shown:
  - **the checkout:** branch (or the commit it is detached at), main checkout or worktree (and of which repository), where it stands against its upstream (to push, to pull, or no upstream) and against the main branch, its path, and who in the room works in it;
  - **Uncommitted:** every changed, staged, renamed and untracked file against the last commit, with line counts. A member's avatar marks files one of their turns changed since that commit;
  - **Worktrees:** the repository's worktrees with their branches and who works in each (when there is more than the main checkout; under the room overview, only the ones nobody in the room works in); click one to show it;
  - **Commits:** the branch's recent commits (subject, sha, author, age, files and line counts), marked "not pushed" until the upstream has them. Click a commit for its files; **Show older commits** reads further back.

  Any file opens its diff: an uncommitted change against the last commit, or a file's change in that commit. Backroom reads all of this with git on its own machine, so it needs to run where T3 keeps the checkouts; a folder that isn't there is shown as such. Reads never take git's locks, so they can't get in the way of agents' own git commands. The panel reads every few seconds while it is open, and only the counts otherwise.

**Thread details…** in a member's menu covers what T3 reports about the thread that isn't shown elsewhere:

- session detail and errors;
- branch, worktree and thread id;
- pull requests;
- the latest proposed plan;
- per-turn checkpoints with changed files;
- the tool log.

Status, model, role and context are on the member's row in **Members** and its usage card.

Terminals, the browser preview and full diff text stay in T3 Code.

### On a phone

Backroom works on a phone. Below about 760px the room list becomes a drawer behind the ☰ button (a red dot on it means a T3 connection problem), member menus and dialogs open as bottom sheets, the side panel covers the area under the header, and the composer sits above the keyboard. On a touch keyboard, Enter inserts a newline and the **Send** button sends.

It also installs as an app. Open Backroom over HTTPS (for example a Tailscale Serve address; the offline shell only registers on a secure origin), then:

- **iPhone or iPad:** in Safari, tap Share, then **Add to Home Screen**. Chrome on iOS 16.4 or later offers the same from its share menu.
- **Android:** in Chrome, open the menu and choose **Install app** (or accept the install banner).
- **Desktop Chrome or Edge:** click the install icon at the right end of the address bar.

The installed app opens full screen, keeps its icon, and shows the last loaded shell when offline. Live data is never cached, so it always reflects the server once connected.

## Managing rooms, members and roles

- **Members mirror their thread.** Change the model or effort in T3 Code and the room updates. Change it from the room and the thread is updated through T3. The provider never changes, because a thread belongs to one harness; to switch provider, rebind to a new thread.
- **Removing a member** asks what happens to its queued, held and blocked tasks (cancel them, or keep them blocked so you can reassign them) and to its T3 thread: **Keep in T3** (the default), **Settle**, **Archive**, or **Delete** in T3. Deleting asks for a confirmation. A thread also seated in another room is always kept, and when T3 no longer has the thread the choice is skipped. Removal is refused while it has a run in progress. If T3 refuses the thread action, the member is still removed and the reason is shown.
- **Deleting a room** removes the room's own record: messages, tasks and stored images. For each member's thread you choose **Keep in T3** (the default), **Settle**, **Archive**, or **Delete** in T3. Turns still running keep running in T3; the room just stops following them.
- **Roles** are named sets of rules ("accountant: reconcile every figure twice"). Manage them under **Roles** at the foot of the sidebar, and assign them from a member's Settings or with `/role`. A member's role rules are delivered as plain text with each of its assignments. Editing a role changes future deliveries for everyone holding it.

### Crew

Your **crew** are the people you bring into rooms: each one a name with a model and its options, a permission mode, a role, and where it works (the project folder, or a new worktree from the project's default branch). The crew is listed under **Crew** in the sidebar and stored by the service, so every device you use sees the same people.

| To | Do this |
| --- | --- |
| Add someone | **+** beside **Crew**, or **Save to crew** in the Add member dialog (it takes the name typed there; a crew member of that name is brought up to date instead) |
| Seat them in a room | Drag them onto the room in the sidebar or onto the open room's page. Or, without dragging: their **⋯** menu → **Seat in a room**, then pick the room from the list (every room, the open one first) |
| Start a thread with them | Click them (the thread starts in the open room's project, else the last one used), or drag them onto a project |
| Use them in a form | The Add member dialog and the New thread page list the crew above the settings; one click fills them in, and you can still change anything before you confirm (**Add member**, or the first message of a new thread). On the New thread page a line under the row names who is picked, and clicking them again goes back to the defaults |
| Change or remove them | Their **⋯** menu → **Edit…** |

Seated in a room, a crew member takes their name as the alias, numbered when the room already has it (`@sol`, then `@sol2`), and always gets a new thread. Capitals make no difference to a name: a room with `@Alice` has `alice` taken, and there is one crew member per name whatever its capitals. Name fields drop spaces as you type or paste. The seated member is the room's own from then on: renaming it or changing its model does not touch the crew, and editing or removing someone from the crew does not touch members or threads made from them. A crew member who works in a new worktree works in the project folder where the project is not a git repository.

## Configuration

The service reads environment variables only; it does **not** load `.env`. Set variables inline, for example `ROOMS_PORT=4500 npm start`, or in the systemd unit.

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
| `ROOMS_BROWSER_IDLE_MINUTES` | `30` | Stop a browser after this long without tab changes, unless a room using it has work in flight (`0` = never) |
| `ROOMS_BROWSER_SCOPE` | on under systemd | `0` keeps browser processes in the service's own cgroup (a service restart then kills them) |
| `ROOMS_BROWSER_API` | `data/browser-api.json` | Read by `bin/rooms-browser` to find the service; briefings pass it along when the data folder is elsewhere |
| `ROOMS_SPEECH` | on | `off` stops the service reading aloud (see [Read aloud](#read-aloud)); the model is then never downloaded |
| `ROOMS_SPEECH_VOICE` | `af_heart` | Kokoro voice used unless a browser chose another: `af_heart`, `af_bella`, `af_nicole`, `bf_emma`, … |

## Running, updating and backing up

- **Restarting is safe.** Queued tasks resume, and in-flight runs are matched back to their T3 turns. A turn that finished while the service was down is picked up on the next poll.
- **Update the UI** by rebuilding it with `npm run build:web`. Open pages show "Backroom was updated" and offer a reload. After changing server code, restart `npm start`. Database migrations run automatically at startup.
- **Back up** by copying the `data/` directory while the service is stopped. It contains `rooms.sqlite`, `t3-auth.json`, the browsers' profiles under `browsers/`, `browser-api.json` and the voice model under `models/` (which can be left out: it is downloaded again when missing). Keep the copy private: the T3 credential and every browser's logins are inside.
- **Keep it running** with any process manager: the systemd user unit in [A headless box over Tailscale](#a-headless-box-over-tailscale), a `launchd` agent, `pm2`, a tmux pane. The service needs no special privileges.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Status says "not paired", and the pairing panel mentions `desktop-managed-local` | The Desktop server on loopback does not issue pairing links. Turn on Settings → Connections → Network access in T3 Code, then create a link. |
| Pairing returns HTTP 4xx | Links are one-time and expire within minutes. Create a fresh one. |
| Status says "pair Backroom again" | The stored token expired or was revoked in T3 (Settings → Connections → clients). Pair again; queued work is untouched. |
| The service logs a T3 base URL that is wrong | T3 wasn't running when the service started, or runs elsewhere. Start T3 first, or set `T3_BASE_URL`. |
| A task sits in "dispatching" and then fails with "provider failed to start" | The harness behind that member isn't signed in, or its CLI is missing. Fix it in T3, then press Retry on the task card. |
| A member shows "busy in T3" | Someone is driving that thread directly in T3 Code. The room waits for that turn to end. |
| A task card shows "previous attempt: T3 no longer reports this turn" | T3 briefly stopped listing the turn. Backroom rechecks for a while and revives the run if the turn reappears, so a retry doesn't deliver the work twice. Retry only if the thread really shows no such turn. |
| `/name is not a T3 command for @x` | That member's provider doesn't offer the command. Type `@x /` to see what it has. |
| The model picker is empty | The catalog comes from T3's server config. With the RPC unavailable, it falls back to `~/.t3/userdata` and existing threads. Create one thread in T3 with the model you want, or type the instance id and model manually. |
| A member shows "thread deleted in T3" | Its thread was deleted in T3 Code. Backroom keeps the member and its past replies, and new work for it is blocked. Rebind it to another thread or remove it. Settling or archiving a thread does not cause this. |
| A browser's status says "Chrome exited during start: No usable sandbox" | Chrome's sandbox can't run, which is typical inside Docker. Run the container with `--security-opt seccomp=unconfined`, or use Google Chrome's package on the host. Each tool's output is in `data/browsers/<browserId>/*.log`. |
| `rooms-browser` says "Browsers are turned off for the room" or "can't use" a browser | The room's Browser tab (the globe in its header): turn browsers on, or tick that browser. |
| A panel says "Backroom's service is older than this page" | The UI was rebuilt (`npm run build:web` goes live on the next load) but the service still runs the old server code. Restart it: `systemctl --user restart backroom.service`. |
| `rooms-browser` can't reach the service | Backroom isn't running, or runs with another data folder. Start it; with a non-default `ROOMS_DATA_DIR`, briefings pass `ROOMS_BROWSER_API` along. |
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

UI text uses one type scale, defined at the top of `web/src/styles.css`: `--text-xs` 11px (meta), `--text-sm` 12px (secondary), `--text-md` 13px (list rows, menus), `--text-base` 14px (messages, inputs), `--text-lg` 16px (titles), `--text-xl` 18px (brand). Use those rather than literal sizes; icons come from `web/src/components/icons.tsx`.

Tests never touch a real T3 server. To try UI changes safely, run a demo instance on another port (`ROOMS_ADAPTER=fake ROOMS_PORT=4401 ROOMS_DATA_DIR=/tmp/rooms-demo npm start`).

| Path | Purpose |
| --- | --- |
| `src/domain` | Room records, the versioned command contract (zod), dependency-graph checks |
| `src/db` | SQLite persistence (`node:sqlite`, WAL) and migrations |
| `src/app/service.ts` | The single command handler behind every input path |
| `src/parser` | Composer syntax: mentions, assignments, waits, directives, slash commands (shared with the UI) |
| `src/scheduler` | Durable queue: dependencies, dispatch outbox, steering, turn correlation, reconciliation |
| `src/browser` | Browsers: the list and which rooms may use what (`catalog.ts`), each browser's Chrome process (and Xvfb/x11vnc/noVNC on Linux) with start, adopt and stop (`roomBrowsers.ts`), and the agents' tool behind `rooms-browser` (`tools.ts`) |
| `src/briefing` | Exact context assembled for each delivery |
| `src/speech` | Backroom's voice: Kokoro run in the service, one piece at a time, recent pieces kept |
| `src/git` | Git read with the CLI on this machine: a folder's branch, uncommitted files, commits, worktrees and diffs (`reader.ts`), and where each member works (`workspaces.ts`) |
| `src/adapter` | T3 boundary: HTTP + WebSocket RPC adapter with pairing, and an in-memory fake |
| `src/server` | HTTP API and Server-Sent Events for the UI |
| `web/` | React UI |
| `bin/rooms-browser` | The agents' browser command (plain Node; talks to the service over `data/browser-api.json`) |
| `scripts/t3-pair.ts` | Pair from the command line |
| `scripts/t3-contract-check.ts` | Live adapter check (`npm run t3:check`) |
| `scripts/t3-steer-check.ts` | Live check of mid-turn delivery per model (creates scratch threads) |
| `scripts/repair-replies.ts` | One-off repair of stored final answers and prompts from T3's record (`--dry-run` first) |
| `tests/` | Acceptance tests driven through the fake adapter |

## How it works

- **Delivery.** Each task goes to its member's thread as one T3 turn. The turn's message is a **briefing**: the room messages the member hasn't seen, the finished answers of the tasks it waited on, its role rules, and its assignment. Each message is delivered once. If a message was addressed only to this member and is already the assignment, it isn't repeated in the context.
- **Where everyone works.** Every briefing says which folder and branch are the agent's own (its thread's T3 worktree, or the project folder, read with git when the task is sent), where each other member works, and who shares its folder. It asks the agent to deliver its work in its own folder and branch, because T3 and Backroom follow changes only there. Extra worktrees are welcome for parallel work (sub-agents, experiments), based on the agent's branch (a harness's own worktrees often start from origin's default branch instead), with what it keeps merged back before it finishes and any it leaves listed in its Handoff. It also asks the agent to read the others' work with git without switching (`git diff <your branch>...<branch>`, `git -C <folder> diff`); never to edit another member's folder; and, when sharing a folder, not to switch branches, stash, reset or clean. A finished task records where its work is (folder, branch, commit and how many files were left uncommitted); a task that waited on it gets that line above the files, and room messages replied on another branch than the reader's are tagged with it.
- **Completion.** T3 has no "turn completed" event and never stamps a turn id on the message that started a turn. The scheduler polls each thread and matches its own message to the turn exactly: the turn's `requestedAt` equals the message's `createdAt`. It then reads that turn's state and final answer. A steered message has no turn of its own. An outcome is decided from the freshest T3 read, with a grace period, so a stale list can't end a run early.
- **Direct turns** started in T3 Code are imported into the timeline for awareness. They mark the member busy but never satisfy a room dependency.

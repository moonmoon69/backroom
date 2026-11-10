# Rooms and the overview

What the overview and a room show, and how to manage rooms, members and your crew.

## The overview

Backroom opens on one page of everything: a section per project, its rooms as tiles, and in each tile the members with their state and what each is doing now (a turn's latest note, the tools running, the request it is on) or last said and how long ago: up to four lines for the Consigliere, who comes first, and one line for everyone else. A stripe down a tile's edge says the room needs you (violet) or is busy (blue). The project's loose threads are tiles too, as rooms of one, and its settled and archived threads fold open under them. Below the projects come your **Crew** and the shared **Browsers**. **+** beside a project's name opens a new room there, with the Consigliere seated, and the globe beside it sets the browsers its new rooms start with; **+** in the header adds a project; **Arrange** sets the order of projects and rooms. Rooms are the one thing made here; threads on their own are started in T3 Code and show up as tiles. Click a tile (anywhere on it, its members' lines too: they are read there, not picked) and the room opens over the whole window as a sheet, its conversation in a readable column down the middle and its side panels beside it; the × in its header, Backspace, or the browser's back closes it. The sheet has its own look: one header with the room's name, the two views as tabs (the Consigliere's name for your conversation with him, **Board · N** for every post), the crew's marks (click them for Members), the browser and git panels and the ⋯ menu; the status bar under it; then the view, then the composer (closed to one line until you want it, see [Writing messages](messages.md#writing-messages)), which goes the same way whichever view is showing. The chat reads like a conversation (your lines in a tinted box, his in a card across the column; in the pixel look yours are sunk into the window and his stand on a raised plate), the board like a ledger (every post numbered, members' turns as cards with a coloured edge). Both read down one centred column of up to 1,100px, with the composer as wide: your messages and the replies start at the same left edge, your boxes at most 70% of it, each reply in its bubble across the column with one line over it at the right: what it answers, the time, and the speaker's mark (in the chat with the Consigliere his mark alone, since every reply there is his; on the board the mark and then the name); tables and code use the whole column. A thread on its own reads the same way. A room without a Consigliere has only the board. A long room opens at its latest posts; **N earlier** at the top draws the next window above. A thread or a browser opens over the page the same way. The page reads the service every five seconds.

## Projects, and threads without a room

The overview lists T3's projects as sections. In each are its rooms, then its T3 threads that no room holds, as tiles of their own. A thread an agent made as a subagent of its own is left out, as in T3's own list. Under the tiles, **Settled · N** and **Archived · N** fold open to T3's settled and archived threads for the project, read when a section opens.

A thread is in one of three states in T3:

- **Active:** in the main list.
- **Settled:** T3's "done for now" list. It opens and reads as usual; sending it a message makes it active again. **Unsettle** in its ⋯ menu does the same without a message.
- **Archived:** hidden in T3 and reversible. T3 does not serve an archived thread's conversation, so opening one shows **Unarchive** and **Delete** instead.

Deleted threads are gone: T3 keeps no record a client can list or restore.

- **Threads on their own** are started in T3 Code; Backroom makes rooms only. Each shows up as a tile of its project and opens over the page like a room. Messages go to T3 exactly as typed, with no room briefing, like typing in T3 Code. While a turn runs you can **Stop** it, or send another message: it goes into the running turn, as T3 Code's composer does by default. Approvals, questions and secrets appear in the conversation. Images work as in a room. A thread paused on a usage limit reads "paused until 15:30" on its tile, and **Resume now** and **Resume queue** sit above its composer (see [Usage limits and held queues](#usage-limits-and-held-queues)); so do **Stop everything**, while anything runs, and a **Stop** for each subagent (see [Background status](#background-status)).
- **The ⋯ menu** on an open thread changes its model and permission mode, **adds it to a room** of the same project (it becomes a member under an alias and keeps its history), or settles (or unsettles), archives or deletes it in T3.
- **Browsers for a project's new rooms.** The globe beside a project's **+** sets what its new rooms start with: **New rooms start with browsers on**, the browsers they can use and the default, the same choices as a room's Browser panel (see [Room browser](browsers.md)). The globe has a green check while they start on. Without a setting, new rooms start with browsers off.
- **A new project.** **+** in the overview's header adds a T3 project for a folder on the machine T3 runs on. Type the path or browse: the list under the field shows the folders T3 finds for what is typed (a path ending in `/` lists that folder's subfolders; otherwise the folders whose names start with the last part), click one to go into it and `..` to go up; folders that are projects already say so. The folder the path names is the one added, so browsing into it and pressing **Add project** adds it. The folder must exist unless you tick **Create the folder**; T3 refuses a folder another project already uses. The title defaults to the folder name. Cloning from a Git URL or GitHub is T3 Code's own; a project added there shows here.

The thread view reads T3's recent window of the thread each time T3 says it changed (see [T3's threads](development.md#how-it-works)); older turns stay in T3 Code. Nothing about a thread outside a room is stored by Backroom.

## What the room shows

### Timeline

- **The layout is a chat.** Your messages are on the left, and members' replies on the right, labelled with their alias. Each reply links back to the message(s) it answers.
- **Progress, then the final answer.** T3 keeps each message an agent writes during a turn separately. While a turn runs, Backroom streams those progress notes, with the tool calls between them collapsed ("ran 4 tools · Read, Bash, Edit"), naming the ones still running ("running Bash · ran 3 tools"). A `/compact` turn, and a compaction that happens by itself mid-turn, shows "Compacting context…", then what it saved ("Context compacted 264k → 8k tokens"). When the turn ends, the reply is the turn's final answer; **turn in T3** under it opens the member's earlier messages in that turn and how many files it changed, read from T3. Whoever asked receives only the final answer, which is why the briefing asks every agent to end with a **Handoff** section.
- **Turns typed directly in T3 Code** also appear, and so does a turn the agent started on its own, such as a background job finishing: each is a **↻ follow-up** on the member's request, with the turn's answer, and in a room with a Consigliere it reaches him like a reply (see [Members only answer](consigliere.md#members-only-answer)).
- **Approvals and questions** appear in the member's working bubble as they come, with T3's own choices (Accept, Accept for session, Always accept, Decline, Cancel turn, or the question's options and a custom answer). Answering there is the same as answering in the status bar or in T3 Code; whichever you use first wins, and the bubble goes back to the live feed. A question the agent asks and then goes on without (Codex can, and says so in its reply) lapses when its turn ends: the member is **ready** again, and you answer in your next message.
- **Secrets** an agent asks you for (T3's `request_secret` tool: a password, a token) appear there too, in T3's words: what it is, why the agent needs it, a password field, **Save securely** and **Decline**. A saved secret goes straight to T3, which stores it and never shows it to the agent (the agent gets a reference to it, or a file for a shell command). Backroom does not keep it: it is not in its database, its logs, the board or the page's state, and the field is cleared once you press Save. When T3 says the request was already answered, no longer exists, or its agent stopped, the card goes and the reason shows; when T3 does not confirm, the secret may have been saved, so look before you answer again. Ending the turn cancels the request.
- **Requests and answers.** Each of your messages shows where its requests went, each with its marker (**open**, **answered**), and **Correct…** and **Cancel** while it is open. Each reply says what it did to them ("answers #12 from you"); a member's message sent with T3's own tools to another is a note. See [The Consigliere](consigliere.md).
- **Notes typed into a running room turn** in T3 Code (Claude delivers them inside the turn, so the reply answers them too) appear as your bubble tagged "in T3", with any images, ahead of the reply.
- **Replies render richly.** Code blocks have a copy button. Inline code that names a file (`src/parser.ts:42`) shows as a chip with a type badge and the basename; hover for the full path, click to preview it (below). Files an agent saves to disk and references by path render inline: an image (`![shot](../../../../../tmp/shot.png)`) as a picture, a recording (`![demo](../../../../me/demo.mp4)`) with a video player, a sound with an audio player. Backroom serves image, video and audio files from wherever it can read them, resolving symlinks first, and streams video in ranges so it seeks and plays on a phone.
- **Preview a file.** A file chip opens the file in a dialog that takes 90% of the window (and follows it as it resizes): Markdown rendered (**Source** shows it as written), an HTML file rendered in a sandbox that admits no outside script, style, font or fetch, whose pictures, recordings and sounds the service serves when they are files on this machine, next to the document or by absolute path, as a Markdown document's; code highlighted with line numbers as T3 Code does it (with Shiki, loaded only when a preview opens), images, recordings and sounds shown. A chip with a line or a range (`http.ts:869-891`) scrolls to it and marks it. A relative path is looked for in the folder the reply was written in (its member's worktree), then in each project; a bare name (`Crew.tsx`) is looked for by name. Links inside a document or a reply stay in the app: `#…` scrolls to that heading, a link to a file (relative, absolute, or with GitHub's `#L10-L20`) opens its preview, and only web links open a new tab. The path can be copied. Any file the service can read is previewed, wherever it is and through symlinks (a project's `docs` may be a link to a folder elsewhere), never one that looks like a secret (`.env`, keys, `t3-auth.json`), and text only up to 512 KB.
- **Copy a whole message.** The copy button at the foot of a reply copies the reply as the Markdown it was written in, so it pastes with its formatting. Your own messages have one beside the bubble: it shows while the pointer is over the message, and always on a phone. Threads on their own have the same buttons.

### Status bar

Above the conversation, a line or two says what is going on in the room, one chip per thing, grouped by what it asks of you. With nothing going on there is no bar.

- **Needs you:** a member waiting on an approval (an MCP server's form request among them: its app's name, its prompt and the choices the server offers, in its words, such as Cancel, Decline and Approve, with a session or permanent approval only when the server allows one), a question or a secret, its own or one a task it delegated raises on a thread of its own (T3 shows that one on the member too, and only you can answer it; your answer goes to the subagent's thread), and a notice that waits on you: a failed turn of a request of yours (with the reason, such as a harness that is not signed in), or, in a room without a Consigliere, a post a retired member could not take (with one, that notice is his). A failed request of Backroom's (a seat briefing, a reseat's checkpoint) is the Consigliere's, and a turn woken by a cancel alone needs nobody, so one failure is one chip; the Consigliere failing on a member's failure notice is yours (the room has stalled).
- **Working:** each turn the room sent and has not seen end, with the requests it works on ("working on #41"; "uncertain" when Backroom cannot yet tell whether T3 took it), members busy with a turn the room did not start ("on its own", or "in T3" when someone typed it there), and members between turns with background work or monitoring, as T3 reports it ("background work", "subagents running" or "monitoring", with the jobs T3 lists, such as "Run the tests (command, 2m)").
- **Waiting:** a member with posts it has not been given yet ("2 unread"): Backroom's own requests and members' answers wait for the turn to end, as everything does in a turn the room did not start; a post too large to deliver ("blocked delivery"); a member **paused** on its provider's usage limit ("on Claude's limit until 15:30"); and a member whose **queue held** T3 holds its queued messages.

A chip moves from one group to the next as its state changes and goes away when it is done. Click one to open it under the bar: an approval's choices, a question's options or a secret's field, **Retry** or **Dismiss** on a failed turn (Dismiss takes it off your list; it stays on the board), **Stop** and **Stop everything** on a running turn (with a **Stop** for each subagent it runs), **Stop everything** on a member's background work, **Resume now** on a paused member, **Resume queue** on a held queue (see [Usage limits and held queues](#usage-limits-and-held-queues)). The same "needs you" count is the pill on the room's tile in the overview, so you see it from the page of every room. A notice is one notice wherever it shows (the bar, the conversation, the board, the tile): one Dismiss takes it off all of them.

### Room header

The header carries the room's own controls. On the right, **Members** (a two-person icon with the number seated; hover for who is doing what), **Browser** (a globe, with a green check while the room's agents may use browsers, the open tabs of every browser the room may use that runs, added up, with each browser's state on hover, and a red dot if one failed to start; it opens the room's browser settings and, for each browser the room may use, its status and tabs, see [Room browser](browsers.md)) and **Git** (a branch, with the number of uncommitted files in the room's folders) open the side panel on that tab. They are icons; hover any of them for what it is and its counts. Clicking the tab already showing closes it. The **⋯** menu shows the room's T3 project (name and id, with a copy button) and holds **Rename…** and **Delete room…**.

Every page opened over the overview names what is open in its header as a small breadcrumb: `project / thread` (`Browsers / name` for a browser); a room shows its name and project. Phones show the name alone.

### Members

Members appear everywhere in a room (the timeline, the status bar, the composer's chips and plan, this list) the way the overview's crew list shows them: the logo of the harness they run on, then their name. The name tells two members on the same harness apart. Colour is kept for what needs a look: a member's status is in words beside it, coloured only while it works, waits on you or fails, and context and usage meters stay grey until they run high (amber from 60%, red above 85%).

The **Members** tab of the side panel lists everyone seated, with the total context across them; the button at its top (a person with a plus) brings in a member. Each member shows its model, context usage (for example `348k / 1M · 35%`) and what it is doing, ranked as T3 Code ranks its thread statuses, the first that holds (`src/domain/memberState.ts`, the order `tests/memberActivity.test.ts` holds this list to):

- **thread deleted in T3**, when T3 no longer has the member's thread;
- **needs approval**, **asking for a secret** or **waiting for your answer**: the card gets a steady border in that colour;
- **paused on Claude's limit until 15:30**, when its provider's usage limit stopped its turn: in amber, neither working nor needing you; the line under it is the provider's own sentence and whether T3 continues the turn at the reset;
- **queue held**, when T3 holds the member's queued messages, with T3's reason when its runs say it;
- **working** (a turn the room sent), **working on its own** (a turn the room did not start: the member woke itself when work it left running finished, another member sent it, or someone typed in T3 Code) or **starting**: the card pulses;
- **error**, **interrupted** or **rolled back**, as the last run ended, even while work it left runs on (T3's **Failed** comes first too): the line under it names what still runs;
- **subagents running** or **background work**, when the turn ended but its subagents or workflows run on: the card pulses;
- **monitoring**, when only monitors are left: the card pulses slower and fainter;
- **plan ready**, a plan proposed in plan mode and not acted on: a steady border;
- then **ready**.

A line under the model says what runs beside the turn, as T3 lists it: "2 subagents · 1 command". With reduced motion turned on in the system, a working card keeps a steady border instead of pulsing. Claude and Codex report context to T3; Cursor and Antigravity do not.

**Click a member** for its menu, headed by the usage card. The card shows:

- the thread's context window and token totals;
- **estimated spend for this thread**: its total at list price, split into the thread's own calls and its subagents', then a row per model with input tokens, output tokens and cost (see [Estimated spend](#estimated-spend));
- today's usage for that model across all threads, with an API-equivalent cost (T3 does not split cost by thread);
- the provider's plan limits.

The menu has:

- **Open thread:** the member's thread here, over the room, read-only (you talk to it from the room); × or Backspace comes back to the room.
- **Open in T3:** thread and project ids.
- **Thread details…:** branch, worktree, pull requests, plan, checkpoints and the tool log.
- **Settings…:** alias, model, options and permission mode, in one dialog. Model and permission changes apply to the T3 thread itself.
- **Remove from room…**

### Estimated spend

T3 reports usage per day and model, never per thread. Backroom fills that gap from what is on the machine: T3's record of which harness session each thread runs, the harness's own transcripts (one per session, plus one per subagent), and T3's price table. Priced the same way, the same calls give T3's daily totals to the cent, so Backroom's figures and T3's usage page agree.

| Where | What it shows |
| --- | --- |
| A member's row in **Members** | The thread's total, with own and subagent shares on hover |
| The member's usage card | The total, the own and subagent split, and a row per model with input tokens, output tokens and cost |
| The **Total** line under **Members** | Every thread ever seated in the room, removed members included |
| The foot of a reply, in a room's timeline or a thread's conversation | What the turn behind it used: everything the thread used since its previous reply, subagents included, with tokens in and out, the number of calls and the running total since your last message (since the earliest post the page has loaded, and saying so, when your last message is older than that). When several models were used or subagents ran, a row per model follows, saying whose calls they were. Turns the agent continued on its own carry their own figure |
| A member's row, while it works | What its thread has used since its last reply: the turn in progress |
| A thread's bar, outside any room | Its total, and the turn in progress while it works; click it for the same card a member has (context, compactions, subagents, files changed, estimated spend, the model's usage today and the provider's plan limits) |

What to know when reading them:

- **List price, not your bill.** The figures are what the calls would cost at the provider's API prices. A subscription charges its plan price instead; treat the estimate as a measure of consumption.
- **Providers.** Claude and Codex threads have estimates. Cursor reports usage through its account rather than per session, and Antigravity's records T3 prices only in part: their threads show "no estimate", and a room total with such threads reads "≥".
- **Per reply, not per request.** A thread's replies divide its spend between them, so nothing is counted twice. A message sent into a running turn shares that turn's reply and its figure. A turn typed directly in T3 on the thread carries its figure too. The first reply's figure includes whatever the thread used before it, which for an attached thread may be a lot.
- **A thread's whole life.** An attached thread's estimate includes what it used before it joined the room. T3 keeps only a thread's current session; Backroom remembers every session it has seen a thread on, so a thread given a new session keeps its earlier spend.
- **Where it reads.** T3's database (read-only) and `~/.claude/projects` and `~/.codex/sessions`, or `$CLAUDE_CONFIG_DIR/projects` and `$CODEX_HOME/sessions` when those are set. T3's database and the transcripts are not public interfaces; a change in them shows as "no estimate", never as a wrong number.

### Background status

A turn can end while subagents, background shells or watch loops keep running. T3 reports this, and Backroom shows it on the member and on the overview, so a quiet thread doesn't look finished or dead.

What the member's label says comes from one ordered table (`src/domain/memberState.ts`), read by the page, by `rooms-board members` and by the Consigliere's notices, in T3's order: thread deleted, an approval, a secret, a question, a usage limit, a queue T3 holds, working, then how the last run ended, then work left running, then a plan ready. A run that failed, was stopped or was rolled back outranks the work it left running, as T3's sidebar puts **Failed** first: the member reads **error**, and its detail names what still runs ("still running: node browser-repl.mjs (command, 3h)"). What runs is T3's thread row, which T3 derives from the provider thread's tasks, the commands and tools a turn left running, and its pull-request watches: a Codex exec left running by a failed turn is listed and named in the member's status line, where the provider thread alone lists nothing.

**Stop** ends the turn alone (T3's `run.interrupt`); what it left running goes on. **Stop everything** (beside Stop on a running turn, and on a member's background-work chip) is T3's `thread.stop`: the turn, its background commands, monitors and subagents, the tasks it delegated to threads of their own and T3's pull-request watches all end; messages queued behind it are held (**queue held**, Resume queue starts them), and a usage limit's recovery is turned off. The Consigliere's notice for a turn it stopped says the user stopped everything, with what the turn had written, and its request stays open for Retry; background work it ended with no turn running gets one quiet follow-up naming what ended "…: the user stopped everything from Backroom". Each subagent a turn runs has a **Stop** of its own in the turn's chip ("Stop subagent: Read the CI logs"): that subagent ends, and the turn and the other subagents go on. T3 stops Claude's own subagents and delegated tasks; for another one it refuses, and the refusal is shown; a subagent that has finished is said to have finished, and nothing is sent.

T3's own watch of a pull request (its `watch_pull_request` tool) is listed the same way, as a monitor "Watching pull request #N": the member shows **monitoring** until the pull request merges or closes or its thread is settled in T3, however its checks went, and T3 wakes the member when the pull request changes. What the watch waits for is said from what T3 gives, in the member's hover, its status chip and a loose thread's controls: "Watching pull request #70: 1 check pending (Browser harness) · watched for 8h". The checks by name come from T3's checks read (`pullRequests.checks`, T3's cached read, read again when T3's snapshot of the pull request changes and at most every 20 s); without it, from the snapshot's `checksState` ("checks pending", "checks failing" with the failed checks the watch recorded, "checks passed"). Neither says when a check started, so the time is the watch's age as T3 records it; a reading older than 15 minutes says its age ("as of 40m ago"). Green checks read "checks passed" while T3 keeps watching. The status line on the member's posts names the watch alone, so a changing line never reads as work that ended. The watch is T3's, not work the member left running: it is named in the member's status line and the quiet follow-up says when it ended, but it holds no reseat and no keep-alive, and a browser is not busy for it. T3 wakes the member on a change of the checks' overall state or the mergeability, not when a run finishes: one failed job makes the state failing while the others still run, and GitHub refuses a rerun until the run completes. So Backroom reads the same checks each tick (from the same cache, no more often) and tells the Consigliere once per run (a rerun on the same head is a run of its own) when no check is pending any more and one failed, naming the failed checks: the rerun is possible from then on.

### Usage limits and held queues

When Claude's 5-hour or 7-day limit (or Codex's) stops a turn, T3 ends the run failed and records when the limit resets. Backroom shows that as a pause, not an error:

- **The member** reads "paused on Claude's limit until 15:30", in your browser's time zone, dated when the reset is not today ("00:10 on Thu 29 Oct"). It is neither working nor needing you. The words change at the reset without a reload.
- **The Consigliere's notice** for that turn says it is paused until the reset, in the service's time zone and naming it ("until 15:30 (Asia/Taipei)"), with the provider's own sentence; Retry stays on it, as on any failed turn. When the turn continues, its reply comes to him as a follow-up on the same request.
- **T3 continues it at the reset.** Backroom arms T3's own recovery for every thread a limit stopped, when T3's thread list shows it (as T3's **Resume after usage limits** setting would, without changing that setting), and T3's recovery worker sends "Continue where you left off." at the reset. Backroom sends no continuation of its own and keeps no timer for it. A recovery that was turned off (by **Stop everything**, or in T3) stays off.
- **Resume now** on the member's chip (or above a loose thread's composer) is T3's own Continue: it continues the turn at once. Before the reset it asks first: the limit may stop it again.
- **Don't resume**, beside it until the reset, turns T3's recovery off for that turn and reset (T3's own `thread.metadata.update`, `autoResume` off): T3 will not continue it at the reset, Backroom never arms it again, and the member reads "paused on Claude's limit until 15:30" with "T3 will not continue it". **Resume now** still continues it. For a member, the Consigliere gets one follow-up on the paused request saying so.
- **Press it in Backroom.** A Don't resume or Stop pressed in T3's own window in the second Backroom arms the thread can be overwritten by that arming; one pressed in Backroom is kept, and Backroom turns T3's resume off again whatever arming lands.
- **Messages sent meanwhile** wait in T3's queue behind the paused turn and start after it continues.

T3 also **holds a thread's queue** after a provider failure, a Stop of everything, a disabled provider or a missing worktree: its queued messages wait until someone resumes them. The member then reads **queue held**, with the reason when T3's runs say it, and **Resume queue** lets T3 start them in their order. T3 refuses that while a usage limit holds the queue; the refusal is shown in T3's words.

### The overview's header

The overview's header holds **+** (a new project) and **Arrange** on the left, and the app-wide controls on the right: the **T3** connection status (a green dot while connected, the problem in words otherwise; hover for host, version and pairing; click for the pairing and providers panel), **Updates** (an arrow in a circle, with a count when T3 or a harness can be updated, see [Updates](#updates)) and the settings menu (two sliders): **Consigliere…** (see [The Consigliere](consigliere.md)), **Agents file…** (see [The agents file](agents-file-and-skills.md#the-agents-file)), **Skills…** (see [Skills](agents-file-and-skills.md#skills)), **Notifications** on this device (see [What finished while you were away](#what-finished-while-you-were-away)), **Copy keyboard log** (see [On a phone](#on-a-phone)), the theme (System, Light, Dark) and the look (Plain, [Pixel](#the-pixel-look)). The header of each page opened over the overview carries only that page's controls.

Controls that open, close, toggle or add something are icons with a hover name (people, globe, branch, ⋯, ×, +, image, theme); actions that change something (**Send**, **Start browser**, **Retry**) are words. Each page's **⋯** menu holds its less frequent actions, the destructive one last and in red.

A room's tile shows what it asks of you: **N need you** (an approval, a question, a secret, a failure), **N busy**, and **N new** when something finished there since you last looked (see [below](#what-finished-while-you-were-away)); under them each member's state and what it is doing. A thread's tile shows its agent's state the same way, **needs you** when it waits on you, and **new** (or **failed**) when its turn ended since you last looked.

### What finished while you were away

When a member replies, or a turn fails without a reply, while you are not looking at its room, the overview shows it the way a chat app shows unread messages: a **N new** pill on the room's tile, which moves ahead of the quiet ones, with the member's line saying what it last said. The tab's title counts it all: `(2) Backroom`. A thread outside rooms gets **new** when its turn finishes (**failed** in red when it failed). Opening the room or thread clears it; so does bringing the window back to the front while it is open. "Looking" means the page is on screen and its window is in front: a reply that lands in the open room while you are in another app is still news.

What you have seen is kept by the service, so looking on your phone clears it on your Mac too. Only what finishes after the update counts; older replies are not news. A turn you interrupted yourself isn't news either.

**Notifications:** **Notifications** in the settings menu in the overview's header turns them on for this device (the browser asks for permission, then shows one so you know what they look like). Then each reply, failed turn, or finished thread arrives as a system notification while Backroom is open but not in front; clicking one opens the room or thread. They come from the page itself, not a push service, so Backroom has to be open in a tab or window on that device. A desktop browser keeps a background tab working, so that is where they are useful. Phones pause a page once it leaves the screen, so a phone rarely gets them (the pills are waiting when you come back); an iPhone offers them only to Backroom added to the Home Screen. The item only appears where the browser supports notifications.

**Arrange** in the overview's header sets the order of projects, and of rooms within their project: drag a project by its name, a room by its row. With a mouse, just drag; on a phone, press and hold until it lifts, then drag (a quick swipe still scrolls). **Alt+↑** / **Alt+↓** moves the focused one a place. Backroom keeps both orders, so every device shows the same; T3 Code keeps its own project order, per browser, and the two don't affect each other. A project added in T3 later goes at the bottom. The overview keeps this order among tiles that ask the same of you. The **⋯** menu on a room's tile renames or deletes it.

### Updates

The **Updates** button in the overview's header shows how many updates you can start from Backroom, and opens a small popup with one row for T3 and one per harness T3 has turned on. **Nothing updates by itself: each update runs only when you click its button.**

- **Harnesses** (Claude Code, Codex, Cursor, …): the installed version and the newest, as T3 checks them. **Update** asks T3 to run the harness's own updater (for Claude Code, `claude update`), the same one-click update T3 Code offers, and only when T3 would offer it. The row follows T3's progress and shows how it ended, with the updater's output when it failed. A harness T3 can't update (installed in a way T3 doesn't manage) shows its newer version and says to update it where it was installed; it isn't counted.
- **T3:** the version the server runs, and the newest release on the same channel (nightly, preview or latest), which Backroom asks npm for at most once an hour. **Update** asks for a confirmation, because T3 installs the version and restarts, which every room and thread notices for a few seconds. When T3 can, turns that are running carry on after the restart; what Backroom has not sent yet waits and is sent once T3 is back. The row says when T3 answers on the new version. A T3 that can't update itself (a dev checkout, or a desktop app that has to do it) shows what to run instead.
- **Check now** asks T3 to check its harnesses again and npm for T3's newest release. Otherwise the count is refreshed every 30 minutes.
- **Permissions.** T3 needs `environment:maintain` for its own update and `providers:manage` for a harness's update. Backroom asks for both (see [What Backroom asks for, and why](operations.md#what-backroom-asks-for-and-why)). If its credential lacks one, the row says so: "Backroom's pairing with T3 does not allow this (it lacks …)". On T3's machine, Backroom replaces its credential within the hour, or right away when you restart the service. Elsewhere, pair again with a link from `t3 pair`.

### Git (side panel)

- **Git:** the git state of the folders the room's threads work in: each member's T3 worktree, or the project's folder (shown even when nobody works there). When members work in more than one folder, the tab opens with the room across them:
  - **Where everyone works:** one row per folder with its branch, who works there, how far it is ahead of or behind the main branch (origin's default, else `main` or `master`) and what is uncommitted. Click a row to show that folder below.
  - **Changed in more than one place:** files two folders both changed since their branches parted, committed or not, with a chip per folder. Merging those branches may conflict there. Branches that share a long history are compared from where they split, so the shared part is never flagged.

  For the folder shown:
  - **the checkout:** branch (or the commit it is detached at), main checkout or worktree (and of which repository), where it stands against its upstream (to push, to pull, or no upstream) and against the main branch, its path, and who in the room works in it;
  - **Uncommitted:** every changed, staged, renamed and untracked file against the last commit, with line counts. A member's avatar marks files one of their turns changed since that commit;
  - **Worktrees:** the repository's worktrees with their branches and who works in each (when there is more than the main checkout; under the room overview, only the ones nobody in the room works in); click one to show it;
  - **Commits:** the branch's recent commits (subject, sha, author, age, files and line counts), marked "not pushed" until the upstream has them. Click a commit for its files; **Show older commits** reads further back.

  Any file opens its diff: an uncommitted change against the last commit, or a file's change in that commit. A diff larger than 400 KB is cut, and the dialog says so. Backroom reads all of this with git on its own machine, so it needs to run where T3 keeps the checkouts; a folder that isn't there is shown as such. Reads never take git's locks, so they can't get in the way of agents' own git commands. The panel reads every few seconds while it is open, and only the counts otherwise.

**Thread details…** in a member's menu covers what T3 reports about the thread that isn't shown elsewhere:

- session detail and errors;
- branch, worktree and thread id;
- pull requests;
- the latest proposed plan;
- per-turn checkpoints with changed files;
- the tool log.

Status, model and context are on the member's row in **Members** and its usage card.

Terminals and the browser preview stay in T3 Code.

### On a phone

Backroom works on a phone. Below about 760px the overview is one column of tiles and what you open from it takes the whole screen, member menus open as bottom sheets, dialogs stay centred in the part of the screen the keyboard leaves, the side panel covers the area under the header, and the composer sits above the keyboard. The page treats the keyboard as open when the visible area is more than 80px shorter than the window, or when a text field has focus and lies below the visible area; it then sizes the app to the visible area and brings the field into view if it is still covered, and it checks again on every viewport, focus and input change and every 250ms while a field has focus, so one missed event cannot leave the composer hidden. If the keyboard still covers the composer, **Copy keyboard log** in the settings menu in the overview's header copies the page's last 40 measurements and what it did with each, to paste into a report so the case can become a test. On a touch keyboard, Enter inserts a newline and the **Send** button sends.

It also installs as an app. Open Backroom over HTTPS (for example a Tailscale Serve address; the offline shell only registers on a secure origin), then:

- **iPhone or iPad:** in Safari, tap Share, then **Add to Home Screen**. Chrome on iOS 16.4 or later offers the same from its share menu.
- **Android:** in Chrome, open the menu and choose **Install app** (or accept the install banner).
- **Desktop Chrome or Edge:** click the install icon at the right end of the address bar.

The installed app opens full screen, keeps its icon, and shows the last loaded shell when offline. Live data is never cached, so it always reflects the server once connected.

On a slow link (a phone on Tailscale from abroad) the page pulls little: the service gzips its answers (the event stream and binary files aside), the browser keeps the page's scripts and styles for a year under their hashed names, and a change in T3 has the page read the overview, T3's projects and the open room, never T3's whole thread list.

## Managing rooms and members

- **Members mirror their thread.** Change the model or effort in T3 Code and the room updates. Change it from the room and the thread is updated through T3. The provider never changes, because a thread belongs to one harness; to switch provider, seat a member on a new thread.
- **Removing a member** asks what happens to its T3 thread: **Keep in T3** (the default), **Settle**, **Archive**, or **Delete** in T3. Deleting asks for a confirmation. A thread also seated in another room is always kept, and when T3 no longer has the thread the choice is skipped. Removal is refused while the member owns an open request or has a turn running; answer or cancel the request first. If T3 refuses the thread action, the member is still removed and the reason is shown.
- **Deleting a room** removes the room's own record in `rooms.sqlite`: its members, settings and stored images. Its posts stay in the rooms' journal (`data/board.sqlite`), which is append-only, and nothing shows them any more. For each member's thread you choose **Keep in T3** (the default), **Settle**, **Archive**, or **Delete** in T3. Turns still running keep running in T3; the room just stops following them.

### Crew

Your **crew** are the people you bring into rooms: each one a name with a model and its options, a permission mode, where it works (the project folder, or a new worktree from the project's default branch), and two lines in your words, **Good at** and **Avoid** (each at most 300 characters, kept on one line). The two show on their tile under the model, a line each, and the Consigliere reads them with each one's model and effort level (the model's effort, reasoning or reasoning effort option) when he picks whom to seat, in `rooms-board crew` and in his briefing; rewrite them when the model or your experience of it changes. The crew is listed under **Crew** on the overview, below the projects, and stored by the service, so every device you use sees the same people.

| To | Do this |
| --- | --- |
| Add someone | **+** beside **Crew**, or **Save to crew** in the Add member dialog (it takes the name typed there; a crew member of that name is brought up to date instead) |
| Seat them in a room | Drag them onto the room's tile on the overview. Or, without dragging: **Seat in a room…** in their Edit dialog (click them, or Enter on them), then pick the room from the list (every room). They are seated with their saved settings, so the dialog's button waits until any change in it is saved or cancelled |
| Use them in a form | The Add member dialog lists the crew above the settings; one click fills them in, and you can still change anything before you confirm (**Add member**). A line under the row names who is picked, and clicking them again goes back to the defaults. By keys: ↓ from New to the crew, ← → along it, Enter or Space picks (see [Keys](../README.md#keys)) |
| Seat several at once | In the Add member dialog, pick more than one. The settings give way to a list of who joins, under which name, with what; **Add 3 members** seats them one after another, each on a new thread with their saved settings. To change someone's settings first, pick them alone. If one can't be seated, those already seated stay, and the rest stay picked to try again |
| Change or remove them | Click them, or press Enter on them, to open their Edit dialog |

Seated in a room, a crew member takes their name as the alias, numbered when the room already has it (`@sol`, then `@sol2`), and always gets a new thread. Capitals make no difference to a name: a room with `@Alice` has `alice` taken, and there is one crew member per name whatever its capitals. Name fields drop spaces as you type or paste. The seated member is the room's own from then on: renaming it or changing its model does not touch the crew, and editing or removing someone from the crew does not touch members or threads made from them. A crew member who works in a new worktree works in the project folder where the project is not a git repository.

## The pixel look

**Settings → Look → Pixel** draws the same Backroom the way a SNES game would, and **Look → Plain** takes it back. Nothing moves and nothing is added or taken away: the page, the rooms, the composer, the dialogs and the menus work exactly as in the plain look, so whatever you can do in one you do the same way in the other.

- **Two palettes**, chosen under **Pixel** in the settings menu: **Slate**, the default, quiet slate by night (the dark theme) and ivory by day (the light theme); and **Blue**, Final Fantasy windows, blue in bands with a white frame on a night-blue ground by night, and paper with an ink frame on the day sky by day. **System** follows the device.
- **Windows drop a hard shadow**, the room you open slides in as a tall window, and the hovered or focused item in a menu is pointed at with the glove.
- **The crew are capybaras,** each wearing the look set for it under **Edit** (hat, fur, eyes, glasses, dark sunglasses among them, neckwear, outfit, accessory), the same in every room and every view; the pocket square, and the hat band and tie unless the look picks another colour, are the colour of the harness it runs on (Claude orange, Codex green, …). A member added by hand under a crew member's name wears that crew member's look. The Consigliere is marked by the star beside his name, not by his clothes.
- **Pixels stay square at any zoom:** the crew, the icons and the small glyphs are drawn as squares sized to a whole number of screen pixels each, so a face never gets one eye wider than the other. At the zooms where 16 does not divide evenly (90%, 110%, 125% and so on), they come out a little larger or smaller than designed instead.
- **Words stay sharp:** titles are set in a sign face, the chrome in monospace, and replies, names and money in the ordinary reading face, never in pixels.

# Messages and requests

## Writing messages

**The composer opens when you want it.** Under a room's conversation (and a thread's) there is one thin line: who a message goes to (the Consigliere, or whoever the text addresses), how many requests are open and how many members have posts they have not been given yet, and your unsent draft if there is one. Click it, press **Enter**, or just start typing anywhere outside a text field, and the composer opens over the lower middle of the conversation, in large type, with the text field focused: a dictation tool that types into the focused field works as it does anywhere. The conversation stays readable above it and scrolls with the mouse wheel, over the composer too. The field grows with the text and then scrolls inside. **Enter** sends and closes it; **Esc** closes it with the text kept, and so does a fresh press of **Backspace** in an empty field; holding Backspace to clear the text stops at the empty field and never closes the composer. When a room or thread opens, the line has the keyboard focus, so Enter is enough to start.

**Unsent text and images are kept**, one draft per room or thread, in this browser, as you type and attach. Leaving the conversation, closing the composer or reloading the page keeps them, and the composer reopens with them and the cursor at the end of the text; sending clears the draft, as do deleting the text and removing the images. A **draft** mark on the overview's tile says where you left something, images alone included. A room's images are uploaded as you attach them, so its draft keeps only their ids (the room stores them until it is deleted, sent or not); a thread's are kept in this browser's IndexedDB until sent or removed.

The text you type is the whole instruction. The buttons around the composer only edit that text. Above the field, one chip per member (plus **@all**) inserts `@name` at the cursor when clicked; chips the message already addresses are highlighted, and a dot marks anyone mid-turn. As you type, the composer highlights mentions and commands, then shows the **plan**: one row per assignment, with its recipients and instruction, and a fix for a directive that is gone (`/hold`, `/after`, `/steer`) or a wait the text implies.

| Key | Action |
| --- | --- |
| **Enter** | Send (however many lines the draft has) and close the composer; nothing when the field is empty. A message for someone mid-turn goes into that turn (see [below](#sending-while-someone-is-working)) |
| **Esc** | Close the composer, keeping the text (a menu in it closes first) |
| **Backspace** in an empty field | Close the composer (a fresh press; a held Backspace stops at the empty field) |
| **Shift+Enter** | New line |
| `@` | Mention autocomplete (members and `@all`) |
| **Backspace** right after a mention (**Delete** right before one) | Removes the whole `@name` at once; ⌘/Ctrl+Z brings it back. Partly typed or unknown names delete letter by letter |
| `/` | Command menu (room commands, and T3 commands after an `@name`; in a room with one member, its T3 commands at the start too) |

On a touch keyboard Enter is a new line and the **Send** button sends; the key hints under the field are not shown there.

### How a message becomes requests

No model reads your message. The composer and the server run the same fixed rules (`src/parser/explicit.ts`), and the plan under the field shows exactly what will happen before you send. There are three steps.

**1. Split into assignments.** An assignment is one or more recipients plus an instruction. Each recipient gets its own **request** on the room's board, numbered like every post (`#41`, `#42`, …), so `@claude @grok review the diff` is two requests with the same text. Text before the first address (for example "The build is red.") is context that every recipient's request carries. The rules for where one assignment ends and the next begins are under [How an @mention is read](#several-assignments-in-one-message).

**2. Nothing waits on other work.** Every assignment goes out **now**: into its recipient's running turn when it is working, as a turn of its own when it is idle. A message that would wait on other work is refused before it is sent, and the plan says how to go on. For a wait the text implies: send it once that work is done, have the Consigliere sequence it, or add `/now` to send it now; for `/after`: send it once that work is done, or have the Consigliere sequence it; for `/hold`: keep it as a draft and send it when it should start. That covers:

- `/after` and `/hold` at the start of an assignment, before or after its `@names` (later in the instruction they are plain text);
- **sequence words:** "then", "after that", "once that's done": `@claude build it, then @grok deploy it`;
- **naming an earlier recipient** in the instruction, with or without `@`, possessive or spoken: `@grok check claude's work`;
- **a condition**, before the address or after it: `when @grok finishes, @claude write the summary`, `@grok deploy it when claude finishes`;
- **pronouns:** "once she's done", "once they're finished", "when both are done", "when @all finished".

`/now` on an assignment takes away a wait its text implies; a condition on someone's work then stays in the instruction (`when @grok finishes, @claude /now write the summary` sends claude "when @grok finishes, write the summary" at once). A condition Backroom could not observe ("when the tests pass") is no wait: it stays in the instruction, and before the address the plan says so. In a room with a Consigliere a message that names members goes to him whole, so it implies no wait: sequencing the work is his job (see [The Consigliere](consigliere.md#the-consigliere)); `/after` and `/hold` are refused there too.

**3. Deliver.** A request goes to its member's thread straight away: into its running turn, or as a turn of its own. The member's final reply answers it: the reply says "answers #41", and the request's marker turns from **open** to **answered**. While it is open, **Correct…** under your message sends an amendment, which goes into the member's running turn the same way, and **Cancel** withdraws it (the member's running turn stops when it works on nothing else).

### Addressing

```
@claude review the diff                        one member
@claude @grok review the diff                  the same instruction for both (a request each)
@all review the release notes                  everyone in the room ("all" cannot be used as an alias)
Claude, review the parser                      the spoken form works at the start of a sentence
```

In a room with one member, a message that addresses nobody goes to that member: `review the diff` and `/compact` need no `@name`. A name that is not in the room is still an error.

### Several assignments in one message

```
@claude fix the login bug @grok update the docs
                                               two assignments, both start now
@claude fix the login bug. @grok check claude's work
                                               refused: grok's would wait for claude (the text names claude)
@claude build it, then @grok deploy it         refused: grok's would wait for claude ("then")
@claude build it. @grok /now read the notes    /now: grok's starts now; no wait is read into it
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
- **The plan row offers one-click fixes that rewrite the text.** "it's a reference" drops the `@`, "make it a new assignment" moves the mention onto a new line, and on a refused wait "Send it now" inserts `/now` and "Remove /hold" or "Remove /after" takes the directive out.

The rules don't understand negation: in "@claude fix it. @grok don't touch claude's files", the text names claude, whose assignment comes first, so grok's reads as a wait on it and is refused until you add `/now` (see [How a message becomes requests](#how-a-message-becomes-requests)). Unknown aliases leave the draft unresolved rather than guessed. No language model is involved: the rules are the whole interpreter.

### Directives and room commands

Type `/` at the start of the message to see these, each with a description:

```
/now @grok …                                   start now: no wait is read into the text
/add alice                                     seat a new member on a new thread (T3's default model)
/remove @alice                                 retire a member (asks what happens to its T3 thread)
```

Room notes are gone: everything goes through the Consigliere or the member you address, so a message that starts with `/note` is refused and nothing is sent. A board that already holds notes still shows them.

### Images

Paste, drop, or attach (**Image** under the composer) PNG, JPEG, GIF or WebP images (T3's limits: up to 10 MB each, 80 MB per message). Every assignment in the message receives them. A resend or retry delivers the same bytes. A message with images can have an empty instruction.

### Quoting and escaping

Text inside code blocks, `` `inline code` ``, or lines starting with `> ` is read literally: its @names and /commands address nobody. `\@name` escapes a single mention. When you paste several lines containing @names or /commands (a transcript, a log), the composer wraps them in a code block for you. Undo removes the wrapping.

## Sending while someone is working

A message to a member who is working goes into its running turn, as typing into Claude Code or Codex while it works does. There is nothing to choose: your messages in every room, a message to the Consigliere included, and the Consigliere's posts, corrections and retries to members all go in. To a member that is idle, a message starts a turn of its own. **Stop** and **Cancel** are what you use when a member is going the wrong way.

Backroom hands the message to T3, and the member's harness takes it. What each does, read from T3's source (0.0.46-nightly.20261010.2908):

| Harness | A message sent into a running turn |
|---|---|
| Claude | goes into the turn at once: whatever the agent was doing (writing, or a tool call such as a command it was running) is cut off, and it carries on with the message |
| Codex | goes into the turn (Codex's own mid-turn input) |
| Cursor (Grok), Antigravity (Gemini) | T3 stops the turn and starts it again with the message, in the same run |

When the turn has just ended, T3 runs the message as a turn of its own, and Backroom follows that turn as the member's answer to it. When T3 refuses it (the turn is starting, being stopped, or waiting on an approval), it starts the member's next turn instead. The message tells the member that it came into its running turn, that a tool call of its own may have been cut off (to check what it left running), and that its final reply for the turn answers it too.

What stays out of a running turn, and waits for it to end:

- a turn the room did not start: one typed in T3, or the member's own after its background work ended (Backroom has no run of its own there to put the message in);
- a keep-alive's turn, and a turn on Backroom's own request (a seat briefing, a reseat's checkpoint): short turns whose one-line reply would otherwise answer your message;
- a turn that **Stop** or a **Cancel** is ending: the message starts the next turn instead;
- while Backroom's own request waits for the member (or, on a board from before cancels went into running turns, a request with its cancel held to the turn's end): everything unread goes in together, so the rest waits with it;
- members' answers and follow-ups to the Consigliere, and Backroom's own requests: they reach him when his turn ends, each reply waking him once (they ride along when a message of yours goes in);
- a T3 command (`@bob /compact`), which a harness runs only as a message of its own.

A request that went into a running turn is answered by that turn's reply. The tag over a reply says what it did to the requests it was given: "answers #12 from you" for a request it answered (one reply can answer several: the one its turn was on and those that came in), "#12 stays open: input it had not seen came in" when a correction came in too late, as the turn ended (its next turn answers), "late for #12: it was cancelled". If a reply answers a request without covering it, say so again: it is answered, and only a new message reopens the work. The Consigliere's replies after his first answer to a message are **updates**, and a member's turn that answered nothing (one it started itself, or one typed in T3 Code) is a **follow-up** on its request. Your message's row says **into the turn** when it went into a running one.

`/steer` is gone: a message that has it is refused before it is sent, with a hint, since every message does what it did.

## T3 slash commands

T3 publishes each provider's slash commands and, apart from them, its skills. Claude exposes dozens of commands (`/compact`, `/autocompact`, its skills, …). Codex has `/compact` and `/feedback` and lists its system and plugin skills apart, and Cursor has `/compact`. Grok and OpenCode currently expose none.

- **Browse:** type `@claude /` to list the room directives plus what claude has, grouped as [Skills](agents-file-and-skills.md#skills)' roster (harness commands, skills, pack skills), each labelled with its group and "@claude", with your line or the author's and the argument hint. Typing narrows the list. With several recipients (or `@all`), only what they all have is listed. In a room with one member, `/` at the start of the message lists its commands too, and `/compact` needs no `@name`. Picking a skill writes `using the <name> skill`, not a slash command: the rest of this section is about commands.
- **Send:** `@claude /compact focus on the parser` is sent to claude's thread exactly as typed, with no room briefing around it, because a harness only runs a slash command when it is the first thing in the message. The plan row marks it **T3 command**.
- **Unknown commands are blocked.** The plan and the server both refuse a command the recipient's provider doesn't have.
- **Limits:** a T3 command never goes into a running turn (a harness runs one only as a message of its own): to a member who is working it runs after the current turn. It doesn't count as the member having seen the room: it is recorded as a note. After `/compact`, as after any compaction, the member's next briefing carries the standing part again.

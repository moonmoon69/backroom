import {
  Fragment,
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { attachmentUrl } from "../api.ts";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, taskLabel, type Desk, type Participant, type RoomEvent, type Task } from "../types.ts";
import { LiveFeed } from "./LiveFeed.tsx";
import { Markdown } from "./Markdown.tsx";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { TaskCard } from "./TaskCard.tsx";

const time = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const fullTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

const dayKey = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

const DIRECT_TITLE = "Started directly in T3 Code. Not shared with other participants and never satisfies a room prerequisite.";

type ChatMessage = Omit<RoomEvent, "kind"> & { kind: MessageKind };
/** "t3.prompt" is not a room event: it is the prompt of a t3.turn, shown on the user's side like a room message.
 * "t3.message" is: a note the user typed in T3 into a turn the room started, shown the same way. */
type MessageKind = "user.message" | "note" | "assistant.reply" | "t3.turn" | "t3.prompt" | "t3.message";
const isMessage = (event: RoomEvent): boolean =>
  event.kind === "user.message" || event.kind === "note" || event.kind === "assistant.reply" || event.kind === "t3.turn" || event.kind === "t3.message";

/** Messages from the same speaker within this gap (and with nothing in between) share one header. */
const GROUP_GAP_MS = 10 * 60 * 1000;

type TimelineItem =
  | { type: "day"; key: string; label: string }
  | { type: "message"; event: ChatMessage; previous: RoomEvent | ChatMessage | null }
  | { type: "status-run"; events: RoomEvent[] }
  | { type: "system"; event: RoomEvent };

const speakerKey = (event: RoomEvent | ChatMessage): string => {
  if (event.kind === "user.message" || event.kind === "t3.message" || (event.kind as string) === "t3.prompt") return "user";
  if (event.kind === "note") return "note";
  return event.speaker.type === "participant" ? `p:${event.speaker.participantId}` : "other";
};

/**
 * Chat items: day separators (only when the room spans more than one day), messages (with the previous message
 * when it continues the same speaker's group), runs of consecutive task.status events, and system lines.
 */
function buildItems(events: RoomEvent[], taskIds: ReadonlySet<string>): TimelineItem[] {
  const items: TimelineItem[] = [];
  const spansDays = events.length > 0 && dayKey(events[0]!.createdAt) !== dayKey(events[events.length - 1]!.createdAt);
  let lastDay: string | null = null;
  let previous: RoomEvent | ChatMessage | null = null;
  for (const event of events) {
    // A task's progress shows on its row under the message; its status events stay out of the chat (Tasks and
    // Inspect delivery keep the full record).
    if (event.kind === "task.status" && event.taskId && taskIds.has(event.taskId)) continue;
    const day = dayKey(event.createdAt);
    if (spansDays && day && day !== lastDay) {
      items.push({ type: "day", key: `day-${day}`, label: dayLabel(event.createdAt) });
      previous = null;
    }
    if (day) lastDay = day;
    if (isMessage(event)) {
      // A turn typed directly in T3 reads like a room exchange: its prompt as the user's bubble, then the reply.
      if (event.kind === "t3.turn" && event.prompt) {
        const prompt = { ...event, id: `${event.id}:prompt`, kind: "t3.prompt", text: event.prompt, speaker: { type: "user" }, progress: [], artifacts: [] } as unknown as ChatMessage;
        const promptContinues = previous !== null && speakerKey(previous) === "user" && new Date(event.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_GAP_MS;
        items.push({ type: "message", event: prompt, previous: promptContinues ? previous : null });
        previous = prompt;
      }
      const continues =
        previous !== null &&
        speakerKey(previous) === speakerKey(event) &&
        new Date(event.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_GAP_MS;
      items.push({ type: "message", event: event as ChatMessage, previous: continues ? previous : null });
      previous = event;
      continue;
    }
    previous = null;
    const last = items[items.length - 1];
    if (event.kind === "task.status") {
      if (last && last.type === "status-run") last.events.push(event);
      else items.push({ type: "status-run", events: [event] });
      continue;
    }
    items.push({ type: "system", event });
  }
  return items;
}

/** Latest status event per distinct task in a run, ordered by each task's first appearance. */
function latestPerTask(events: RoomEvent[]): RoomEvent[] {
  const order: string[] = [];
  const latest = new Map<string, RoomEvent>();
  for (const event of events) {
    const key = event.taskId ?? event.id;
    if (!latest.has(key)) order.push(key);
    latest.set(key, event);
  }
  return order.map((key) => latest.get(key) as RoomEvent);
}

/** Lets a message stop the timeline from following the bottom (expanding a long reply must not jump the view). */
const ScrollControl = createContext<{ release: () => void }>({ release: () => {} });

/** Distance from the bottom (px) under which the timeline keeps following new content. */
const STICK_PX = 40;
/** Distance from the bottom (px) beyond which "Jump to latest" appears. */
const JUMP_PX = 240;

export function Timeline() {
  const { snapshot, desk } = useRoom();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [far, setFar] = useState(false);
  const [seenSequence, setSeenSequence] = useState(0);

  const tasksByEvent = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of snapshot.tasks) {
      const list = map.get(task.sourceEventId) ?? [];
      list.push(task);
      map.set(task.sourceEventId, list);
    }
    return map;
  }, [snapshot.tasks]);
  const taskById = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);
  const items = useMemo(() => buildItems(snapshot.events, new Set(taskById.keys())), [snapshot.events, taskById]);
  const taskFor = useCallback((id: string | null) => (id ? taskById.get(id) : undefined), [taskById]);

  // Turns typed directly in T3 that are still running: shown live at the bottom until the server imports them.
  const liveTurns = useMemo(() => {
    if (!desk) return [];
    const imported = new Set(snapshot.events.filter((e) => e.kind === "t3.turn" && e.sourceRef?.turnId).map((e) => e.sourceRef?.turnId));
    return snapshot.participants
      .filter(isActiveParticipant)
      .map((participant) => ({ participant, desk: desk.participants[participant.id] }))
      .filter(
        (entry): entry is { participant: Participant; desk: Desk } =>
          Boolean(entry.desk?.runningTurn) && !entry.desk?.runningTurn?.startedByRoom && !imported.has(entry.desk?.runningTurn?.turnId),
      );
  }, [desk, snapshot.events, snapshot.participants]);

  // Room tasks being worked on: the reply builds up as the participant's bubble at the bottom, like a chat. Tasks sent
  // into the same running turn (steering) share one bubble.
  const liveTasks = useMemo(() => {
    const byParticipant = new Map<string, Task[]>();
    for (const task of snapshot.tasks) {
      if (task.state !== "dispatching" && task.state !== "running" && task.state !== "needs_input") continue;
      byParticipant.set(task.participantId, [...(byParticipant.get(task.participantId) ?? []), task]);
    }
    return [...byParticipant.entries()]
      .map(([participantId, tasks]) => ({ tasks, participant: snapshot.participants.find((p) => p.id === participantId), desk: desk?.participants[participantId] }))
      .filter((entry): entry is { tasks: Task[]; participant: Participant; desk: Desk | undefined } => Boolean(entry.participant));
  }, [snapshot.tasks, snapshot.participants, desk]);

  const lastSequence = snapshot.events[snapshot.events.length - 1]?.sequence ?? 0;
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // A different room starts at the bottom.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setFar(false);
    scrollToBottom();
  }, [snapshot.room.id, scrollToBottom]);

  useLayoutEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [lastSequence, snapshot.tasks, liveTurns, liveTasks, scrollToBottom]);

  // Content that grows after render (images, live feeds, task live sections) keeps the bottom in view.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useEffect(() => {
    if (!far) setSeenSequence(lastSequence);
  }, [far, lastSequence]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < STICK_PX;
    const isFar = distance > JUMP_PX;
    if (isFar !== far) setFar(isFar);
  };

  const unseen = far ? snapshot.events.filter((e) => e.sequence > seenSequence && (e.kind === "assistant.reply" || e.kind === "t3.turn")).length : 0;
  const scrollControl = useMemo(() => ({ release: () => (stickToBottom.current = false) }), []);
  const noCrew = !snapshot.participants.some(isActiveParticipant);

  return (
    <ScrollControl.Provider value={scrollControl}>
      <div className="timeline-wrap">
        <div className="timeline" ref={scroller} onScroll={onScroll} aria-label="Timeline" role="log">
          <div className="timeline-content" ref={content}>
            {snapshot.events.length === 0 || noCrew ? (
              <div className="timeline-empty">
                <p className="serif">
                  {noCrew
                    ? "No crew seated yet; open People (the two-person icon above) to add a participant, then hand out work orders here."
                    : "The transcript is empty; address the crew to open the first work order."}
                </p>
                <pre className="worked-example mono">
                  {"@sol1 investigate the parser. @sol2 review what sol1 finds\n@sol1 @sol2 independently check the tests\n/after task1, task2 @claude compare their findings"}
                </pre>
                <p className="muted">Each line is one message. Direct controls do the same thing without the syntax.</p>
              </div>
            ) : null}
            {items.map((item) => {
              if (item.type === "day") {
                return (
                  <div key={item.key} className="chat-day" role="separator">
                    <span>{item.label}</span>
                  </div>
                );
              }
              if (item.type === "status-run") {
                const latest = item.events[item.events.length - 1] as RoomEvent;
                if (item.events.length === 1) return <StatusLine key={latest.id} event={latest} task={taskFor(latest.taskId)} />;
                return <StatusRun key={latest.id} events={item.events} taskFor={taskFor} />;
              }
              if (item.type === "system") return <SystemLine key={item.event.id} event={item.event} />;
              return (
                <MessageRow
                  key={item.event.id}
                  event={item.event}
                  previous={item.previous}
                  tasks={tasksByEvent.get(item.event.id) ?? []}
                  taskFor={taskFor}
                />
              );
            })}
            {liveTurns.map(({ participant, desk: participantDesk }) => (
              <Fragment key={participantDesk.runningTurn?.turnId ?? participant.id}>
                {participantDesk.runningTurn?.prompt ? (
                  <MessageRow event={livePromptMessage(participantDesk.runningTurn.turnId, participantDesk.runningTurn.prompt)} previous={null} tasks={[]} taskFor={taskFor} />
                ) : null}
                <LiveTurnBubble participant={participant} desk={participantDesk} />
              </Fragment>
            ))}
            {liveTasks.map(({ tasks, participant, desk: participantDesk }) => (
              <LiveTurnBubble key={participant.id} participant={participant} desk={participantDesk} tasks={tasks} />
            ))}
          </div>
        </div>
        {far ? (
          <button
            type="button"
            className={`jump-latest mono${unseen > 0 ? " has-new" : ""}`}
            onClick={() => {
              stickToBottom.current = true;
              scrollToBottom(true);
            }}
          >
            {unseen > 0 ? `${unseen} new repl${unseen === 1 ? "y" : "ies"}` : "Jump to latest"} <span aria-hidden="true">↓</span>
          </button>
        ) : null}
      </div>
    </ScrollControl.Provider>
  );
}

/** One compact, centred task.status line; `extra` renders trailing controls (the collapse toggle). */
function StatusLine({ event, task, extra }: { event: RoomEvent; task: Task | undefined; extra?: ReactNode }) {
  const label = task ? taskLabel(task) : null;
  return (
    <div className="chat-status mono" title={`room event #${event.sequence} · ${fullTime(event.createdAt)}`} data-sequence={event.sequence}>
      <span className="time">{time(event.createdAt)}</span>
      {label && !event.text.includes(label) ? <span className="tag mono">{label}</span> : null}
      <span className="status-text">{event.text}</span>
      {extra}
    </div>
  );
}

/**
 * A run of consecutive status events: one visible line with the latest status per task
 * ("task7 started on @sol1 · task8 started on @sol2"), the whole run behind a "+N earlier" toggle.
 */
function StatusRun({ events, taskFor }: { events: RoomEvent[]; taskFor: (id: string | null) => Task | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const latest = events[events.length - 1] as RoomEvent;
  const segments = latestPerTask(events);
  const earlier = events.length - 1;
  const tasks = segments.map((e) => taskFor(e.taskId)).filter((t): t is Task => Boolean(t));
  const label = tasks.length > 0 ? tasks.map(taskLabel).join(", ") : "task";
  const toggle = (
    <button
      type="button"
      className="status-toggle mono"
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? "Collapse earlier status updates" : `Show ${earlier} earlier status update${earlier === 1 ? "" : "s"}`}
    >
      {expanded ? "collapse" : `+${earlier} earlier`}
    </button>
  );
  return (
    <div className="status-run" role="group" aria-label={`${label} status updates`}>
      {expanded ? events.slice(0, -1).map((event) => <StatusLine key={event.id} event={event} task={taskFor(event.taskId)} />) : null}
      {segments.length === 1 ? (
        <StatusLine event={latest} task={taskFor(latest.taskId)} extra={toggle} />
      ) : (
        <div className="chat-status mono multi" title={`room events #${events[0]?.sequence}–#${latest.sequence}`} data-sequence={latest.sequence}>
          <span className="time">{time(latest.createdAt)}</span>
          <span className="status-text status-segments">
            {segments.map((event, index) => (
              <span key={event.id} className="status-segment">
                {index > 0 ? <span className="dep-sep"> · </span> : null}
                {event.text}
              </span>
            ))}
          </span>
          {toggle}
        </div>
      )}
    </div>
  );
}

function SystemLine({ event }: { event: RoomEvent }) {
  return (
    <div className="chat-status chat-system" title={`room event #${event.sequence} · ${fullTime(event.createdAt)}`} data-sequence={event.sequence}>
      <span className="time mono">{time(event.createdAt)}</span>
      <span className="status-text">{event.text}</span>
    </div>
  );
}

/** Images attached to a user message; each opens full size in a new tab. */
function AttachedImages({ ids }: { ids: string[] }) {
  return (
    <div className="event-images">
      {ids.map((id) => (
        <a key={id} href={attachmentUrl(id)} target="_blank" rel="noreferrer" title="Open full size">
          <img src={attachmentUrl(id)} alt="Attached image" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

/** The participant's earlier messages in the turn (progress notes between tool calls), collapsed by default. */
function ProgressUpdates({ progress }: { progress: Array<{ text: string; at: string }> }) {
  return (
    <details className="reply-progress">
      <summary className="mono">
        {progress.length} progress update{progress.length === 1 ? "" : "s"}
      </summary>
      <ol>
        {progress.map((note, index) => (
          <li key={index}>
            <span className="time mono">{time(note.at)}</span>
            <Markdown text={note.text} className="md-small" />
          </li>
        ))}
      </ol>
    </details>
  );
}



/** User text as typed: line breaks kept, @mentions of crew members tinted in their colour. */
function UserText({ text }: { text: string }) {
  const { snapshot, colorOf } = useRoom();
  const byAlias = useMemo(() => new Map(snapshot.participants.map((p) => [p.alias.toLowerCase(), p])), [snapshot.participants]);
  const parts: ReactNode[] = [];
  const pattern = /(^|[^\w@])@([A-Za-z0-9][\w-]*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const participant = byAlias.get((match[2] ?? "").toLowerCase());
    if (!participant) continue;
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    const end = start + 1 + (match[2] ?? "").length;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <span key={start} className="mention identity" style={identityStyle(colorOf(participant.id))}>
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <div className="user-text">{parts}</div>;
}

const isLongReply = (text: string): boolean => text.length > 600 || /^\s*\|.*\|\s*$/m.test(text) || text.includes("```");

function MessageRow({
  event,
  previous,
  tasks,
  taskFor,
}: {
  event: ChatMessage;
  previous: RoomEvent | ChatMessage | null;
  tasks: Task[];
  taskFor: (id: string | null) => Task | undefined;
}) {
  const { aliasOf, colorOf, participantById, snapshot } = useRoom();
  const events = snapshot.events;
  const continued = previous !== null;
  const seqTitle = `room event #${event.sequence} · ${fullTime(event.createdAt)}`;
  const stamp = (
    <span className="time mono" title={seqTitle}>
      {time(event.createdAt)}
    </span>
  );
  // A bubble grouped under the one above shows its own time on a small line of its own, unless it came in the same
  // minute (a burst stays compact).
  const newMinute = continued && time(previous.createdAt) !== time(event.createdAt);

  if (event.kind === "user.message" || event.kind === "note" || event.kind === "t3.prompt" || event.kind === "t3.message") {
    const note = event.kind === "note";
    const fromT3 = event.kind === "t3.prompt" || event.kind === "t3.message";
    const attachments = event.attachmentIds ?? [];
    return (
      <div className={`chat-row from-user${note ? " is-note" : ""}${continued ? " continued" : ""}`} data-sequence={event.sequence}>
        <div className="chat-stack">
          {!continued ? (
            <div className="chat-head">
              <span className="you-mark mono">{note ? "note" : "you"}</span>
              {fromT3 ? (
                <span
                  className="tag mono direct-tag"
                  title={
                    event.kind === "t3.message"
                      ? "Typed in T3 Code into this participant's running turn. Not shared with other participants."
                      : "Typed directly in T3 Code on this participant's thread. Not shared with other participants."
                  }
                >
                  in T3
                </span>
              ) : (
                stamp
              )}
            </div>
          ) : newMinute ? (
            <div className="chat-head sub">{stamp}</div>
          ) : null}
          <div className={`bubble ${note ? "bubble-note" : "bubble-user"}${fromT3 ? " bubble-user-t3" : ""}`}>
            {event.text ? <UserText text={event.text} /> : null}
            {attachments.length > 0 ? <AttachedImages ids={attachments} /> : null}
          </div>
          {tasks.length > 0 ? (
            <div className="chat-tasks">
              {tasks.map((t) => (
                <TaskCard key={t.id} task={t} variant="chip" showInstruction={new Set(tasks.map((x) => x.instruction)).size > 1} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // assistant.reply (answer to a room task) or t3.turn (a turn typed directly in T3 on this participant's thread;
  // shown for awareness only: never forwarded to other participants or counted toward a prerequisite).
  const direct = event.kind === "t3.turn";
  const participantId = event.speaker.type === "participant" ? event.speaker.participantId : null;
  const participant = participantId ? participantById(participantId) : undefined;
  const alias = participantId ? aliasOf(participantId) : "assistant";
  const color = participantId ? colorOf(participantId) : "var(--fg-muted)";
  const task = taskFor(event.taskId);
  const source = task ? events.find((e) => e.id === task.sourceEventId) : undefined;
  // Every task this reply answers: several when messages were sent into the same running turn (steering).
  const answered = snapshot.tasks.filter((t) => snapshot.runs.some((r) => r.taskId === t.id && r.resultEventId === event.id));
  const tag = direct ? (
    <span className="tag mono direct-tag" title={DIRECT_TITLE}>
      in T3
    </span>
  ) : task && source ? (
    <ReplyTo tasks={answered.length > 0 ? answered : [task]} />
  ) : null;
  // A continued bubble repeats the tag only when it answers something else than the bubble above.
  const tagChanged = continued && (previous.kind !== event.kind || previous.taskId !== event.taskId);
  // A turn the agent started itself (no prompt: background work finished and woke it). Its last message is a real
  // final answer, so it keeps its own bubble; the marker says nobody asked for it.
  const selfStarted = direct && !event.prompt;
  const selfMark = selfStarted ? (
    <span className="self-started mono" title="The agent continued on its own (background work finished and woke it); no new prompt">
      ↻ continued on its own
    </span>
  ) : null;

  return (
    <div
      className={`chat-row from-agent${continued ? " continued" : ""}${isLongReply(event.text) ? " wide" : ""}`}
      style={identityStyle(color)}
      data-sequence={event.sequence}
    >
      <div className="chat-stack">
        {!continued ? (
          <div className="chat-head">
            {participant ? <Monogram participant={participant} size="xs" /> : null}
            <span className="speaker mono identity">{alias}</span>
            {tag}
            {selfMark}
            {stamp}
          </div>
        ) : selfMark || (tagChanged && tag) || newMinute ? (
          <div className="chat-head sub">
            {selfMark ?? (tagChanged ? tag : null)}
            {stamp}
          </div>
        ) : null}
        <div className="bubble bubble-agent">
          {(event.progress ?? []).length > 0 ? <ProgressUpdates progress={event.progress} /> : null}
          {/* The reply is shown in full: it is what the user came to read. */}
          {event.text ? <Markdown text={event.text} /> : null}
          {event.artifacts.length > 0 ? <ChangedFiles artifacts={event.artifacts} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A turn someone is typing directly in T3 on a participant's thread, still running: shown live at the bottom
 * (prompt, messages, tool bursts). When it finishes the server imports it as a t3.turn event and this goes away.
 */
function LiveTurnBubble({ participant, desk, tasks = [] }: { participant: Participant; desk: Desk | undefined; tasks?: Task[] }) {
  const { colorOf } = useRoom();
  const task = tasks[0];
  // A room task's bubble only shows the feed once T3 reports the task's own turn (not an earlier or direct one).
  const feedIsOurs = !task || (desk?.runningTurn?.startedByRoom ?? false);
  const items = feedIsOurs ? desk?.liveFeed ?? [] : [];
  const needsYou = task?.state === "needs_input";
  return (
    <div className="chat-row from-agent live-turn wide" style={identityStyle(colorOf(participant.id))} aria-live="off">
      <div className="chat-stack">
        <div className="chat-head">
          <Monogram participant={participant} size="xs" />
          <span className="speaker mono identity">{participant.alias}</span>
          {task ? (
            <ReplyTo tasks={tasks} />
          ) : (
            <span className="tag mono direct-tag" title={DIRECT_TITLE}>
              in T3
            </span>
          )}
          <span className="live-working mono">
            <span className="dot dot-working" aria-hidden="true" /> {needsYou ? "needs you" : task?.state === "dispatching" ? "starting" : "working"}
          </span>
        </div>
        <div className={`bubble bubble-agent bubble-live${task ? "" : " bubble-direct"}`} aria-label={`${participant.alias} is working`}>
          {needsYou ? <div className="status-error">Waiting for your approval or answer: see Tasks, or respond in T3.</div> : null}
          <LiveFeed items={items} placeholder={task?.state === "dispatching" ? "Sending to T3…" : "Thinking…"} className="live-feed-chat" />
        </div>
      </div>
    </div>
  );
}


/** Scroll a message into view and flash it (used by "↩ your … message" on replies). */
function revealEvent(sequence: number): void {
  const element = document.querySelector<HTMLElement>(`.timeline [data-sequence="${sequence}"]`);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.remove("flash");
  void element.offsetWidth;
  element.classList.add("flash");
}

/**
 * "↩ your 3:49 PM message", or "↩ your 3:49 and 3:50 PM messages" when one turn answered several messages
 * (the later ones were sent into the running turn). Each time scrolls to its message.
 */
function ReplyTo({ tasks }: { tasks: Task[] }) {
  const { snapshot } = useRoom();
  const sources = [...new Map(tasks.map((t) => [t.sourceEventId, snapshot.events.find((e) => e.id === t.sourceEventId)])).values()]
    .filter((e): e is RoomEvent => Boolean(e))
    .sort((a, b) => a.sequence - b.sequence);
  if (sources.length === 0) return null;
  const labels = tasks.map((t) => taskLabel(t)).join(", ");
  return (
    <span className="reply-to mono" title={`Reply to ${sources.length === 1 ? "your message" : "your messages"} (${labels}); click a time to show it`}>
      ↩ your{" "}
      {sources.map((source, index) => (
        <span key={source.id}>
          {index > 0 ? (index === sources.length - 1 ? " and " : ", ") : null}
          <button type="button" className="reply-to-time" onClick={() => revealEvent(source.sequence)}>
            {time(source.createdAt)}
          </button>
        </span>
      ))}{" "}
      {sources.length === 1 ? "message" : "messages"}
    </span>
  );
}

/** The files a turn changed, folded to one line ("3 files changed · +19 −8"); open it for the list. */
function ChangedFiles({ artifacts }: { artifacts: RoomEvent["artifacts"] }) {
  const files = artifacts.filter((artifact) => artifact.path);
  const additions = artifacts.reduce((sum, artifact) => sum + (artifact.additions ?? 0), 0);
  const deletions = artifacts.reduce((sum, artifact) => sum + (artifact.deletions ?? 0), 0);
  return (
    <details className="changed-files">
      <summary className="mono">
        {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`}
        {additions > 0 ? <span className="add"> +{additions}</span> : null}
        {deletions > 0 ? <span className="del"> −{deletions}</span> : null}
      </summary>
      <ul className="artifacts mono">
        {artifacts.map((artifact, index) => (
          <li key={index}>
            {artifact.kind ? <span className="artifact-kind">{artifact.kind}</span> : null}
            {artifact.path ? <code>{artifact.path}</code> : null}
            {artifact.branch ? <span className="muted"> {artifact.branch}</span> : null}
            {artifact.commit ? <code className="muted"> {artifact.commit.slice(0, 8)}</code> : null}
            {typeof artifact.additions === "number" ? <span className="add"> +{artifact.additions}</span> : null}
            {typeof artifact.deletions === "number" ? <span className="del"> −{artifact.deletions}</span> : null}
            {artifact.note ? <span className="muted"> {artifact.note}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The prompt of a turn running directly in T3, shown on the user's side while the reply builds up. */
function livePromptMessage(turnId: string, prompt: string): ChatMessage {
  return {
    id: `live-prompt:${turnId}`,
    roomId: "",
    sequence: -1,
    kind: "t3.prompt",
    speaker: { type: "user" },
    text: prompt,
    taskId: null,
    runId: null,
    artifacts: [],
    attachmentIds: [],
    progress: [],
    prompt: null,
    sourceRef: null,
    createdAt: new Date().toISOString(),
  };
}

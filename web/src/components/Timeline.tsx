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
import { isActiveParticipant, isWorkspaceArtifact, taskLabel, type Desk, type Participant, type RoomEvent, type RoomSnapshot, type Task, type ThreadCost } from "../types.ts";
import { replyPieces, replySources, replyTitle } from "../replyTo.ts";
import { BranchIcon, Glyph } from "./icons.tsx";
import { CopyTextButton } from "./CopyText.tsx";
import { FileBaseContext, useOpenImagePreview } from "./filePreviewContext.ts";
import { withoutT3ContextRefs } from "../t3Context.ts";
import { LiveFeed } from "./LiveFeed.tsx";
import { Markdown } from "./Markdown.tsx";
import { ApprovalRequestCard, UserInputRequestCard } from "./NativeRequests.tsx";
import { fmtTokens, money } from "./deskFormat.ts";
import { speakableSummary, useAutoRead } from "../speech.ts";
import { SpeakButton, useAnnounceNew } from "./SpeakButton.tsx";
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

const DIRECT_TITLE = "Started directly in T3 Code. Not shared with other members and never satisfies a room prerequisite.";

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
  /** A turn one member's agent asked of another: what was sent into it (in order), and its answer once it ended. */
  | { type: "turn"; messages: RoomEvent[]; answer: RoomEvent | null }
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
/** The T3 run a board post belongs to, on its thread: what a member's messages and their answer share. */
const turnKey = (event: RoomEvent): string => `${event.sourceRef?.threadId ?? ""}:${event.sourceRef?.t3RunId ?? event.id}`;

function buildItems(events: RoomEvent[], taskIds: ReadonlySet<string>, tasksByEvent: ReadonlyMap<string, Task[]> = new Map()): TimelineItem[] {
  const items: TimelineItem[] = [];
  // Turns between members are one row each: every message sent into the turn, with the answer underneath.
  const sentInto = new Map<string, RoomEvent[]>();
  for (const event of events) if (event.kind === "member.message") sentInto.set(turnKey(event), [...(sentInto.get(turnKey(event)) ?? []), event]);
  const answers = new Map<string, RoomEvent>();
  for (const event of events) if (event.kind === "t3.turn" && sentInto.has(turnKey(event))) answers.set(turnKey(event), event);
  // A board post (a member's message with no T3 source) is answered by the reply to the task it made.
  const postOfTask = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "member.message" || event.sourceRef !== null) continue;
    for (const task of tasksByEvent.get(event.id) ?? []) if (task.kind !== "wake") postOfTask.set(task.id, event.id);
  }
  const postAnswers = new Map<string, RoomEvent>();
  for (const event of events) {
    const post = event.kind === "assistant.reply" && event.taskId ? postOfTask.get(event.taskId) : undefined;
    if (post) postAnswers.set(post, event);
  }
  const shownAnswers = new Set([...postAnswers.values()].map((event) => event.id));
  const shownTurns = new Set<string>();
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
    if (event.kind === "member.message") {
      const key = turnKey(event);
      if (!shownTurns.has(key)) {
        shownTurns.add(key);
        items.push({ type: "turn", messages: sentInto.get(key) ?? [event], answer: answers.get(key) ?? postAnswers.get(event.id) ?? null });
        previous = null;
      }
      continue;
    }
    // An answer already under its turn's row.
    if (event.kind === "t3.turn" && answers.get(turnKey(event)) === event) continue;
    if (event.kind === "assistant.reply" && shownAnswers.has(event.id)) continue;
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

/**
 * The user's conversation with the room's Consigliere, as a view of the board: the messages addressed to him and his
 * replies to them. Nothing is stored for the chat alone; every message in it is a post on the board.
 */
function consigliereChat(snapshot: RoomSnapshot): RoomEvent[] {
  const him = snapshot.room.consigliereId;
  const tasks = snapshot.tasks.filter((task) => task.participantId === him && task.kind !== "seat");
  const asked = new Set(tasks.map((task) => task.sourceEventId));
  const taskIds = new Set(tasks.map((task) => task.id));
  // A turn of his that no member asked for (he woke himself when a watch tripped, or typed in T3) is a note to the user.
  const askedByMember = new Set(snapshot.events.filter((e) => e.kind === "member.message" && e.to === him).map(turnKey));
  return snapshot.events.filter(
    (event) =>
      (event.kind === "user.message" && asked.has(event.id)) ||
      (event.kind === "assistant.reply" && event.speaker.type === "participant" && event.speaker.participantId === him) ||
      (event.kind === "t3.turn" && event.speaker.type === "participant" && event.speaker.participantId === him && !askedByMember.has(turnKey(event))) ||
      (event.kind === "t3.message" && event.taskId !== null && taskIds.has(event.taskId)),
  );
}

/**
 * The room's posts, oldest first. "board" (the default) is every post; "chat" is the conversation with the room's
 * Consigliere (see consigliereChat). A room without a Consigliere shows the board alone.
 */
export function Timeline({ view = "board", limit = 0 }: { view?: "board" | "chat"; limit?: number } = {}) {
  const { snapshot, desk, aliasOf } = useRoom();
  const chat = view === "chat";
  const consigliereId = snapshot.room.consigliereId;
  const events = useMemo(() => (chat ? consigliereChat(snapshot) : snapshot.events), [chat, snapshot]);
  // Read aloud, when the room's menu says so: each new reply (its Handoff, or its opening), and each new request
  // for approval or an answer, named by who it is from.
  const [autoRead] = useAutoRead(`room:${snapshot.room.id}`);
  useAnnounceNew(
    `room:${snapshot.room.id}`,
    autoRead && !chat,
    snapshot.events
      .filter((event) => event.kind === "assistant.reply" && event.speaker.type === "participant" && event.text.trim().length > 0)
      .map((event) => ({ id: event.id, text: `${event.speaker.type === "participant" ? aliasOf(event.speaker.participantId) : "reply"}. ${speakableSummary(event.text)}` })),
  );
  useAnnounceNew(
    `room:${snapshot.room.id}:requests`,
    autoRead && !chat,
    snapshot.nativeRequests.map((request) => ({ id: request.requestId, text: `${aliasOf(request.participantId)} ${request.kind === "approval" ? "needs your approval." : "has a question for you."}` })),
  );
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
  const allItems = useMemo(() => buildItems(events, new Set(taskById.keys()), tasksByEvent), [events, taskById, tasksByEvent]);
  // With a limit, only the latest posts are drawn at first (a long board opens at once); "earlier" draws the next
  // window above, keeping what is in view where it is.
  const [shown, setShown] = useState(limit);
  useEffect(() => setShown(limit), [limit, snapshot.room.id]);
  const items = limit > 0 && allItems.length > shown ? allItems.slice(allItems.length - shown) : allItems;
  const earlier = allItems.length - items.length;
  const keepPlace = useRef<{ height: number; top: number } | null>(null);
  const showEarlier = () => {
    const el = scroller.current;
    if (el) keepPlace.current = { height: el.scrollHeight, top: el.scrollTop };
    setShown((n) => n + limit);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const place = keepPlace.current;
    if (!el || !place) return;
    keepPlace.current = null;
    el.scrollTop = place.top + (el.scrollHeight - place.height);
  }, [shown]);
  // Replies say which branch they were made on once the room's replies come from more than one branch.
  const showBranches = useMemo(
    () => new Set(snapshot.events.flatMap((e) => (e.kind === "assistant.reply" ? e.artifacts.filter(isWorkspaceArtifact).map((a) => a.branch ?? "") : []))).size > 1,
    [snapshot.events],
  );
  const taskFor = useCallback((id: string | null) => (id ? taskById.get(id) : undefined), [taskById]);

  // Turns typed directly in T3 that are still running: shown live at the bottom until the server imports them.
  const liveTurns = useMemo(() => {
    // The chat is the user's conversation; a turn someone else started is the board's.
    if (!desk || chat) return [];
    const imported = new Set(snapshot.events.filter((e) => e.kind === "t3.turn" && e.sourceRef?.t3RunId).map((e) => e.sourceRef?.t3RunId));
    return snapshot.participants
      .filter(isActiveParticipant)
      .map((participant) => ({ participant, desk: desk.participants[participant.id] }))
      .filter(
        (entry): entry is { participant: Participant; desk: Desk } =>
          Boolean(entry.desk?.runningRun) && !entry.desk?.runningRun?.startedByRoom && !imported.has(entry.desk?.runningRun?.runId),
      );
  }, [desk, chat, snapshot.events, snapshot.participants]);

  // Room tasks being worked on: the reply builds up as the participant's bubble at the bottom, like a chat. Tasks sent
  // into the same running turn (steering) share one bubble.
  const liveTasks = useMemo(() => {
    const byParticipant = new Map<string, Task[]>();
    for (const task of snapshot.tasks) {
      if (task.state !== "dispatching" && task.state !== "running" && task.state !== "needs_input") continue;
      if (chat && task.participantId !== consigliereId) continue;
      byParticipant.set(task.participantId, [...(byParticipant.get(task.participantId) ?? []), task]);
    }
    return [...byParticipant.entries()]
      .map(([participantId, tasks]) => ({ tasks, participant: snapshot.participants.find((p) => p.id === participantId), desk: desk?.participants[participantId] }))
      .filter((entry): entry is { tasks: Task[]; participant: Participant; desk: Desk | undefined } => Boolean(entry.participant));
  }, [snapshot.tasks, snapshot.participants, desk, chat, consigliereId]);

  const lastSequence = events[events.length - 1]?.sequence ?? 0;
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

  // A panel that was put away (the board hidden, the chat or board switched on a narrow screen) comes back at the
  // top, because a hidden element loses its scroll position: show it at the latest again. A width change (the other
  // panel hidden or shown) keeps the bottom in view when it was in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const shown = height === 0 && el.clientHeight > 0;
      height = el.clientHeight;
      if (shown) {
        stickToBottom.current = true;
        setFar(false);
      }
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

  const unseen = far ? events.filter((e) => e.sequence > seenSequence && (e.kind === "assistant.reply" || e.kind === "t3.turn")).length : 0;
  const scrollControl = useMemo(() => ({ release: () => (stickToBottom.current = false) }), []);
  const noCrew = !snapshot.participants.some(isActiveParticipant);

  return (
    <ScrollControl.Provider value={scrollControl}>
      <div className="timeline-wrap">
        <div className="timeline" ref={scroller} onScroll={onScroll} aria-label={chat ? "Conversation with the Consigliere" : consigliereId ? "Board" : "Timeline"} role="log">
          <div className="timeline-content" ref={content}>
            {earlier > 0 ? (
              <button type="button" className="small ghost earlier-posts mono" onClick={showEarlier}>
                {earlier} earlier · show {Math.min(earlier, limit)} more
              </button>
            ) : null}
            {chat && events.length === 0 && liveTasks.length === 0 ? (
              <div className="timeline-empty">
                <p className="serif">Tell {consigliereId ? aliasOf(consigliereId) : "the Consigliere"} what you need. He brings in the others, hands out the work and reports back.</p>
                <p className="muted">Everything he and the members send each other is on the board.</p>
              </div>
            ) : null}
            {!chat && (snapshot.events.length === 0 || noCrew) ? (
              <div className="timeline-empty">
                <p className="serif">
                  {noCrew
                    ? "No crew seated yet; open People (the two-person icon above) to add a member, then hand out work orders here."
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
              if (item.type === "turn") return <TurnRow key={(item.messages[0] as RoomEvent).id} messages={item.messages} answer={item.answer} />;
              return (
                <MessageRow
                  key={item.event.id}
                  event={item.event}
                  previous={item.previous}
                  tasks={tasksByEvent.get(item.event.id) ?? []}
                  taskFor={taskFor}
                  showBranches={showBranches}
                />
              );
            })}
            {liveTurns.map(({ participant, desk: participantDesk }) => (
              <Fragment key={participantDesk.runningRun?.runId ?? participant.id}>
                {participantDesk.runningRun?.prompt ? (
                  <MessageRow
                    event={livePromptMessage(participantDesk.runningRun.runId, participantDesk.runningRun.prompt, participantDesk.runningRun.promptImages ?? [])}
                    previous={null}
                    tasks={[]}
                    taskFor={taskFor}
                  />
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
            {unseen > 0 ? `${unseen} new repl${unseen === 1 ? "y" : "ies"}` : "Jump to latest"} <Glyph name="down" text="↓" />
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
    <div className="chat-status mono" title={fullTime(event.createdAt)} data-sequence={event.sequence}>
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
        <div className="chat-status mono multi" title={`${events.length} status updates · ${fullTime(latest.createdAt)}`} data-sequence={latest.sequence}>
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
    <div className="chat-status chat-system" title={fullTime(event.createdAt)} data-sequence={event.sequence}>
      <span className="time mono">{time(event.createdAt)}</span>
      <span className="status-text">{event.text}</span>
    </div>
  );
}

/** Images attached to a user message open in the shared preview surface. */
function AttachedImages({ ids }: { ids: string[] }) {
  const openImage = useOpenImagePreview();
  return (
    <div className="event-images">
      {ids.map((id) => (
        <button type="button" className="image-preview-trigger" key={id} aria-label="Open attached image" aria-haspopup="dialog" title="Open full size" onClick={() => openImage?.({ src: attachmentUrl(id), alt: "Attached image" })}>
          <img src={attachmentUrl(id)} alt="Attached image" loading="lazy" />
        </button>
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


function MessageRow({
  event,
  previous,
  tasks,
  taskFor,
  showBranches = false,
}: {
  event: ChatMessage;
  previous: RoomEvent | ChatMessage | null;
  tasks: Task[];
  taskFor: (id: string | null) => Task | undefined;
  /** Mark replies with the branch they were made on (the room's replies come from more than one). */
  showBranches?: boolean;
}) {
  const { aliasOf, colorOf, participantById, snapshot } = useRoom();
  const events = snapshot.events;
  const continued = previous !== null;
  const number = postNumberOf(event);
  const seqTitle = number !== null ? `post #${number} · ${fullTime(event.createdAt)}` : fullTime(event.createdAt);
  // In a room with a Consigliere posts are cited by number, so each message shows its own.
  const stamp = (
    <span className="time mono" title={seqTitle}>
      {snapshot.room.consigliereId && number !== null ? <span className="post-number">#{number} · </span> : null}
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
    const shownText = event.text && fromT3 ? withoutT3ContextRefs(event.text, attachments.length > 0) : event.text;
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
                      ? "Typed in T3 Code into this member's running turn. Not shared with other participants."
                      : "Typed directly in T3 Code on this member's thread. Not shared with other participants."
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
          <div className="bubble-line">
            <div className={`bubble ${note ? "bubble-note" : "bubble-user"}${fromT3 ? " bubble-user-t3" : ""}`}>
              {shownText ? <UserText text={shownText} /> : null}
              {attachments.length > 0 ? <AttachedImages ids={attachments} /> : null}
            </div>
            <CopyTextButton text={shownText} label={note ? "Copy note" : "Copy message"} className="bubble-side" />
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
  const where = event.artifacts.find(isWorkspaceArtifact);
  const branchTag =
    showBranches && where?.branch ? (
      <span className="tag mono branch-tag" title={`Made on branch ${where.branch}${where.commit ? ` at ${where.commit.slice(0, 7)}` : ""}, in ${where.path}`}>
        <BranchIcon small />
        {where.branch}
      </span>
    ) : null;
  // A turn the agent started itself (no prompt: background work finished and woke it). Its last message is a real
  // final answer, so it keeps its own bubble; the marker says nobody asked for it.
  const selfStarted = direct && !event.prompt;
  const stopped = direct && event.outcome && event.outcome !== "completed" ? <TurnState state={event.outcome} /> : null;
  const selfMark = selfStarted ? (
    <span className="self-started mono" title="The agent continued on its own (background work finished and woke it); no new prompt">
      <Glyph name="again" text="↻" /> continued on its own
    </span>
  ) : null;

  // Every reply is its own bubble with its whole head, the speaker's mark included, so the heads line up whoever spoke
  // before it.
  return (
    <div className="chat-row from-agent" style={identityStyle(color)} data-sequence={event.sequence}>
      <div className="chat-stack">
        <div className="chat-head">
          {participant ? <Monogram participant={participant} size="xs" title={alias} /> : null}
          <span className="speaker mono identity">{alias}</span>
          {tag}
          {branchTag}
          {selfMark}
          {stopped}
          {stamp}
        </div>
        <div className="bubble bubble-agent">
          {/* Files the reply names are looked for in the folder it was written in first. */}
          <FileBaseContext.Provider value={where?.path ?? null}>
            {(event.progress ?? []).length > 0 ? <ProgressUpdates progress={event.progress} /> : null}
            {/* The reply is shown in full: it is what the user came to read. */}
            {event.text ? <Markdown text={event.text} /> : null}
          </FileBaseContext.Provider>
          {event.artifacts.some((a) => !isWorkspaceArtifact(a)) ? <ChangedFiles artifacts={event.artifacts} /> : null}
          <div className="reply-foot">
            <CopyTextButton text={event.text} label="Copy reply" />
            {event.text ? <SpeakButton id={event.id} text={event.text} lead={alias} /> : null}
            <ReplySpend event={event} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** How a turn between members stands: working, or how it ended. */
function TurnState({ state }: { state: "working" | "sent" | "completed" | "interrupted" | "failed" }) {
  const title = {
    working: "The member is working on it",
    sent: "Sent; T3 has not started the turn yet, or it is part of another turn",
    completed: "The turn completed",
    interrupted: "The turn was interrupted before it finished",
    failed: "The turn failed",
  }[state];
  return (
    <span className={`turn-state mono turn-${state}`} title={title}>
      {state === "working" ? <span className="dot dot-working" aria-hidden="true" /> : null}
      {state}
    </span>
  );
}

/** What one member sent another: its first line, opening to the whole text. A short single line is shown as it is. */
function SentText({ event, lead }: { event: RoomEvent; lead: ReactNode }) {
  const firstLine = (event.text.trim().split("\n")[0] ?? "").trim();
  const short = event.text.trim() === firstLine && firstLine.length <= 160;
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  const head = (
    <>
      {lead}
      <span className="post-number mono" title={`post #${postNumberOf(event)} · ${fullTime(event.createdAt)}`}>
        #{postNumberOf(event)}
      </span>
    </>
  );
  if (short) {
    return (
      <div className="sent-text" data-sequence={event.sequence}>
        {head} <span className="sent-line">{firstLine}</span>
      </div>
    );
  }
  return (
    <details className="sent-text" data-sequence={event.sequence}>
      <summary>
        {head} <span className="sent-line">{summary}</span>
      </summary>
      <div className="sent-full">
        <Markdown text={event.text} />
        <CopyTextButton text={event.text} label="Copy message" />
      </div>
    </details>
  );
}

/**
 * A turn one member's agent asked of another, as one row of the board: who sent it and to whom, the first line of
 * what was sent, how it stands, everything else sent into the same turn (steers, questions, answers), and the answer
 * underneath when it arrives.
 */
function TurnRow({ messages, answer }: { messages: RoomEvent[]; answer: RoomEvent | null }) {
  const { aliasOf, colorOf, participantById, snapshot, desk } = useRoom();
  const first = messages[0] as RoomEvent;
  const name = (event: RoomEvent): string => (event.speaker.type === "participant" ? aliasOf(event.speaker.participantId) : event.speaker.type === "outside" ? event.speaker.title : event.speaker.type);
  const sender = first.speaker.type === "participant" ? participantById(first.speaker.participantId) : undefined;
  const receiver = first.to ? participantById(first.to) : undefined;
  const t3RunId = first.sourceRef?.t3RunId ?? null;
  // A board post's work is the tasks it made; a message sent with T3's tools runs on the receiver's thread.
  const posted = first.sourceRef === null ? snapshot.tasks.filter((task) => task.sourceEventId === first.id && task.kind !== "wake") : [];
  const running =
    (first.to !== null && t3RunId !== null && desk?.participants[first.to]?.runningRun?.runId === t3RunId) ||
    posted.some((task) => task.state === "running" || task.state === "dispatching" || task.state === "needs_input");
  // A message sent into a turn the room started is answered by that turn's reply, further down the board.
  const roomTurn = t3RunId !== null && snapshot.runs.some((run) => run.t3RunId === t3RunId);
  const ended = posted.find((task) => task.state === "failed" || task.state === "cancelled" || task.state === "interrupted");
  const state = answer ? (answer.outcome ?? "completed") : running ? "working" : ended ? (ended.state === "failed" ? "failed" : "interrupted") : "sent";
  return (
    <div className="turn-row" style={identityStyle(sender ? colorOf(sender.id) : "var(--fg-muted)")}>
      <div className="turn-head">
        {sender ? <Monogram participant={sender} size="xs" /> : null}
        <span className="speaker mono identity">{name(first)}</span>
        {first.speaker.type === "outside" ? (
          <span className="tag mono direct-tag" title="Sent by a thread that is not a member of this room">
            outside the room
          </span>
        ) : null}
        <span className="turn-arrow" aria-label="to">
          <Glyph name="arrow" text="→" />
        </span>
        {receiver ? <Monogram participant={receiver} size="xs" /> : null}
        <span className="speaker mono identity">{first.to ? aliasOf(first.to) : "?"}</span>
        <TurnState state={state} />
        {roomTurn && !answer ? <span className="muted turn-note">sent into a turn the room started; its reply is below</span> : null}
        <span className="time mono" title={fullTime(first.createdAt)}>
          {time(first.createdAt)}
        </span>
      </div>
      <div className="turn-sent">
        {messages.map((message, index) => (
          <SentText key={message.id} event={message} lead={index > 0 ? <span className="sent-by mono">{name(message)} added</span> : null} />
        ))}
      </div>
      {answer ? (
        <div className="turn-answer" data-sequence={answer.sequence}>
          <div className="turn-answer-head mono">
            <span className="speaker identity">{first.to ? aliasOf(first.to) : "answer"}</span> answered
            <span className="post-number" title={`post #${postNumberOf(answer)} · ${fullTime(answer.createdAt)}`}>
              #{postNumberOf(answer)}
            </span>
            <span className="time">{time(answer.createdAt)}</span>
          </div>
          <div className="bubble bubble-agent">
            {(answer.progress ?? []).length > 0 ? <ProgressUpdates progress={answer.progress} /> : null}
            {answer.text ? <Markdown text={answer.text} /> : <span className="muted">No answer: the turn {answer.outcome === "failed" ? "failed" : "was interrupted"} before it gave one.</span>}
            {answer.text ? (
              <div className="reply-foot">
                <CopyTextButton text={answer.text} label="Copy answer" />
                <SpeakButton id={answer.id} text={answer.text} lead={first.to ? aliasOf(first.to) : "answer"} />
                <ReplySpend event={answer as ChatMessage} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A turn someone is typing directly in T3 on a participant's thread, still running: shown live at the bottom
 * (prompt, messages, tool bursts). When it finishes the server imports it as a t3.turn event and this goes away.
 */
function LiveTurnBubble({ participant, desk, tasks = [] }: { participant: Participant; desk: Desk | undefined; tasks?: Task[] }) {
  const { snapshot, colorOf, runCommand } = useRoom();
  const task = tasks[0];
  // A room task's bubble only shows the feed once T3 reports the task's own turn (not an earlier or direct one).
  const feedIsOurs = !task || (desk?.runningRun?.startedByRoom ?? false);
  const items = feedIsOurs ? desk?.liveFeed ?? [] : [];
  // What T3 is waiting on for this member: approvals and questions, answered here as in Tasks or in T3 itself.
  const requests = snapshot.nativeRequests.filter((request) => request.participantId === participant.id);
  const needsYou = task?.state === "needs_input" || requests.length > 0;
  const speaker = <span className="speaker mono identity">{participant.alias}</span>;
  return (
    <div className="chat-row from-agent live-turn" style={identityStyle(colorOf(participant.id))} aria-live="off">
      <div className="chat-stack">
        <div className="chat-head">
          <Monogram participant={participant} size="xs" title={participant.alias} />
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
          {needsYou && requests.length === 0 ? <div className="status-error">Waiting for your approval or answer: see Tasks, or respond in T3.</div> : null}
          {requests.length > 0 ? (
            <div className="native-requests thread-requests" role="group" aria-label={`${participant.alias} is waiting for you`}>
              {requests.map((request) =>
                request.kind === "approval" ? (
                  <ApprovalRequestCard
                    key={request.requestId}
                    payload={request.payload}
                    speaker={speaker}
                    onRespond={async (decision) => {
                      await runCommand({ type: "native.approval.respond", participantId: request.participantId, requestId: request.requestId, decision });
                    }}
                  />
                ) : (
                  <UserInputRequestCard
                    key={request.requestId}
                    requestId={request.requestId}
                    payload={request.payload}
                    speaker={speaker}
                    onSubmit={async (answers) => {
                      await runCommand({ type: "native.userInput.respond", participantId: request.participantId, requestId: request.requestId, answers });
                    }}
                    onDismiss={async () => {
                      await runCommand({ type: "native.userInput.dismiss", participantId: request.participantId, requestId: request.requestId });
                    }}
                  />
                ),
              )}
            </div>
          ) : null}
          <FileBaseContext.Provider value={desk?.worktreePath ?? null}>
            <LiveFeed items={items} placeholder={task?.state === "dispatching" ? "Sending to T3…" : "Thinking…"} className="live-feed-chat" />
          </FileBaseContext.Provider>
        </div>
      </div>
    </div>
  );
}


/** Scroll a message into view and flash it (used by "↩ your … message" on replies). */
/**
 * A post's number as the board cites it; null for what is not a post (and for the timeline's own placeholders). From a
 * service older than post numbers, the sequence, which was the post's number there.
 */
function postNumberOf(event: { sequence: number; postNumber?: number | null | undefined }): number | null {
  if (event.postNumber !== undefined) return event.postNumber;
  return event.sequence > 0 ? event.sequence : null;
}

function revealEvent(sequence: number): void {
  const element = document.querySelector<HTMLElement>(`.timeline [data-sequence="${sequence}"]`);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.remove("flash");
  void element.offsetWidth;
  element.classList.add("flash");
}

/**
 * What the turn behind a reply used, at list price: everything the thread used since its previous reply, subagents
 * included. The tooltip adds the running total since the user's last message, over the turns since.
 */
function ReplySpend({ event }: { event: { id: string; speaker: RoomEvent["speaker"] } }) {
  const { snapshot, costs } = useRoom();
  const spend = costs?.replies[event.id];
  if (!spend || !spend.available || spend.total.calls === 0) return null;
  const participantId = event.speaker.type === "participant" ? event.speaker.participantId : null;
  // Back from this reply to the user's last message (one the user wrote: a member's post or Backroom's wake-up is not
  // it): this member's replies in between, this one included.
  let since = 0;
  let turns = 0;
  let found = false;
  for (let index = snapshot.events.findIndex((e) => e.id === event.id); index >= 0; index -= 1) {
    const earlier = snapshot.events[index] as RoomEvent;
    if (earlier.kind === "user.message") {
      found = true;
      break;
    }
    if (earlier.speaker.type === "participant" && earlier.speaker.participantId === participantId) {
      const part = costs?.replies[earlier.id];
      if (part?.available) {
        since += part.total.costUsd;
        turns += 1;
      }
    }
  }
  // The page holds the room's latest events only: when your last message is older than those, the total runs from the
  // oldest one held, and says so.
  const first = snapshot.events[0];
  const from = found || !first || first.sequence <= 1 ? null : first;
  return <SpendFoot spend={spend} since={since} turns={turns} from={from ? `${time(from.createdAt)} (the earliest loaded)` : null} />;
}

/**
 * The foot of a reply: what the turn behind it used, and (over more than one turn since the user's last message) the
 * running total. Rooms and threads on their own alike; `since` and `turns` are counted by whoever knows the history.
 */
export function SpendFoot({ spend, since, turns, from = null }: { spend: ThreadCost; since: number; turns: number; from?: string | null }) {
  const input = (t: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }) => t.inputTokens + t.cachedInputTokens + t.cacheWriteTokens;
  const inputTitle = (t: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }) =>
    `${t.inputTokens.toLocaleString()} uncached · ${t.cachedInputTokens.toLocaleString()} from cache · ${t.cacheWriteTokens.toLocaleString()} written to cache`;
  const only = spend.models.length === 1 ? spend.models[0] : undefined;
  // One model, no subagents: the summary line says it all. Otherwise a row per model, with whose calls they were.
  const rows = only && only.subagents.calls === 0 ? [] : spend.models;
  return (
    <div className="reply-spend mono" title="List price, not what a subscription charges">
      <div className="reply-spend-line">
        <span className="reply-spend-total">
          {spend.priced ? "≈ " : "≥ "}
          {money(spend.total.costUsd)}
        </span>
        {rows.length === 0 && only ? <span> · {only.model}</span> : null}
        <span title={inputTitle(spend.total)}> · {fmtTokens(input(spend.total))} in</span>
        <span> · {fmtTokens(spend.total.outputTokens)} out</span>
        <span> · {spend.total.calls} call{spend.total.calls === 1 ? "" : "s"}</span>
        {turns > 1 ? (
          <span className="reply-spend-since">
            {" "}
            · since {from ?? "your last message"} {money(since)} over {turns} turns
          </span>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <table className="reply-spend-table">
          <tbody>
            {rows.map((model) => (
              <tr key={model.model}>
                <td>{model.model}</td>
                <td className="reply-spend-who">{model.own.calls > 0 && model.subagents.calls > 0 ? "own + subagents" : model.subagents.calls > 0 ? "subagents" : "own"}</td>
                <td className="num" title={inputTitle(model)}>
                  {fmtTokens(input(model))} in
                </td>
                <td className="num">{fmtTokens(model.outputTokens)} out</td>
                <td className="num">{model.priced ? money(model.costUsd) : "unpriced"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/**
 * "↩ your 3:49 PM message", or "↩ your 3:49 and 3:50 PM messages" when one turn answered several messages
 * (the later ones were sent into the running turn). Each time scrolls to its message.
 */
/**
 * What a reply answers, over it: "↩ your 07:43 PM message", "↩ Fable's 07:43 PM message", "↩ Opus's result · 07:43 PM"
 * for a wake-up after a member's task, and so on (replyTo.ts). Only a message the user wrote is "your". A time shows
 * the post it points at, where the view shows it.
 */
function ReplyTo({ tasks }: { tasks: Task[] }) {
  const { snapshot, aliasOf } = useRoom();
  const sources = replySources(tasks, { tasks: snapshot.tasks, runs: snapshot.runs, events: snapshot.events, aliasOf });
  if (sources.length === 0) return null;
  // A seat briefing is Backroom's message, not the user's: its acknowledgement says so.
  if (sources.every((s) => s.kind === "notice")) {
    return (
      <span className="reply-to mono" title="Acknowledges what Backroom sent this member: the standing facts of a room that has a Consigliere, or who its new Consigliere is">
        <Glyph name="reply" text="↩" /> {sources.map((s) => (s.kind === "notice" ? s.label : "")).join(" and ")}
      </span>
    );
  }
  return (
    <span className="reply-to mono" title={replyTitle(sources, tasks, time)}>
      {replyPieces(sources).map((piece, index) =>
        "text" in piece ? (
          piece.text.startsWith("↩ ") ? (
            <span key={index}>
              <Glyph name="reply" text="↩" />
              {piece.text.slice(1)}
            </span>
          ) : (
            <span key={index}>{piece.text}</span>
          )
        ) : (
          <button key={index} type="button" className="reply-to-time" onClick={() => revealEvent(piece.time.sequence)}>
            {time(piece.time.createdAt)}
          </button>
        ),
      )}
    </span>
  );
}

/**
 * The files a turn changed, folded to one line ("3 files changed · +19 −8"); open it for the list, headed by where
 * the work is (folder, branch, commit).
 */
function ChangedFiles({ artifacts: all }: { artifacts: RoomEvent["artifacts"] }) {
  const where = all.find(isWorkspaceArtifact);
  const artifacts = all.filter((artifact) => !isWorkspaceArtifact(artifact));
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
        {where ? (
          <li className="artifact-where" title={where.path}>
            in <code>{where.path}</code>
            {where.branch ? <span className="muted"> on {where.branch}</span> : null}
            {where.commit ? <code className="muted"> {where.commit.slice(0, 7)}</code> : null}
            {where.note ? <span className="muted"> · {where.note}</span> : null}
          </li>
        ) : null}
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
function livePromptMessage(turnId: string, prompt: string, images: string[]): ChatMessage {
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
    attachmentIds: images,
    progress: [],
    prompt: null,
    to: null,
    outcome: null,
    sourceRef: null,
    createdAt: new Date().toISOString(),
  };
}

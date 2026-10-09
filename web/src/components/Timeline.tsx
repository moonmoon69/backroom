import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, attachmentUrl } from "../api.ts";
import { useRoom } from "../context.tsx";
import { backroomNote, backroomNotice, intoRunningTurn, replyPieces, replyText, sourceWords, type ReplyContext, type ReplyPiece } from "../replyTo.ts";
import { consigliereChat, consigliereSeats } from "../chat.ts";
import { sinceWords } from "../engineTime.ts";
import { isActiveParticipant, type Desk, type EngineActivityView, type EnginePost, type EngineRunDetail, type EngineRunView, type EngineT3Ref, type Participant, type ThreadCost, type ThreadItem } from "../types.ts";
import { Glyph } from "./icons.tsx";
import { Dialog } from "./Dialog.tsx";
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

/**
 * The room's board, read from its journal (GET /api/rooms/:roomId, RoomSnapshot.posts): every request with its
 * open/answered marker, every reply with what it answers ("answers #12"), notes, progress, notices with Retry and
 * Dismiss, and below them the runs going on now, live from T3. Board numbers come from the read API (`post.number`):
 * nothing here works one out. Times come from T3 only: a post T3 did not time shows none.
 */

const time = (iso: string | null): string => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const fullTime = (iso: string | null): string => {
  if (!iso) return "";
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
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** A post's time as its tooltip says it: exact, or the lower bound T3 gives, or unknown. */
const whenTitle = (post: EnginePost): string =>
  post.at ? fullTime(post.at) : post.after ? `time not known exactly: after ${fullTime(post.after)}` : "time not known";

const firstLine = (text: string): string => (text.trim().split("\n")[0] ?? "").trim();

/** The room's lookups every row needs, computed once per snapshot. */
interface Board {
  /** The post that made a request, by request ID (among the posts the page holds). */
  requestPost: (requestId: string) => EnginePost | undefined;
  /** Pending background work by ID ("working since"). */
  activity: (id: string) => EngineActivityView | undefined;
  /** T3 runs whose prompt the user typed in T3 (a `$user` turn note): the member's note for that run is a reply to it. */
  typedInT3: ReadonlySet<string>;
  /** Board numbers of the posts on screen, to reveal one. */
  reveal: (number: number) => void;
}

const BoardContext = createContext<Board | null>(null);
const useBoard = (): Board => {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard outside the timeline");
  return value;
};

/**
 * A post as drawn in its detail (Enter on a post): its folded text open, and not an item of the board's arrows.
 */
const InDetail = createContext(false);

/** A post's one line for assistive technology: its number, who to whom, what it is, where it stands, how it starts. */
function postLabel(post: EnginePost, nameOf: (principal: string) => string, owners?: string[]): string {
  const author = nameOf(post.author);
  const text = firstLine(post.body);
  const words = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  const state = post.request ? `, ${post.request.state}` : "";
  const what =
    post.kind === "request"
      ? `${author} to ${(owners ?? [nameOf(post.request!.owner)]).join(", ")}${state}`
      : post.kind === "output"
        ? `${author} replied`
        : post.kind === "note"
          ? `note from ${author}`
          : post.kind === "notice"
            ? post.notice?.intent === "error" ? "failed" : post.notice?.intent === "keep-alive" ? "keep-alive" : "attention"
            : `${post.kind} by ${author}`;
  return `#${post.number}, ${what}${words ? `: ${words}` : ""}`;
}

/** What makes a post's row an item the arrows reach (keys.ts): focusable, with a role and a name; Enter opens its detail. */
function useNavProps(post: EnginePost, owners?: string[]) {
  const { nameOf } = useRoom();
  const inDetail = useContext(InDetail);
  if (inDetail) return {};
  return { "data-nav": "post", "data-nav-key": `post:${post.seq}`, tabIndex: -1, role: "article", "aria-label": postLabel(post, nameOf, owners), "aria-description": "Enter opens its detail" };
}

/** Lets a row stop the timeline from following the bottom (expanding a long reply must not jump the view). */
const ScrollControl = createContext<{ release: () => void }>({ release: () => {} });

/** Distance from the bottom (px) under which the timeline keeps following new content. */
const STICK_PX = 40;
/** Distance from the bottom (px) beyond which "Jump to latest" appears. */
const JUMP_PX = 240;

type Item = { type: "day"; key: string; label: string } | { type: "post"; post: EnginePost } | { type: "message"; posts: EnginePost[] };

/** A run that has not ended: what it is doing, in a word. */
const PHASE_WORDS: Record<EngineRunView["phase"], string> = {
  prepared: "preparing",
  sending: "sending to T3",
  accepted: "starting",
  running: "working",
  uncertain: "uncertain",
  rejected: "refused by T3",
  terminal: "done",
};

/**
 * The room's posts, oldest first. "board" (the default) is every post; "chat" is the conversation with the room's
 * Consigliere (see consigliereChat). A room without a Consigliere shows the board alone.
 */
export function Timeline({ view = "board", limit = 0 }: { view?: "board" | "chat"; limit?: number } = {}) {
  const { snapshot, desk, nameOf } = useRoom();
  const chat = view === "chat";
  const consigliereId = snapshot.room.consigliereId;

  // Older pages of the board, read on demand ("load older posts"); the snapshot holds the newest.
  const [older, setOlder] = useState<{ roomId: string; posts: EnginePost[]; earlier: boolean } | null>(null);
  const roomId = snapshot.room.id;
  useEffect(() => setOlder(null), [roomId]);
  const allPosts = useMemo(() => {
    const kept = older && older.roomId === roomId ? older.posts : [];
    const first = snapshot.posts[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    return [...kept.filter((post) => post.seq < first), ...snapshot.posts];
  }, [older, roomId, snapshot.posts]);
  const moreOnServer = older && older.roomId === roomId ? older.earlier : snapshot.earlier;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = () => {
    const before = allPosts[0]?.seq;
    if (before === undefined || loadingOlder) return;
    setLoadingOlder(true);
    api
      .board(roomId, before, 200)
      .then((page) => setOlder((current) => ({ roomId, posts: [...page.posts, ...(current && current.roomId === roomId ? current.posts : [])], earlier: page.earlier })))
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false));
  };

  // His seats and threads, across reseats (a reseat seats a fresh member; the transfer posts link them).
  const his = useMemo(() => consigliereSeats(snapshot, allPosts), [snapshot, allPosts]);
  const posts = useMemo(() => (chat ? consigliereChat(allPosts, his) : allPosts), [chat, allPosts, his]);

  // Read aloud, when the room's menu says so: each new reply, and each new approval or question, named by who it is from.
  const [autoRead] = useAutoRead(`room:${snapshot.room.id}`);
  useAnnounceNew(
    `room:${snapshot.room.id}`,
    autoRead && !chat,
    snapshot.posts
      .filter((post) => post.kind === "output" && !post.author.startsWith("$") && post.body.trim().length > 0)
      .map((post) => ({ id: post.id, text: `${nameOf(post.author).replace(/^@/, "")}. ${speakableSummary(post.body)}` })),
  );
  useAnnounceNew(
    `room:${snapshot.room.id}:requests`,
    autoRead && !chat,
    snapshot.nativeRequests.map((request) => ({ id: request.requestId, text: `${snapshot.participants.find((p) => p.id === request.participantId)?.alias ?? "A member"} ${request.kind === "approval" ? "needs your approval." : "has a question for you."}` })),
  );

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [far, setFar] = useState(false);
  const [seenSeq, setSeenSeq] = useState(0);

  const board = useMemo<Board>(() => {
    const byRequest = new Map<string, EnginePost>();
    for (const post of allPosts) if (post.request) byRequest.set(post.request.id, post);
    const activities = new Map(snapshot.seats.flatMap((seat) => seat.activities.map((a) => [a.id, a] as const)));
    const typedInT3 = new Set(allPosts.flatMap((post) => (post.author === "$user" && post.note?.source === "t3-turn" && post.note.t3?.runId ? [post.note.t3.runId] : [])));
    return {
      requestPost: (id) => byRequest.get(id),
      activity: (id) => activities.get(id),
      typedInT3,
      reveal: (number) => {
        const element = scroller.current?.querySelector<HTMLElement>(`[data-number="${number}"]`);
        if (!element) return;
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.remove("flash");
        void element.offsetWidth;
        element.classList.add("flash");
      },
    };
  }, [allPosts, snapshot.seats]);

  const allItems = useMemo(() => {
    const items: Item[] = [];
    const timed = posts.filter((post) => post.at);
    const spansDays = timed.length > 0 && dayKey(timed[0]!.at!) !== dayKey(timed[timed.length - 1]!.at!);
    let lastDay: string | null = null;
    // A user message made one request per recipient per assignment: they are one message on the board.
    const messages = new Map<string, { type: "message"; posts: EnginePost[] }>();
    for (const post of posts) {
      const messageId = post.author === "$user" ? post.request?.message?.id : undefined;
      const same = messageId ? messages.get(messageId) : undefined;
      if (same) {
        same.posts.push(post);
        continue;
      }
      const day = post.at ? dayKey(post.at) : null;
      if (spansDays && day && day !== lastDay) items.push({ type: "day", key: `day-${day}-${post.seq}`, label: dayLabel(post.at!) });
      if (day) lastDay = day;
      if (post.kind === "request" && post.author === "$user") {
        const item = { type: "message" as const, posts: [post] };
        if (messageId) messages.set(messageId, item);
        items.push(item);
      } else items.push({ type: "post", post });
    }
    return items;
  }, [posts]);
  // With a limit, only the latest posts are drawn at first (a long board opens at once); "earlier" draws the next
  // window above, keeping what is in view where it is.
  const [shown, setShown] = useState(limit);
  useEffect(() => setShown(limit), [limit, snapshot.room.id]);
  const items = limit > 0 && allItems.length > shown ? allItems.slice(allItems.length - shown) : allItems;
  const earlier = allItems.length - items.length;
  const keepPlace = useRef<{ height: number; top: number } | null>(null);
  const keep = () => {
    const el = scroller.current;
    if (el) keepPlace.current = { height: el.scrollHeight, top: el.scrollTop };
  };
  const showEarlier = () => {
    keep();
    setShown((n) => n + limit);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const place = keepPlace.current;
    if (!el || !place) return;
    keepPlace.current = null;
    el.scrollTop = place.top + (el.scrollHeight - place.height);
  }, [shown, allPosts.length]);

  // Runs that have not ended: each builds up as its member's bubble at the bottom. In the chat, only his.
  const liveRuns = useMemo(
    () => snapshot.runs.filter((run) => run.phase !== "terminal" && (!chat || his.seats.has(run.seatId))),
    [snapshot.runs, chat, his],
  );
  // Turns typed directly in T3 (or started by the agent itself) still running: live at the bottom until imported.
  const liveTurns = useMemo(() => {
    if (!desk || chat) return [];
    const imported = new Set(allPosts.flatMap((post) => (post.note?.t3?.runId ? [post.note.t3.runId] : post.output?.t3?.runId ? [post.output.t3.runId] : [])));
    const roomRuns = new Set(snapshot.runs.flatMap((run) => (run.t3RunId ? [run.t3RunId] : [])));
    return snapshot.participants
      .filter(isActiveParticipant)
      .map((participant) => ({ participant, desk: desk.participants[participant.id] }))
      .filter((entry): entry is { participant: Participant; desk: Desk } => {
        const running = entry.desk?.runningRun;
        return Boolean(running) && !running!.startedByRoom && !imported.has(running!.runId) && !roomRuns.has(running!.runId);
      });
  }, [desk, chat, allPosts, snapshot.runs, snapshot.participants]);

  const lastSeq = posts[posts.length - 1]?.seq ?? 0;
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
  }, [lastSeq, liveRuns, liveTurns, scrollToBottom]);

  // Content that grows after render (live feeds, opened rows) keeps the bottom in view.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // A panel that was put away comes back at the latest again; a width change keeps the bottom in view when it was.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const appeared = height === 0 && el.clientHeight > 0;
      height = el.clientHeight;
      if (appeared) {
        stickToBottom.current = true;
        setFar(false);
      }
      if (stickToBottom.current) scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useEffect(() => {
    if (!far) setSeenSeq(lastSeq);
  }, [far, lastSeq]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < STICK_PX;
    const isFar = distance > JUMP_PX;
    if (isFar !== far) setFar(isFar);
  };

  // New replies while scrolled up: one per member turn (an explicit answer and its turn's final are one).
  const unseen = far ? posts.filter((post) => post.seq > seenSeq && post.turn && !post.author.startsWith("$")).length : 0;
  const scrollControl = useMemo(() => ({ release: () => (stickToBottom.current = false) }), []);
  const noCrew = !snapshot.participants.some(isActiveParticipant);
  // The post whose detail is open (Enter on a post), by its first seq.
  const [detail, setDetail] = useState<number | null>(null);
  const detailItem = detail === null ? null : (allItems.find((item) => item.type !== "day" && (item.type === "message" ? item.posts[0]!.seq : item.post.seq) === detail) ?? null);

  return (
    <BoardContext.Provider value={board}>
      <ScrollControl.Provider value={scrollControl}>
        <div className="timeline-wrap">
          <div
            className="timeline"
            ref={scroller}
            onScroll={onScroll}
            aria-label={chat ? "Conversation with the Consigliere" : consigliereId ? "Board" : "Timeline"}
            role="log"
            onKeyDown={(event) => {
              const target = event.target as HTMLElement;
              if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target.dataset.nav !== "post") return;
              // Taken before the composer's "Enter writes a message" sees it.
              event.preventDefault();
              setDetail(Number(target.dataset.navKey!.slice("post:".length)));
            }}
          >
            <div className="timeline-content" ref={content}>
              {earlier > 0 ? (
                <button type="button" className="small ghost earlier-posts mono" onClick={showEarlier}>
                  {earlier} earlier · show {Math.min(earlier, limit)} more
                </button>
              ) : moreOnServer ? (
                <button
                  type="button"
                  className="small ghost earlier-posts mono"
                  disabled={loadingOlder}
                  onClick={() => {
                    keep();
                    loadOlder();
                  }}
                >
                  {loadingOlder ? "reading older posts…" : "load older posts"}
                </button>
              ) : null}
              {chat && posts.length === 0 && liveRuns.length === 0 ? (
                <div className="timeline-empty">
                  <p className="serif">Tell {consigliereId ? (snapshot.participants.find((p) => p.id === consigliereId)?.alias ?? "the Consigliere") : "the Consigliere"} what you need. He brings in the others, hands out the work and reports back.</p>
                  <p className="muted">Everything he and the members send each other is on the board.</p>
                </div>
              ) : null}
              {!chat && (allPosts.length === 0 || noCrew) ? (
                <div className="timeline-empty">
                  <p className="serif">
                    {noCrew
                      ? "No crew seated yet; open People (the two-person icon above) to add a member, then hand out work here."
                      : "The board is empty; address the crew to post the first request."}
                  </p>
                  <pre className="worked-example mono">{"@sol1 investigate the parser\n@sol1 @sol2 independently check the tests"}</pre>
                  <p className="muted">Each line is one message. Send a follow-up once the work it builds on is answered.</p>
                </div>
              ) : null}
              {items.map((item) =>
                item.type === "day" ? (
                  <div key={item.key} className="chat-day" role="separator">
                    <span>{item.label}</span>
                  </div>
                ) : item.type === "message" ? (
                  <UserMessage key={item.posts[0]!.id} posts={item.posts} chat={chat} />
                ) : (
                  <PostRow key={item.post.id} post={item.post} chat={chat} />
                ),
              )}
              {liveTurns.map(({ participant, desk: participantDesk }) => (
                <LiveTurnBubble
                  key={participantDesk.runningRun?.runId ?? participant.id}
                  participant={participant}
                  desk={participantDesk}
                  promptOnBoard={allPosts.some((post) => post.author === "$user" && post.note?.source === "t3-message" && post.note.t3?.threadId === participantDesk.threadId && participantDesk.runningRun?.prompt != null && post.body.trim().startsWith(participantDesk.runningRun.prompt.trim()))}
                />
              ))}
              {liveRuns.map((run) => (
                <LiveRunBubble key={run.id} run={run} />
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
        {detailItem && detailItem.type !== "day" ? <PostDetail item={detailItem} onClose={() => setDetail(null)} /> : null}
      </ScrollControl.Provider>
    </BoardContext.Provider>
  );
}

/**
 * A post's detail (Enter on it): who wrote it to whom, when, where it stands, and the post itself with its folded text
 * open and its controls. Esc closes it and the focus goes back to the post.
 */
function PostDetail({ item, onClose }: { item: Exclude<Item, { type: "day" }>; onClose: () => void }) {
  const { nameOf } = useRoom();
  const posts = item.type === "message" ? item.posts : [item.post];
  const first = posts[0]!;
  const to = first.request ? posts.map((post) => nameOf(post.request!.owner)) : first.to.map(nameOf);
  return (
    <Dialog title={`Post #${first.number}`} onClose={onClose} wide manageFocus>
      <dl className="post-detail-facts">
        <dt>What</dt>
        <dd className="mono">{first.kind}{first.request ? ` · ${posts.map((post) => `#${post.number} ${post.request!.state}`).join(", ")}` : ""}</dd>
        <dt>From</dt>
        <dd className="mono">{nameOf(first.author)}</dd>
        {to.length > 0 ? (
          <>
            <dt>To</dt>
            <dd className="mono">{to.join(", ")}</dd>
          </>
        ) : null}
        <dt>When</dt>
        <dd className="mono">{whenTitle(first)}</dd>
      </dl>
      <InDetail.Provider value={true}>
        <div className="post-detail-body timeline-content">{item.type === "message" ? <UserMessage posts={posts} chat={false} /> : <PostRow post={first} chat={false} />}</div>
      </InDetail.Provider>
    </Dialog>
  );
}

/** One post, drawn by what it is. */
function PostRow({ post, chat }: { post: EnginePost; chat: boolean }) {
  switch (post.kind) {
    case "request":
      return post.author === "$user" ? <UserMessage posts={[post]} chat={chat} /> : <MemberRequest post={post} />;
    case "output":
      return <Reply post={post} />;
    case "note":
      return <Note post={post} />;
    case "progress":
      return <Progress post={post} />;
    case "notice":
      return post.notice?.intent === "keep-alive" ? <StatusPost post={post} /> : <Notice post={post} />;
    case "blocked":
      return <Blocked post={post} />;
    default:
      return <StatusPost post={post} />;
  }
}

/** "#12" with the post's time as its tooltip. */
function Stamp({ post }: { post: EnginePost }) {
  return (
    <span className="time mono" title={`post #${post.number} · ${whenTitle(post)}`}>
      {/* The chat hides the number (styles.css), and its separator with it. */}
      <span className="post-number">
        #{post.number}
        {post.at ? " · " : ""}
      </span>
      {post.at ? time(post.at) : null}
    </span>
  );
}

/** A board number that shows its post when clicked. */
function Ref({ number }: { number: number }) {
  const { reveal } = useBoard();
  return (
    <button type="button" className="post-ref mono" onClick={() => reveal(number)} title={`Show #${number}`}>
      #{number}
    </button>
  );
}

/** Several board numbers, each showing its post, separated: "#12, #14". Unknown ones are left out. */
function Refs({ numbers }: { numbers: ReadonlyArray<number | null> }) {
  const shown = numbers.filter((n): n is number => n !== null);
  return (
    <>
      {shown.map((n, index) => (
        <Fragment key={`${n}-${index}`}>
          {index > 0 ? ", " : null}
          <Ref number={n} />
        </Fragment>
      ))}
    </>
  );
}

function Pieces({ pieces }: { pieces: readonly ReplyPiece[] }) {
  return (
    <>
      {pieces.map((piece, index) => ("text" in piece ? <span key={index}>{piece.text}</span> : <Ref key={index} number={piece.ref} />))}
    </>
  );
}

/**
 * Where a request stands: open (with who is on it and what holds it), answered (by which post), or cancelled. The
 * marker the board is read by.
 */
function RequestMarker({ post }: { post: EnginePost }) {
  const { snapshot, nameOf } = useRoom();
  const { activity } = useBoard();
  const request = post.request;
  if (!request) return null;
  if (request.state === "answered") {
    return (
      <span className="req-state req-answered mono" title="Answered">
        answered{request.answer ? <> · <Ref number={request.answer.number} /></> : null}
      </span>
    );
  }
  if (request.state === "cancelled") return <span className="req-state req-cancelled mono">cancelled</span>;
  const open = snapshot.requests.find((q) => q.id === request.id);
  const run = open?.runId ? snapshot.runs.find((r) => r.id === open.runId) : undefined;
  const held = (open?.activityIds ?? []).map(activity).filter((a): a is EngineActivityView => Boolean(a));
  const children = (open?.openChildren ?? []).map((id) => snapshot.requests.find((q) => q.id === id)).filter(Boolean);
  return (
    <span className="req-state req-open mono" title="Open: not answered yet">
      open
      {run ? (
        <span className={`req-run${run.phase === "uncertain" ? " req-uncertain" : ""}`}>
          {" "}· {nameOf(run.seatId)} {PHASE_WORDS[run.phase]}
        </span>
      ) : null}
      {held.map((a) => (
        <WorkingSince key={a.id} activity={a} />
      ))}
      {children.map((child) => (
        <span key={child!.id} className="req-child" title={child!.preview}>
          {" "}· waits on <Ref number={child!.number} /> ({nameOf(child!.owner)})
        </span>
      ))}
    </span>
  );
}

/** "working since 14:03": background work holding a request open (a `work:` mark or T3's background jobs). */
function WorkingSince({ activity, who }: { activity: EngineActivityView; who?: string }) {
  const what = activity.kind === "bg" ? "background work T3 listed when the turn ended" : "the member said it is still working (rooms-board working)";
  const when = activity.since.at ? ` · since ${fullTime(activity.since.at)}` : activity.since.after ? ` · since some time after ${fullTime(activity.since.after)} (T3 has no exact time for it)` : "";
  return (
    <span className="working-since mono" title={`${what}${activity.memberHeld ? "; it ends only when the member answers" : ""}${when}`}>
      {` · ${who ? `${who} ` : ""}working since ${sinceWords(activity.since)}`}
    </span>
  );
}

/**
 * One message of the user's: the requests it made (one per recipient per assignment, sharing `request.message.id`) as one
 * message, with its images; where each went and each one's marker, with Correct… and Cancel while it is open.
 */
function UserMessage({ posts, chat }: { posts: EnginePost[]; chat: boolean }) {
  const first = posts[0]!;
  const notice = backroomNotice(first);
  if (notice) return <BackroomRequest post={first} notice={notice} />;
  return <UserBubble posts={posts} chat={chat} />;
}

function UserBubble({ posts, chat }: { posts: EnginePost[]; chat: boolean }) {
  const { nameOf, snapshot } = useRoom();
  const first = posts[0]!;
  const message = first.request?.message ?? null;
  const images = message?.attachmentIds ?? [];
  // One text when every recipient got the same words; otherwise each assignment's own, under whom it went to.
  const sameText = posts.every((post) => post.body === first.body);
  const owners = posts.map((post) => nameOf(post.request!.owner));
  const nav = useNavProps(first, owners);
  return (
    <div className="chat-row from-user" data-number={first.number} data-seq={first.seq} {...nav}>
      <div className="chat-stack">
        <div className="chat-head">
          <span className="you-mark mono">you</span>
          {!chat ? (
            <span className="mono req-to">
              <Glyph name="arrow" text="→" /> {owners.join(", ")}
            </span>
          ) : null}
          {posts.some((post) => intoRunningTurn(post, snapshot.runs)) ? (
            <span className="tag mono" title="Taken into the member's running turn (/steer): that turn's reply answers it too">
              into the turn
            </span>
          ) : null}
          <Stamp post={first} />
        </div>
        {sameText ? (
          <div className="bubble-line">
            <div className="bubble bubble-user">
              {first.body ? <UserText text={first.body} /> : null}
              {images.length > 0 ? <AttachedImages ids={images} /> : null}
            </div>
            <CopyTextButton text={first.body} label="Copy message" className="bubble-side" />
          </div>
        ) : (
          <>
            {posts.map((post, index) => (
              <div key={post.id} className="bubble-line">
                <div className="bubble bubble-user">
                  <span className="mono muted req-to">{owners[index]}</span>
                  <UserText text={post.body} />
                  {index === posts.length - 1 && images.length > 0 ? <AttachedImages ids={images} /> : null}
                </div>
                <CopyTextButton text={post.body} label="Copy message" className="bubble-side" />
              </div>
            ))}
          </>
        )}
        {posts.map((post) => (
          <RequestFoot key={post.id} post={post} owner={posts.length > 1 ? nameOf(post.request!.owner) : null} />
        ))}
      </div>
    </div>
  );
}

/** Backroom's briefing to a member, made in the user's name: one line, opening to its text, with its marker. */
function BackroomRequest({ post, notice }: { post: EnginePost; notice: string }) {
  const { nameOf } = useRoom();
  const nav = useNavProps(post);
  const open = useContext(InDetail);
  return (
    <div className="chat-status mono backroom-request" data-number={post.number} data-seq={post.seq} title={whenTitle(post)} {...nav}>
      <span className="post-number">#{post.number}</span>
      <details open={open || undefined}>
        <summary>
          {`Backroom → ${nameOf(post.request!.owner)}: ${notice}`}
        </summary>
        <div className="sent-full">
          <Markdown text={post.body} />
        </div>
      </details>
      <RequestMarker post={post} />
    </div>
  );
}

/** Images that came with a message, opening in the shared preview. */
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

/** One request of the user's message: its marker, and Correct… and Cancel while it is open. */
function RequestFoot({ post, owner }: { post: EnginePost; owner: string | null }) {
  const { runCommand, snapshot } = useRoom();
  const request = post.request!;
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState("");
  const correctButton = useRef<HTMLButtonElement>(null);
  const open = request.state === "open";
  return (
    <div
      className="req-block"
      data-number={post.number}
      data-seq={post.seq}
      onKeyDown={(event) => {
        // Esc with the focus in the open correction (its field, Send, Correct…) closes it and goes back to Correct….
        if (event.key !== "Escape" || !correcting || !open || event.nativeEvent.isComposing) return;
        event.preventDefault();
        setCorrecting(false);
        correctButton.current?.focus();
      }}
    >
      <div className="req-foot">
        {owner ? <span className="mono muted">#{post.number} → {owner}</span> : null}
        <RequestMarker post={post} />
        {request.corrections > 0 ? <span className="mono muted"> · corrected {request.corrections}×</span> : null}
        {open ? (
          <span className="req-actions">
            <button type="button" ref={correctButton} className="link-button" aria-expanded={correcting} onClick={() => setCorrecting((v) => !v)} title="Add to or change what you asked; the member gets it with the request">
              Correct…
            </button>
            <button
              type="button"
              className="link-button danger"
              title="Withdraw it: a turn working only on it is stopped"
              onClick={() => void runCommand({ type: "request.cancel", roomId: snapshot.room.id, requestId: request.id })}
            >
              Cancel
            </button>
          </span>
        ) : null}
      </div>
      {correcting && open ? (
        <form
          className="req-correct"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            void runCommand({ type: "request.correct", roomId: snapshot.room.id, requestId: request.id, text: text.trim() }).then((result) => {
              if (result) {
                setText("");
                setCorrecting(false);
              }
            });
          }}
        >
          {/* Opened, it has the focus (what is typed goes in it, not into a new message); Esc goes back to Correct…. */}
          <textarea
            autoFocus
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            placeholder={`What changes in #${post.number}`}
            aria-label={`Correction to #${post.number}`}
          />
          <button type="submit" className="small primary" disabled={!text.trim()}>
            Send correction
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** A request one member posted to another: who to whom, its first line (opening to the whole), and its marker. */
function MemberRequest({ post }: { post: EnginePost }) {
  const { nameOf, seatOf, colorOf } = useRoom();
  const request = post.request!;
  const sender = seatOf(post.author).participant;
  const receiver = seatOf(request.owner).participant;
  const line = firstLine(post.body);
  const short = post.body.trim() === line && line.length <= 160;
  const nav = useNavProps(post);
  const open = useContext(InDetail);
  return (
    <div className="turn-row" style={identityStyle(sender ? colorOf(sender.id) : "var(--fg-muted)")} data-number={post.number} data-seq={post.seq} {...nav}>
      <div className="turn-head">
        {sender ? <Monogram participant={sender} size="xs" /> : null}
        <span className="speaker mono identity">{nameOf(post.author)}</span>
        <span className="turn-arrow" aria-label="to">
          <Glyph name="arrow" text="→" />
        </span>
        {receiver ? <Monogram participant={receiver} size="xs" /> : null}
        <span className="speaker mono identity">{nameOf(request.owner)}</span>
        {request.parentId ? <span className="tag mono" title="Posted while working on another request: it holds that one open until it is answered">under {<ParentRef id={request.parentId} />}</span> : null}
        <RequestMarker post={post} />
        <Stamp post={post} />
      </div>
      <div className="turn-sent">
        {short ? (
          <div className="sent-text">
            <span className="sent-line">{line}</span>
          </div>
        ) : (
          <details className="sent-text" open={open || undefined}>
            <summary>
              <span className="sent-line">{line.length > 160 ? `${line.slice(0, 160)}…` : line}</span>
            </summary>
            <div className="sent-full">
              <Markdown text={post.body} />
              <CopyTextButton text={post.body} label="Copy message" />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function ParentRef({ id }: { id: string }) {
  const { requestPost } = useBoard();
  const { snapshot } = useRoom();
  const number = requestPost(id)?.number ?? snapshot.requests.find((q) => q.id === id)?.number ?? null;
  return number === null ? <>an earlier request</> : <Ref number={number} />;
}

/** A member's reply: what it answers (from the engine's claims), how it came about, and what its turn used. */
function Reply({ post }: { post: EnginePost }) {
  const { nameOf, seatOf, colorOf } = useRoom();
  const { requestPost } = useBoard();
  const output = post.output!;
  const participant = seatOf(post.author).participant;
  const context: ReplyContext = { requestPost, nameOf };
  const pieces = replyPieces(post, context);
  const source = sourceWords(post);
  const late = output.claims.some((claim) => claim.outcome === "late");
  const nav = useNavProps(post);
  return (
    <div className="chat-row from-agent" style={identityStyle(participant ? colorOf(participant.id) : "var(--fg-muted)")} data-number={post.number} data-seq={post.seq} {...nav}>
      <div className="chat-stack">
        <div className="chat-head">
          {participant ? <Monogram participant={participant} size="xs" title={participant.alias} /> : null}
          <span className="speaker mono identity">{nameOf(post.author).replace(/^@/, "")}</span>
          {pieces.length > 0 ? (
            <span className={`reply-to mono${late ? " reply-late" : ""}${output.disposition === "yield" ? " reply-yield" : ""}`} title={replyText(pieces)}>
              <Glyph name="reply" text="↩" /> <Pieces pieces={pieces} />
            </span>
          ) : null}
          {source ? (
            <span className="self-started mono" title={source === "rooms-board answer" ? "Answered with rooms-board answer during or between its turns" : source}>
              {output.source === "continuation" ? <Glyph name="again" text="↻" /> : null} {source}
            </span>
          ) : null}
          {output.afterAnswer ? <AfterAnswer /> : null}
          {output.disposition === "error" ? <span className="turn-state mono turn-failed">failed</span> : null}
          <Stamp post={post} />
        </div>
        <div className="bubble bubble-agent">
          <FileBaseContext.Provider value={null}>{post.body ? <Markdown text={post.body} /> : <span className="muted">No text.</span>}</FileBaseContext.Provider>
          {output.runId ? <SentToT3 runId={output.runId} /> : null}
          {output.t3?.runId ? <TurnInT3 t3={output.t3} /> : null}
          <div className="reply-foot">
            <CopyTextButton text={post.body} label="Copy reply" />
            {post.body ? <SpeakButton id={post.id} text={post.body} lead={nameOf(post.author).replace(/^@/, "")} /> : null}
            <ReplySpend post={post} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What the member was sent for this turn: the exact briefing Backroom gave T3 (frozen when it was sent; a resend sends
 * the same), and the images that went with it. Read when opened (GET …/runs/:runId).
 */
function SentToT3({ runId }: { runId: string }) {
  const { snapshot } = useRoom();
  const [detail, setDetail] = useState<EngineRunDetail | "loading" | "gone" | null>(null);
  const load = () => {
    if (detail !== null && detail !== "gone") return;
    setDetail("loading");
    api
      .run(snapshot.room.id, runId)
      .then(setDetail)
      .catch(() => setDetail("gone"));
  };
  const images = detail !== null && typeof detail === "object" ? detail.images.flatMap((entry) => entry.names) : [];
  return (
    <details className="reply-progress sent-to-t3" onToggle={(event) => (event.currentTarget.open ? load() : undefined)}>
      <summary className="mono">sent to T3</summary>
      {detail === null || detail === "loading" ? (
        <p className="muted mono">reading…</p>
      ) : detail === "gone" ? (
        <p className="muted">Backroom no longer has this turn.</p>
      ) : detail.briefing === null ? (
        <p className="muted">Not sent yet.</p>
      ) : (
        <>
          <pre className="briefing-text">{detail.briefing}</pre>
          {images.length > 0 ? <p className="mono muted">with {images.length} image{images.length === 1 ? "" : "s"}: {images.join(", ")}</p> : null}
        </>
      )}
    </details>
  );
}

/**
 * The T3 turn behind a reply, as T3 shows it: the member's messages before its final one and the files it changed. The
 * board keeps only the final; this reads the rest from T3 when opened (T3's recent window of the thread).
 */
function TurnInT3({ t3 }: { t3: EngineT3Ref }) {
  const [turn, setTurn] = useState<Extract<ThreadItem, { kind: "reply" }> | "loading" | "gone" | null>(null);
  const load = () => {
    if (turn !== null) return;
    setTurn("loading");
    api
      .thread(t3.threadId)
      .then((view) => setTurn(view.items.find((item): item is Extract<ThreadItem, { kind: "reply" }> => item.kind === "reply" && item.runId === t3.runId) ?? "gone"))
      .catch(() => setTurn("gone"));
  };
  return (
    <details className="reply-progress turn-in-t3" onToggle={(event) => (event.currentTarget.open ? load() : undefined)}>
      <summary className="mono">turn in T3</summary>
      {turn === "loading" || turn === null ? (
        <p className="muted mono">reading T3…</p>
      ) : turn === "gone" ? (
        <p className="muted">T3 no longer shows this turn in the thread's recent window.</p>
      ) : (
        <>
          {turn.progress.length > 0 ? (
            <ol>
              {turn.progress.map((note, index) => (
                <li key={index}>
                  <span className="time mono">{time(note.at)}</span>
                  <Markdown text={note.text} className="md-small" />
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No messages before its final one.</p>
          )}
          {turn.files ? (
            <p className="mono muted">
              {turn.files.count} file{turn.files.count === 1 ? "" : "s"} changed <span className="add">+{turn.files.additions}</span> <span className="del">−{turn.files.deletions}</span>
            </p>
          ) : null}
        </>
      )}
    </details>
  );
}

/** Said after the member had already answered the request it is under (plan §5): a signal to look again. */
function AfterAnswer() {
  return (
    <span className="after-answer mono" title="Said after this member had already answered: the answer may have been early. Closed work is not reopened; ask again citing it if needed.">
      after answer
    </span>
  );
}

/** A note: the user's or a member's (no one is woken), or a turn or message from T3 the room did not start. */
function Note({ post }: { post: EnginePost }) {
  const { nameOf, seatOf, colorOf } = useRoom();
  const { typedInT3 } = useBoard();
  const note = post.note!;
  const nav = useNavProps(post);
  if (note.source === "deferred-cancel" || note.source === "keep-alive") return <StatusPost post={post} />;
  if (post.author === "$user" || post.author === "$system") {
    const fromT3 = note.source !== "post";
    const shown = fromT3 ? withoutT3ContextRefs(post.body, false) : post.body;
    return (
      <div className="chat-row from-user is-note" data-number={post.number} data-seq={post.seq} {...nav}>
        <div className="chat-stack">
          <div className="chat-head">
            <span className="you-mark mono" title={note.room ? "A note to the whole room: every member's next briefing carries it; nobody is woken" : undefined}>
              {post.author === "$system" || backroomNote(post) ? "Backroom" : fromT3 ? "you" : note.room ? "note to the room" : "note"}
            </span>
            {fromT3 ? (
              <span className="tag mono direct-tag" title="Typed in T3 Code on a member's thread; recorded on the board as a note, nobody is woken">
                in T3
              </span>
            ) : null}
            {post.about.length > 0 ? (
              <span className="mono muted">
                on {<Refs numbers={post.about.map((r) => r.number)} />}
              </span>
            ) : null}
            <Stamp post={post} />
          </div>
          <div className="bubble-line">
            <div className={`bubble ${fromT3 ? "bubble-user bubble-user-t3" : "bubble-note"}`}>{shown ? <UserText text={shown} /> : null}</div>
            <CopyTextButton text={shown} label="Copy note" className="bubble-side" />
          </div>
        </div>
      </div>
    );
  }
  const participant = seatOf(post.author).participant;
  const turn = note.source === "t3-turn";
  const selfStarted = turn && !(note.t3?.runId && typedInT3.has(note.t3.runId));
  return (
    <div className="chat-row from-agent is-note" style={identityStyle(participant ? colorOf(participant.id) : "var(--fg-muted)")} data-number={post.number} data-seq={post.seq} {...nav}>
      <div className="chat-stack">
        <div className="chat-head">
          {participant ? <Monogram participant={participant} size="xs" title={participant.alias} /> : null}
          <span className="speaker mono identity">{nameOf(post.author).replace(/^@/, "")}</span>
          {selfStarted ? (
            <span className="self-started mono" title="A turn the agent started itself (background work finished and woke it): recorded as a note, nobody is woken">
              <Glyph name="again" text="↻" /> continued on its own
            </span>
          ) : turn ? (
            <span className="tag mono direct-tag" title="Its reply to a turn typed in T3 Code; recorded as a note, nobody is woken">
              in T3
            </span>
          ) : note.source === "t3-message" ? (
            <span className="tag mono direct-tag" title="Sent with T3's own thread tools, not the board; recorded as a note">
              via T3
            </span>
          ) : (
            <span className="tag mono" title="A note on the board: nobody is woken">
              note
            </span>
          )}
          {note.afterAnswer ? <AfterAnswer /> : null}
          {post.about.length > 0 ? (
            <span className="mono muted">
              under {<Refs numbers={post.about.map((r) => r.number)} />}
            </span>
          ) : null}
          <Stamp post={post} />
        </div>
        <div className="bubble bubble-agent bubble-agent-note">
          {post.body ? <Markdown text={post.body} /> : null}
          {note.t3?.runId ? <TurnInT3 t3={note.t3} /> : null}
          <div className="reply-foot">
            <CopyTextButton text={post.body} label="Copy" />
            <ReplySpend post={post} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A follow-up (H5): a member's turn that answered nothing (one it started itself, or one typed in T3), or background work
 * that ended without a further turn. Its status line is at the top; it wakes the Consigliere.
 */
function FollowUp({ post }: { post: EnginePost }) {
  const { nameOf, seatOf, colorOf } = useRoom();
  const nav = useNavProps(post);
  const participant = seatOf(post.author).participant;
  const t3 = post.progress?.t3 ?? null;
  return (
    <div className="chat-row from-agent is-note is-follow-up" style={identityStyle(participant ? colorOf(participant.id) : "var(--fg-muted)")} data-number={post.number} data-seq={post.seq} {...nav}>
      <div className="chat-stack">
        <div className="chat-head">
          {participant ? <Monogram participant={participant} size="xs" title={participant.alias} /> : null}
          <span className="speaker mono identity">{nameOf(post.author).replace(/^@/, "")}</span>
          <span className="tag mono" title={t3 ? "A turn the room did not start (the agent continued on its own, or a turn typed in T3)" : "Background work that ended without a further turn"}>
            {t3 ? <><Glyph name="again" text="↻" /> follow-up</> : "follow-up"}
          </span>
          {post.about.length > 0 ? (
            <span className="mono muted">
              on {<Refs numbers={post.about.map((r) => r.number)} />}
            </span>
          ) : null}
          {post.to.length > 0 ? <span className="mono muted">→ {post.to.map(nameOf).join(", ")}</span> : null}
          <Stamp post={post} />
        </div>
        <div className="bubble bubble-agent bubble-agent-note">
          {post.body ? <Markdown text={post.body} /> : null}
          {t3?.runId ? <TurnInT3 t3={t3} /> : null}
          <div className="reply-foot">
            <CopyTextButton text={post.body} label="Copy" />
            <ReplySpend post={post} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A progress post: "@W working on #12: …". Wakes nobody unless someone follows the request. */
function Progress({ post }: { post: EnginePost }) {
  const { nameOf } = useRoom();
  const line = firstLine(post.body);
  const nav = useNavProps(post);
  if (post.progress?.milestone === "follow-up") return <FollowUp post={post} />;
  return (
    <div {...nav} className="chat-status mono progress-line" data-number={post.number} data-seq={post.seq} title={`${whenTitle(post)}${post.to.length > 0 ? ` · followed by ${post.to.map(nameOf).join(", ")}` : ""}`}>
      <span className="post-number">#{post.number}</span>
      <span className="speaker identity">{nameOf(post.author)}</span>
      {post.progress?.working ? <span className="turn-state turn-working">working</span> : <span className="tag">{post.progress?.milestone ?? "progress"}</span>}
      {post.about.length > 0 ? <span>on {<Refs numbers={post.about.map((r) => r.number)} />}</span> : null}
      <span className="status-text" title={post.body}>
        {line.length > 200 ? `${line.slice(0, 200)}…` : line}
      </span>
    </div>
  );
}

/** Something went wrong: a failed run, an undeliverable post, a late answer. Retry and Dismiss while it needs you. */
function Notice({ post }: { post: EnginePost }) {
  const notice = post.notice!;
  const nav = useNavProps(post);
  return (
    <div className={`chat-status notice-line notice-${notice.intent}${notice.needsYou ? " notice-needs" : ""}`} data-number={post.number} data-seq={post.seq} title={whenTitle(post)} {...nav}>
      <span className="post-number mono">#{post.number}</span>
      <span className="notice-mark mono">{notice.intent === "error" ? "failed" : "attention"}</span>
      {post.about.length > 0 ? <span className="mono">on {<Refs numbers={post.about.map((r) => r.number)} />}</span> : null}
      <span className="status-text">{post.body}</span>
      {notice.needsYou ? <span className="pill pill-input">needs you</span> : null}
      {notice.retried ? <span className="mono muted">retried</span> : null}
      {notice.dismissed && !notice.retried ? <span className="mono muted">dismissed</span> : null}
      <NoticeActions post={post} />
    </div>
  );
}

/** Retry (the failed run, with its original content) and Dismiss (off your list, still on the board). */
export function NoticeActions({ post }: { post: EnginePost }) {
  const { runCommand, snapshot, refetch } = useRoom();
  const [busy, setBusy] = useState(false);
  const notice = post.notice;
  if (!notice || (!notice.retryRunId && !notice.needsYou)) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="notice-actions">
      {notice.retryRunId ? (
        <button type="button" className="small primary" disabled={busy} title="Send the failed turn again, with what it was given" onClick={() => void act(() => runCommand({ type: "run.retry", roomId: snapshot.room.id, runId: notice.retryRunId! }))}>
          Retry
        </button>
      ) : null}
      {notice.needsYou ? (
        <button
          type="button"
          className="small"
          disabled={busy}
          title="Take it off your list without retrying; it stays on the board"
          onClick={() => void act(() => api.dismissNotices(snapshot.room.id, { ids: [post.id] }).then(refetch))}
        >
          Dismiss
        </button>
      ) : null}
    </span>
  );
}

/** A delivery the engine could not make: the post is over the byte budget for that member. */
function Blocked({ post }: { post: EnginePost }) {
  const { nameOf } = useRoom();
  const blocked = post.blocked!;
  const nav = useNavProps(post);
  return (
    <div className="chat-status notice-line notice-blocked" data-number={post.number} data-seq={post.seq} title={whenTitle(post)} {...nav}>
      <span className="post-number mono">#{post.number}</span>
      <span className="notice-mark mono">blocked delivery</span>
      <span className="status-text">
        {blocked.number !== null ? <Ref number={blocked.number} /> : "A post"} cannot reach {nameOf(blocked.seatId)}: it needs {blocked.requiredBytes.toLocaleString()} bytes, over the delivery budget (ROOMS_ENVELOPE_BYTES).
      </span>
    </div>
  );
}

/** Corrections, cancels, retries, handovers, keep-alives and the replies to them: one line each. */
function StatusPost({ post }: { post: EnginePost }) {
  const { nameOf } = useRoom();
  const nav = useNavProps(post);
  const refs = <Refs numbers={post.about.map((r) => r.number)} />;
  let text: ReactNode;
  switch (post.kind) {
    case "correction":
      text = (
        <>
          {nameOf(post.author)} corrected {refs}: <span className="status-body">{firstLine(post.body)}</span>
        </>
      );
      break;
    case "cancel":
      text = (
        <>
          {nameOf(post.author)} {post.cancel?.applied ? "cancelled" : "asked to cancel"} {refs}
          {post.cancel?.applied ? "" : " (it applies when the turn ends)"}
        </>
      );
      break;
    case "retry":
      text = (
        <>
          {nameOf(post.author)} retried a failed turn{post.about.length > 0 ? <> on {refs}</> : null}
        </>
      );
      break;
    case "notice":
      // A keep-alive (H6): the full text, with the status lines of the work in flight, is in the row's title.
      text = <>Backroom kept {post.to.map(nameOf).join(", ")} warm while work is in flight</>;
      break;
    case "transfer":
      text = (
        <>
          {nameOf(post.transfer?.oldSeatId ?? "")}'s open work handed to its fresh seat{post.about.length > 0 ? <>: {refs}</> : null}
        </>
      );
      break;
    default:
      text = (
        <>
          {nameOf(post.author)}: {firstLine(post.body)}
        </>
      );
  }
  return (
    <div className="chat-status mono" data-number={post.number} data-seq={post.seq} title={`${whenTitle(post)}\n${post.body}`} {...nav}>
      <span className="post-number">#{post.number}</span>
      <span className="status-text">{text}</span>
    </div>
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

/**
 * A run of a member that has not ended, at the bottom: what it works on, its phase (an uncertain one says so), the
 * approvals and questions T3 is waiting on for it, and its turn live from T3 once T3 runs it.
 */
function LiveRunBubble({ run }: { run: EngineRunView }) {
  const { snapshot, desk, colorOf, seatOf, runCommand } = useRoom();
  const { requestPost } = useBoard();
  const participant = seatOf(run.seatId).participant;
  const participantDesk = participant ? desk?.participants[participant.id] : undefined;
  // The feed is this run's once T3 runs it: the desk says the running T3 run is the room's.
  const running = participantDesk?.runningRun;
  const feedIsOurs = Boolean(running?.startedByRoom && (run.t3RunId === null || running.runId === run.t3RunId));
  const items = feedIsOurs ? (participantDesk?.liveFeed ?? []) : [];
  const requests = snapshot.nativeRequests.filter((request) => request.participantId === participant?.id);
  const numbers = run.requestIds.map((id) => requestPost(id)?.number ?? snapshot.requests.find((q) => q.id === id)?.number ?? null).filter((n): n is number => n !== null);
  const alias = participant?.alias ?? "member";
  const speaker = <span className="speaker mono identity">{alias}</span>;
  const uncertain = run.phase === "uncertain";
  const label = requests.length > 0 ? "needs you" : PHASE_WORDS[run.phase];
  return (
    <div className={`chat-row from-agent live-turn${uncertain ? " live-uncertain" : ""}`} style={identityStyle(participant ? colorOf(participant.id) : "var(--fg-muted)")} aria-live="off" data-run={run.id}>
      <div className="chat-stack">
        <div className="chat-head">
          {participant ? <Monogram participant={participant} size="xs" title={alias} /> : null}
          {speaker}
          {numbers.length > 0 ? (
            <span className="reply-to mono">
              on{" "}
              <Refs numbers={numbers} />
            </span>
          ) : null}
          <span className={`live-working mono${uncertain ? " live-uncertain-mark" : ""}`} title={uncertain ? "Backroom cannot tell whether T3 received this turn: it keeps looking and never sends it twice" : PHASE_WORDS[run.phase]}>
            {uncertain ? null : <span className="dot dot-working" aria-hidden="true" />} {label}
          </span>
          {participant && (run.phase === "running" || run.phase === "accepted" || run.phase === "uncertain") ? (
            <button type="button" className="link-button danger" title="Stop the turn through T3" onClick={() => void runCommand({ type: "run.stop", roomId: snapshot.room.id, participantId: participant.id })}>
              Stop
            </button>
          ) : null}
        </div>
        <div className="bubble bubble-agent bubble-live" aria-label={`${alias} is working`}>
          {uncertain ? (
            <div className="status-warn">Uncertain: Backroom cannot tell whether T3 received this turn. It keeps checking and does not send it twice.</div>
          ) : null}
          {run.phase === "rejected" ? <div className="status-error">T3 refused this turn{run.failure ? `: ${run.failure}` : ""}.</div> : null}
          {requests.length > 0 ? (
            <div className="native-requests thread-requests" role="group" aria-label={`${alias} is waiting for you`}>
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
          <FileBaseContext.Provider value={participantDesk?.worktreePath ?? null}>
            <LiveFeed items={items} placeholder={run.phase === "prepared" || run.phase === "sending" ? "Sending to T3…" : uncertain ? "Waiting to hear from T3…" : "Thinking…"} className="live-feed-chat" />
          </FileBaseContext.Provider>
          {run.phase !== "prepared" ? <SentToT3 runId={run.id} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A turn on a member's thread the room did not start (typed in T3, or the agent woke itself), still running: its
 * prompt, and the turn live. When it ends the service imports it as notes and this goes away.
 */
function LiveTurnBubble({ participant, desk, promptOnBoard }: { participant: Participant; desk: Desk; promptOnBoard: boolean }) {
  const { snapshot, colorOf, runCommand } = useRoom();
  const running = desk.runningRun!;
  const requests = snapshot.nativeRequests.filter((request) => request.participantId === participant.id);
  const speaker = <span className="speaker mono identity">{participant.alias}</span>;
  return (
    <>
      {/* The prompt, until the service imports it as the user's note (it does while the turn still runs). */}
      {running.prompt && !promptOnBoard ? (
        <div className="chat-row from-user">
          <div className="chat-stack">
            <div className="chat-head">
              <span className="you-mark mono">you</span>
              <span className="tag mono direct-tag" title="Typed directly in T3 Code on this member's thread">
                in T3
              </span>
            </div>
            <div className="bubble bubble-user bubble-user-t3">
              <UserText text={withoutT3ContextRefs(running.prompt, (running.promptImages ?? []).length > 0)} />
            </div>
          </div>
        </div>
      ) : null}
      <div className="chat-row from-agent live-turn" style={identityStyle(colorOf(participant.id))} aria-live="off">
        <div className="chat-stack">
          <div className="chat-head">
            <Monogram participant={participant} size="xs" title={participant.alias} />
            {speaker}
            <span className="tag mono direct-tag" title="A turn the room did not start: typed in T3 Code, or the agent continued on its own">
              {running.prompt ? "in T3" : "on its own"}
            </span>
            <span className="live-working mono">
              <span className="dot dot-working" aria-hidden="true" /> {requests.length > 0 ? "needs you" : "working"}
            </span>
          </div>
          <div className="bubble bubble-agent bubble-live bubble-direct" aria-label={`${participant.alias} is working`}>
            {requests.length > 0 ? (
              <div className="native-requests thread-requests" role="group" aria-label={`${participant.alias} is waiting for you`}>
                {requests.map((request) =>
                  request.kind === "approval" ? (
                    <ApprovalRequestCard key={request.requestId} payload={request.payload} speaker={speaker} onRespond={async (decision) => void (await runCommand({ type: "native.approval.respond", participantId: request.participantId, requestId: request.requestId, decision }))} />
                  ) : (
                    <UserInputRequestCard
                      key={request.requestId}
                      requestId={request.requestId}
                      payload={request.payload}
                      speaker={speaker}
                      onSubmit={async (answers) => void (await runCommand({ type: "native.userInput.respond", participantId: request.participantId, requestId: request.requestId, answers }))}
                      onDismiss={async () => void (await runCommand({ type: "native.userInput.dismiss", participantId: request.participantId, requestId: request.requestId }))}
                    />
                  ),
                )}
              </div>
            ) : null}
            <FileBaseContext.Provider value={desk.worktreePath ?? null}>
              <LiveFeed items={desk.liveFeed} placeholder="Thinking…" className="live-feed-chat" />
            </FileBaseContext.Provider>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * What the turn behind a reply used, at list price: everything its thread used since the thread's previous reply,
 * subagents included. Only the post that carries a T3 run has a figure (spend is counted once per T3 run). The
 * tooltip adds the running total since the user's last request, over this member's turns since.
 */
function ReplySpend({ post }: { post: EnginePost }) {
  const { snapshot, costs, seatOf } = useRoom();
  const spend = costs?.replies[post.id];
  if (!spend || !spend.available || spend.total.calls === 0) return null;
  const participantId = seatOf(post.author).participant?.id ?? null;
  let since = 0;
  let turns = 0;
  let found = false;
  const posts = snapshot.posts;
  for (let index = posts.findIndex((p) => p.id === post.id); index >= 0; index -= 1) {
    const earlier = posts[index]!;
    if (earlier.author === "$user" && earlier.kind === "request") {
      found = true;
      break;
    }
    if (participantId !== null && seatOf(earlier.author).participant?.id === participantId) {
      const part = costs?.replies[earlier.id];
      if (part?.available) {
        since += part.total.costUsd;
        turns += 1;
      }
    }
  }
  // The page holds the room's latest posts only: when your last request is older, the total runs from the oldest held.
  const first = posts[0];
  const from = found || !first || !snapshot.earlier ? null : first;
  return <SpendFoot spend={spend} since={since} turns={turns} from={from ? `#${from.number} (the earliest loaded)` : null} />;
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

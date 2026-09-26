/**
 * A T3 thread used on its own, outside any room. The conversation is read from T3 on every poll and nothing is stored
 * by the room service. What you type goes to T3 as typed (no room briefing), like typing in T3 Code.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, ApiError, attachmentUrl } from "../api.ts";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MIME_TYPES,
  RUNTIME_MODES,
  type CommandResult,
  type InlineImage,
  type ModelSelection,
  type RoomCommand,
  type BrowserListItem,
  type RoomListItem,
  type RuntimeMode,
  type T3Project,
  type T3ThreadShell,
  type ThreadItem,
  type ThreadView as ThreadViewData,
} from "../types.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { Dialog } from "./Dialog.tsx";
import { LiveFeed } from "./LiveFeed.tsx";
import { Markdown } from "./Markdown.tsx";
import { identityStyle, participantColor } from "./Monogram.tsx";
import { ApprovalRequestCard, UserInputRequestCard } from "./NativeRequests.tsx";
import { CopyButton, ModelPicker } from "./pickers.tsx";
import { PageTitle } from "./PageTitle.tsx";
import { Popover } from "./Popover.tsx";
import { GlobeIcon } from "./RoomBrowser.tsx";
import { useToast } from "./Toast.tsx";

type RunCommand = (command: RoomCommand) => Promise<CommandResult | null>;

const AGENT_COLOR = participantColor(0);
const STICK_PX = 40;

const time = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export type ThreadActivity = { label: string; tone: "input" | "working" | "background" | "error" | "idle" };

/** What a thread is doing, as one short label: needs you, working, background, error, or idle. */
export function threadActivity(thread: Pick<T3ThreadShell, "session" | "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness">): ThreadActivity {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return { label: "needs you", tone: "input" };
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return { label: status === "starting" ? "starting" : "working", tone: "working" };
  if (thread.backgroundLiveness === "working") return { label: "background", tone: "background" };
  if (thread.backgroundLiveness === "monitoring") return { label: "monitoring", tone: "background" };
  if (status === "error") return { label: "error", tone: "error" };
  return { label: "idle", tone: "idle" };
}

/** Poll the thread: every 1.5s while it works or waits on you (and briefly after a send), else every 5s. */
function useThreadView(threadId: string, onGone: () => void): { view: ThreadViewData | null; error: string | null; refresh: () => void; hurry: () => void } {
  const [view, setView] = useState<ThreadViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const fastUntil = useRef(0);
  // A thread just started may not be readable yet; it only counts as gone after it was seen, or after a few tries.
  const misses = useRef(0);
  const seen = useRef(false);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    setView(null);
    setError(null);
    misses.current = 0;
    seen.current = false;
  }, [threadId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let busy = Date.now() < fastUntil.current;
      try {
        const data = await api.thread(threadId);
        if (cancelled) return;
        setView(data);
        setError(null);
        seen.current = true;
        misses.current = 0;
        busy = busy || data.running !== null || data.requests.length > 0 || data.thread.session?.status === "starting";
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 404) {
          misses.current += 1;
          if (seen.current || misses.current >= 5) {
            cancelled = true;
            gone.current();
            return;
          }
          busy = true;
        } else {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
      if (!cancelled) timer = setTimeout(tick, busy ? 1500 : 5000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [threadId, nonce]);
  return {
    view,
    error,
    refresh: useCallback(() => setNonce((n) => n + 1), []),
    hurry: useCallback(() => {
      fastUntil.current = Date.now() + 10_000;
      setNonce((n) => n + 1);
    }, []),
  };
}

interface ThreadViewProps {
  threadId: string;
  rooms: RoomListItem[];
  /** Shared browsers; null when the service cannot run them. */
  browsers: BrowserListItem[] | null;
  runCommand: RunCommand;
  /** The thread is gone from T3 (deleted), or was deleted here. */
  onGone: () => void;
  /** Something the sidebar shows changed (title, status, lifecycle). */
  onChanged: () => void;
  /** Archived here: T3 stops serving the conversation, so the archived panel takes over. */
  onArchived: () => void;
  onOpenRoom: (roomId: string) => void;
  headerStart: ReactNode;
}

export function ThreadView({ threadId, rooms, browsers, runCommand, onGone, onChanged, onArchived, onOpenRoom, headerStart }: ThreadViewProps) {
  const { view, error, refresh, hurry } = useThreadView(threadId, onGone);
  // A browser attached here: its instructions go in front of the next message (threads outside rooms get no briefing).
  const [attached, setAttached] = useState<string | null>(null);
  const { toast } = useToast();
  const attachedBrowser = attached ? browsers?.find((b) => b.id === attached) ?? null : null;
  const [dialog, setDialog] = useState<"settings" | "room" | "delete" | null>(null);
  const thread = view?.thread;
  const activity = thread ? threadActivity({ ...thread, hasPendingApprovals: thread.hasPendingApprovals || (view?.requests.length ?? 0) > 0 }) : null;
  const running = view?.running ?? null;

  const lifecycle = async (action: "settle" | "unsettle" | "archive" | "delete") => {
    const result = await runCommand({ type: "thread.lifecycle", threadId, action });
    if (!result) return;
    onChanged();
    if (action === "archive") onArchived();
    else if (action === "delete") onGone();
    else refresh();
  };

  return (
    <>
      <div className="room-header thread-header">
        {headerStart}
        <PageTitle context={view?.project?.title ?? null} contextTitle={view?.project?.workspaceRoot} name={thread?.title ?? "Thread"} />
        {activity && activity.tone !== "idle" ? <span className={`pill thread-pill tone-${activity.tone}`}>{activity.label}</span> : null}
        <span className="spacer" />
        {thread && browsers ? (
          <ThreadBrowserButton
            browsers={browsers}
            lastUsed={lastThreadBrowser(threadId)}
            attached={attached}
            onAttach={setAttached}
          />
        ) : null}
        {thread ? (
          <ThreadMenu
            onSettings={() => setDialog("settings")}
            onAddToRoom={() => setDialog("room")}
            settled={Boolean(thread.settledAt)}
            onToggleSettled={() => void lifecycle(thread.settledAt ? "unsettle" : "settle")}
            onArchive={() => void lifecycle("archive")}
            onDelete={() => setDialog("delete")}
          />
        ) : null}
      </div>
      <div className="room-under">
        {thread ? (
          <div className="thread-bar">
            <button type="button" className="thread-setting" onClick={() => setDialog("settings")} title="Model and permission mode (applied in T3)">
              <span className="mono">{thread.modelSelection.model}</span>
              <span className={`pill pill-mode mode-${thread.runtimeMode}`}>{thread.runtimeMode}</span>
            </button>
            {view?.contextWindow ? <ContextMeter reading={view.contextWindow} compact /> : null}
            {thread.branch ? (
              <span className="mono muted thread-branch" title={thread.worktreePath ?? undefined}>
                ⎇ {thread.branch}
              </span>
            ) : null}
            <span className="spacer" />
            <span className="muted mono thread-direct-note" title="Messages go to T3 exactly as typed. No room briefing, no queue.">
              direct thread
            </span>
          </div>
        ) : null}
        <div className="room-body">
          <div className="room-centre">
            <div className="timeline-wrap">
              <Transcript
                key={threadId}
                view={view}
                error={error}
                onRespond={async (command) => {
                  const result = await runCommand(command);
                  if (result) hurry();
                }}
              />
            </div>
            {thread?.boundToRoom ? (
              <p className="chat-status mono thread-partial">This thread is now a participant in a room; talk to it from the room.</p>
            ) : null}
            <ThreadComposer
              key={threadId}
              placeholder={running ? "Message the running turn: T3 steers it in or queues it, as its own client does" : "Message this thread"}
              disabled={!thread || thread.boundToRoom}
              running={running !== null}
              onStop={async () => {
                if (await runCommand({ type: "thread.interrupt", threadId })) hurry();
              }}
              notice={
                attachedBrowser ? (
                  <>
                    <span>
                      Browser <span className="mono">{attachedBrowser.name}</span>: its instructions go with your next message.
                    </span>
                    <span className="spacer" />
                    <button type="button" className="small ghost" onClick={() => setAttached(null)}>
                      Don&rsquo;t send
                    </button>
                  </>
                ) : null
              }
              onSend={async (text, images) => {
                const withBrowser = attached ? await withBrowserInstructions(threadId, attached, text, toast) : text;
                if (withBrowser === null) return false;
                const result = await runCommand({ type: "thread.send", threadId, text: withBrowser, images });
                if (result) {
                  if (attached) rememberThreadBrowser(threadId, attached);
                  setAttached(null);
                  hurry();
                  onChanged();
                }
                return result !== null;
              }}
            />
          </div>
        </div>
      </div>
      {dialog === "settings" && thread ? (
        <ThreadSettingsDialog
          thread={thread}
          runCommand={runCommand}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
      {dialog === "room" && thread ? <AddToRoomDialog thread={thread} rooms={rooms} runCommand={runCommand} onClose={() => setDialog(null)} onAdded={onOpenRoom} /> : null}
      {dialog === "delete" && thread ? (
        <Dialog title="Delete thread" onClose={() => setDialog(null)}>
          <p className="remove-lede">
            Delete <strong>{thread.title}</strong> in T3 Code? Its conversation is removed there for good. Archive it instead to hide it and keep it.
          </p>
          <div className="dialog-actions">
            <button type="button" className="ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="button" className="primary destructive" data-autofocus onClick={() => void lifecycle("delete")}>
              Delete in T3
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

// ---- archived thread ----

/**
 * An archived thread. T3 keeps it but serves neither its conversation nor its state by id until it is unarchived,
 * so this shows what the thread list carries and offers the two ways out.
 */
export function ArchivedThreadView({
  thread,
  project,
  runCommand,
  onUnarchived,
  onGone,
  headerStart,
}: {
  thread: T3ThreadShell;
  project: T3Project | null;
  runCommand: RunCommand;
  onUnarchived: () => void;
  onGone: () => void;
  headerStart: ReactNode;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: "unarchive" | "delete") => {
    setBusy(true);
    const result = await runCommand({ type: "thread.lifecycle", threadId: thread.id, action });
    setBusy(false);
    if (!result) return;
    if (action === "unarchive") onUnarchived();
    else onGone();
  };
  const archivedOn = thread.archivedAt ? new Date(thread.archivedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <>
      <div className="room-header thread-header">
        {headerStart}
        <PageTitle context={project?.title ?? null} contextTitle={project?.workspaceRoot} name={thread.title} />
        <span className="pill pill-muted">archived</span>
        <span className="spacer" />
      </div>
      <div className="empty-state archived-thread">
        <p className="serif">Archived in T3{archivedOn ? ` on ${archivedOn}` : ""}.</p>
        <p className="muted">
          T3 keeps an archived thread but does not serve its conversation. Unarchive it to read it or continue it here; it keeps its model (
          <span className="mono">{thread.modelSelection.model}</span>), permission mode and history.
        </p>
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void run("unarchive")}>
            Unarchive
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete…
          </button>
        </div>
      </div>
      {confirmDelete ? (
        <Dialog title="Delete thread" onClose={() => setConfirmDelete(false)}>
          <p className="remove-lede">
            Delete <strong>{thread.title}</strong> in T3 Code? T3 keeps no record a client can list or restore afterwards.
          </p>
          <div className="dialog-actions">
            <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" className="primary destructive" data-autofocus disabled={busy} onClick={() => void run("delete")}>
              Delete in T3
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

// ---- new thread (fast start) ----

interface NewThreadViewProps {
  projectId: string;
  projects: T3Project[];
  browsers: BrowserListItem[] | null;
  runCommand: RunCommand;
  onProject: (projectId: string) => void;
  onStarted: (threadId: string) => void;
  headerStart: ReactNode;
}

export function NewThreadView({ projectId, projects, browsers, runCommand, onProject, onStarted, headerStart }: NewThreadViewProps) {
  const [browserId, setBrowserId] = useState<string>("");
  const { toast } = useToast();
  const [model, setModel] = useState<ModelSelection | null>(null);
  // T3's default model for the project is looked up first; the picker only falls back to the catalog default without one.
  const [modelReady, setModelReady] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(() => (localStorage.getItem(MODE_KEY) as RuntimeMode | null) ?? "full-access");
  const project = projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setModelReady(false);
    api
      .defaultModel(projectId)
      .then(({ modelSelection }) => {
        if (!cancelled) setModel((current) => modelSelection ?? current);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setModelReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <>
      <div className="room-header thread-header">
        {headerStart}
        <PageTitle context={project?.title ?? null} contextTitle={project?.workspaceRoot} name="New thread" />
        <span className="spacer" />
      </div>
      <div className="room-under">
        <div className="room-body">
          <div className="room-centre">
            <div className="timeline-wrap">
              <div className="timeline">
                <div className="timeline-content">
                  <div className="thread-start form">
                    <p className="muted">A thread on its own: no room, no crew. What you type goes to T3 as typed, like typing in T3 Code.</p>
                    <label>
                      Project
                      <select value={projectId} onChange={(e) => onProject(e.target.value)}>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title} — {p.workspaceRoot}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Model
                      {modelReady ? <ModelPicker value={model} onChange={setModel} /> : <span className="muted mono model-pending">looking up T3&rsquo;s default model…</span>}
                    </label>
                    <label>
                      Permission mode
                      <select
                        value={runtimeMode}
                        onChange={(e) => {
                          setRuntimeMode(e.target.value as RuntimeMode);
                          localStorage.setItem(MODE_KEY, e.target.value);
                        }}
                      >
                        {RUNTIME_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </select>
                      <span className="hint">Enforced by T3 for this thread. You can change it later.</span>
                    </label>
                    {browsers ? (
                      <label>
                        Browser
                        <select value={browserId} onChange={(e) => setBrowserId(e.target.value)}>
                          <option value="">none</option>
                          {browsers.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <span className="hint">
                          {browserId
                            ? browsers.find((b) => b.id === browserId)?.description || "The browser's instructions go with the first message."
                            : "Give the agent a shared browser: its instructions go with the first message. You can add one later."}
                        </span>
                      </label>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <ThreadComposer
              key={projectId}
              autoFocus
              placeholder="What should this thread do?"
              disabled={!project || !model}
              running={false}
              onSend={async (text, images) => {
                if (!model) return false;
                // The thread's id is chosen here so the browser key in the first message is the thread's own.
                const threadId = crypto.randomUUID();
                const first = browserId ? await withBrowserInstructions(threadId, browserId, text, toast) : text;
                if (first === null) return false;
                const result = await runCommand({ type: "thread.start", projectId, threadId, text: first, images, modelSelection: model, runtimeMode });
                if (result && browserId) rememberThreadBrowser(threadId, browserId);
                if (result && result.type === "thread.started" && "threadId" in result) {
                  onStarted(result.threadId as string);
                  return true;
                }
                return false;
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

const MODE_KEY = "t3rooms.directMode";

// ---- browsers for threads outside rooms ----

const THREAD_BROWSER_KEY = "t3rooms.threadBrowser.";
const lastThreadBrowser = (threadId: string): string | null => localStorage.getItem(THREAD_BROWSER_KEY + threadId);
const rememberThreadBrowser = (threadId: string, browserId: string): void => localStorage.setItem(THREAD_BROWSER_KEY + threadId, browserId);
/** The agent key of a thread outside rooms: tabs it opens with it are its own. */
const threadBrowserKey = (threadId: string): string => `thread.${threadId.slice(0, 8)}`;

/** The browsers section (every browser, this one as default, started now) in front of the user's text; null on failure. */
async function withBrowserInstructions(threadId: string, browserId: string, text: string, toast: (message: string) => void): Promise<string | null> {
  try {
    const { text: instructions } = await api.browserBriefing(threadBrowserKey(threadId), browserId);
    return text.trim() ? `${instructions}\n\n${text}` : instructions;
  } catch (error) {
    toast(`The browser instructions could not be prepared: ${error instanceof ApiError ? error.message : String(error)}`);
    return null;
  }
}

function ThreadBrowserButton({
  browsers,
  lastUsed,
  attached,
  onAttach,
}: {
  browsers: BrowserListItem[];
  lastUsed: string | null;
  attached: string | null;
  onAttach: (browserId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(attached ?? lastUsed ?? browsers[0]?.id ?? "");
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const used = browsers.find((b) => b.id === (attached ?? lastUsed));
  const chosen = browsers.find((b) => b.id === choice);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`small thread-browser-button${attached ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={attached && used ? `Browser "${used.name}": its instructions go with your next message` : used ? `Browser: ${used.name}` : "Give this thread a shared browser"}
        title={attached && used ? `Browser "${used.name}": its instructions go with your next message` : used ? `Browser: ${used.name}` : "Give this thread a shared browser"}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon checked={Boolean(attached)} failed={used?.status.state === "error"} />
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="dialog" className="browser-panel" onClose={() => setOpen(false)}>
          <label className="browser-default">
            <span className="label">Browser</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {browsers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {chosen?.description ? <p className="hint browser-purpose">{chosen.description}</p> : null}
          <p className="hint">
            A thread outside a room gets no briefing, so the browser&rsquo;s instructions travel with your next message, once. Add them again if the agent loses track.
          </p>
          <div className="dialog-actions">
            {attached ? (
              <button
                type="button"
                onClick={() => {
                  onAttach(null);
                  setOpen(false);
                }}
              >
                Don&rsquo;t send
              </button>
            ) : null}
            <button
              type="button"
              className="primary"
              disabled={!choice}
              onClick={() => {
                onAttach(choice);
                setOpen(false);
              }}
            >
              Add to my next message
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

// ---- transcript ----

function Transcript({ view, error, onRespond }: { view: ThreadViewData | null; error: string | null; onRespond: (command: RoomCommand) => Promise<void> }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const signature = view
    ? `${view.items.length}:${view.items[view.items.length - 1]?.id ?? ""}:${view.running?.feed.length ?? -1}:${view.running?.feed[view.running.feed.length - 1]?.at ?? ""}:${view.requests.length}`
    : "";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [signature]);

  if (!view) {
    return (
      <div className="timeline">
        <div className="timeline-content">
          <p className="muted thread-loading">{error ? `Could not read the thread from T3: ${error}` : "Loading thread…"}</p>
        </div>
      </div>
    );
  }
  const thread = view.thread;
  const speaker = (
    <span className="speaker mono identity" style={identityStyle(AGENT_COLOR)}>
      {thread.modelSelection.model}
    </span>
  );
  return (
    <div
      className="timeline"
      ref={scroller}
      role="log"
      aria-label="Thread"
      onScroll={() => {
        const el = scroller.current;
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
    >
      <div className="timeline-content">
        {view.partial ? <div className="chat-status mono thread-partial">Earlier turns are in T3 Code</div> : null}
        {view.items.length === 0 && !view.running ? <p className="muted thread-loading">No messages yet.</p> : null}
        {view.items.map((item, index) => (item.kind === "user" ? <UserRow key={item.id} item={item} continued={view.items[index - 1]?.kind === "user"} /> : <ReplyRow key={item.id} item={item} speaker={speaker} />))}
        {view.running ? (
          <div className="chat-row from-agent live-turn wide" style={identityStyle(AGENT_COLOR)} aria-live="off">
            <div className="chat-stack">
              <div className="chat-head">
                {speaker}
                <span className="live-working mono">
                  <span className="dot dot-working" aria-hidden="true" /> {view.requests.length > 0 ? "needs you" : "working"}
                </span>
              </div>
              <div className="bubble bubble-agent bubble-live">
                <LiveFeed items={view.running.feed} placeholder="Thinking…" className="live-feed-chat" />
              </div>
            </div>
          </div>
        ) : null}
        {view.requests.length > 0 ? (
          <div className="native-requests thread-requests" role="group" aria-label="Waiting for you">
            {view.requests.map((request) =>
              request.kind === "approval" ? (
                <ApprovalRequestCard
                  key={request.requestId}
                  payload={request.payload}
                  speaker={speaker}
                  onRespond={(decision) => onRespond({ type: "thread.approval.respond", threadId: thread.id, requestId: request.requestId, decision })}
                />
              ) : (
                <UserInputRequestCard
                  key={request.requestId}
                  requestId={request.requestId}
                  payload={request.payload}
                  speaker={speaker}
                  onSubmit={(answers) => onRespond({ type: "thread.userInput.respond", threadId: thread.id, requestId: request.requestId, answers })}
                />
              ),
            )}
          </div>
        ) : null}
        {thread.session?.status === "error" && thread.session.lastError ? (
          <div className="chat-status chat-system thread-error" role="alert">
            <span className="status-text">T3: {thread.session.lastError}</span>
          </div>
        ) : null}
        {error ? <div className="chat-status mono thread-partial">Showing the last reading; T3 did not answer: {error}</div> : null}
      </div>
    </div>
  );
}

function UserRow({ item, continued }: { item: Extract<ThreadItem, { kind: "user" }>; continued: boolean }) {
  return (
    <div className={`chat-row from-user${continued ? " continued" : ""}`}>
      <div className="chat-stack">
        {!continued ? (
          <div className="chat-head">
            <span className="you-mark mono">you</span>
            <span className="time mono">{time(item.at)}</span>
          </div>
        ) : null}
        <div className="bubble bubble-user">
          {item.text ? <div className="user-text">{item.text}</div> : null}
          {item.attachmentIds.length > 0 ? (
            <div className="event-images">
              {item.attachmentIds.map((id) => (
                <a key={id} href={attachmentUrl(id)} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={attachmentUrl(id)} alt="Attached image" loading="lazy" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const isLong = (text: string): boolean => text.length > 600 || /^\s*\|.*\|\s*$/m.test(text) || text.includes("```");

function ReplyRow({ item, speaker }: { item: Extract<ThreadItem, { kind: "reply" }>; speaker: ReactNode }) {
  return (
    <div className={`chat-row from-agent${isLong(item.text) ? " wide" : ""}`} style={identityStyle(AGENT_COLOR)}>
      <div className="chat-stack">
        <div className="chat-head">
          {speaker}
          {item.state ? <span className={`tag mono thread-turn-${item.state}`}>{item.state === "error" ? "failed" : "interrupted"}</span> : null}
          <span className="time mono">{time(item.at)}</span>
        </div>
        <div className="bubble bubble-agent">
          {item.progress.length > 0 ? (
            <details className="reply-progress">
              <summary className="mono">
                {item.progress.length} progress update{item.progress.length === 1 ? "" : "s"}
              </summary>
              <ol>
                {item.progress.map((note, index) => (
                  <li key={index}>
                    <span className="time mono">{time(note.at)}</span>
                    <Markdown text={note.text} className="md-small" />
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <Markdown text={item.text} />
          {item.files ? (
            <div className="thread-files mono muted">
              {item.files.count} file{item.files.count === 1 ? "" : "s"} changed <span className="add">+{item.files.additions}</span>{" "}
              <span className="del">−{item.files.deletions}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---- composer ----

interface PendingImage {
  key: string;
  name: string;
  sizeBytes: number;
  dataUrl: string | null;
  error: string | null;
}

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

const readDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.readAsDataURL(file);
  });

/** Plain composer for a direct thread: Enter sends (Shift+Enter for a new line), images by button, paste or drop. */
function ThreadComposer({
  placeholder,
  disabled,
  running,
  autoFocus,
  notice,
  onSend,
  onStop,
}: {
  placeholder: string;
  disabled: boolean;
  running: boolean;
  autoFocus?: boolean;
  /** Shown above the text box (what will go with the next message). */
  notice?: ReactNode;
  onSend: (text: string, images: InlineImage[]) => Promise<boolean>;
  onStop?: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const touchKeyboard = useMediaQuery(COARSE_POINTER_QUERY);

  useEffect(() => {
    if (autoFocus && !touchKeyboard) textarea.current?.focus();
  }, [autoFocus, touchKeyboard]);

  const attach = (files: File[]) => {
    let total = images.filter((i) => !i.error).reduce((sum, i) => sum + i.sizeBytes, 0);
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const base = { key, name: file.name || "image", sizeBytes: file.size, dataUrl: null };
      const problem = !ATTACHMENT_MIME_TYPES.has(file.type)
        ? "only PNG, JPEG, GIF, or WebP images"
        : file.size > ATTACHMENT_MAX_BYTES
          ? "larger than 10 MB"
          : total + file.size > ATTACHMENT_MAX_TOTAL_BYTES
            ? "images can total 80 MB per message"
            : null;
      if (problem) {
        setImages((list) => [...list, { ...base, error: problem }]);
        continue;
      }
      total += file.size;
      setImages((list) => [...list, { ...base, error: null }]);
      readDataUrl(file).then(
        (dataUrl) => setImages((list) => list.map((i) => (i.key === key ? { ...i, dataUrl } : i))),
        (error: unknown) => setImages((list) => list.map((i) => (i.key === key ? { ...i, error: error instanceof Error ? error.message : String(error) } : i))),
      );
    }
  };

  const ready = images.filter((i): i is PendingImage & { dataUrl: string } => i.dataUrl !== null && !i.error);
  const reading = images.some((i) => !i.dataUrl && !i.error);
  const canSend = !disabled && !busy && !reading && (text.trim().length > 0 || ready.length > 0);

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const sent = await onSend(text, ready.map((i) => ({ name: i.name, dataUrl: i.dataUrl })));
      if (sent) {
        setText("");
        setImages([]);
      }
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same keys as the room composer: Enter sends, Shift+Enter is a new line; the on-screen keyboard's Enter is a new line.
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !touchKeyboard && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    attach(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    attach([...event.dataTransfer.files]);
  };

  return (
    <div
      className={`composer thread-composer${dragging ? " dragging" : ""}`}
      aria-label="Composer"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {notice ? <div className="composer-notice">{notice}</div> : null}
      <div className="composer-text">
        <div className="composer-field plain">
          <textarea
            ref={textarea}
            value={text}
            rows={3}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label="Message"
          />
        </div>
      </div>
      {images.length > 0 ? (
        <div className="attach-strip" aria-label="Attached images">
          {images.map((image) => (
            <figure key={image.key} className={`attach-thumb status-${image.error ? "error" : image.dataUrl ? "ready" : "uploading"}`}>
              <div className="attach-image">{image.dataUrl ? <img src={image.dataUrl} alt={image.name} /> : <span className="attach-missing mono">…</span>}</div>
              <figcaption>
                <span className="attach-name" title={image.name}>
                  {image.name}
                </span>
                {image.error ? <span className="attach-error">{image.error}</span> : null}
              </figcaption>
              <button type="button" className="attach-remove" aria-label={`Remove ${image.name}`} title="Remove" onClick={() => setImages((list) => list.filter((i) => i.key !== image.key))}>
                ×
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      <div className="composer-row composer-toolbar">
        <button type="button" className="small ghost" onClick={() => fileInput.current?.click()} title="Attach PNG, JPEG, GIF, or WebP images (or paste / drop them here)">
          Attach image
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <span className="spacer" />
        <span className="muted hint mono composer-hint">Enter to send · Shift+Enter new line</span>
        {running && onStop ? (
          <button type="button" className="danger" onClick={() => void onStop()} title="Interrupt the running turn in T3">
            Stop
          </button>
        ) : null}
        <button type="button" className="primary" disabled={!canSend} onClick={() => void submit()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ---- menus and dialogs ----

function ThreadMenu({
  onSettings,
  onAddToRoom,
  settled,
  onToggleSettled,
  onArchive,
  onDelete,
}: {
  onSettings: () => void;
  onAddToRoom: () => void;
  settled: boolean;
  onToggleSettled: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <button ref={anchor} type="button" className="small ghost icon-only" aria-label="Thread options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="menu" onClose={() => setOpen(false)}>
          <button type="button" role="menuitem" onClick={pick(onSettings)}>
            Model and permissions…
          </button>
          <button type="button" role="menuitem" onClick={pick(onAddToRoom)}>
            Add to a room…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={pick(onToggleSettled)}
            title={settled ? "Take it out of T3's settled list" : "Move it to T3's settled list: done for now"}
          >
            {settled ? "Unsettle" : "Settle"}
          </button>
          <button type="button" role="menuitem" onClick={pick(onArchive)} title="Hide it in T3; reversible there">
            Archive
          </button>
          <button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
            Delete…
          </button>
        </Popover>
      ) : null}
    </>
  );
}

function ThreadSettingsDialog({ thread, runCommand, onClose }: { thread: T3ThreadShell; runCommand: RunCommand; onClose: () => void }) {
  const [model, setModel] = useState<ModelSelection | null>(thread.modelSelection);
  const [mode, setMode] = useState<RuntimeMode>(thread.runtimeMode);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    let ok = true;
    if (model && JSON.stringify(model) !== JSON.stringify(thread.modelSelection)) {
      ok = (await runCommand({ type: "thread.model.set", threadId: thread.id, modelSelection: model })) !== null && ok;
    }
    if (mode !== thread.runtimeMode) ok = (await runCommand({ type: "thread.runtimeMode.set", threadId: thread.id, runtimeMode: mode })) !== null && ok;
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title="Thread settings" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Model
          <ModelPicker value={model} onChange={setModel} providerFilter={thread.modelSelection.instanceId} />
          <span className="hint">Applies to the T3 thread itself. The provider stays {thread.modelSelection.instanceId}: T3 cannot switch a thread&rsquo;s provider.</span>
        </label>
        <label>
          Permission mode
          <select value={mode} onChange={(e) => setMode(e.target.value as RuntimeMode)}>
            {RUNTIME_MODES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
          <span className="hint">Enforced by T3 for this thread.</span>
        </label>
        <dl className="kv">
          <dt>Thread id</dt>
          <dd>
            <code>{thread.id}</code> <CopyButton text={thread.id} label="Copy thread id" />
          </dd>
          {thread.worktreePath ? (
            <>
              <dt>Worktree</dt>
              <dd>
                <code>{thread.worktreePath}</code>
              </dd>
            </>
          ) : null}
        </dl>
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Seat the thread in a room of the same project; it becomes that room's participant under the alias. */
function AddToRoomDialog({
  thread,
  rooms,
  runCommand,
  onClose,
  onAdded,
}: {
  thread: T3ThreadShell;
  rooms: RoomListItem[];
  runCommand: RunCommand;
  onClose: () => void;
  onAdded: (roomId: string) => void;
}) {
  const candidates = rooms.filter((room) => room.projectId === thread.projectId);
  const [roomId, setRoomId] = useState(candidates[0]?.id ?? "");
  const [alias, setAlias] = useState(() => (thread.modelSelection.model.split(/[-_.\s]/)[0] ?? "agent").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "agent");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!roomId || !alias.trim()) return;
    setBusy(true);
    const result = await runCommand({ type: "participant.create", roomId, alias: alias.trim(), thread: { mode: "attach", threadId: thread.id } });
    setBusy(false);
    if (result) {
      onClose();
      onAdded(roomId);
    }
  };
  return (
    <Dialog title="Add to a room" onClose={onClose}>
      {candidates.length === 0 ? (
        <>
          <p>There is no room in this thread&rsquo;s project yet. Create one from the project&rsquo;s + menu in the sidebar, then add the thread.</p>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          <p className="muted">The thread keeps its model, permission mode and history. In the room you address it by its alias.</p>
          <label>
            Room
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {candidates.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Alias
            <input value={alias} onChange={(e) => setAlias(e.target.value)} data-autofocus />
            <span className="hint">What you type after @ in the room.</span>
          </label>
          <div className="dialog-actions">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || !roomId || !alias.trim()}>
              Add to room
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

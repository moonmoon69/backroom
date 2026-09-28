/**
 * A T3 thread used on its own, outside any room. The conversation is read from T3 on every poll and nothing is stored
 * by Backroom. What you type goes to T3 as typed (no room briefing), like typing in T3 Code.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, ApiError, attachmentUrl, useThreadCosts } from "../api.ts";
import type { ThreadCost, ThreadCosts } from "../types.ts";
import { withoutT3ContextRefs } from "../t3Context.ts";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MIME_TYPES,
  type CommandResult,
  type InlineImage,
  type ModelSelection,
  type Preset,
  type RoomCommand,
  type BrowserListItem,
  type RoomListItem,
  type RuntimeMode,
  type T3Project,
  type T3ThreadShell,
  type ThreadItem,
  type ThreadView as ThreadViewData,
  type WorkspaceChoice,
} from "../types.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { CopyTextButton } from "./CopyText.tsx";
import { Dialog } from "./Dialog.tsx";
import { money } from "./deskFormat.ts";
import { PresetChips, PresetIcon, usePresets } from "./presets.tsx";
import { LiveFeed } from "./LiveFeed.tsx";
import { Markdown } from "./Markdown.tsx";
import { identityStyle, participantColor } from "./Monogram.tsx";
import { ApprovalRequestCard, UserInputRequestCard } from "./NativeRequests.tsx";
import { CopyButton, ThreadSettingsRow, WorkspacePicker, workspaceReady } from "./pickers.tsx";
import { PageTitle } from "./PageTitle.tsx";
import { SpendFoot } from "./Timeline.tsx";
import { speakableSummary, useAutoRead, useSpeechAvailable } from "../speech.ts";
import { SpeakButton, useAnnounceNew } from "./SpeakButton.tsx";
import { UsageCard } from "./ThreadUsageCard.tsx";
import { Popover } from "./Popover.tsx";
import { BrowserChoices, GlobeIcon } from "./RoomBrowser.tsx";
import { useToast } from "./Toast.tsx";
import { CloseIcon, ImageIcon, MoreIcon } from "./icons.tsx";

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
  // The browser instructions go in front of the next message (threads outside rooms get no briefing).
  const [attached, setAttached] = useState(false);
  const { toast } = useToast();
  const [dialog, setDialog] = useState<"settings" | "room" | "delete" | null>(null);
  const crew = useMemo(() => threadCrew(threadId), [threadId]);
  // Priced as a room prices a member: the total, a figure per reply, the turn in progress. A new reply is priced at once.
  const costs = useThreadCosts(threadId, view?.items.filter((item) => item.kind === "reply").length ?? 0);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageAnchor = useRef<HTMLButtonElement>(null);
  const usageMenu = useRef<HTMLDivElement>(null);
  const { presets } = usePresets();
  const crewPreset = crew ? (presets.find((p) => p.id === crew.presetId) ?? null) : null;
  const thread = view?.thread;
  // Who is speaking when a reply is read aloud: the crew member it started as, else its model.
  const voiceName = crew?.name ?? thread?.modelSelection.model ?? "reply";
  const [autoRead, setAutoRead] = useAutoRead(`thread:${threadId}`);
  const canSpeak = useSpeechAvailable();
  useAnnounceNew(
    `thread:${threadId}`,
    autoRead,
    view ? view.items.filter((item) => item.kind === "reply" && item.text.trim().length > 0).map((item) => ({ id: item.id, text: `${voiceName}. ${speakableSummary(item.text)}` })) : null,
  );
  useAnnounceNew(
    `thread:${threadId}:requests`,
    autoRead,
    view ? view.requests.map((request) => ({ id: request.requestId, text: `${voiceName} ${request.kind === "approval" ? "needs your approval." : "has a question for you."}` })) : null,
  );
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
        {thread && browsers && view?.browsers ? (
          <ThreadBrowserButton threadId={threadId} browsers={browsers} access={view.browsers} attached={attached} onAttach={setAttached} runCommand={runCommand} onChanged={refresh} />
        ) : null}
        {thread ? (
          <ThreadMenu
            canSpeak={canSpeak}
            autoRead={autoRead}
            onToggleAutoRead={() => setAutoRead(!autoRead)}
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
            {crew ? (
              <span className="thread-crew" title={`Started with ${crew.name} from your crew: their settings then; the thread's own since (change them here or in T3).`}>
                {crewPreset ? <PresetIcon preset={crewPreset} /> : null}
                <span className="mono">{crew.name}</span>
              </span>
            ) : null}
            <button type="button" className="thread-setting" onClick={() => setDialog("settings")} title="Model and permission mode (applied in T3)">
              <span className="mono">{thread.modelSelection.model}</span>
              <span className={`pill pill-mode mode-${thread.runtimeMode}`}>{thread.runtimeMode}</span>
            </button>
            {view?.contextWindow ? <ContextMeter reading={view.contextWindow} compact /> : null}
            <button
              type="button"
              ref={usageAnchor}
              className="thread-setting thread-usage"
              onClick={() => setUsageOpen((open) => !open)}
              aria-expanded={usageOpen}
              title="Usage: context, estimated spend at list price, today's usage for this model and the provider's plan limits"
            >
              {costs?.total.available ? (
                <span className="thread-spend mono">
                  {costs.total.priced ? "≈ " : "≥ "}
                  {money(costs.total.total.costUsd)}
                  {running && costs.openTurn ? <span className="crew-spend-open"> · {money(costs.openTurn.total.costUsd)} this turn</span> : null}
                </span>
              ) : (
                <span className="thread-spend mono">usage</span>
              )}
            </button>
            {usageOpen && view ? (
              <Popover anchor={usageAnchor} menuRef={usageMenu} className="menu-with-usage" role="dialog" onClose={() => setUsageOpen(false)}>
                <UsageCard
                  label={thread.title || "thread"}
                  modelSelection={thread.modelSelection}
                  facts={{ context: view.contextWindow, contextReporting: view.usage.contextReporting, lastCompaction: view.usage.lastCompaction, subagents: view.usage.subagents, files: view.usage.changedFiles }}
                  cost={costs?.total ?? null}
                  pricesFetchedAt={costs?.pricesFetchedAt ?? null}
                />
              </Popover>
            ) : null}
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
                costs={costs}
                lead={voiceName}
                onRespond={async (command) => {
                  const result = await runCommand(command);
                  if (result) hurry();
                }}
              />
            </div>
            {thread?.boundToRoom ? (
              <p className="chat-status mono thread-partial">This thread is now a member in a room; talk to it from the room.</p>
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
                attached ? (
                  <>
                    <span>The browser instructions go with your next message.</span>
                    <span className="spacer" />
                    <button type="button" className="small ghost" onClick={() => setAttached(false)}>
                      Don&rsquo;t send
                    </button>
                  </>
                ) : null
              }
              onSend={async (text, images) => {
                const withBrowser = attached ? await withBrowserInstructions(threadId, text, toast) : text;
                if (withBrowser === null) return false;
                const result = await runCommand({ type: "thread.send", threadId, text: withBrowser, images });
                if (result) {
                  setAttached(false);
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
  /** The preset the thread's settings start from (picked in the sidebar), if any. */
  presetId: string | null;
  projects: T3Project[];
  browsers: BrowserListItem[] | null;
  runCommand: RunCommand;
  onProject: (projectId: string) => void;
  onStarted: (threadId: string) => void;
  /** Leave without starting a thread (back to where you were). */
  onCancel: () => void;
  headerStart: ReactNode;
}

export function NewThreadView({ projectId, presetId, projects, browsers, runCommand, onProject, onStarted, onCancel, headerStart }: NewThreadViewProps) {
  const [browserId, setBrowserId] = useState<string>("");
  const { toast } = useToast();
  const [model, setModel] = useState<ModelSelection | null>(null);
  // T3's default model for the project is looked up first; the picker only falls back to the catalog default without one.
  const [modelReady, setModelReady] = useState(false);
  const [defaultModel, setDefaultModel] = useState<ModelSelection | null>(null);
  const lastMode = (): RuntimeMode => (localStorage.getItem(MODE_KEY) as RuntimeMode | null) ?? "full-access";
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(lastMode);
  // Where it works starts over with each project (its branches and T3's default differ).
  const [workspace, setWorkspace] = useState<WorkspaceChoice>({ mode: "local" });
  useEffect(() => setWorkspace({ mode: "local" }), [projectId]);
  const { presets } = usePresets();
  // A picked preset sets where it works once the project's branches are known, and keeps T3's default model out.
  const [workspacePrefer, setWorkspacePrefer] = useState<{ mode: "local" | "worktree"; nonce: number } | null>(null);
  const presetPicked = useRef(false);
  // The crew member picked, by name: their settings fill the form, and the thread is marked as started with them.
  const [picked, setPicked] = useState<Preset | null>(null);
  const applyPreset = useCallback((preset: Preset) => {
    presetPicked.current = true;
    setPicked(preset);
    setModel(preset.modelSelection);
    setRuntimeMode(preset.runtimeMode);
    setWorkspacePrefer({ mode: preset.workspaceMode, nonce: Date.now() });
  }, []);
  // Clicking the picked member again: back to T3's default model, the last permission mode, the project folder.
  const clearPreset = useCallback(() => {
    presetPicked.current = false;
    setPicked(null);
    setModel(defaultModel);
    setRuntimeMode(lastMode());
    setWorkspacePrefer({ mode: "local", nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultModel]);
  // The preset the page was opened with, once the presets are read; in another project it applies again.
  const opened = presetId ? (presets.find((p) => p.id === presetId) ?? null) : null;
  useEffect(() => {
    if (opened) applyPreset(opened);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened?.id, opened?.updatedAt, projectId, applyPreset]);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const page = useRef<HTMLDivElement>(null);

  // Esc cancels, but only while nothing is typed (a half-written prompt is not thrown away by a stray key) and no
  // menu or dialog is open (Esc closes those first).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".dialog-backdrop, .menu, [role='listbox']")) return;
      if (page.current?.querySelector("textarea")?.value.trim()) return;
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
    let cancelled = false;
    setModelReady(false);
    api
      .defaultModel(projectId)
      .then(({ modelSelection }) => {
        if (cancelled) return;
        setDefaultModel(modelSelection);
        if (!presetPicked.current) setModel((current) => modelSelection ?? current);
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
        <button type="button" className="small ghost icon-only" aria-label="Cancel new thread" title="Cancel new thread (Esc)" onClick={onCancel}>
          <CloseIcon />
        </button>
      </div>
      <div className="room-under" ref={page}>
        <div className="room-body">
          <div className="room-centre">
            <div className="timeline-wrap">
              <div className="timeline">
                <div className="timeline-content">
                  <div className="thread-start form">
                    <p className="muted">A thread on its own, outside any room: what you type goes to T3 as typed, like typing in T3 Code. Pick someone from your crew to fill in their settings, or set them below; your first message starts the thread.</p>
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
                    <PresetChips model={model} runtimeMode={runtimeMode} onPick={applyPreset} pickedId={picked?.id ?? null} onClear={clearPreset} pickedNote="Your first message starts the thread with them." />
                    <div className="form-field">
                      <span>Model</span>
                      <ThreadSettingsRow
                        model={model}
                        onModel={setModel}
                        runtimeMode={runtimeMode}
                        onRuntimeMode={(mode) => {
                          setRuntimeMode(mode);
                          localStorage.setItem(MODE_KEY, mode);
                        }}
                        pending={!modelReady && !presetPicked.current}
                      />
                      <span className="hint">T3&rsquo;s own settings for the thread; you can change them later.</span>
                    </div>
                    <WorkspacePicker projectId={projectId} value={workspace} onChange={setWorkspace} newBranchHint="named by T3 from your first message" prefer={workspacePrefer} />
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
                            ? `${browsers.find((b) => b.id === browserId)?.description || "No description."} The agent may use this browser only, as a room limits its agents; its instructions go with the first message. The globe in the thread's header changes it later.`
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
              placeholder={picked ? `Message ${picked.name} to start the thread` : "What should this thread do?"}
              disabled={!project || !model}
              running={false}
              onSend={async (text, images) => {
                if (!model) return false;
                if (!workspaceReady(workspace)) return false;
                // The thread's id is chosen here, so its browsers are set and the key in the first message is its own.
                const threadId = crypto.randomUUID();
                if (browserId && !(await runCommand({ type: "thread.browser", threadId, enabled: true, browserId, allowed: [browserId] }))) return false;
                const first = browserId ? await withBrowserInstructions(threadId, text, toast) : text;
                if (first === null) return false;
                const result = await runCommand({ type: "thread.start", projectId, threadId, text: first, images, modelSelection: model, runtimeMode, ...(workspace.mode === "local" ? {} : { workspace }) });
                if (result && picked) rememberThreadCrew(threadId, picked);
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

const MODE_KEY = "backroom.directMode";

// ---- the crew member a thread was started with ----
// Kept here, like the thread's browser: T3 knows nothing of the crew, and the thread's settings are its own from the
// start. The name is stored too, so it outlives the crew member.
const THREAD_CREW_KEY = "backroom.threadCrew.";
const threadCrew = (threadId: string): { presetId: string; name: string } | null => {
  try {
    const raw = localStorage.getItem(THREAD_CREW_KEY + threadId);
    return raw ? (JSON.parse(raw) as { presetId: string; name: string }) : null;
  } catch {
    return null;
  }
};
const rememberThreadCrew = (threadId: string, preset: Preset): void => localStorage.setItem(THREAD_CREW_KEY + threadId, JSON.stringify({ presetId: preset.id, name: preset.name }));

// ---- browsers for threads outside rooms ----

/** The thread's browsers section (the ones it may use, its default started now) in front of the user's text; null on failure. */
async function withBrowserInstructions(threadId: string, text: string, toast: (message: string) => void): Promise<string | null> {
  try {
    const { text: instructions } = await api.threadBrowserBriefing(threadId);
    return text.trim() ? `${instructions}\n\n${text}` : instructions;
  } catch (error) {
    toast(`The browser instructions could not be prepared: ${error instanceof ApiError ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The thread's Browser switch: a globe, checked while its agent may use browsers, like a room's. It opens the choices a
 * room's panel has (browsers on or off, which ones, the default), with the same rules: the tool refuses the rest, and
 * refuses the thread while they are off. A thread outside a room gets no briefing, so the instructions go with your
 * next message: after each change, or when you add them again.
 */
function ThreadBrowserButton({
  threadId,
  browsers,
  access,
  attached,
  onAttach,
  runCommand,
  onChanged,
}: {
  threadId: string;
  browsers: BrowserListItem[];
  access: NonNullable<ThreadViewData["browsers"]>;
  attached: boolean;
  onAttach: (attach: boolean) => void;
  runCommand: RunCommand;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const set = async (next: { enabled: boolean; browserId?: string | null; allowed?: string[] | null }) => {
    setBusy(true);
    const result = await runCommand({ type: "thread.browser", threadId, ...next });
    setBusy(false);
    if (!result) return;
    onChanged();
    // What the agent was told is out of date: the new instructions go with the next message (nothing, once off).
    onAttach(next.enabled);
  };
  const defaultBrowser = browsers.find((b) => b.id === access.defaultBrowserId);
  const title = !access.enabled
    ? "Browser: off for this thread's agent"
    : `Browser: on for this thread's agent · default "${defaultBrowser?.name ?? "none"}"${attached ? " · instructions go with your next message" : ""}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`small thread-browser-button${attached ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon checked={access.enabled} failed={access.enabled && defaultBrowser?.status.state === "error"} />
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="dialog" className="browser-panel thread-browser-panel" onClose={() => setOpen(false)}>
          <label className="browser-toggle">
            <input type="checkbox" checked={access.enabled} disabled={busy} onChange={() => void set({ enabled: !access.enabled })} />
            <span>
              Let this thread&rsquo;s agent use browsers
              <span className="hint">As in a room: the agent is told about the browsers ticked below, and the browser tool refuses the others. While this is off, it refuses this thread.</span>
            </span>
          </label>
          <BrowserChoices
            list={browsers}
            enabled={access.enabled}
            allowedIds={access.allowedBrowserIds}
            defaultId={access.defaultBrowserId}
            busy={busy}
            subject="thread"
            onChange={(next) => void set({ enabled: access.enabled, ...next })}
          />
          <p className="hint">A thread outside a room gets no briefing, so the instructions go with your next message, once, after each change. Add them again if the agent loses track.</p>
          <div className="dialog-actions">
            {attached ? (
              <button type="button" onClick={() => onAttach(false)} title="The instructions are going with your next message; keep them back">
                Don&rsquo;t send
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!access.enabled}
                onClick={() => {
                  onAttach(true);
                  setOpen(false);
                }}
              >
                Add to my next message
              </button>
            )}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

// ---- transcript ----

function Transcript({ view, error, onRespond, costs, lead }: { view: ThreadViewData | null; error: string | null; onRespond: (command: RoomCommand) => Promise<void>; costs: ThreadCosts | null; lead: string }) {
  // What the turn behind a reply used, and the running total since the user's last message over the replies since.
  const spendOf = (index: number): { spend: ThreadCost; since: number; turns: number } | null => {
    const items = view?.items ?? [];
    const spend = costs?.replies[items[index]?.id ?? ""];
    if (!spend?.available || spend.total.calls === 0) return null;
    let since = 0;
    let turns = 0;
    for (let earlier = index; earlier >= 0; earlier -= 1) {
      const item = items[earlier] as ThreadItem;
      if (item.kind === "user") break;
      const part = costs?.replies[item.id];
      if (part?.available) {
        since += part.total.costUsd;
        turns += 1;
      }
    }
    return { spend, since, turns };
  };
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
        {view.items.map((item, index) => (item.kind === "user" ? <UserRow key={item.id} item={item} continued={view.items[index - 1]?.kind === "user"} /> : <ReplyRow key={item.id} item={item} speaker={speaker} spend={spendOf(index)} lead={lead} />))}
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

/**
 * The browser instructions a thread outside a room sends in front of a message (see withBrowserInstructions): the
 * "== Browsers ==" block up to the first blank line. Shown folded, so the message reads as typed.
 */
function splitBrowserInstructions(text: string): { instructions: string | null; rest: string } {
  if (!text.startsWith("== Browsers ==")) return { instructions: null, rest: text };
  const end = text.indexOf("\n\n");
  return end < 0 ? { instructions: text, rest: "" } : { instructions: text.slice(0, end), rest: text.slice(end + 2) };
}

function UserRow({ item, continued }: { item: Extract<ThreadItem, { kind: "user" }>; continued: boolean }) {
  const { instructions, rest } = splitBrowserInstructions(item.text);
  const shownText = rest ? withoutT3ContextRefs(rest, item.attachmentIds.length > 0) : "";
  return (
    <div className={`chat-row from-user${continued ? " continued" : ""}`}>
      <div className="chat-stack">
        {!continued ? (
          <div className="chat-head">
            <span className="you-mark mono">you</span>
            <span className="time mono">{time(item.at)}</span>
          </div>
        ) : null}
        <div className="bubble-line">
          <div className="bubble bubble-user">
            {instructions ? (
              <details className="reply-progress browser-instructions">
                <summary className="mono" title="Sent in front of the message so the agent can use the shared browsers">
                  browser instructions
                </summary>
                <div className="browser-instructions-text">{instructions}</div>
              </details>
            ) : null}
            {shownText ? <div className="user-text">{shownText}</div> : null}
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
          <CopyTextButton text={shownText} label="Copy message" className="bubble-side" />
        </div>
      </div>
    </div>
  );
}

const isLong = (text: string): boolean => text.length > 600 || /^\s*\|.*\|\s*$/m.test(text) || text.includes("```");

function ReplyRow({ item, speaker, spend, lead }: { item: Extract<ThreadItem, { kind: "reply" }>; speaker: ReactNode; spend: { spend: ThreadCost; since: number; turns: number } | null; lead: string }) {
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
          <div className="reply-foot">
            <CopyTextButton text={item.text} label="Copy reply" />
            <SpeakButton id={item.id} text={item.text} lead={lead} />
            {spend ? <SpendFoot spend={spend.spend} since={spend.since} turns={spend.turns} /> : null}
          </div>
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
                <CloseIcon />
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      <div className="composer-row composer-toolbar">
        <button
          type="button"
          className="small ghost icon-only"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach images"
          title="Attach images: PNG, JPEG, GIF or WebP (or paste or drop them here)"
        >
          <ImageIcon />
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
  canSpeak,
  autoRead,
  onToggleAutoRead,
  onSettings,
  onAddToRoom,
  settled,
  onToggleSettled,
  onArchive,
  onDelete,
}: {
  canSpeak: boolean;
  autoRead: boolean;
  onToggleAutoRead: () => void;
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
      <button ref={anchor} type="button" className="small ghost icon-only" aria-label="Thread options" title="Thread options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreIcon />
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="menu" onClose={() => setOpen(false)}>
          {canSpeak ? (
            <button type="button" role="menuitemcheckbox" aria-checked={autoRead} onClick={pick(onToggleAutoRead)} title="Read each new reply and request aloud in this browser, with the voice set at the foot of the sidebar">
              <span className="setting-check">{autoRead ? "✓" : ""}</span>
              Read new replies aloud
            </button>
          ) : null}
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
        <div className="form-field">
          <span>Model</span>
          <ThreadSettingsRow model={model} onModel={setModel} runtimeMode={mode} onRuntimeMode={setMode} providerFilter={thread.modelSelection.instanceId} />
          <span className="hint">T3&rsquo;s own settings for the thread. The provider stays {thread.modelSelection.instanceId}: T3 cannot switch a thread&rsquo;s provider.</span>
        </div>
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

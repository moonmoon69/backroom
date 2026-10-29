import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { arrowKey, focusItem, tabbables, type NavProps } from "../keys.ts";
import { chipTarget } from "../keyOrder.ts";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import {
  isActiveParticipant,
  type Desk,
  type ModelSelection,
  type T3ThreadShell,
  type Participant,
  type ParticipantStatus,
  type Preset,
  type RuntimeMode,
  type CommandResult,
  type ThreadLifecycleChoice,
  type WorkspaceChoice,
} from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { NameInput } from "./NameInput.tsx";
import { ContextMeterLine, ContextReadout } from "./ContextMeter.tsx";
import { selectionEffort } from "../../../src/domain/effort.ts";
import { fmtTokens, money } from "./deskFormat.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { describeStatus } from "../memberActivity.ts";
import { useResetClock } from "../resetClock.ts";
import { backroomRequest } from "../replyTo.ts";
import { sinceWords } from "../engineTime.ts";
import { OpenInT3Dialog } from "./OpenInT3Dialog.tsx";
import { InheritedLine, RUNTIME_MODE_INFO, ThreadList, ThreadSettingsRow, WorkspacePicker, branchSlug, useAttachableThreads, workspaceReady } from "./pickers.tsx";
import { ThreadDetailsDialog } from "./ThreadDetails.tsx";
import { ThreadUsageCard } from "./ThreadUsageCard.tsx";
import { useToast } from "./Toast.tsx";
import { PresetChips, PresetIcon, usePresets, usePresetText } from "./presets.tsx";
import { Popover } from "./Popover.tsx";
import { ActionStrip, type StripAction } from "./ActionStrip.tsx";
import { THREAD_CHOICES } from "./RoomActions.tsx";
import { PeopleIcon, PersonPlusIcon } from "./icons.tsx";

type MenuAction = "thread" | "open" | "details" | "settings" | "remove" | "consigliere" | "unconsigliere";


/**
 * The People tab of the room's side panel: everyone seated, each opening its thread menu (open in T3, details,
 * settings, remove), and a way to add someone. A member is not rebound to another thread on the board: the Consigliere
 * reseats it on a fresh one (rooms-board reseat).
 */
export function CrewPanel() {
  const { snapshot, desk, runCommand, openMember } = useRoom();
  const [dialog, setDialog] = useState<{ action: MenuAction; participant: Participant; warnings?: string[] } | null>(null);
  const crew = snapshot.participants.filter(isActiveParticipant);
  // Making a member the Consigliere is done at once, unless something says it may not work: then the user is told first.
  const onAction = async (action: MenuAction, participant: Participant) => {
    if (action === "thread") {
      openMember(participant.id);
      return;
    }
    if (action === "unconsigliere") {
      await runCommand({ type: "room.consigliere.set", roomId: snapshot.room.id, participantId: null });
      return;
    }
    if (action === "consigliere") {
      const { warnings } = await api.consigliereWarnings(snapshot.room.id, participant.id).catch(() => ({ warnings: [] as string[] }));
      if (warnings.length === 0) {
        await runCommand({ type: "room.consigliere.set", roomId: snapshot.room.id, participantId: participant.id });
        return;
      }
      setDialog({ action, participant, warnings });
      return;
    }
    setDialog({ action, participant });
  };

  return (
    <div className="crew-list" aria-label="Members">
      {crew.length === 0 ? <p className="serif muted crew-empty">Nobody seated yet. Bring in a member with the button at the top of this panel, then hand out the work.</p> : null}
      {crew.map((participant) => (
        <ParticipantChip
          key={participant.id}
          participant={participant}
          status={snapshot.participantStatus[participant.id]}
          desk={desk?.participants[participant.id] ?? null}
          onAction={(action) => void onAction(action, participant)}
        />
      ))}
      <CrewContextTotal />
      {dialog?.action === "open" ? <OpenInT3Dialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "details" ? <ThreadDetailsDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "settings" ? <ParticipantSettingsDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "remove" ? <RemoveParticipantDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "consigliere" ? (
        <Dialog title={`Make ${dialog.participant.alias} the Consigliere`} onClose={() => setDialog(null)}>
          <p>This may not work as it stands:</p>
          <ul className="consigliere-warnings">
            {(dialog.warnings ?? []).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <p className="muted hint">You can change his permission mode under Settings… in his menu, before or after.</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={async () => {
                const participant = dialog.participant;
                setDialog(null);
                await runCommand({ type: "room.consigliere.set", roomId: snapshot.room.id, participantId: participant.id });
              }}
            >
              Make Consigliere anyway
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * The header's people button: a two-person icon and how many are seated, opening the People tab (where participants
 * are added, and each one's status and thread menu are). Hover lists who is doing what. `nav` makes it an item of the
 * room's header lane (keys.ts).
 */
export function CrewButton({ active, onClick, nav }: { active: boolean; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; nav?: NavProps }) {
  const { snapshot, desk } = useRoom();
  const crew = snapshot.participants.filter(isActiveParticipant);
  const now = useResetClock(crew.map((p) => snapshot.participantStatus[p.id]?.paused?.resetAt));
  const statuses = crew.map((p) => {
    const activity = describeStatus(snapshot.participantStatus[p.id], desk?.participants[p.id], now);
    return `@${p.alias}: ${activity.label}${activity.detail ? ` (${activity.detail})` : ""}`;
  });
  return (
    <button
      type="button"
      className={`small crew-button${active ? " active" : ""}`}
      aria-pressed={active}
      aria-label={`Members (${crew.length})`}
      title={crew.length > 0 ? `Members\n${statuses.join("\n")}` : "Members: nobody seated yet"}
      onClick={onClick}
      {...nav}
    >
      <PeopleIcon />
      <span className="panel-count mono">{crew.length}</span>
    </button>
  );
}

/**
 * The People panel's add button, in its head beside the close button: seat a participant (new or existing thread). `nav`
 * makes it an item of the panel's head row (keys.ts).
 */
export function AddParticipantButton({ nav }: { nav?: NavProps }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <button type="button" className="small ghost icon-only" aria-label="Add member" title="Add member" onClick={() => setAdding(true)} {...nav}>
        <PersonPlusIcon />
      </button>
      {adding ? <AddParticipantDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** Sum of usedTokens across seated participants whose threads report context; hidden when nothing reports. */
function CrewContextTotal() {
  const { snapshot, desk, costs } = useRoom();
  const readings = snapshot.participants
    .filter(isActiveParticipant)
    .map((p) => desk?.participants[p.id]?.contextWindow ?? null)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const total = readings.reduce((n, r) => n + r.usedTokens, 0);
  // The room's spend counts everyone who was ever seated: a removed member's work was still paid for.
  const spend = costs?.room.available ? costs.room : null;
  const left = costs?.withoutEstimate.length ?? 0;
  if (readings.length === 0 && !spend) return null;
  return (
    <span className="crew-total mono">
      <span className="label">Total</span>
      {readings.length > 0 ? <span title={`${readings.length} thread${readings.length === 1 ? "" : "s"} reporting context`}>crew context {fmtTokens(total)}</span> : null}
      {spend ? (
        <span title={`Estimated spend of every thread seated here, at list price${left > 0 ? `; ${left} member${left === 1 ? "" : "s"} without an estimate` : ""}`}>
          {readings.length > 0 ? " · " : ""}
          spent {spend.priced && left === 0 ? "≈" : "≥"} {money(spend.total.costUsd)}
        </span>
      ) : null}
    </span>
  );
}

function ParticipantChip({
  participant,
  status,
  desk,
  onAction,
}: {
  participant: Participant;
  status: ParticipantStatus | undefined;
  desk: Desk | null;
  onAction: (action: MenuAction) => void;
}) {
  const [open, setOpen] = useState(false);
  // Its action strip (K1-7): Enter on the member draws the menu's items in a row under it (ActionStrip.tsx).
  const [strip, setStrip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The menu is portalled to the body (see Popover), so the outside-click check has to know about it too.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { colorOf, snapshot, costs } = useRoom();
  const spend = costs?.participants[participant.id];
  const inProgress = costs?.openTurns[participant.id];
  const meter = costs?.contexts?.[participant.id];
  const isConsigliere = snapshot.room.consigliereId === participant.id;
  const now = useResetClock([status?.paused?.resetAt]);
  const described = describeStatus(status, desk, now);
  const effort = selectionEffort(participant.modelSelection);
  const attention = ["approval", "input", "error", "missing"].includes(described.tone) ? ` attention-${described.tone}` : "";
  const pick = (action: MenuAction) => {
    setOpen(false);
    onAction(action);
  };
  const where = `@${participant.alias}${isConsigliere ? ", the Consigliere" : ""} · ${described.label}`;
  // The strip holds the menu's items, in the design's order (K1-Fable section 4): each does what its menu item does.
  const actions: StripAction[] = [
    { key: "thread", label: "Open thread", name: "Open thread", title: "Its thread here, over the room (Backspace comes back)", press: () => onAction("thread") },
    { key: "settings", label: "Settings…", name: "Settings…", press: () => onAction("settings") },
    { key: "details", label: "Thread details…", name: "Thread details…", press: () => onAction("details") },
    { key: "open", label: "Open in T3", name: "Open in T3", press: () => onAction("open") },
    isConsigliere
      ? { key: "consigliere", label: "Remove as Consigliere", name: "Remove as Consigliere", title: "The room goes back to one board with the composer; nobody is removed", press: () => onAction("unconsigliere") }
      : { key: "consigliere", label: "Make Consigliere", name: "Make Consigliere", title: "You talk to him; he hands the work to the other members and reports back", press: () => onAction("consigliere") },
    { key: "remove", label: "Remove from room…", name: "Remove from room…", tone: "danger", press: () => onAction("remove") },
  ];
  return (
    // An item of the side panel's rows (keys.ts): Enter on it opens its action strip; its button opens the menu.
    <div
      className={`participant-chip${described.motion ? ` activity-${described.motion}` : ""}${attention}`}
      ref={ref}
      style={identityStyle(colorOf(participant.id))}
      tabIndex={-1}
      role="group"
      data-nav="member"
      data-nav-key={`member:${participant.id}`}
      data-where={where}
      aria-label={`@${participant.alias}${isConsigliere ? ", the Consigliere" : ""}, ${described.label}${described.detail ? `, ${described.detail}` : ""}`}
      aria-description="Enter: its actions"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        setStrip(true);
      }}
    >
      <button
        type="button"
        className="participant-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          described.tone === "missing"
            ? "Its thread is gone: remove the member, or have the Consigliere reseat it"
            : `${participant.alias} · ${participant.modelSelection.model} · ${described.label}${described.detail ? ` (${described.detail})` : ""}`
        }
      >
        <Monogram participant={participant} size="md" />
        <span className="crew-text">
          <span className="alias mono identity">
            {participant.alias}
            {desk && desk.pullRequests.length > 0 ? (
              <span className="pill pill-pr" title={desk.pullRequests.map((pr) => `${pr.repository}#${pr.number}`).join(", ")}>
                PR
              </span>
            ) : null}
          </span>
          {isConsigliere ? (
            <span className="role consigliere-mark" title="The member you talk to in this room: he hands the work to the others and reports back">
              Consigliere
            </span>
          ) : null}
          <span className="model">
            {participant.modelSelection.model}
            {effort ? ` · ${effort}` : ""}
          </span>
          <span className={`status-label mono status-${described.tone}`}>{described.label}</span>
          {described.detail ? <span className={`crew-activity mono status-${described.tone}`}>{described.detail}</span> : null}
          <SeatLines participant={participant} />
          {desk ? <ContextReadout desk={desk} /> : <span className="crew-context mono no-reading">context —</span>}
          {meter ? <ContextMeterLine meter={meter} besideReading={Boolean(desk?.contextWindow)} /> : null}
          {spend?.available ? (
            <span
              className="crew-spend mono"
              title={`Estimated spend at list price${spend.subagents.calls > 0 ? `: own ${money(spend.own.costUsd)}, subagents ${money(spend.subagents.costUsd)}` : ""}${inProgress?.available ? `. Since its last reply: ${money(inProgress.total.costUsd)} over ${inProgress.total.calls} calls` : ""}`}
            >
              {spend.priced ? "≈ " : "≥ "}
              {money(spend.total.costUsd)}
              {inProgress?.available ? <span className="crew-spend-open"> · {money(inProgress.total.costUsd)} since last reply</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <Popover anchor={ref} menuRef={menuRef} className="menu-with-usage" role="menu" onClose={() => setOpen(false)}>
          <ThreadUsageCard participant={participant} desk={desk} cost={costs ? (costs.participants[participant.id] ?? null) : null} pricesFetchedAt={costs?.pricesFetchedAt ?? null} />
          <button type="button" role="menuitem" onClick={() => pick("thread")} title="Its thread here, over the room (Backspace comes back)">
            Open thread
          </button>
          <button type="button" role="menuitem" onClick={() => pick("open")}>
            Open in T3
          </button>
          <button type="button" role="menuitem" onClick={() => pick("details")}>
            Thread details…
          </button>
          <button type="button" role="menuitem" onClick={() => pick("settings")}>
            Settings…
          </button>
          {isConsigliere ? (
            <button type="button" role="menuitem" title="The room goes back to one board with the composer; nobody is removed" onClick={() => pick("unconsigliere")}>
              Remove as Consigliere
            </button>
          ) : (
            <button type="button" role="menuitem" title="You talk to him; he hands the work to the other members and reports back" onClick={() => pick("consigliere")}>
              Make Consigliere
            </button>
          )}
          <button type="button" role="menuitem" className="danger" onClick={() => pick("remove")}>
            Remove from room…
          </button>
        </Popover>
      ) : null}
      {strip ? <ActionStrip actions={actions} where={where} item={() => ref.current} onClose={() => setStrip(false)} /> : null}
    </div>
  );
}

/**
 * What the room's journal adds to a member's T3 status: background work it holds requests open with ("working since
 * …"), a run Backroom cannot tell T3 received (uncertain), posts it has not been given yet, and a delivery that cannot
 * be made.
 */
function SeatLines({ participant }: { participant: Participant }) {
  const { snapshot } = useRoom();
  const seatId = snapshot.participantStatus[participant.id]?.seatId ?? null;
  const seat = seatId ? snapshot.seats.find((s) => s.seatId === seatId) : undefined;
  if (!seat) return null;
  const run = seat.activeRunId ? snapshot.runs.find((r) => r.id === seat.activeRunId) : undefined;
  const numbers = (ids: readonly string[]) =>
    ids
      .map((id) => snapshot.requests.find((q) => q.id === id)?.number)
      .filter((n): n is number => n !== undefined)
      .map((n) => `#${n}`)
      .join(" ");
  return (
    <>
      {run?.phase === "uncertain" ? (
        <span className="crew-activity mono status-error" title="Backroom cannot tell whether T3 received this turn; it keeps checking and never sends it twice">
          turn uncertain
        </span>
      ) : null}
      {seat.activities.map((activity) => (
        <span key={activity.id} className="crew-activity mono status-working" title={activity.kind === "bg" ? "Background work T3 listed when its turn ended holds the request open" : "It said it is still working: the request stays open until it answers"}>
          {`working since ${sinceWords(activity.since)}${activity.requestIds.length > 0 ? ` on ${numbers(activity.requestIds)}` : ""}`}
        </span>
      ))}
      {seat.blocked ? <span className="crew-activity mono status-error">blocked delivery{seat.blocked.number !== null ? `: #${seat.blocked.number}` : ""}</span> : null}
      {!seat.blocked && seat.unread > 0 && seat.activeRunId === null ? (
        <span className="crew-activity mono" title="Posts addressed to it that it has not been given yet">
          {seat.unread} unread
        </span>
      ) : null}
    </>
  );
}

/** The field a settings entry point wants focused when the dialog opens. */
export type SettingsField = "name" | "mode";

interface SettingsValues {
  alias: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
}

const sameModel = (a: ModelSelection | null, b: ModelSelection | null) => JSON.stringify(a) === JSON.stringify(b);
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error));

/**
 * One dialog for a seated participant's name, model and permission mode. Save sends only what
 * changed, in order: participant.update, participant.model.set, participant.runtimeMode.set. Each part
 * stands alone: a failure is reported inline by part while the parts that succeeded stay applied.
 */
export function ParticipantSettingsDialog({
  participant,
  focus = "name",
  onClose,
}: {
  participant: Participant;
  focus?: SettingsField;
  onClose: () => void;
}) {
  const { snapshot, refetch } = useRoom();
  // What the server holds, advanced as each part of a save succeeds so a retry sends only what is still pending.
  const [saved, setSaved] = useState<SettingsValues>(() => ({
    alias: participant.alias,
    modelSelection: participant.modelSelection,
    runtimeMode: participant.runtimeMode,
  }));
  const [alias, setAlias] = useState(participant.alias);
  const [model, setModel] = useState<ModelSelection | null>(participant.modelSelection);
  const [mode, setMode] = useState<RuntimeMode>(participant.runtimeMode);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Array<{ part: string; message: string }>>([]);

  const trimmed = alias.trim();
  const aliasTaken = snapshot.participants
    .filter(isActiveParticipant)
    .some((p) => p.id !== participant.id && p.alias.toLowerCase() === trimmed.toLowerCase());
  const aliasChanged = trimmed !== saved.alias;
  const modelChanged = model !== null && !sameModel(model, saved.modelSelection);
  const modeChanged = mode !== saved.runtimeMode;
  const changed = aliasChanged || modelChanged || modeChanged;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !changed || aliasTaken || trimmed.length === 0) return;
    setBusy(true);
    setFailures([]);
    const next = { ...saved };
    const failed: Array<{ part: string; message: string }> = [];
    let applied = false;
    if (aliasChanged) {
      try {
        await api.command({ type: "participant.update", participantId: participant.id, alias: trimmed });
        next.alias = trimmed;
        applied = true;
      } catch (error) {
        failed.push({ part: "Name", message: errorText(error) });
      }
    }
    if (modelChanged && model) {
      try {
        await api.command({ type: "participant.model.set", participantId: participant.id, modelSelection: model });
        next.modelSelection = model;
        applied = true;
      } catch (error) {
        failed.push({ part: "Model", message: errorText(error) });
      }
    }
    if (modeChanged) {
      try {
        await api.command({ type: "participant.runtimeMode.set", participantId: participant.id, runtimeMode: mode });
        next.runtimeMode = mode;
        applied = true;
      } catch (error) {
        failed.push({ part: "Permission mode", message: errorText(error) });
      }
    }
    setSaved(next);
    setBusy(false);
    if (applied) refetch();
    if (failed.length === 0) onClose();
    else setFailures(failed);
  };

  return (
    <Dialog title={`@${saved.alias} settings`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <NameInput
            value={alias}
            onValue={setAlias}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}"
            aria-invalid={aliasTaken}
            data-autofocus={focus === "name" ? "" : undefined}
          />
          {aliasTaken ? (
            <span className="field-error">Alias already used in this room.</span>
          ) : (
            <span className="hint">This is how you address it: @name in the composer, or just say the name.</span>
          )}
        </label>
        <div className="form-field">
          <span>Model</span>
          <ThreadSettingsRow model={model} onModel={setModel} runtimeMode={mode} onRuntimeMode={setMode} providerFilter={saved.modelSelection.instanceId} />
          <span className="hint">
            T3&rsquo;s own settings for the thread; changes made in T3 Code show up here too. The provider stays {saved.modelSelection.instanceId}: seat a member on a new thread to use another.
          </span>
        </div>
        {failures.length > 0 ? (
          <div className="settings-errors" role="alert">
            {failures.map((failure) => (
              <p key={failure.part} className="field-error">
                <strong>{failure.part} not saved:</strong> {failure.message}
              </p>
            ))}
            <p className="hint">Everything else was saved.</p>
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !changed || aliasTaken || trimmed.length === 0}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Retire a participant: past replies stay attributed, the T3 thread is untouched, pending work is handled explicitly. */
export function RemoveParticipantDialog({ participant, onClose }: { participant: Participant; onClose: () => void }) {
  const { runCommand, snapshot } = useRoom();
  const { toast } = useToast();
  const [thread, setThread] = useState<ThreadLifecycleChoice>("keep");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Its open work on the journal: requests it owns and has not answered, and its run. Removal is refused while it has any.
  // Backroom's request it never answered (its briefing) is not work: removal cancels it.
  const seatIds = new Set(snapshot.bindings.filter((b) => b.participantId === participant.id).map((b) => b.id));
  const owned = snapshot.requests.filter((q) => seatIds.has(q.owner) && !backroomRequest(q));
  const running = snapshot.runs.some((run) => seatIds.has(run.seatId) && run.phase !== "terminal");
  // A thread T3 no longer has cannot be settled, archived, or deleted; the choice is skipped and "keep" sent.
  const threadMissing = snapshot.participantStatus[participant.id]?.threadMissing === true;
  const deleting = thread === "delete" && !threadMissing;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (deleting && !confirmed) return;
    setBusy(true);
    // The engine refuses a member with open requests or a run, so there is no pending work to decide about.
    const result = (await runCommand({ type: "participant.retire", participantId: participant.id, thread: threadMissing ? "keep" : thread })) as CommandResult | null;
    setBusy(false);
    if (!result) return;
    const outcome = result.type === "participant.updated" && "thread" in result ? (result as Extract<CommandResult, { type: "participant.updated" }>).thread : undefined;
    if (outcome && outcome.action !== "keep") {
      if (outcome.result === "done") toast(`@${participant.alias} removed; its thread was ${outcome.action === "delete" ? "deleted" : `${outcome.action}d`} in T3.`, "success");
      else if (outcome.result === "kept") toast(`@${participant.alias} removed; its thread was kept in T3 (${outcome.detail ?? "still in use"}).`, "info");
      else if (outcome.result === "timeout") toast(`@${participant.alias} removed; the ${outcome.action} of its thread was sent to T3, not confirmed in time (may still go through).`);
      else toast(`@${participant.alias} removed, but T3 did not ${outcome.action} the thread: ${outcome.detail ?? "failed"}`);
    }
    onClose();
  };
  return (
    <Dialog title={`Remove ${participant.alias} from the room`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="serif remove-lede">
          @{participant.alias}&rsquo;s past replies stay in the timeline under its name; it simply stops receiving work here.
          {threadMissing ? " Its thread no longer exists in T3 Code, so there is nothing to archive or delete there." : " Its thread lives in T3 Code: choose what happens to it."}
        </p>
        {threadMissing ? null : (
        <label>
          T3 thread
          <select value={thread} onChange={(e) => setThread(e.target.value as ThreadLifecycleChoice)} title={THREAD_CHOICES.find((c) => c.key === thread)?.help}>
            {THREAD_CHOICES.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
          <span className="hint">{THREAD_CHOICES.find((c) => c.key === thread)?.help}. A thread also seated in another room is always kept.</span>
        </label>
        )}
        {deleting ? (
          <label className="checkbox">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I understand the thread and its history are deleted in T3 permanently.
          </label>
        ) : null}
        {owned.length > 0 || running ? (
          <p className="status-warn">
            @{participant.alias} {running ? "is in a turn" : ""}
            {running && owned.length > 0 ? " and " : ""}
            {owned.length > 0 ? `owns ${owned.length} open request${owned.length === 1 ? "" : "s"} (${owned.map((q) => `#${q.number}`).join(", ")})` : ""}: removal is refused until
            {owned.length > 0 ? " they are answered or cancelled" : " the turn ends"}.
          </p>
        ) : null}
        <p className="muted hint">Removal is refused while the member has work in progress; stop or wait for it first.</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary destructive" disabled={busy || (deleting && !confirmed)}>
            {busy ? "Removing…" : `Remove @${participant.alias}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shared alias/model fields for seating a participant; the alias is a room-local handle for one T3 thread. */
export interface CrewFieldsState {
  alias: string;
  model: ModelSelection | null;
  runtimeMode: RuntimeMode;
}

export const emptyCrewFields = (): CrewFieldsState => ({ alias: "", model: null, runtimeMode: "full-access" });

/**
 * Name leads (it is what you type, say, and see on the tile), then the model; the permission mode
 * lives behind a remembered Advanced disclosure. `children` renders between Model and Advanced.
 */
export function CrewFields({
  value,
  onChange,
  aliasLabel = "Name",
  aliasPlaceholder = "sol2",
  aliasTaken = false,
  aliasRef,
  showModel = true,
  modelPending = false,
  children,
}: {
  value: CrewFieldsState;
  onChange: (next: CrewFieldsState) => void;
  aliasLabel?: string;
  aliasPlaceholder?: string;
  aliasTaken?: boolean;
  aliasRef?: RefObject<HTMLInputElement | null>;
  /** Model, options and permission mode (a new thread); an attached thread keeps its own. */
  showModel?: boolean;
  /** While true the picker is withheld so it cannot auto-pick before T3's default is known. */
  modelPending?: boolean;
  children?: ReactNode;
}) {
  const set = <K extends keyof CrewFieldsState>(key: K, next: CrewFieldsState[K]) => onChange({ ...value, [key]: next });
  return (
    <>
      <label>
        {aliasLabel}
        <NameInput
          ref={aliasRef}
          value={value.alias}
          onValue={(alias) => set("alias", alias)}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}"
          placeholder={aliasPlaceholder}
          aria-invalid={aliasTaken}
        />
        {aliasTaken ? (
          <span className="field-error">Alias already used in this room.</span>
        ) : (
          <span className="hint">This is how you address it: @name in the composer, or just say the name.</span>
        )}
      </label>
      {showModel ? (
        <div className="form-field">
          <span>Model</span>
          <ThreadSettingsRow
            model={value.model}
            onModel={(model) => set("model", model)}
            runtimeMode={value.runtimeMode}
            onRuntimeMode={(mode) => set("runtimeMode", mode)}
            pending={modelPending}
          />
          <span className="hint">T3&rsquo;s own settings for the new thread (prefilled with the project&rsquo;s default model).</span>
        </div>
      ) : null}
      {children}
    </>
  );
}

const ADD_MODE_KEY = "backroom.addMode";

/** "Backroom Build Feasibility" -> "t3-rooms-build-feasibility" (valid alias: alnum start, [a-z0-9_-], max 32). */
export function slugifyAlias(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug;
}

/** A name free among `taken` (lowercased aliases): the name itself, else with 2, 3… added, as the service does. */
function freeAlias(name: string, taken: ReadonlySet<string>): string {
  let alias = name;
  for (let n = 2; taken.has(alias.toLowerCase()); n += 1) alias = `${name.slice(0, 32 - String(n).length)}${n}`;
  return alias;
}

function AddParticipantDialog({ onClose }: { onClose: () => void }) {
  const { runCommand, snapshot } = useRoom();
  const { toast } = useToast();
  const [mode, setMode] = useState<"create" | "attach">(() => (localStorage.getItem(ADD_MODE_KEY) === "attach" ? "attach" : "create"));
  const [fields, setFields] = useState<CrewFieldsState>(emptyCrewFields);
  const [aliasTouched, setAliasTouched] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceChoice>({ mode: "local" });
  // T3's default model for the project: "loading" until fetched; null when T3 has none configured.
  const [defaultModel, setDefaultModel] = useState<ModelSelection | null | "loading">("loading");
  const [fromDefault, setFromDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const { presets, reload: reloadPresets } = usePresets();
  const presetText = usePresetText();
  // A picked preset sets where it works once the project's branches are known, and keeps T3's default model out.
  const [workspacePrefer, setWorkspacePrefer] = useState<{ mode: "local" | "worktree"; nonce: number } | null>(null);
  const presetPicked = useRef(false);
  // The crew picked, in the order picked. One fills in the form; several are seated at once, each with its saved
  // settings, and the form waits hidden (with the preset it was filled from) in case they go back to one.
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const formPresetId = useRef<string | null>(null);
  const [seating, setSeating] = useState(0);
  const picked = pickedIds.map((id) => presets.find((p) => p.id === id)).filter((p): p is Preset => p !== undefined);
  const several = picked.length > 1;
  const aliasRef = useRef<HTMLInputElement>(null);
  const threads = useAttachableThreads(snapshot.room.projectId);
  const selectedThread = threadId ? (threads ?? []).find((t) => t.id === threadId) ?? null : null;

  const chooseMode = (next: "create" | "attach") => {
    localStorage.setItem(ADD_MODE_KEY, next);
    setMode(next);
  };

  // The crew member the ring was last on, where ↓ from New and Existing lands again.
  const lastChip = useRef<string | null>(null);
  // The arrows of New and Existing and of the crew (keyOrder.ts, chipTarget): ↓ from New or Existing to the crew, ← →
  // along it, ↑ back, ↓ on to the fields below. ← → on New and Existing stay theirs (they choose). Enter and Space on a
  // crew member are its click, a held Enter's repeats none.
  const onFormKey = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    const form = event.currentTarget;
    const chips = [...form.querySelectorAll<HTMLElement>(".preset-chip")];
    if (event.key === "Enter" && event.repeat && chips.includes(target)) return event.preventDefault();
    const key = arrowKey(event.nativeEvent);
    if (!key) return;
    // The first control Tab reaches after `from` and outside it.
    const after = (from: Element | null) => (from ? (tabbables(form).find((element) => !from.contains(element) && from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null) : null);
    if (target.matches(".add-mode input")) {
      if (key !== "up" && key !== "down") return;
      // ↑ goes nowhere: New and Existing are the top.
      event.preventDefault();
      if (key === "down") focusItem(chips.find((chip) => chip.dataset.presetId === lastChip.current) ?? chips[0] ?? after(target.closest(".composer-row")));
      return;
    }
    const at = chips.indexOf(target);
    if (at < 0) return;
    event.preventDefault();
    const next = chipTarget(chips.length, at, key);
    if (next === "above") focusItem(form.querySelector<HTMLElement>(".add-mode input:checked"));
    else if (next === "below") focusItem(after(target.closest(".preset-field")));
    else if (next !== null) focusItem(chips[next]!);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .defaultModel(snapshot.room.projectId)
      .then(({ modelSelection }) => {
        if (cancelled) return;
        setDefaultModel(modelSelection);
        if (modelSelection && !presetPicked.current) {
          setFields((f) => ({ ...f, model: modelSelection }));
          setFromDefault(true);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setDefaultModel(null);
        toast(error instanceof ApiError ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.room.projectId, toast]);

  const seatedAliases = () => new Set(snapshot.participants.filter(isActiveParticipant).map((p) => p.alias.toLowerCase()));
  const aliasTaken = seatedAliases().has(fields.alias.trim().toLowerCase());
  const aliasValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(fields.alias.trim());
  const ready = (mode === "create" && several) || (aliasValid && !aliasTaken && (mode === "create" ? fields.model !== null && workspaceReady(workspace) : threadId !== null));

  const selectThread = (thread: T3ThreadShell) => {
    setThreadId(thread.id);
    if (!aliasTouched || fields.alias.trim().length === 0) setFields((f) => ({ ...f, alias: slugifyAlias(thread.title) }));
  };

  const applyPreset = (preset: Preset) => {
    formPresetId.current = preset.id;
    presetPicked.current = true;
    setFields({ alias: freeAlias(preset.name, seatedAliases()), model: preset.modelSelection, runtimeMode: preset.runtimeMode });
    setAliasTouched(true);
    setFromDefault(false);
    setWorkspacePrefer({ mode: preset.workspaceMode, nonce: Date.now() });
  };

  // Nobody picked: the form goes back to how it opened, on T3's default model.
  const clearForm = () => {
    formPresetId.current = null;
    presetPicked.current = false;
    const model = defaultModel === "loading" ? null : defaultModel;
    setFields({ ...emptyCrewFields(), model });
    setFromDefault(model !== null);
    setAliasTouched(false);
    setWorkspacePrefer({ mode: "local", nonce: Date.now() });
  };

  const pick = (ids: string[]) => {
    setPickedIds(ids);
    if (ids.length === 1 && ids[0] !== formPresetId.current) {
      const preset = presets.find((p) => p.id === ids[0]);
      if (preset) applyPreset(preset);
    } else if (ids.length === 0 && formPresetId.current) clearForm();
  };
  const togglePreset = (preset: Preset) => !busy && pick(pickedIds.includes(preset.id) ? pickedIds.filter((id) => id !== preset.id) : [...pickedIds, preset.id]);

  // The names the picked take, as the service will give them: each after the ones seated before it.
  const pickedAliases = (() => {
    const taken = seatedAliases();
    return picked.map((preset) => {
      const alias = freeAlias(preset.name, taken);
      taken.add(alias.toLowerCase());
      return alias;
    });
  })();

  // The form as a preset, under the name typed: a new one, or the one of that name brought up to date.
  const presetOfName = presets.find((p) => p.name.toLowerCase() === fields.alias.trim().toLowerCase()) ?? null;
  const savePreset = async () => {
    if (!aliasValid || !fields.model) return;
    const values = { name: fields.alias.trim(), modelSelection: fields.model, runtimeMode: fields.runtimeMode, workspaceMode: workspace.mode === "worktree" ? ("worktree" as const) : ("local" as const) };
    const result = presetOfName ? await runCommand({ type: "preset.update", presetId: presetOfName.id, ...values }) : await runCommand({ type: "preset.create", ...values });
    if (!result) return;
    reloadPresets();
    toast(presetOfName ? `${values.name} in your crew updated` : `${values.name} saved to your crew`, "success");
  };

  const onFields = (next: CrewFieldsState) => {
    if (next.alias !== fields.alias) setAliasTouched(true);
    if (next.model !== fields.model && fromDefault && JSON.stringify(next.model) !== JSON.stringify(defaultModel)) setFromDefault(false);
    // Another model or permission mode makes someone new: the crew member the form came from is no longer picked.
    const formPreset = presets.find((p) => p.id === formPresetId.current);
    if (formPreset && (JSON.stringify(next.model) !== JSON.stringify(formPreset.modelSelection) || next.runtimeMode !== formPreset.runtimeMode)) {
      formPresetId.current = null;
      setPickedIds([]);
    }
    setFields(next);
  };

  // Seated one after another, so each takes the next free name. What fails stays picked, to try again.
  const seatPicked = async () => {
    setBusy(true);
    const seated = new Set<string>();
    for (const preset of picked) {
      setSeating(seated.size + 1);
      const result = await runCommand({ type: "participant.fromPreset", roomId: snapshot.room.id, presetId: preset.id });
      if (!result) break;
      seated.add(preset.id);
    }
    setBusy(false);
    if (seated.size === picked.length) onClose();
    else pick(pickedIds.filter((id) => !seated.has(id)));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (mode === "create" && several) return seatPicked();
    setBusy(true);
    // An attached thread keeps what T3 already has: no model, options or permission mode are sent.
    const result =
      mode === "attach"
        ? await runCommand({
            type: "participant.create",
            roomId: snapshot.room.id,
            alias: fields.alias.trim(),
            interactionMode: "default",
            thread: { mode: "attach", threadId: threadId as string },
          })
        : await runCommand({
            type: "participant.create",
            roomId: snapshot.room.id,
            alias: fields.alias.trim(),
            // Still on T3's default: let the server resolve it rather than pinning a copy.
            ...(fromDefault ? {} : { modelSelection: fields.model as ModelSelection }),
            runtimeMode: fields.runtimeMode,
            interactionMode: "default",
            thread: { mode: "create", ...(workspace.mode === "local" ? {} : { workspace }) },
          });
    setBusy(false);
    if (result) onClose();
  };

  return (
    <Dialog title="Add member" onClose={onClose} wide>
      <form
        className="form"
        onSubmit={submit}
        onKeyDown={onFormKey}
        onFocus={(event) => {
          if (event.target.matches(".preset-chip")) lastChip.current = event.target.dataset.presetId ?? null;
        }}
      >
        <div className="composer-row" role="group" aria-label="Thread">
          <span className="segmented add-mode">
            <label className={`segment${mode === "create" ? " on" : ""}`} title="The member gets a new T3 thread">
              <input type="radio" name="add-mode" checked={mode === "create"} onChange={() => chooseMode("create")} />
              New
            </label>
            <label className={`segment${mode === "attach" ? " on" : ""}`} title="The member continues one of the project's T3 threads">
              <input type="radio" name="add-mode" checked={mode === "attach"} onChange={() => chooseMode("attach")} />
              Existing
              {threads !== null ? <span className="muted"> ({threads.length})</span> : null}
            </label>
          </span>
        </div>

        {mode === "create" ? (
          <>
            <PresetChips
              model={fields.model}
              runtimeMode={fields.runtimeMode}
              onPick={togglePreset}
              pickedIds={pickedIds}
              note={
                picked.length === 0 ? (
                  "Pick one to fill in the settings below, or several to add them all at once."
                ) : picked.length === 1 ? (
                  <>
                    <strong>{picked[0]?.name}</strong>&rsquo;s settings are filled in below; change anything you like, or pick more to add several at once.
                  </>
                ) : null
              }
            />
            {several ? (
              <div className="form-field">
                <span>Joining</span>
                <ul className="seat-list">
                  {picked.map((preset, index) => {
                    const where = preset.workspaceMode === "worktree" ? "new worktree" : "project folder";
                    return (
                      <li key={preset.id} className="seat-row">
                        <PresetIcon preset={preset} />
                        <span className="preset-chip-name">@{pickedAliases[index]}</span>
                        <span className="preset-chip-what">{[presetText(preset).what, RUNTIME_MODE_INFO[preset.runtimeMode].label, where].join(" · ")}</span>
                      </li>
                    );
                  })}
                </ul>
                <span className="hint">Each joins on a new thread of their own, with the settings saved in your crew. To change someone&rsquo;s first, pick them alone.</span>
              </div>
            ) : (
              <CrewFields value={fields} onChange={onFields} aliasTaken={aliasTaken} aliasRef={aliasRef} modelPending={defaultModel === "loading"}>
                <WorkspacePicker
                  projectId={snapshot.room.projectId}
                  value={workspace}
                  onChange={setWorkspace}
                  newBranchHint={`${branchSlug(snapshot.room.title, "room")}/${branchSlug(fields.alias || "name", "name")}`}
                  prefer={workspacePrefer}
                />
              </CrewFields>
            )}
            <div className="dialog-actions">
              {several ? null : (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || !aliasValid || fields.model === null}
                  title={presetOfName ? `Bring ${presetOfName.name} in your crew up to date with these settings` : "Keep these settings under this name in your crew, to seat or start with one click next time"}
                  onClick={() => void savePreset()}
                >
                  {presetOfName ? "Update in crew" : "Save to crew"}
                </button>
              )}
              <span className="spacer" />
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !ready}>
                {several ? (busy ? `Adding ${seating} of ${picked.length}…` : `Add ${picked.length} members`) : busy ? "Adding…" : "Add member"}
              </button>
            </div>
          </>
        ) : (
          <>
            <ThreadList threads={threads} selectedId={threadId} onSelect={selectThread} name="add-thread-id" />
            {selectedThread ? <InheritedLine thread={selectedThread} /> : <span className="hint">Pick the thread this member should continue.</span>}
            <CrewFields value={fields} onChange={onFields} aliasTaken={aliasTaken} aliasRef={aliasRef} showModel={false} />
            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !ready}>
                {busy ? "Attaching…" : "Attach and add"}
              </button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}


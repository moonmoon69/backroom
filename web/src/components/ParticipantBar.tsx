import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import {
  isActiveParticipant,
  RUNTIME_MODES,
  type Desk,
  type ModelSelection,
  type T3ThreadShell,
  type Participant,
  type ParticipantStatus,
  type RuntimeMode,
  type ThreadBindingInput,
  type CommandResult,
  type ThreadLifecycleChoice,
} from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { ContextReadout } from "./ContextMeter.tsx";
import { fmtTokens } from "./deskFormat.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { OpenInT3Dialog } from "./OpenInT3Dialog.tsx";
import { InheritedLine, ModelPicker, ThreadBindingPicker, ThreadList, threadBindingReady, useAttachableThreads } from "./pickers.tsx";
import { ThreadDetailsDialog } from "./ThreadDetails.tsx";
import { ThreadUsageCard } from "./ThreadUsageCard.tsx";
import { useToast } from "./Toast.tsx";
import { Popover } from "./Popover.tsx";
import { THREAD_CHOICES } from "./RoomActions.tsx";

type MenuAction = "open" | "details" | "settings" | "rebind" | "remove";

export function describeStatus(status: ParticipantStatus | undefined): { label: string; tone: string } {
  if (!status) return { label: "unknown", tone: "unknown" };
  // A deleted T3 thread outranks everything: the participant cannot receive work until rebound or removed.
  if (status.threadMissing) return { label: "thread deleted in T3", tone: "missing" };
  // PRD: waiting for input is the most prominent state, then working, then busy in T3, then idle/ready.
  if (status.pendingApprovals || status.pendingUserInput) return { label: "needs input", tone: "input" };
  if (status.activeRunId || status.session === "running") return { label: "working", tone: "working" };
  if (status.externalActivity) return { label: "busy in T3", tone: "busy" };
  // Between turns but not done: the agent will wake itself when its background work finishes.
  if (status.background === "working") return { label: "background work", tone: "busy" };
  if (status.background === "monitoring") return { label: "monitoring", tone: "busy" };
  switch (status.session) {
    case "error":
      return { label: "error", tone: "error" };
    case "starting":
      return { label: "starting", tone: "working" };
    case "idle":
    case "ready":
      return { label: status.session, tone: "idle" };
    case "interrupted":
    case "stopped":
      return { label: status.session, tone: "stopped" };
    default:
      return { label: "unknown", tone: "unknown" };
  }
}

export function ParticipantBar() {
  const { snapshot, desk } = useRoom();
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<{ action: MenuAction; participant: Participant } | null>(null);

  return (
    <div className="participant-bar" aria-label="Participants">
      {snapshot.participants.filter(isActiveParticipant).length === 0 ? (
        <span className="serif muted crew-empty">No crew seated; add a participant to start handing out work.</span>
      ) : null}
      {snapshot.participants.filter(isActiveParticipant).map((participant) => (
        <ParticipantChip
          key={participant.id}
          participant={participant}
          status={snapshot.participantStatus[participant.id]}
          desk={desk?.participants[participant.id] ?? null}
          onAction={(action) => setDialog({ action, participant })}
        />
      ))}
      <button type="button" className="crew-add" onClick={() => setAdding(true)}>
        + Add participant
      </button>
      <CrewContextTotal />
      {adding ? <AddParticipantDialog onClose={() => setAdding(false)} /> : null}
      {dialog?.action === "open" ? <OpenInT3Dialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "details" ? <ThreadDetailsDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "settings" ? <ParticipantSettingsDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "rebind" ? <RebindDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
      {dialog?.action === "remove" ? <RemoveParticipantDialog participant={dialog.participant} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

/** Sum of usedTokens across seated participants whose threads report context; hidden when nothing reports. */
function CrewContextTotal() {
  const { snapshot, desk } = useRoom();
  const readings = snapshot.participants
    .filter(isActiveParticipant)
    .map((p) => desk?.participants[p.id]?.contextWindow ?? null)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (readings.length === 0) return null;
  const total = readings.reduce((n, r) => n + r.usedTokens, 0);
  return (
    <span className="crew-total mono" title={`${readings.length} thread${readings.length === 1 ? "" : "s"} reporting context`}>
      <span className="label">Total</span> crew context {fmtTokens(total)}
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

  // Usage card: on hover (after a short delay, so passing the mouse over the strip does not flash it) and at the
  // top of the click menu.
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIn = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(true), 450);
  };
  const hoverOut = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(false), 150);
  };
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const { colorOf, snapshot } = useRoom();
  const roleName = participant.roleId ? (snapshot.roles.find((r) => r.id === participant.roleId)?.name ?? null) : null;
  const described = describeStatus(status);
  const pick = (action: MenuAction) => {
    setOpen(false);
    onAction(action);
  };
  return (
    <div className="participant-chip" ref={ref} style={identityStyle(colorOf(participant.id))} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      <button
        type="button"
        className="participant-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          described.tone === "missing"
            ? "Rebind to another thread or remove the participant"
            : `${participant.alias} · ${participant.modelSelection.model} · ${described.label}`
        }
      >
        <Monogram participant={participant} size="md" ring={described.tone} pulse={described.tone === "working"} />
        <span className="crew-text">
          <span className="alias mono identity">
            {participant.alias}
            {desk && desk.pullRequests.length > 0 ? (
              <span className="pill pill-pr" title={desk.pullRequests.map((pr) => `${pr.repository}#${pr.number}`).join(", ")}>
                PR
              </span>
            ) : null}
          </span>
          {roleName ? <span className="role">{roleName}</span> : null}
          <span className="model">
            {participant.modelSelection.model}
            {effortOf(participant.modelSelection) ? ` · ${effortOf(participant.modelSelection)}` : ""}
          </span>
          <span className={`status-label mono status-${described.tone}`}>{described.label}</span>
          {desk ? <ContextReadout desk={desk} /> : <span className="crew-context mono no-reading">context —</span>}
        </span>
      </button>
      {hover && !open ? (
        <div className="usage-popover">
          <ThreadUsageCard participant={participant} desk={desk} />
        </div>
      ) : null}
      {open ? (
        <Popover anchor={ref} menuRef={menuRef} className="menu-with-usage" role="menu" onClose={() => setOpen(false)}>
          <ThreadUsageCard participant={participant} desk={desk} />
          <button type="button" role="menuitem" onClick={() => pick("open")}>
            Open in T3
          </button>
          <button type="button" role="menuitem" onClick={() => pick("details")}>
            Thread details…
          </button>
          <button type="button" role="menuitem" onClick={() => pick("settings")}>
            Settings…
          </button>
          <button type="button" role="menuitem" onClick={() => pick("rebind")}>
            Rebind thread…
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => pick("remove")}>
            Remove from room…
          </button>
        </Popover>
      ) : null}
    </div>
  );
}

/** Role picker over the room's roles, with an inline "New role…" form that posts role.create. */
export function RoleSelect({
  value,
  onChange,
  id,
  autoFocus = false,
}: {
  value: string | null;
  onChange: (roleId: string | null) => void;
  id?: string;
  /** Marks the select as the dialog's initial focus target (Dialog's data-autofocus). */
  autoFocus?: boolean;
}) {
  const { snapshot, runCommand } = useRoom();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [rules, setRules] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim() || !rules.trim()) return;
    setBusy(true);
    const result = await runCommand({ type: "role.create", name: name.trim(), rules: rules.trim() });
    setBusy(false);
    if (result) {
      const roleId = "roleId" in result && typeof result.roleId === "string" ? result.roleId : null;
      onChange(roleId);
      setCreating(false);
      setName("");
      setRules("");
    }
  };
  return (
    <div className="role-select">
      <label>
        Role
        <select
          id={id}
          data-autofocus={autoFocus ? "" : undefined}
          value={creating ? "__new__" : (value ?? "")}
          onChange={(e) => {
            if (e.target.value === "__new__") {
              setCreating(true);
              return;
            }
            setCreating(false);
            onChange(e.target.value === "" ? null : e.target.value);
          }}
        >
          <option value="">none</option>
          {snapshot.roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
          <option value="__new__">New role…</option>
        </select>
        <span className="hint">A named set of rules delivered with every assignment while the role is held.</span>
      </label>
      {creating ? (
        <div className="role-inline" role="group" aria-label="New role">
          <label>
            Role name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="accountant" autoFocus />
          </label>
          <label>
            Rules
            <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={3} placeholder="Reconcile every figure twice." />
            <span className="hint">Delivered as plain text with every assignment for anyone holding this role; not an enforced permission.</span>
          </label>
          <div className="row">
            <button type="button" className="small primary" disabled={busy || !name.trim() || !rules.trim()} onClick={() => void create()}>
              Create role
            </button>
            <button type="button" className="small ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const MODE_HELP: Record<RuntimeMode, string> = {
  "approval-required": "Every tool call asks for approval in the queue drawer.",
  "auto-accept-edits": "File edits are accepted automatically; other tools ask.",
  auto: "T3 decides which actions need approval.",
  "full-access": "No approval prompts.",
};

/** The field a settings entry point wants focused when the dialog opens. */
export type SettingsField = "name" | "role" | "mode";

interface SettingsValues {
  alias: string;
  roleId: string | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
}

const sameModel = (a: ModelSelection | null, b: ModelSelection | null) => JSON.stringify(a) === JSON.stringify(b);
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error));

/**
 * One dialog for a seated participant's name, role, model and permission mode. Save sends only what
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
    roleId: participant.roleId,
    modelSelection: participant.modelSelection,
    runtimeMode: participant.runtimeMode,
  }));
  const [alias, setAlias] = useState(participant.alias);
  const [roleId, setRoleId] = useState<string | null>(participant.roleId);
  const [model, setModel] = useState<ModelSelection | null>(participant.modelSelection);
  const [mode, setMode] = useState<RuntimeMode>(participant.runtimeMode);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Array<{ part: string; message: string }>>([]);

  const trimmed = alias.trim();
  const aliasTaken = snapshot.participants
    .filter(isActiveParticipant)
    .some((p) => p.id !== participant.id && p.alias.toLowerCase() === trimmed.toLowerCase());
  const aliasChanged = trimmed !== saved.alias;
  const roleChanged = roleId !== saved.roleId;
  const modelChanged = model !== null && !sameModel(model, saved.modelSelection);
  const modeChanged = mode !== saved.runtimeMode;
  const changed = aliasChanged || roleChanged || modelChanged || modeChanged;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !changed || aliasTaken || trimmed.length === 0) return;
    setBusy(true);
    setFailures([]);
    const next = { ...saved };
    const failed: Array<{ part: string; message: string }> = [];
    let applied = false;
    if (aliasChanged || roleChanged) {
      try {
        await api.command({
          type: "participant.update",
          participantId: participant.id,
          ...(aliasChanged ? { alias: trimmed } : {}),
          ...(roleChanged ? { roleId } : {}),
        });
        next.alias = trimmed;
        next.roleId = roleId;
        applied = true;
      } catch (error) {
        failed.push({ part: aliasChanged && roleChanged ? "Name and role" : aliasChanged ? "Name" : "Role", message: errorText(error) });
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
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
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
        <RoleSelect value={roleId} onChange={setRoleId} autoFocus={focus === "role"} />
        <label>
          Model
          <ModelPicker value={model} onChange={setModel} providerFilter={saved.modelSelection.instanceId} />
          <span className="hint">Applies to the T3 thread itself; changes made in T3 Code show up here too.</span>
        </label>
        <p className="muted mono small-note">
          Provider stays {saved.modelSelection.instanceId}: T3 cannot switch a thread&rsquo;s provider. Rebind to a new thread to use another.
        </p>
        <fieldset>
          <legend>Permission mode</legend>
          <span className="hint">Enforced by T3 for this thread, independent of any role rules.</span>
          {RUNTIME_MODES.map((candidate) => (
            <label key={candidate} className="radio">
              <input
                type="radio"
                name="runtime-mode"
                checked={mode === candidate}
                onChange={() => setMode(candidate)}
                data-autofocus={focus === "mode" && mode === candidate ? "" : undefined}
              />
              <span>
                <strong>{candidate}</strong>
                <span className="hint">{MODE_HELP[candidate]}</span>
              </span>
            </label>
          ))}
        </fieldset>
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

export function RebindDialog({ participant, onClose }: { participant: Participant; onClose: () => void }) {
  const { runCommand, snapshot } = useRoom();
  const [thread, setThread] = useState<ThreadBindingInput>({ mode: "create" });
  const [outstanding, setOutstanding] = useState<"carry" | "block" | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = snapshot.tasks.filter(
    (t) => t.participantId === participant.id && (t.state === "queued" || t.state === "held" || t.state === "blocked"),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!outstanding) return;
    setBusy(true);
    const result = await runCommand({ type: "participant.rebind", participantId: participant.id, thread, outstandingTasks: outstanding });
    setBusy(false);
    if (result) onClose();
  };
  return (
    <Dialog title={`Rebind ${participant.alias} to another thread`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">
          The current binding is retired and kept in history. A bootstrap briefing is delivered to the replacement
          thread.
        </p>
        <ThreadBindingPicker projectId={snapshot.room.projectId} value={thread} onChange={setThread} />
        <fieldset>
          <legend>
            Outstanding tasks ({pending.length} pending) <span className="required">required</span>
          </legend>
          <label className="radio">
            <input type="radio" name="outstanding" checked={outstanding === "carry"} onChange={() => setOutstanding("carry")} />
            <span>
              <strong>Carry</strong>
              <span className="hint">Pending tasks are delivered to the replacement thread.</span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="outstanding" checked={outstanding === "block"} onChange={() => setOutstanding("block")} />
            <span>
              <strong>Block</strong>
              <span className="hint">Pending tasks are marked blocked until you unblock them.</span>
            </span>
          </label>
        </fieldset>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !outstanding || !threadBindingReady(thread)}>
            Rebind
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
  const [pendingTasks, setPendingTasks] = useState<"cancel" | "keep" | null>(null);
  const [thread, setThread] = useState<ThreadLifecycleChoice>("keep");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = snapshot.tasks.filter(
    (t) => t.participantId === participant.id && (t.state === "queued" || t.state === "held" || t.state === "blocked"),
  );
  // A thread T3 no longer has cannot be settled, archived, or deleted; the choice is skipped and "keep" sent.
  const threadMissing = snapshot.participantStatus[participant.id]?.threadMissing === true;
  const deleting = thread === "delete" && !threadMissing;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingTasks || (deleting && !confirmed)) return;
    setBusy(true);
    const result = (await runCommand({ type: "participant.retire", participantId: participant.id, pendingTasks, thread: threadMissing ? "keep" : thread })) as CommandResult | null;
    setBusy(false);
    if (!result) return;
    const outcome = result.type === "participant.updated" && "thread" in result ? (result as Extract<CommandResult, { type: "participant.updated" }>).thread : undefined;
    if (outcome && outcome.action !== "keep") {
      if (outcome.result === "done") toast(`@${participant.alias} removed; its thread was ${outcome.action === "delete" ? "deleted" : `${outcome.action}d`} in T3.`, "success");
      else if (outcome.result === "kept") toast(`@${participant.alias} removed; its thread was kept in T3 (${outcome.detail ?? "still in use"}).`, "info");
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
        <fieldset>
          <legend>
            Pending tasks ({pending.length}) <span className="required">required</span>
          </legend>
          <label className="radio">
            <input type="radio" name="pending-tasks" checked={pendingTasks === "cancel"} onChange={() => setPendingTasks("cancel")} />
            <span>
              <strong>Cancel its pending tasks</strong>
              <span className="hint">Queued, held and blocked work assigned to it is cancelled.</span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="pending-tasks" checked={pendingTasks === "keep"} onChange={() => setPendingTasks("keep")} />
            <span>
              <strong>Keep them blocked so I can reassign</strong>
              <span className="hint">Pending work stays on the board as blocked until you edit it onto someone else.</span>
            </span>
          </label>
        </fieldset>
        <p className="muted hint">Removal is refused while the participant has work in progress; stop or wait for it first.</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary destructive" disabled={busy || !pendingTasks || (deleting && !confirmed)}>
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

const ADVANCED_KEY = "t3rooms.crewAdvanced";

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
  showRuntimeMode = true,
  modelTag,
  modelPending = false,
  children,
}: {
  value: CrewFieldsState;
  onChange: (next: CrewFieldsState) => void;
  aliasLabel?: string;
  aliasPlaceholder?: string;
  aliasTaken?: boolean;
  aliasRef?: RefObject<HTMLInputElement | null>;
  showModel?: boolean;
  showRuntimeMode?: boolean;
  /** Small tag shown next to the Model label (for example "T3 default"). */
  modelTag?: ReactNode;
  /** While true the picker is withheld so it cannot auto-pick before T3's default is known. */
  modelPending?: boolean;
  children?: ReactNode;
}) {
  const set = <K extends keyof CrewFieldsState>(key: K, next: CrewFieldsState[K]) => onChange({ ...value, [key]: next });
  const [advanced, setAdvanced] = useState<boolean>(() => localStorage.getItem(ADVANCED_KEY) === "open");
  const toggleAdvanced = () => {
    setAdvanced((open) => {
      localStorage.setItem(ADVANCED_KEY, open ? "closed" : "open");
      return !open;
    });
  };
  const advancedId = "crew-advanced";
  return (
    <>
      <label>
        {aliasLabel}
        <input
          ref={aliasRef}
          value={value.alias}
          onChange={(e) => set("alias", e.target.value)}
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
        <label>
          <span className="label-row">
            Model
            {modelTag}
          </span>
          {modelPending ? <span className="muted mono model-pending">looking up T3's default model…</span> : <ModelPicker value={value.model} onChange={(model) => set("model", model)} />}
        </label>
      ) : null}
      {children}
      {showRuntimeMode ? (
        <div className="advanced">
          <button type="button" className="advanced-toggle mono" aria-expanded={advanced} aria-controls={advancedId} onClick={toggleAdvanced}>
            <span className="chevron" aria-hidden="true">
              {advanced ? "▾" : "▸"}
            </span>
            Advanced
            {!advanced ? <span className="muted advanced-summary">{value.runtimeMode}</span> : null}
          </button>
          {advanced ? (
            <div className="advanced-body" id={advancedId}>
              <label>
                Permission mode
                <select value={value.runtimeMode} onChange={(e) => set("runtimeMode", e.target.value as RuntimeMode)}>
                  {RUNTIME_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
                <span className="hint">Enforced by T3 for this thread; independent of any role rules.</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

const ADD_MODE_KEY = "t3rooms.addMode";

/** "T3 Rooms Build Feasibility" -> "t3-rooms-build-feasibility" (valid alias: alnum start, [a-z0-9_-], max 32). */
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

function AddParticipantDialog({ onClose }: { onClose: () => void }) {
  const { runCommand, snapshot } = useRoom();
  const { toast } = useToast();
  const [mode, setMode] = useState<"create" | "attach">(() => (localStorage.getItem(ADD_MODE_KEY) === "attach" ? "attach" : "create"));
  const [fields, setFields] = useState<CrewFieldsState>(emptyCrewFields);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [aliasTouched, setAliasTouched] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  // T3's default model for the project: "loading" until fetched; null when T3 has none configured.
  const [defaultModel, setDefaultModel] = useState<ModelSelection | null | "loading">("loading");
  const [fromDefault, setFromDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const aliasRef = useRef<HTMLInputElement>(null);
  const threads = useAttachableThreads(snapshot.room.projectId);
  const selectedThread = threadId ? (threads ?? []).find((t) => t.id === threadId) ?? null : null;

  const chooseMode = (next: "create" | "attach") => {
    localStorage.setItem(ADD_MODE_KEY, next);
    setMode(next);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .defaultModel(snapshot.room.projectId)
      .then(({ modelSelection }) => {
        if (cancelled) return;
        setDefaultModel(modelSelection);
        if (modelSelection) {
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

  const aliasTaken = snapshot.participants.filter(isActiveParticipant).some((p) => p.alias.toLowerCase() === fields.alias.trim().toLowerCase());
  const aliasValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(fields.alias.trim());
  const ready = aliasValid && !aliasTaken && (mode === "create" ? fields.model !== null : threadId !== null);

  const selectThread = (thread: T3ThreadShell) => {
    setThreadId(thread.id);
    if (!aliasTouched || fields.alias.trim().length === 0) setFields((f) => ({ ...f, alias: slugifyAlias(thread.title) }));
  };

  const onFields = (next: CrewFieldsState) => {
    if (next.alias !== fields.alias) setAliasTouched(true);
    if (next.model !== fields.model && fromDefault && JSON.stringify(next.model) !== JSON.stringify(defaultModel)) setFromDefault(false);
    setFields(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    // An attached thread keeps what T3 already has: no model, options or permission mode are sent.
    const result =
      mode === "attach"
        ? await runCommand({
            type: "participant.create",
            roomId: snapshot.room.id,
            alias: fields.alias.trim(),
            roleId,
            interactionMode: "default",
            thread: { mode: "attach", threadId: threadId as string },
          })
        : await runCommand({
            type: "participant.create",
            roomId: snapshot.room.id,
            alias: fields.alias.trim(),
            roleId,
            // Still on T3's default: let the server resolve it rather than pinning a copy.
            ...(fromDefault ? {} : { modelSelection: fields.model as ModelSelection }),
            runtimeMode: fields.runtimeMode,
            interactionMode: "default",
            thread: { mode: "create" },
          });
    setBusy(false);
    if (result) onClose();
  };

  const modelTag =
    defaultModel === "loading" ? null : fromDefault ? (
      <span className="pill pill-muted mono" title="T3's default model for this project; pick another to override for this thread">
        T3 default
      </span>
    ) : defaultModel === null ? (
      <span className="pill pill-muted mono" title="T3 has no default model for this project">no T3 default</span>
    ) : null;

  return (
    <Dialog title="Add participant" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="composer-row" role="group" aria-label="Thread">
          <span className="segmented add-mode">
            <label className={`segment${mode === "create" ? " on" : ""}`}>
              <input type="radio" name="add-mode" checked={mode === "create"} onChange={() => chooseMode("create")} />
              New thread
            </label>
            <label className={`segment${mode === "attach" ? " on" : ""}`}>
              <input type="radio" name="add-mode" checked={mode === "attach"} onChange={() => chooseMode("attach")} />
              Attach existing
              {threads !== null ? <span className="muted"> ({threads.length})</span> : null}
            </label>
          </span>
        </div>

        {mode === "create" ? (
          <>
            <CrewFields value={fields} onChange={onFields} aliasTaken={aliasTaken} aliasRef={aliasRef} modelTag={modelTag} modelPending={defaultModel === "loading"}>
              <RoleSelect value={roleId} onChange={setRoleId} />
            </CrewFields>
            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !ready}>
                {busy ? "Adding…" : "Add participant"}
              </button>
            </div>
          </>
        ) : (
          <>
            <ThreadList threads={threads} selectedId={threadId} onSelect={selectThread} name="add-thread-id" />
            {selectedThread ? <InheritedLine thread={selectedThread} /> : <span className="hint">Pick the thread this participant should continue.</span>}
            <CrewFields value={fields} onChange={onFields} aliasTaken={aliasTaken} aliasRef={aliasRef} showModel={false} showRuntimeMode={false}>
              <RoleSelect value={roleId} onChange={setRoleId} />
            </CrewFields>
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

/** The effort option value, when the model selection carries one. */
export const effortOf = (selection: ModelSelection): string | null => {
  const value = selection.options?.find((o) => o.id === "effort")?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
};

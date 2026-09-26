import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, useLive } from "../api.ts";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, taskLabel, type PrerequisiteRef, type Run, type Schedule, type ScheduleMode, type Task } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { LiveFeed } from "./LiveFeed.tsx";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { PrerequisitePicker } from "./PrerequisitePicker.tsx";
import { useToast } from "./Toast.tsx";

type TaskDialog = "edit" | "retry" | "block" | "inspect";

export function scheduleSummary(task: Task, labelFor: (taskId: string) => string): string {
  if (task.scheduleMode === "after_all") return `After ${task.prerequisites.map((p) => labelFor(p.taskId)).join(", ") || "(none)"}`;
  if (task.scheduleMode === "manual") return "Held until released";
  return "Now";
}

/**
 * A work order. `variant="chip"` is the timeline form under the user's message: one compact row (id, assignee,
 * instruction, schedule, state) that expands for the full instruction and the secondary actions. Actionable states
 * (pending, running, failed) always show their actions, and a running task always shows its live section.
 */
/** Plain words for task states in the chat; the Tasks panel and dialogs keep the exact state names. */
const STATE_WORDS: Record<Task["state"], string> = {
  queued: "waiting",
  held: "held",
  blocked: "blocked",
  dispatching: "sending",
  running: "working",
  needs_input: "needs you",
  succeeded: "done",
  failed: "failed",
  interrupted: "stopped",
  cancelled: "cancelled",
};

export function TaskCard({
  task,
  compact = false,
  variant = "card",
  showInstruction = true,
}: {
  task: Task;
  compact?: boolean;
  variant?: "card" | "chip";
  /** Chip only: false when the instruction is simply the message above (one assignment), so it is not repeated. */
  showInstruction?: boolean;
}) {
  const { snapshot, runCommand, aliasOf, colorOf, addFollowUp } = useRoom();
  const [dialog, setDialog] = useState<TaskDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const runs = snapshot.runs.filter((r) => r.taskId === task.id).sort((a, b) => a.attempt - b.attempt);
  const currentRun = task.currentRunId ? runs.find((r) => r.id === task.currentRunId) ?? null : null;
  const latestRun = currentRun ?? runs[runs.length - 1] ?? null;
  // After a retry the task has no current run yet; the last run's error belongs to the previous attempt.
  const runError: string | null = latestRun?.error
    ? currentRun === null && task.state !== "failed" && task.state !== "interrupted"
      ? `previous attempt: ${latestRun.error}`
      : latestRun.error
    : null;
  const labelFor = (taskId: string) => {
    const found = snapshot.tasks.find((t) => t.id === taskId);
    return found ? taskLabel(found) : taskId;
  };

  /** "grok" or "grok, sol1": who this task waits for, by name; numbers stay in the tooltip. */
  const waitNames = (t: Task): string => {
    const names = t.prerequisites.map((p) => {
      const prerequisite = snapshot.tasks.find((x) => x.id === p.taskId);
      return prerequisite ? `@${aliasOf(prerequisite.participantId)}` : labelFor(p.taskId);
    });
    return [...new Set(names)].join(", ") || "(none)";
  };

  const send = async (command: Parameters<typeof runCommand>[0]) => {
    setBusy(true);
    try {
      await runCommand(command);
    } finally {
      setBusy(false);
    }
  };

  const pending = task.state === "queued" || task.state === "held" || task.state === "blocked";
  const active = task.state === "dispatching" || task.state === "running" || task.state === "needs_input";
  const retryable = task.state === "failed" || task.state === "interrupted";

  const assignee = snapshot.participants.find((p) => p.id === task.participantId);
  const reason =
    task.stateReason && task.stateReason.toLowerCase() !== scheduleSummary(task, labelFor).toLowerCase() ? task.stateReason : null;
  const primaryAction = task.state === "held" ? "release" : task.state === "blocked" ? "unblock" : retryable ? "retry" : active ? "stop" : null;
  const ghostClass = (name: string) => `small ghost${primaryAction === name ? " primary-outline" : ""}`;

  const actions = (
    <div className="task-actions">
      {pending ? (
        <>
          <button type="button" className={ghostClass("edit")} disabled={busy} onClick={() => setDialog("edit")}>
            Edit
          </button>
          <button
            type="button"
            className={ghostClass("cancel")}
            disabled={busy}
            onClick={() => send({ type: "task.cancel", taskId: task.id, revision: task.revision })}
          >
            Cancel
          </button>
          {task.state === "held" ? (
            <button
              type="button"
              className={ghostClass("release")}
              disabled={busy}
              onClick={() => send({ type: "task.release", taskId: task.id, revision: task.revision })}
            >
              Release
            </button>
          ) : null}
          {task.state === "blocked" ? (
            <button
              type="button"
              className={ghostClass("unblock")}
              disabled={busy}
              onClick={() => send({ type: "task.unblock", taskId: task.id, revision: task.revision })}
            >
              Unblock
            </button>
          ) : null}
        </>
      ) : null}
      {active ? (
        <button
          type="button"
          className={`${ghostClass("stop")} danger`}
          disabled={busy || !task.currentRunId}
          title={task.currentRunId ? "Request interruption through T3" : "No run to interrupt yet"}
          onClick={() => task.currentRunId && send({ type: "task.interrupt", taskId: task.id, runId: task.currentRunId })}
        >
          Stop
        </button>
      ) : null}
      {retryable ? (
        <button type="button" className={ghostClass("retry")} disabled={busy} onClick={() => setDialog("retry")}>
          Retry…
        </button>
      ) : null}
      {task.state === "succeeded" ? (
        <>
          <button type="button" className={ghostClass("block")} disabled={busy} onClick={() => setDialog("block")}>
            Mark blocked…
          </button>
          <button
            type="button"
            className={ghostClass("followup")}
            onClick={() => addFollowUp([{ taskId: task.id, revision: task.revision, label: `${taskLabel(task)}: ${task.instruction}` }])}
          >
            Add follow-up
          </button>
        </>
      ) : null}
      {latestRun ? (
        <button type="button" className="small ghost" onClick={() => setDialog("inspect")}>
          Inspect delivery
        </button>
      ) : null}
    </div>
  );
  const dialogs = (
    <>
      {dialog === "edit" ? <EditTaskDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === "retry" ? <RetryDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === "block" ? <MarkBlockedDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === "inspect" && latestRun ? <InspectDeliveryDialog task={task} runs={runs} initialRunId={latestRun.id} onClose={() => setDialog(null)} /> : null}
    </>
  );

  if (variant === "chip") {
    const showActions = open || pending || active || retryable;
    // "completed" under a succeeded task says nothing the stamp doesn't; errors always show.
    // The state word already says "working"/"sending"; only waits, holds, blocks and failures need a reason line.
    const quiet = task.state === "succeeded" || task.state === "running" || task.state === "dispatching";
    const problem = runError || (!quiet ? reason : null);
    return (
      <article
        className={`task-chip work-order state-${task.state}${open ? " open" : ""}`}
        aria-label={`${taskLabel(task)} ${task.state}`}
        title={`${taskLabel(task)} for @${aliasOf(task.participantId)}`}
        style={identityStyle(colorOf(task.participantId))}
      >
        <header className="chip-head">
          <span className="chip-arrow mono" aria-hidden="true">
            →
          </span>
          {assignee ? <Monogram participant={assignee} size="xs" /> : null}
          <span className="task-assignee mono identity">{aliasOf(task.participantId)}</span>
          {showInstruction ? (
            <span className="chip-instruction" title={task.instruction}>
              {task.instruction}
            </span>
          ) : (
            <span className="spacer" />
          )}
          {task.scheduleMode === "after_all" ? (
            <span className="chip-dep mono" title={task.prerequisites.map((p) => { const t = snapshot.tasks.find((x) => x.id === p.taskId); return t ? `${taskLabel(t)} by @${aliasOf(t.participantId)}: ${t.instruction}` : p.taskId; }).join("\n")}>
              after {waitNames(task)}
            </span>
          ) : task.scheduleMode === "manual" ? (
            <span className="chip-dep mono" title="Held until released">
              held
            </span>
          ) : null}
          {latestRun?.steered ? (
            <span className="chip-dep mono" title="Sent into the turn that was already running; the same reply answers it">
              into turn
            </span>
          ) : null}
          <span className={`stamp stamp-${task.state}`} title={`${taskLabel(task)} · ${task.state.replace("_", " ")}`}>
            {STATE_WORDS[task.state]}
          </span>
          <button
            type="button"
            className="chip-toggle mono"
            aria-expanded={open}
            aria-label={open ? `Hide ${taskLabel(task)} details` : `Show ${taskLabel(task)} details`}
            title={open ? "Hide details" : "Details and actions"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "less" : "more"}
          </button>
        </header>
        {problem && !open ? (
          <div className="chip-reason">
            {!quiet ? reason : null}
            {runError ? <span className="status-error">{reason && !quiet ? " · " : ""}{runError}</span> : null}
          </div>
        ) : null}
        {open ? (
          <div className="chip-details">
            {showInstruction ? <div className="task-instruction">{task.instruction}</div> : null}
            <div className="wo-foot">
              <span className="wo-reason">
                <span className="dep-word">{task.scheduleMode === "after_all" ? "after" : task.scheduleMode === "manual" ? "held" : "now"}</span>{" "}
                {task.scheduleMode === "after_all" ? waitNames(task) : null}
                {reason ? <> · {reason}</> : null}
                {runError ? <span className="status-error"> · {runError}</span> : null}
              </span>
              <span className="spacer" />
              <span className="wo-meta mono">
                <span title="Use this number to wait for it: /after task…">{taskLabel(task)}</span>
                <span className="task-rev"> · rev {task.revision}</span>
                {latestRun ? (
                  <span className="task-attempt" title={`run ${latestRun.id} · ${latestRun.status}`}>
                    {" · "}attempt {latestRun.attempt}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        ) : null}
        {showActions ? actions : null}
        {dialogs}
      </article>
    );
  }

  return (
    <article
      className={`task-card work-order state-${task.state}${compact ? " compact" : ""}`}
      aria-label={`${taskLabel(task)} ${task.state}`}
      style={identityStyle(colorOf(task.participantId))}
    >
      <header className="wo-head">
        <span className="wo-id mono">TASK {task.number}</span>
        {assignee ? <Monogram participant={assignee} size="xs" /> : null}
        <span className="task-assignee mono identity">{aliasOf(task.participantId)}</span>
        <span className="spacer" />
        <span className={`stamp stamp-${task.state}`}>{task.state.replace("_", " ")}</span>
      </header>
      <div className="task-instruction">{task.instruction}</div>
      <div className="wo-dep mono">
        {task.scheduleMode === "after_all" ? (
          <>
            <span className="dep-word">after</span>
            {task.prerequisites.map((p, index) => (
              <span key={p.taskId}>
                {index > 0 ? <span className="dep-sep"> · </span> : null}
                <span className="tag mono">{labelFor(p.taskId)}</span>
              </span>
            ))}
          </>
        ) : task.scheduleMode === "manual" ? (
          <>
            <span className="dep-word">held</span> until released
          </>
        ) : (
          <span className="dep-word">now</span>
        )}
      </div>
      {reason || runError || latestRun ? (
        <div className="wo-foot">
          <span className="wo-reason">
            {reason}
            {runError ? <span className="status-error">{reason ? " · " : ""}{runError}</span> : null}
          </span>
          <span className="spacer" />
          <span className="wo-meta mono">
            <span className="task-rev">rev {task.revision}</span>
            {latestRun ? (
              <span className="task-attempt" title={`run ${latestRun.id} · ${latestRun.status}`}>
                {" · "}attempt {latestRun.attempt}
              </span>
            ) : null}
          </span>
        </div>
      ) : (
        <div className="wo-foot">
          <span className="spacer" />
          <span className="wo-meta mono">
            <span className="task-rev">rev {task.revision}</span>
          </span>
        </div>
      )}
      {active ? <LiveSection task={task} /> : null}
      {actions}
      {dialogs}
    </article>
  );
}

/**
 * In-progress turn from T3 for an active task, in its own card (PRD 4.1): progress messages and tool bursts
 * as T3 shows them. Mounted only while the task is dispatching/running/needs_input, so polling stops with the state.
 */
function LiveSection({ task }: { task: Task }) {
  const { snapshot, aliasOf } = useRoom();
  const { live, error } = useLive(snapshot.room.id, task.participantId, true, 2000);
  const status = [live?.session?.status, live?.latestTurn ? `turn ${live.latestTurn.state}` : null].filter(Boolean).join(" · ");
  // What the thread is doing, as T3 reports it: plan step, tool count and last tool, branch.
  const tools = live?.toolSummary;
  const facts = [
    live?.planProgress ? `step ${live.planProgress.completedSteps}/${live.planProgress.totalSteps}: ${live.planProgress.step}` : null,
    tools && tools.started > 0 ? `${tools.started} tool call${tools.started === 1 ? "" : "s"}${tools.lastTool ? ` · last: ${tools.lastTool}` : ""}` : null,
    tools && tools.errors > 0 ? `${tools.errors} error${tools.errors === 1 ? "" : "s"}` : null,
    live?.branch ? `⎇ ${live.branch}` : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <section className="live-section" aria-label={`Live reply from ${aliasOf(task.participantId)}`}>
      <div className="live-head">
        <span className="dot dot-working" aria-hidden="true" />
        <span className="speaker mono identity">{aliasOf(task.participantId)}</span>
        <span className="muted mono">live{status ? ` · ${status}` : ""}</span>
      </div>
      {facts.length > 0 ? <div className="live-facts mono">{facts.join(" · ")}</div> : null}
      {error ? <div className="status-error">{error}</div> : null}
      <LiveFeed items={live?.liveFeed ?? []} placeholder={live ? "Waiting for the first output from T3…" : "Connecting…"} />
    </section>
  );
}

function EditTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { snapshot, runCommand } = useRoom();
  const [instruction, setInstruction] = useState(task.instruction);
  const [participantId, setParticipantId] = useState(task.participantId);
  const [mode, setMode] = useState<ScheduleMode>(task.scheduleMode);
  const [prerequisites, setPrerequisites] = useState<PrerequisiteRef[]>(task.prerequisites);
  const [carryDependents, setCarryDependents] = useState(true);
  const [busy, setBusy] = useState(false);

  const schedule: Schedule | null =
    mode === "after_all" ? (prerequisites.length > 0 ? { mode, prerequisites } : null) : { mode };
  const ready = instruction.trim().length > 0 && schedule !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !schedule) return;
    setBusy(true);
    const result = await runCommand({
      type: "task.update",
      taskId: task.id,
      revision: task.revision,
      instruction: instruction.trim(),
      participantId,
      schedule,
      carryDependents,
    });
    setBusy(false);
    if (result) onClose();
  };

  return (
    <Dialog title={`Edit ${taskLabel(task)} (revision ${task.revision})`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <label>
          Instruction
          <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4} required />
        </label>
        <label>
          Recipient
          <select value={participantId} onChange={(e) => setParticipantId(e.target.value)}>
            {snapshot.participants
              .filter((p) => isActiveParticipant(p) || p.id === task.participantId)
              .map((p) => (
              <option key={p.id} value={p.id}>
                  {p.alias} · {p.modelSelection.model}
                  {isActiveParticipant(p) ? "" : " (removed)"}
                </option>
              ))}
          </select>
        </label>
        <fieldset>
          <legend>Timing</legend>
          <div className="row">
            <label className="radio">
              <input type="radio" name="edit-timing" checked={mode === "now"} onChange={() => setMode("now")} /> Now
            </label>
            <label className="radio">
              <input type="radio" name="edit-timing" checked={mode === "after_all"} onChange={() => setMode("after_all")} /> After tasks
            </label>
            <label className="radio">
              <input type="radio" name="edit-timing" checked={mode === "manual"} onChange={() => setMode("manual")} /> Save for later
            </label>
          </div>
          {mode === "after_all" ? (
            <PrerequisitePicker value={prerequisites} onChange={setPrerequisites} exclude={[task.id]} invalid={prerequisites.length === 0} />
          ) : null}
        </fieldset>
        <label className="checkbox">
          <input type="checkbox" checked={carryDependents} onChange={(e) => setCarryDependents(e.target.checked)} />
          Carry dependents to the new revision (tasks waiting on revision {task.revision} follow the edited task)
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            Save revision
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RetryDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { runCommand, snapshot } = useRoom();
  const [reattach, setReattach] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const dependents = snapshot.tasks.filter((t) => t.prerequisites.some((p) => p.taskId === task.id) && t.state !== "cancelled");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reattach === null) return;
    setBusy(true);
    const result = await runCommand({ type: "task.retry", taskId: task.id, revision: task.revision, reattachDependents: reattach });
    setBusy(false);
    if (result) onClose();
  };
  return (
    <Dialog title={`Retry ${taskLabel(task)}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">A new attempt is recorded and delivered to the same participant.</p>
        <fieldset>
          <legend>
            Blocked dependents ({dependents.length}) <span className="required">required</span>
          </legend>
          <label className="radio">
            <input type="radio" name="reattach" checked={reattach === true} onChange={() => setReattach(true)} />
            <span>
              <strong>Reattach</strong>
              <span className="hint">Dependents follow the new attempt and release when it succeeds.</span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="reattach" checked={reattach === false} onChange={() => setReattach(false)} />
            <span>
              <strong>Leave blocked</strong>
              <span className="hint">Dependents stay blocked until you unblock or edit them.</span>
            </span>
          </label>
          {dependents.length > 0 ? (
            <ul className="dependents">
              {dependents.map((d) => (
                <li key={d.id}>
                  {taskLabel(d)}: {d.instruction} <span className="muted">({d.state})</span>
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || reattach === null}>
            Retry
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MarkBlockedDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { runCommand } = useRoom();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    const result = await runCommand({ type: "task.markBlocked", taskId: task.id, revision: task.revision, reason: reason.trim() });
    setBusy(false);
    if (result) onClose();
  };
  return (
    <Dialog title={`Mark ${taskLabel(task)} as blocked`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">
          Use this when the participant reported success but the result is actually blocked. Dependent tasks will
          not be released.
        </p>
        <label>
          Reason
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required placeholder="Tests fail on main; waiting for fix" />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || reason.trim().length === 0}>
            Mark blocked
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function InspectDeliveryDialog({
  task,
  runs,
  initialRunId,
  onClose,
}: {
  task: Task;
  runs: Run[];
  initialRunId: string;
  onClose: () => void;
}) {
  const { snapshot } = useRoom();
  const { toast } = useToast();
  const [runId, setRunId] = useState(initialRunId);
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .run(snapshot.room.id, runId)
      .then((loaded) => {
        if (!cancelled) setRun(loaded);
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof ApiError ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, snapshot.room.id, toast]);

  return (
    <Dialog title={`Exact delivery for ${taskLabel(task)}`} onClose={onClose} wide>
      <div className="row">
        <label>
          Attempt
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                attempt {r.attempt} · {r.status} · rev {r.taskRevision}
              </option>
            ))}
          </select>
        </label>
      </div>
      {run ? (
        <dl className="kv">
          <dt>Status</dt>
          <dd>{run.status}</dd>
          <dt>Thread</dt>
          <dd>
            <code>{run.threadId}</code>
          </dd>
          <dt>Turn</dt>
          <dd>{run.turnId ? <code>{run.turnId}</code> : <span className="muted">not started</span>}</dd>
          <dt>Context</dt>
          <dd>
            room events {run.includedFromSequence}–{run.includedToSequence}
          </dd>
          {run.error ? (
            <>
              <dt>Error</dt>
              <dd className="status-error">{run.error}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p className="muted">This is the exact text delivered to the T3 thread for this attempt.</p>
      <pre className="briefing">{loading ? "Loading…" : run?.briefing || "(empty briefing)"}</pre>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

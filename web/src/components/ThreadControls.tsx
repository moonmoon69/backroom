import { useState } from "react";
import type { BackgroundTask, CommandResult, PageControl, QueueState, UsageLimitPause } from "../types.ts";
import { pauseDetail, queueLine } from "../memberActivity.ts";
import { pauseLabel, resetTime } from "../../../src/domain/usageLimit.ts";

/** What a control's command came to: T3 took it, the turn had continued already, or null when it was refused. */
export function outcomeOf(result: CommandResult | null): "sent" | "already" | null {
  return result && (result.type === "member.controlled" || result.type === "thread.controlled") && "outcome" in result ? (result.outcome as "sent" | "already") : null;
}

/**
 * What can be done about a thread's runs besides its turn: continue a turn its usage limit paused, resume a queue T3
 * holds, stop one running subagent, and stop everything (the turn, its background work, monitors and subagents). For a
 * room's member (its status chip's choices) and a thread on its own alike. `send` resolves with what T3 made of it, or
 * null when it was refused (the page says why, in T3's words). `stopAll` is drawn when something is left to stop.
 */
export function ThreadControls({
  pause,
  queue,
  background = [],
  running = false,
  now,
  send,
  stopAll,
}: {
  pause: UsageLimitPause | null;
  queue: QueueState | null | undefined;
  /** What runs beside or after the turn, as T3 lists it: its subagents get a Stop of their own. */
  background?: BackgroundTask[];
  /** A turn runs on the thread. */
  running?: boolean;
  now: number;
  send: (control: PageControl) => Promise<"sent" | "already" | null>;
  /** Stop everything; resolves true once T3 took it. */
  stopAll?: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Before the reset, Resume now asks first: it continues the turn at once, where the limit may stop it again.
  const [confirming, setConfirming] = useState(false);
  const press = async (control: PageControl, done: string, key: string = control.type, already = "It had already continued.") => {
    setBusy(key);
    setSaid(null);
    try {
      const outcome = await send(control);
      if (outcome === "sent") setSaid(done);
      else if (outcome === "already") setSaid(already);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };
  const held = queue?.hold?.by === "held" ? queue : null;
  const subagents = background.filter((task) => task.kind === "agent" && task.runId);
  // T3's watches of pull requests, with what each waits for.
  const watches = background.filter((task) => task.taskId.startsWith("pull-request-watch:") && task.detail);
  // Stop everything while anything is left: a turn, background work, a held queue, a recovery T3 would run.
  const left = running || background.length > 0 || held !== null || pause?.resume === "on";
  if (!pause && !held && subagents.length === 0 && watches.length === 0 && !(stopAll && left) && !said) return null;
  const before = pause?.resetAt ? Date.parse(pause.resetAt) > now : false;
  const time = pause ? resetTime(pause.resetAt, now) : null;
  return (
    <div className="work-actions thread-controls">
      {pause ? (
        <>
          <span className="work-open-text">
            {pauseLabel(pause, now)}: {pauseDetail(pause, now)}.
          </span>
          {confirming ? (
            <span className="thread-controls-confirm" role="alert">
              <span className="work-open-text">The limit resets at {time}. Resume now continues the turn at once, and the limit may stop it again{pause.resume === "on" ? `; otherwise T3 continues it by itself at ${time}` : ""}.</span>
              <button type="button" className="small primary" disabled={busy !== null} onClick={() => void press({ type: "resume" }, "Asked T3 to continue the turn.")}>
                Resume anyway
              </button>
              <button type="button" className="small" disabled={busy !== null} onClick={() => setConfirming(false)}>
                Keep waiting
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="small primary"
              disabled={busy !== null}
              title={before ? `Continue the turn now, before the limit resets at ${time}` : "Continue the turn now (Continue where you left off.)"}
              onClick={() => (before ? setConfirming(true) : void press({ type: "resume" }, "Asked T3 to continue the turn."))}
            >
              {busy === "resume" ? "Resuming…" : "Resume now"}
            </button>
          )}
          {before && pause.resume !== "off" && !confirming ? (
            <button
              type="button"
              className="small"
              disabled={busy !== null}
              title={`T3 does not continue the turn at ${time}; it stays paused until Resume now`}
              onClick={() => void press({ type: "resume.cancel" }, "T3 will not continue the turn at the reset.", "resume.cancel", "T3 was already set not to continue it.")}
            >
              {busy === "resume.cancel" ? "Saving…" : "Don't resume"}
            </button>
          ) : null}
        </>
      ) : null}
      {held ? (
        <>
          <span className="work-open-text">{queueLine(held)}.</span>
          <button type="button" className="small" disabled={busy !== null} title="Let T3 start the queued messages, in their order" onClick={() => void press({ type: "queue.resume" }, "Asked T3 to resume the queue.")}>
            {busy === "queue.resume" ? "Resuming…" : "Resume queue"}
          </button>
        </>
      ) : queue?.hold?.by === "limit" ? (
        <span className="work-open-text">{queueLine(queue)}.</span>
      ) : null}
      {watches.map((task) => (
        <span key={task.taskId} className="work-open-text thread-controls-watch">
          {task.detail}
        </span>
      ))}
      {subagents.map((task) => (
        <span key={task.taskId} className="thread-controls-subagent">
          <span className="work-open-text">subagent {task.title}</span>
          <button
            type="button"
            className="small danger"
            aria-label={`Stop subagent: ${task.title}`}
            title="Stop this subagent through T3; the turn and the other subagents go on"
            disabled={busy !== null}
            onClick={() => void press({ type: "subagent.stop", runId: task.runId!, subagentId: task.taskId }, `Asked T3 to stop the subagent ${task.title}.`, `subagent:${task.taskId}`)}
          >
            {busy === `subagent:${task.taskId}` ? "Stopping…" : "Stop"}
          </button>
        </span>
      ))}
      {stopAll && left ? (
        <button
          type="button"
          className="small danger"
          title="Stop the turn and everything it left running through T3: background commands, monitors, subagents; queued messages are held"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("stop.all");
            setSaid(null);
            try {
              if (await stopAll()) setSaid("Asked T3 to stop everything on the thread.");
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "stop.all" ? "Stopping…" : "Stop everything"}
        </button>
      ) : null}
      {said ? (
        <span className="work-open-text thread-controls-said" role="status">
          {said}
        </span>
      ) : null}
    </div>
  );
}

import { useState } from "react";
import type { CommandResult, PageControl, QueueState, UsageLimitPause } from "../types.ts";
import { pauseDetail, queueLine } from "../memberActivity.ts";
import { pauseLabel, resetTime } from "../../../src/domain/usageLimit.ts";

/** What a control's command came to: T3 took it, the turn had continued already, or null when it was refused. */
export function outcomeOf(result: CommandResult | null): "sent" | "already" | null {
  return result && (result.type === "member.controlled" || result.type === "thread.controlled") && "outcome" in result ? (result.outcome as "sent" | "already") : null;
}

/**
 * What can be done about a thread's runs besides its turn: continue a turn its usage limit paused, and resume a queue T3
 * holds. For a room's member (its status chip's choices) and a thread on its own alike. `send` resolves with what T3
 * made of it, or null when it was refused (the page says why, in T3's words).
 */
export function ThreadControls({
  pause,
  queue,
  now,
  send,
}: {
  pause: UsageLimitPause | null;
  queue: QueueState | null | undefined;
  now: number;
  send: (control: PageControl) => Promise<"sent" | "already" | null>;
}) {
  const [busy, setBusy] = useState<PageControl["type"] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Before the reset, Resume now asks first: it continues the turn at once, where the limit may stop it again.
  const [confirming, setConfirming] = useState(false);
  const press = async (control: PageControl, done: string) => {
    setBusy(control.type);
    setSaid(null);
    try {
      const outcome = await send(control);
      if (outcome === "sent") setSaid(done);
      else if (outcome === "already") setSaid("It had already continued.");
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };
  const held = queue?.hold?.by === "held" ? queue : null;
  if (!pause && !held && !said) return null;
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
              <span className="work-open-text">The limit resets at {time}. Resume now continues the turn at once, and the limit may stop it again{pause.armed ? `; otherwise T3 continues it by itself at ${time}` : ""}.</span>
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
      {said ? (
        <span className="work-open-text thread-controls-said" role="status">
          {said}
        </span>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useRoom } from "../context.tsx";
import { sinceWords } from "../engineTime.ts";
import { isActiveParticipant, type EnginePost, type EngineRunView, type Participant } from "../types.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { NativeRequestsPanel } from "./NativeRequests.tsx";
import { NoticeActions } from "./Timeline.tsx";

type Group = "needs" | "working" | "waiting";

interface Item {
  key: string;
  group: Group;
  participant: Participant | undefined;
  /** What it is, in a few words: "approval", "failed", "#12 working", "uncertain", "3 unread". */
  what: string;
  /** The reason or the work, cut short on the chip and whole in its hover. */
  text: string;
  /** A tone besides its group's: an uncertain run, a blocked delivery. */
  tone?: "warn";
  /** Opens under the bar: a notice's actions, or the approvals and questions. */
  open?: { notice: EnginePost } | { asking: true } | { run: EngineRunView };
}

const GROUPS: Array<{ key: Group; title: string }> = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "waiting", title: "Waiting" },
];

const PHASE: Record<EngineRunView["phase"], string> = {
  prepared: "preparing",
  sending: "sending",
  accepted: "starting",
  running: "working",
  uncertain: "uncertain",
  rejected: "refused by T3",
  terminal: "done",
};

/**
 * The room's status in a line or two above the conversation, read from its journal: one chip per thing going on, under
 * what it asks of you. "Needs you" is a notice that waits on you (a failed turn: Retry or Dismiss) and an approval or
 * question T3 is waiting on; "Working" is a run (an uncertain one says so), a turn the room did not start, and
 * background work a member holds open ("working since"); "Waiting" is a member with posts it has not been given yet
 * (its unread backlog), or a delivery that cannot be made. Clicking a chip opens what can be done about it.
 */
export function WorkBar() {
  const { snapshot, desk, colorOf, participantById, seatOf, nameOf, runCommand } = useRoom();
  const [open, setOpen] = useState<string | null>(null);
  // Esc folds the open chip (keys.ts), once a menu, a dialog or the composer in front of it has closed; the focus, if it
  // was in the choices or nowhere, goes back to the chip.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      const root = bar.current;
      const choices = root?.querySelector(".work-open");
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !root || !choices || root.closest("[inert]")) return;
      if ([...document.querySelectorAll(".dialog-backdrop, .menu, .composer-overlay")].some((element) => !element.closest("[inert]"))) return;
      event.preventDefault();
      const now = document.activeElement;
      if (!now || now === document.body || choices.contains(now)) root.querySelector<HTMLElement>('.work-chip[aria-expanded="true"]')?.focus({ preventScroll: true });
      setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const items: Item[] = [];
  const numberOf = (requestId: string) => snapshot.requests.find((q) => q.id === requestId)?.number ?? snapshot.posts.find((p) => p.request?.id === requestId)?.number ?? null;
  const refs = (ids: readonly string[]) =>
    ids
      .map(numberOf)
      .filter((n): n is number => n !== null)
      .map((n) => `#${n}`)
      .join(" ");

  // Approvals and questions T3 is waiting on, one chip per member.
  const asking = new Map<string, number>();
  for (const request of snapshot.nativeRequests) asking.set(request.participantId, (asking.get(request.participantId) ?? 0) + 1);
  for (const [participantId, count] of asking) {
    const kinds = snapshot.nativeRequests.filter((r) => r.participantId === participantId).map((r) => r.kind);
    const what = kinds.every((kind) => kind === "approval") ? "approval" : kinds.every((kind) => kind !== "approval") ? "question" : "approval and question";
    items.push({ key: `ask:${participantId}`, group: "needs", participant: participantById(participantId), what: count > 1 ? `${count} × ${what}` : what, text: "waiting for you", open: { asking: true } });
  }
  // Notices that wait on you: a failed turn, an undeliverable post. Retry or Dismiss.
  for (const notice of snapshot.needsYou) {
    const run = notice.notice?.runId ? snapshot.runs.find((r) => r.id === notice.notice!.runId) : undefined;
    items.push({
      key: `notice:${notice.id}`,
      group: "needs",
      participant: seatOf(run?.seatId ?? notice.author).participant,
      what: notice.notice?.intent === "error" ? "failed" : "attention",
      text: `#${notice.number} ${notice.body}`,
      open: { notice },
    });
  }

  // Runs that have not ended.
  const busy = new Set<string>();
  for (const run of snapshot.runs) {
    if (run.phase === "terminal") continue;
    const participant = seatOf(run.seatId).participant;
    if (participant) busy.add(participant.id);
    const on = refs(run.requestIds);
    items.push({
      key: `run:${run.id}`,
      group: "working",
      participant,
      what: PHASE[run.phase],
      text: on ? `on ${on}` : "",
      ...(run.phase === "uncertain" || run.phase === "rejected" ? { tone: "warn" as const } : {}),
      open: { run },
    });
  }
  // Busy without a room run: a turn someone typed in T3, or the agent continued on its own.
  for (const participant of snapshot.participants.filter(isActiveParticipant)) {
    if (busy.has(participant.id)) continue;
    const running = desk?.participants[participant.id]?.runningRun;
    if ((running && !running.startedByRoom) || (!running && snapshot.participantStatus[participant.id]?.externalActivity)) {
      items.push({ key: `turn:${participant.id}`, group: "working", participant, what: running?.prompt ? "in T3" : "on its own", text: running?.prompt ?? "" });
    }
  }
  // Background work a member holds requests open with ("working since …").
  for (const seat of snapshot.seats) {
    if (seat.status === "retired") continue;
    for (const activity of seat.activities) {
      const since = sinceWords(activity.since);
      items.push({ key: `activity:${activity.id}`, group: "working", participant: seatOf(seat.seatId).participant, what: `working since ${since}`, text: `holds ${refs(activity.requestIds) || "its request"} open${activity.kind === "bg" ? " · background work" : ""}` });
    }
  }

  // Waiting: posts a member has not been given yet, and deliveries that cannot be made.
  for (const seat of snapshot.seats) {
    if (seat.status === "retired") continue;
    const participant = seatOf(seat.seatId).participant;
    if (seat.blocked) {
      items.push({ key: `blocked:${seat.seatId}`, group: "waiting", participant, what: "blocked delivery", text: `${seat.blocked.number !== null ? `#${seat.blocked.number}` : "a post"} is over the delivery budget (${seat.blocked.requiredBytes.toLocaleString()} bytes)`, tone: "warn" });
      continue;
    }
    if (seat.activeRunId === null && seat.unread > 0) {
      items.push({ key: `waiting:${seat.seatId}`, group: "waiting", participant, what: `${seat.unread} unread`, text: `waiting for ${nameOf(seat.seatId)}'s next turn` });
    }
  }

  if (items.length === 0) return null;
  const opened = items.find((item) => item.key === open) ?? null;
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return (
    <div className="work-bar" role="status" aria-label="What is going on in this room" ref={bar}>
      <div className="work-groups">
        {GROUPS.map((group) => {
          const list = items.filter((item) => item.group === group.key);
          if (list.length === 0) return null;
          return (
            <div key={group.key} className={`work-group work-${group.key}`}>
              <span className="work-title mono">
                {group.title} · {list.length}
              </span>
              {list.map((item) => {
                const body = (
                  <>
                    {item.participant ? <Monogram participant={item.participant} size="xs" /> : null}
                    <span className="speaker mono identity">{item.participant?.alias ?? "Backroom"}</span>
                    <span className={`work-what mono${item.tone === "warn" ? " work-warn" : ""}`}>{item.what}</span>
                    {item.text ? <span className="work-text">{oneLine(item.text)}</span> : null}
                  </>
                );
                const style = identityStyle(item.participant ? colorOf(item.participant.id) : "var(--fg-muted)");
                const title = `${item.participant?.alias ?? ""} · ${item.what}${item.text ? `: ${oneLine(item.text).slice(0, 400)}` : ""}`;
                return item.open ? (
                  <button key={item.key} type="button" className={`work-chip${open === item.key ? " open" : ""}`} style={style} title={title} aria-expanded={open === item.key} onClick={() => setOpen(open === item.key ? null : item.key)}>
                    {body}
                  </button>
                ) : (
                  <span key={item.key} className="work-chip" style={style} title={title}>
                    {body}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
      {opened?.open ? (
        <div className="work-open">
          {"notice" in opened.open ? (
            <div className="work-actions">
              <span className="work-open-text" title={opened.open.notice.body}>
                <span className="mono">#{opened.open.notice.number}</span> {oneLine(opened.open.notice.body)}
              </span>
              <NoticeActions post={opened.open.notice} />
            </div>
          ) : "run" in opened.open ? (
            <RunActions run={opened.open.run} onStop={(participantId) => void runCommand({ type: "run.stop", roomId: snapshot.room.id, participantId })} />
          ) : (
            <NativeRequestsPanel />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What can be done about a run: stop it (through T3). An uncertain one is explained. */
function RunActions({ run, onStop }: { run: EngineRunView; onStop: (participantId: string) => void }) {
  const { seatOf } = useRoom();
  const participant = seatOf(run.seatId).participant;
  return (
    <div className="work-actions">
      <span className="work-open-text">
        {run.phase === "uncertain"
          ? "Uncertain: Backroom cannot tell whether T3 received this turn. It keeps checking and never sends it twice."
          : run.phase === "rejected"
            ? `T3 refused this turn${run.failure ? `: ${run.failure}` : ""}.`
            : `${PHASE[run.phase]}${run.startedAt ? ` since ${new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`}
      </span>
      {participant && run.phase !== "prepared" && run.phase !== "rejected" ? (
        <button type="button" className="small danger" title="Stop the turn through T3" onClick={() => onStop(participant.id)}>
          Stop
        </button>
      ) : null}
    </div>
  );
}

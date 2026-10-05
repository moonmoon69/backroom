import { useEffect, useState } from "react";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, taskLabel, type Participant, type RoomCommand, type Task } from "../types.ts";
import { tasksNeedingYou } from "../workStatus.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { NativeRequestsPanel } from "./NativeRequests.tsx";
import { TaskCard } from "./TaskCard.tsx";

type Group = "needs" | "working" | "waiting";

interface Item {
  key: string;
  group: Group;
  participant: Participant | undefined;
  /** What it is, in a few words: "approval", "failed", "task4", "turn in T3". */
  what: string;
  /** The instruction or the reason, cut short on the chip and whole in its hover. */
  text: string;
  /** Opens the task's card (with its actions) under the bar; without one the chip opens the approvals and questions. */
  task?: Task;
}

const GROUPS: Array<{ key: Group; title: string }> = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "waiting", title: "Waiting" },
];

const NEEDS_WORD: Partial<Record<Task["state"], string>> = { needs_input: "needs your answer", held: "held", blocked: "blocked", failed: "failed" };

/**
 * The room's status in a line or two above the conversation: one chip per thing going on, under what it asks of you.
 * "Needs you" is an approval or question, a held or blocked task, a failure nobody has followed up; "Working" is a
 * task running or a turn someone started in T3; "Waiting" is a task queued behind another. A chip moves from one
 * group to the next as its state changes and goes away when it is done. Clicking one opens it under the bar, with its
 * actions (answer, release, retry, stop). Nothing going on: no bar.
 */
export function WorkBar() {
  const { snapshot, desk, colorOf, participantById, runCommand } = useRoom();
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [open]);
  const items: Item[] = [];

  // Approvals and questions T3 is waiting on, one chip per member.
  const asking = new Map<string, number>();
  for (const request of snapshot.nativeRequests) asking.set(request.participantId, (asking.get(request.participantId) ?? 0) + 1);
  for (const [participantId, count] of asking) {
    const kinds = snapshot.nativeRequests.filter((r) => r.participantId === participantId).map((r) => r.kind);
    const what = kinds.every((kind) => kind === "approval") ? "approval" : kinds.every((kind) => kind !== "approval") ? "question" : "approval and question";
    items.push({ key: `ask:${participantId}`, group: "needs", participant: participantById(participantId), what: count > 1 ? `${count} × ${what}` : what, text: "waiting for you" });
  }
  // A removed member's old tasks ask nothing of anyone.
  const seated = new Set(snapshot.participants.filter(isActiveParticipant).map((p) => p.id));
  for (const task of tasksNeedingYou(snapshot.tasks.filter((t) => seated.has(t.participantId)), snapshot.room.consigliereId)) {
    // An approval or question already has its chip.
    if (task.state === "needs_input" && asking.has(task.participantId)) continue;
    items.push({ key: task.id, group: "needs", participant: participantById(task.participantId), what: NEEDS_WORD[task.state] ?? task.state, text: (task.stateReason ?? task.instruction).replace(/^failed:\s*/, ""), task });
  }

  const busy = new Set<string>();
  for (const task of snapshot.tasks) {
    if (task.state !== "running" && task.state !== "dispatching") continue;
    busy.add(task.participantId);
    items.push({ key: task.id, group: "working", participant: participantById(task.participantId), what: taskLabel(task), text: task.kind === "seat" ? "seat briefing" : task.instruction, task });
  }
  // Busy without a room task: a turn another member (or you, in T3) started.
  for (const participant of snapshot.participants.filter(isActiveParticipant)) {
    if (busy.has(participant.id) || asking.has(participant.id)) continue;
    const running = desk?.participants[participant.id]?.runningRun;
    if ((running && !running.startedByRoom) || (!running && snapshot.participantStatus[participant.id]?.externalActivity)) {
      const asked = running ? snapshot.events.find((e) => e.kind === "member.message" && e.to === participant.id && e.sourceRef?.t3RunId === running.runId) : undefined;
      const from = asked?.speaker.type === "participant" ? participantById(asked.speaker.participantId)?.alias : undefined;
      items.push({ key: `turn:${participant.id}`, group: "working", participant, what: from ? `for ${from}` : "turn in T3", text: asked?.text ?? running?.prompt ?? "" });
    }
  }
  for (const task of snapshot.tasks) {
    if (task.state === "queued") items.push({ key: task.id, group: "waiting", participant: participantById(task.participantId), what: taskLabel(task), text: task.stateReason ?? task.instruction, task });
  }

  if (items.length === 0) return null;
  const opened = items.find((item) => item.key === open) ?? null;
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return (
    <div className="work-bar" role="status" aria-label="What is going on in this room">
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
                const openable = Boolean(item.task) || item.key.startsWith("ask:");
                const body = (
                  <>
                    {item.participant ? <Monogram participant={item.participant} size="xs" /> : null}
                    <span className="speaker mono identity">{item.participant?.alias ?? "?"}</span>
                    <span className="work-what mono">{item.what}</span>
                    {item.text ? <span className="work-text">{oneLine(item.text)}</span> : null}
                  </>
                );
                const style = identityStyle(item.participant ? colorOf(item.participant.id) : "var(--fg-muted)");
                const title = `${item.participant?.alias ?? ""} · ${item.what}${item.text ? `: ${oneLine(item.text).slice(0, 400)}` : ""}`;
                return openable ? (
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
      {opened ? (
        <div className="work-open">
          {opened.task ? (
            <>
              <TaskActions task={opened.task} text={oneLine(opened.text || opened.task.instruction)} more={more} onMore={() => setMore((v) => !v)} run={runCommand} />
              {more ? <TaskCard task={opened.task} compact /> : null}
            </>
          ) : (
            <NativeRequestsPanel />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What you can do about one task, the same three for every state: the answer (release, unblock, retry), Dismiss (take
 * a failure off your list without acting), and Cancel (stop the work, or cancel it before it starts). Edit, the retry
 * options and what was delivered are the full card, behind "more".
 */
function TaskActions({ task, text, more, onMore, run }: { task: Task; text: string; more: boolean; onMore: () => void; run: (command: RoomCommand) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const send = async (command: RoomCommand) => {
    setBusy(true);
    try {
      await run(command);
    } finally {
      setBusy(false);
    }
  };
  const at = { taskId: task.id, revision: task.revision };
  const pending = task.state === "queued" || task.state === "held" || task.state === "blocked";
  const active = task.state === "running" || task.state === "dispatching" || task.state === "needs_input";
  return (
    <div className="work-actions">
      <span className="work-open-text" title={text}>
        <span className="mono">{taskLabel(task)}</span> {text}
      </span>
      {task.state === "held" ? (
        <button type="button" className="small primary" disabled={busy} onClick={() => send({ type: "task.release", ...at })}>
          Release
        </button>
      ) : null}
      {task.state === "blocked" ? (
        <button type="button" className="small primary" disabled={busy} onClick={() => send({ type: "task.unblock", ...at })}>
          Unblock
        </button>
      ) : null}
      {task.state === "failed" ? (
        <>
          <button type="button" className="small primary" disabled={busy} title="Send it again; work that waited for it follows the new attempt" onClick={() => send({ type: "task.retry", ...at, reattachDependents: true })}>
            Retry
          </button>
          <button type="button" className="small" disabled={busy} title="Take it off your list without retrying; it stays failed on the board" onClick={() => send({ type: "task.dismiss", taskId: task.id })}>
            Dismiss
          </button>
        </>
      ) : null}
      {pending ? (
        <button type="button" className="small danger" disabled={busy} onClick={() => send({ type: "task.cancel", ...at })}>
          Cancel
        </button>
      ) : null}
      {active ? (
        <button
          type="button"
          className="small danger"
          disabled={busy || !task.currentRunId}
          title={task.currentRunId ? "Stop the turn through T3" : "No turn to stop yet"}
          onClick={() => task.currentRunId && send({ type: "task.interrupt", taskId: task.id, runId: task.currentRunId })}
        >
          Stop
        </button>
      ) : null}
      <button type="button" className="small ghost" aria-expanded={more} onClick={onMore}>
        {more ? "less" : "more"}
      </button>
    </div>
  );
}

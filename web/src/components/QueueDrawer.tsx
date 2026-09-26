import { useRoom } from "../context.tsx";
import { isActiveParticipant, type Participant, type Task, type TaskState } from "../types.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { NativeRequestsPanel } from "./NativeRequests.tsx";
import { TaskCard } from "./TaskCard.tsx";

interface Lane {
  key: string;
  title: string;
  states: TaskState[];
  hint: string;
}

/** Task lanes in dispatch order; native requests sit at the top of "Needs input". */
const LANES: Lane[] = [
  { key: "needs_input", title: "Needs input", states: ["needs_input"], hint: "Waiting on an answer in T3 or below." },
  { key: "running", title: "Running", states: ["running", "dispatching"], hint: "Nothing running: no room task, no turn typed in T3, no background work." },
  { key: "waiting", title: "Waiting", states: ["queued"], hint: "Ready; waits for the participant's session to be free." },
  { key: "held", title: "Held", states: ["held"], hint: "Saved for later; release to queue." },
  { key: "blocked", title: "Blocked", states: ["blocked"], hint: "Waiting on prerequisites or manually blocked." },
];

export function taskCount(tasks: Task[], nativeCount: number): number {
  return LANES.reduce((n, lane) => n + tasks.filter((t) => lane.states.includes(t.state)).length, 0) + nativeCount;
}

/** Rows for work T3 is doing outside the room's queue, so an idle-looking lane is not mistaken for idle crew. */
interface OutsideWork {
  participant: Participant;
  label: string;
  detail: string | null;
}

/**
 * The Tasks tab body: pending/running work as lanes of compact tickets. The Running lane also lists participants
 * busy without a room task: a turn typed directly in T3, or background work / monitoring between turns.
 */
export function TaskLanes() {
  const { snapshot, desk } = useRoom();
  const inLane = (lane: Lane): Task[] => snapshot.tasks.filter((t) => lane.states.includes(t.state));
  const nativeCount = snapshot.nativeRequests.length;
  const withTask = new Set(
    snapshot.tasks.filter((t) => t.state === "running" || t.state === "dispatching" || t.state === "needs_input").map((t) => t.participantId),
  );
  const outside: OutsideWork[] = snapshot.participants.filter(isActiveParticipant).flatMap((participant) => {
    if (withTask.has(participant.id)) return [];
    const status = snapshot.participantStatus[participant.id];
    const d = desk?.participants[participant.id];
    if (d?.runningTurn && !d.runningTurn.startedByRoom) {
      return [{ participant, label: "turn typed in T3", detail: d.runningTurn.prompt }];
    }
    if (d?.runningTurn || status?.externalActivity) return [{ participant, label: "turn in T3", detail: null }];
    const liveness = d?.backgroundLiveness ?? status?.background ?? null;
    if (!liveness) return [];
    const jobs = (d?.backgroundTasks ?? []).map((job) => `${job.title} (${job.kind === "agent" ? "subagent" : "shell"})`);
    return [{ participant, label: liveness === "monitoring" ? "monitoring" : "background work", detail: jobs.join(" · ") || null }];
  });
  return (
    <>
      {LANES.map((lane) => {
        const tasks = inLane(lane);
        const extra = lane.key === "running" ? outside : [];
        const count = tasks.length + extra.length + (lane.key === "needs_input" ? nativeCount : 0);
        return (
          <section key={lane.key} className={`lane lane-${lane.key}${count === 0 ? " empty" : ""}`} aria-label={lane.title}>
            <h3>
              <span className="lane-title">{lane.title}</span>
              <span className="lane-count mono">{count}</span>
            </h3>
            {lane.key === "needs_input" ? <NativeRequestsPanel /> : null}
            {count === 0 ? <p className="lane-hint mono muted">{lane.hint}</p> : null}
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} compact />
            ))}
            {extra.map(({ participant, label, detail }) => (
              <OutsideRow key={participant.id} participant={participant} label={label} detail={detail} />
            ))}
          </section>
        );
      })}
    </>
  );
}

function OutsideRow({ participant, label, detail }: OutsideWork) {
  const { colorOf } = useRoom();
  return (
    <div className="outside-row" style={identityStyle(colorOf(participant.id))} title={detail ?? undefined}>
      <span className="dot dot-working" aria-hidden="true" />
      <Monogram participant={participant} size="xs" />
      <span className="speaker mono identity">{participant.alias}</span>
      <span className="mono">{label}</span>
      {detail ? <span className="outside-detail">{detail}</span> : null}
    </div>
  );
}

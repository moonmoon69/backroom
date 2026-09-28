import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRoom } from "../context.tsx";
import { CLUB_H, CLUB_W, drawClubhouse, KINDS, PALETTE, SPOTS, type Kind, type Villager } from "../looks/clubhouseArt.ts";
import { showInLog, useSceneLog } from "../looks/sceneLog.ts";
import "../looks/astra.css";
import { describeStatus, type MemberActivity } from "../memberActivity.ts";
import { useSkin } from "../skin.ts";
import { speakable } from "../speechText.ts";
import { ACTIVE_STATES, isActiveParticipant, type Participant, type RoomEvent, type Task, type TaskState } from "../types.ts";

/** Settings → Look → Astra: the room as Astra's clubhouse, above its conversation. */
export function AstraLook({ onTalk }: { onTalk: (alias: string) => void }) {
  const [skin] = useSkin();
  const { snapshot } = useRoom();
  if (skin !== "astra") return null;
  return <Clubhouse key={snapshot.room.id} onTalk={onTalk} />;
}

/** The faces Astra gave the three of us; anyone else gets one from their name. */
const KNOWN: Record<string, { kind: Kind; colour: string }> = {
  astra: { kind: "cat", colour: "#9eae94" },
  opus: { kind: "fox", colour: "#cd9672" },
  grok: { kind: "frog", colour: "#9eb56d" },
};

function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** How a member's nameplate reads at a glance. */
type Mood = "working" | "needs" | "error" | "away" | "idle";

function moodOf(activity: MemberActivity): Mood {
  if (activity.tone === "missing") return "away";
  if (activity.tone === "approval" || activity.tone === "input") return "needs";
  if (activity.tone === "error") return "error";
  if (activity.motion) return "working";
  return "idle";
}

const TASK_WORDS: Record<TaskState, string> = {
  queued: "Waiting",
  held: "Held",
  blocked: "Blocked",
  dispatching: "Starting",
  running: "Working",
  needs_input: "Needs you",
  succeeded: "Done",
  failed: "Failed",
  interrupted: "Stopped",
  cancelled: "Cancelled",
};

const isReply = (event: RoomEvent) => (event.kind === "assistant.reply" || event.kind === "t3.turn") && event.speaker.type === "participant";
const isEvening = () => {
  const hour = new Date().getHours();
  return hour >= 18 || hour < 7;
};

function short(markdown: string, max: number): string {
  const text = speakable(markdown);
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

interface Member {
  participant: Participant;
  activity: MemberActivity;
  mood: Mood;
  villager: Villager;
  task: Task | null;
  reply: RoomEvent | null;
}

/** What a member says over their head: what they need first, then what they are doing, then their last answer. */
function speechOf(member: Member): string {
  const { activity, mood, reply } = member;
  if (activity.tone === "approval") return "Could you approve something?";
  if (activity.label === "plan ready") return "My plan is ready for you.";
  if (activity.tone === "input") return "I have a question for you.";
  if (mood === "error") return "Something went wrong…";
  if (mood === "away") return "(This desk's thread was deleted in T3.)";
  if (mood === "working") return activity.detail ? `On it… (${activity.detail})` : activity.label === "monitoring" ? "Keeping an eye on things…" : "On it…";
  if (reply) return short(reply.text, 46);
  return "Ready when you are.";
}

/**
 * Astra's clubhouse with the room in it: members at the two desks, the armchair and cushions, as cats, foxes and frogs;
 * a desk's screen lights while its member works; the noticeboard pins the latest tasks and ticks them off; evening
 * follows the clock. Click someone for their desk (Talk puts @them in the composer), the board for the task list.
 * No motion: the scene redraws when the room changes.
 */
function Clubhouse({ onTalk }: { onTalk: (alias: string) => void }) {
  const { snapshot, desk } = useRoom();
  const [logOpen, setLogOpen] = useSceneLog();
  const [selected, setSelected] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [evening, setEvening] = useState(isEvening);
  const [scale, setScale] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const seated = useMemo(() => snapshot.participants.filter(isActiveParticipant), [snapshot.participants]);
  const members: Member[] = useMemo(
    () =>
      seated.slice(0, SPOTS.length).map((participant) => {
        const activity = describeStatus(snapshot.participantStatus[participant.id], desk?.participants[participant.id]);
        const mood = moodOf(activity);
        const hash = hashOf(participant.alias.toLowerCase());
        const face = KNOWN[participant.alias.toLowerCase()] ?? { kind: KINDS[hash % KINDS.length]!, colour: PALETTE[(hash >> 3) % PALETTE.length]! };
        const task = snapshot.tasks.find((t) => t.participantId === participant.id && ACTIVE_STATES.has(t.state)) ?? null;
        const reply = [...snapshot.events].reverse().find((e) => isReply(e) && e.speaker.type === "participant" && e.speaker.participantId === participant.id) ?? null;
        return { participant, activity, mood, villager: { ...face, working: mood === "working", away: mood === "away" }, task, reply };
      }),
    [seated, snapshot.participantStatus, snapshot.tasks, snapshot.events, desk],
  );
  const tasks = useMemo(() => [...snapshot.tasks].sort((a, b) => a.number - b.number), [snapshot.tasks]);
  const pins = tasks.slice(-3).map((task) => task.state === "succeeded");
  const drawKey = JSON.stringify([evening, members.map((m) => m.villager), pins]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawClubhouse(ctx, { evening, villagers: members.map((m) => m.villager), pins });
    // drawKey holds everything drawn.
  }, [drawKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setEvening(isEvening()), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => setScale(Math.max(0.5, Math.min(stage.clientWidth / CLUB_W, stage.clientHeight / CLUB_H)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const pick = members.find((m) => m.participant.id === selected) ?? null;
  const working = members.filter((m) => m.mood === "working").length;
  const needs = members.filter((m) => m.mood === "needs").length;
  const waiting = snapshot.tasks.filter((t) => t.state === "queued" || t.state === "blocked" || t.state === "held").length;
  const summary = [working ? `${working} working` : null, needs ? `${needs} need${needs === 1 ? "s" : ""} you` : null, waiting ? `${waiting} waiting` : null]
    .filter(Boolean)
    .join(" · ");
  const pct = (value: number, of: number) => `${(value / of) * 100}%`;

  return (
    <section className={`astra-club look-scene${evening ? " is-evening" : ""}`} aria-label="The clubhouse">
      <div className="astra-stage-wrap" ref={stageRef}>
        <div className="astra-stage" style={{ width: CLUB_W * scale, height: CLUB_H * scale, "--s": scale } as CSSProperties}>
          <canvas ref={canvasRef} width={CLUB_W} height={CLUB_H} aria-hidden="true" />
          <p className="astra-tag" aria-hidden="true">
            <span>✦</span> {snapshot.room.title}
          </p>
          <button
            type="button"
            className="astra-hotspot astra-board"
            aria-expanded={boardOpen}
            aria-label={`Task board: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
            onClick={() => setBoardOpen((open) => !open)}
          >
            <span>
              Task board <span aria-hidden="true">↗</span>
            </span>
          </button>
          {members.map((member, index) => {
            const spot = SPOTS[index]!;
            const { participant, activity, mood } = member;
            return (
              <button
                key={participant.id}
                type="button"
                className={`astra-hotspot astra-member mood-${mood}`}
                style={{ left: pct(spot.x - 20, CLUB_W), top: pct(spot.y - 30, CLUB_H), width: pct(70, CLUB_W), height: pct(74, CLUB_H) }}
                aria-pressed={selected === participant.id}
                aria-label={`${participant.alias}: ${activity.label}${activity.detail ? `, ${activity.detail}` : ""}`}
                onClick={() => setSelected((id) => (id === participant.id ? null : participant.id))}
              >
                <span className="astra-speech">{speechOf(member)}</span>
                <span className="astra-nameplate">
                  <i aria-hidden="true" />
                  {participant.alias}
                </span>
              </button>
            );
          })}
          <span className="astra-door" aria-hidden="true">
            MAKE YOURSELF AT HOME
          </span>
          {boardOpen ? (
            <div className="astra-board-card" role="dialog" aria-label="Task board">
              <p className="astra-eyebrow">PINNED FOR EVERYONE</p>
              {tasks.length === 0 ? (
                <p className="astra-muted">Nothing pinned yet. @someone from the composer to start.</p>
              ) : (
                <ol>
                  {[...tasks]
                    .reverse()
                    .slice(0, 6)
                    .map((task) => (
                      <li key={task.id} data-state={task.state}>
                        <span className="astra-task-top">
                          <span>
                            {String(task.number).padStart(2, "0")} / {snapshot.participants.find((p) => p.id === task.participantId)?.alias ?? "?"}
                          </span>
                          <span>{TASK_WORDS[task.state]}</span>
                        </span>
                        <span className="astra-task-text">{short(task.instruction, 80)}</span>
                        {task.prerequisites.length > 0 ? (
                          <span className="astra-muted">
                            after{" "}
                            {task.prerequisites
                              .map((pre) => snapshot.tasks.find((t) => t.id === pre.taskId))
                              .map((t) => (t ? `task ${t.number}` : "an earlier task"))
                              .join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                </ol>
              )}
              <button type="button" className="astra-button" onClick={() => setBoardOpen(false)}>
                Close
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="astra-footer">
        {pick ? (
          <span className="astra-desk" aria-live="polite">
            <strong>{pick.participant.alias}’s desk</strong>
            <span>
              {pick.activity.label}
              {pick.activity.detail ? ` · ${pick.activity.detail}` : ""}
              {pick.task ? ` · task ${pick.task.number}: ${short(pick.task.instruction, 60)}` : ""}
            </span>
            <button type="button" className="astra-button" onClick={() => onTalk(pick.participant.alias)} title={`Put @${pick.participant.alias} in the composer`}>
              Talk
            </button>
            {pick.reply ? (
              <button type="button" className="astra-button" onClick={() => showInLog(pick.reply!.sequence, setLogOpen)}>
                Last answer
              </button>
            ) : null}
          </span>
        ) : (
          <span className="astra-muted">
            {members.length === 0 ? "The clubhouse is empty. Seat someone from the crew." : "Click a crew member to say hello"}
            {seated.length > SPOTS.length ? ` · ${seated.length - SPOTS.length} more out in the garden` : ""}
          </span>
        )}
        <span className="astra-footer-end">
          {summary ? (
            <span>
              <span className="astra-dot" aria-hidden="true" />
              {summary}
            </span>
          ) : null}
          <button type="button" className="astra-button" aria-pressed={evening} onClick={() => setEvening((on) => !on)}>
            {evening ? "☀ Daytime" : "☾ Evening"}
          </button>
          <button type="button" className="astra-button" aria-pressed={logOpen} onClick={() => setLogOpen(!logOpen)}>
            {logOpen ? "Hide log" : "Show log"}
          </button>
        </span>
      </div>
    </section>
  );
}

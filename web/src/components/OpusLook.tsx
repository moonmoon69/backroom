import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRoom } from "../context.tsx";
import { describeStatus, type MemberActivity } from "../memberActivity.ts";
import { BOSS_SEAT, drawFrame, drawRoom, drawTable, MAX_SEATS, SCENE_H, SCENE_W, seatOf, seedOf, TABLE_TOP, type Actor, type Flight, type Seat } from "../looks/opusScene.ts";
import { HATS } from "../looks/opusSprites.ts";
import { showInLog, useSceneLog } from "../looks/sceneLog.ts";
import "../looks/opus.css";
import { useSkin } from "../skin.ts";
import { speakable } from "../speechText.ts";
import { ACTIVE_STATES, isActiveParticipant, type Participant, type RoomEvent, type Task } from "../types.ts";
import { useCatalog } from "./catalog.ts";

/** The hat band and tie of each harness, in its logo's colour where it has one. */
const HARNESS_COLOUR: Record<string, string> = {
  claudeAgent: "#d97757",
  codex: "#10a37f",
  cursor: "#8fb4ff",
  grok: "#e6e6e6",
  opencode: "#f2c14e",
  antigravity: "#4f8cf7",
};
const SPARE_COLOURS = ["#c65d7b", "#6cc3c1", "#b48ede", "#e0a458", "#8cc084", "#d4d4aa"];
const SOUND_KEY = "backroom.scene.sound";
/** How long a new line stays over the speaker's head. */
const SAY_MS = 14000;

interface Seated {
  participant: Participant;
  seat: Seat;
  actor: Actor;
  activity: MemberActivity;
}

interface Said {
  speakerId: string | null;
  text: string;
  at: number;
}

const motionAllowed = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function actorOf(participant: Participant, activity: MemberActivity, colour: string, hat: string, subagents: number): Actor {
  const pose: Actor["pose"] =
    activity.tone === "missing" ? "away" : activity.motion === "working" ? "work" : activity.motion === "monitoring" ? "read" : activity.tone === "stopped" ? "sleep" : "idle";
  const mark: Actor["mark"] =
    activity.tone === "approval" ? "!" : activity.tone === "input" ? "?" : activity.tone === "error" ? "x" : pose === "work" ? "typing" : pose === "sleep" ? "z" : null;
  return { id: participant.id, alias: participant.alias, colour, hat, pose, mark, subagents, dizzy: activity.tone === "error" };
}

/** What a member says when they have not answered yet, by what they are doing. */
function idleLine(actor: Actor): string {
  switch (actor.pose) {
    case "work":
      return "Working on it, boss. You'll have it when it's done.";
    case "read":
      return "Just keeping an eye on things, boss.";
    case "sleep":
      return "…zz. Huh? Nobody's said a word to me yet, boss.";
    case "away":
      return "(The chair is empty. This member's thread was deleted in T3.)";
    default:
      return "Waiting for orders, boss.";
  }
}

const isReply = (event: RoomEvent) => (event.kind === "assistant.reply" || event.kind === "t3.turn") && event.speaker.type === "participant";

/** Plain words for a bubble or the dialog box, cut at `max` on a word. */
function lineOf(markdown: string, max: number): string {
  const text = speakable(markdown);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** Animal Crossing's babble, very small: a blip per couple of letters, pitched per speaker. */
function useBlips(enabled: boolean) {
  const audio = useRef<AudioContext | null>(null);
  return useCallback(
    (seed: number) => {
      if (!enabled) return;
      audio.current ??= new AudioContext();
      const ctx = audio.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 320 + seed * 260 + Math.random() * 60;
      gain.gain.setValueAtTime(0.025, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.06);
    },
    [enabled],
  );
}

/** Settings → Look → Opus: the room as the back room, above its conversation. */
export function OpusLook({ onTalk }: { onTalk: (alias: string) => void }) {
  const [skin] = useSkin();
  const { snapshot } = useRoom();
  if (skin !== "opus") return null;
  return <BackRoom key={snapshot.room.id} onTalk={onTalk} />;
}

/**
 * The room as a scene: the boss (you) at the head of the table, each member in a chair, doing what their thread is
 * doing: typing at a laptop while a turn runs (small capybaras beside them for subagents), reading the paper while
 * only monitors run, a "!" when they need an approval, a "?" for a question, asleep when their session stopped.
 * Envelopes fly out with each new assignment and a sheet comes back with each answer. Click someone to hear them.
 */
function BackRoom({ onTalk }: { onTalk: (alias: string) => void }) {
  const { snapshot, desk, costs, aliasOf } = useRoom();
  const [logOpen, setLogOpen] = useSceneLog();
  const catalog = useCatalog();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(3);
  const [open, setOpen] = useState<string | "boss" | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) === "on");
  const blip = useBlips(sound);
  const motion = useMemo(motionAllowed, []);

  const members = useMemo(() => snapshot.participants.filter(isActiveParticipant).slice(0, MAX_SEATS), [snapshot.participants]);

  const seated: Seated[] = useMemo(() => {
    let spare = 0;
    return members.map((participant, index) => {
      const driver = catalog?.find((e) => e.instanceId === participant.modelSelection.instanceId)?.driver;
      const colour = HARNESS_COLOUR[driver ?? ""] ?? HARNESS_COLOUR[participant.modelSelection.instanceId] ?? SPARE_COLOURS[spare++ % SPARE_COLOURS.length]!;
      const memberDesk = desk?.participants[participant.id];
      const activity = describeStatus(snapshot.participantStatus[participant.id], memberDesk);
      const subagents = (memberDesk?.backgroundTasks ?? []).filter((job) => job.kind === "agent").length;
      const hat = HATS[index % HATS.length]!;
      return { participant, seat: seatOf(index), actor: actorOf(participant, activity, colour, hat, subagents), activity };
    });
  }, [members, catalog, desk, snapshot.participantStatus]);

  // ---- what the loop draws, kept in refs so the loop never restarts ----
  const actorsRef = useRef<Actor[]>([]);
  actorsRef.current = seated.map((s) => s.actor);
  const flightsRef = useRef<Flight[]>([]);
  const roomRef = useRef<{ seats: number; canvas: HTMLCanvasElement } | null>(null);
  const tableRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    tableRef.current ??= drawTable();
    let frame = 0;
    let last = 0;
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw);
      // Thirty frames a second is plenty for pixels; without motion, once a second for the clock and new states.
      if (t - last < (motion ? 33 : 1000)) return;
      last = t;
      const seats = actorsRef.current.length;
      if (roomRef.current?.seats !== seats) roomRef.current = { seats, canvas: drawRoom(seats) };
      flightsRef.current = flightsRef.current.filter((f) => t < f.start + f.duration);
      drawFrame(ctx, {
        room: roomRef.current.canvas,
        table: tableRef.current!,
        actors: actorsRef.current,
        boss: { colour: "#1b1c1f", mark: null },
        flights: flightsRef.current,
        t: motion ? t : 0,
        now: new Date(),
        motion,
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [motion]);

  // ---- the scene fills the space in whole pixels ----
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const fitted = Math.min(stage.clientWidth / SCENE_W, stage.clientHeight / SCENE_H);
      setScale(fitted >= 2 ? Math.floor(fitted) : Math.max(1, fitted));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // ---- new assignments fly out, answers come back, the latest line shows over its speaker ----
  const seen = useRef<{ tasks: Set<string>; sequence: number } | null>(null);
  // The first snapshot can be partial, and what fills it in is not news: only what happened since the scene opened
  // (with some slack for a phone's clock) flies across the room.
  const openedAt = useRef(Date.now());
  useEffect(() => {
    const recent = (iso: string) => Date.parse(iso) >= openedAt.current - 10_000;
    const events = snapshot.events;
    const newest = events.length > 0 ? events[events.length - 1]!.sequence : 0;
    if (!seen.current) {
      seen.current = { tasks: new Set(snapshot.tasks.map((task) => task.id)), sequence: newest };
      return;
    }
    const now = performance.now();
    const seatById = new Map(seated.map((s) => [s.participant.id, s.seat]));
    let delay = 0;
    for (const task of snapshot.tasks) {
      if (seen.current.tasks.has(task.id)) continue;
      seen.current.tasks.add(task.id);
      const seat = seatById.get(task.participantId);
      if (!seat || !motion || !recent(task.createdAt)) continue;
      flightsRef.current.push({ kind: "envelope", fromX: BOSS_SEAT.x, fromY: TABLE_TOP + 4, toX: seat.x, toY: TABLE_TOP + 2, start: now + delay, duration: 750 });
      delay += 180;
    }
    const fresh = events.filter((event) => event.sequence > seen.current!.sequence && recent(event.createdAt));
    seen.current.sequence = newest;
    for (const event of fresh) {
      if (isReply(event) && event.speaker.type === "participant") {
        const seat = seatById.get(event.speaker.participantId);
        if (seat && motion) flightsRef.current.push({ kind: "sheet", fromX: seat.x, fromY: TABLE_TOP + 2, toX: BOSS_SEAT.x, toY: TABLE_TOP + 4, start: now, duration: 800 });
      }
    }
    const line = [...fresh].reverse().find((event) => isReply(event) || event.kind === "user.message");
    if (line) setSaid({ speakerId: line.speaker.type === "participant" ? line.speaker.participantId : null, text: lineOf(line.text, 90), at: Date.now() });
  }, [snapshot.events, snapshot.tasks, seated, motion]);

  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), SAY_MS);
    return () => window.clearTimeout(timer);
  }, [said]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // ---- the HUD's counts ----
  const working = seated.filter((s) => s.actor.pose === "work").length;
  const needYou = seated.filter((s) => s.actor.mark === "!" || s.actor.mark === "?").length;
  const spent = costs?.room.total.costUsd ?? null;

  const pct = (value: number, of: number) => `${(value / of) * 100}%`;
  const saidSeat = said ? (said.speakerId ? seated.find((s) => s.participant.id === said.speakerId)?.seat : BOSS_SEAT) : null;

  return (
    <section className="opus-room look-scene" ref={stageRef} aria-label="The back room">
      <div className="opus-stage" style={{ width: SCENE_W * scale, height: SCENE_H * scale, "--px": `${scale}px` } as CSSProperties}>
        <canvas ref={canvasRef} className="opus-canvas" width={SCENE_W} height={SCENE_H} aria-hidden="true" />

        <div className="opus-hud">
          <span>
            {seated.length} at the table
            {working > 0 ? ` · ${working} working` : ""}
            {needYou > 0 ? <strong> · {needYou} need{needYou === 1 ? "s" : ""} you</strong> : null}
          </span>
          {spent !== null && spent > 0 ? <span className="opus-bells">${spent.toFixed(2)}</span> : null}
        </div>
        <div className="opus-tools">
          <button type="button" aria-pressed={logOpen} title={logOpen ? "Hide the conversation and sit with the table" : "Show the conversation under the table"} onClick={() => setLogOpen(!logOpen)}>
            {logOpen ? "Hide log" : "Show log"}
          </button>
          <button
            type="button"
            aria-pressed={sound}
            title={sound ? "Babble on: members make small sounds as they talk" : "Babble off"}
            onClick={() => {
              const next = !sound;
              setSound(next);
              localStorage.setItem(SOUND_KEY, next ? "on" : "off");
            }}
          >
            {sound ? "♪ on" : "♪ off"}
          </button>
        </div>

        <button
          type="button"
          className="opus-seat"
          style={{ left: pct(BOSS_SEAT.x - 14, SCENE_W), top: pct(BOSS_SEAT.y - 4, SCENE_H), width: pct(28, SCENE_W), height: pct(TABLE_TOP + 8 - BOSS_SEAT.y, SCENE_H) }}
          aria-label="You, the boss: the room at a glance"
          onClick={() => setOpen("boss")}
        />
        {seated.map(({ participant, seat, activity }) => (
          <button
            key={participant.id}
            type="button"
            className={`opus-seat${seat.near ? " near" : ""}${open === participant.id ? " open" : ""}`}
            style={{
              left: pct(seat.x - 13, SCENE_W),
              top: pct(seat.y - 2, SCENE_H),
              width: pct(26, SCENE_W),
              height: pct(seat.near ? 26 : TABLE_TOP + 22 - seat.y, SCENE_H),
            }}
            aria-label={`${participant.alias}: ${activity.label}${activity.detail ? `, ${activity.detail}` : ""}`}
            title={`${participant.alias} · ${activity.label}${activity.detail ? ` · ${activity.detail}` : ""}`}
            onClick={() => setOpen(participant.id)}
          >
            <span className={`opus-card tone-${activity.tone}`}>{participant.alias}</span>
          </button>
        ))}

        {said && saidSeat ? (
          <div
            key={said.at}
            className="opus-say"
            style={{ left: `clamp(18%, ${pct(saidSeat.x, SCENE_W)}, 82%)`, top: pct(saidSeat.y - 14, SCENE_H) }}
            aria-live="polite"
          >
            <b>{said.speakerId ? aliasOf(said.speakerId) : "you"}</b> {said.text}
          </div>
        ) : null}

        {open ? (
          <Dialogue
            key={open}
            who={open}
            seated={seated}
            events={snapshot.events}
            tasks={snapshot.tasks}
            motion={motion}
            blip={blip}
            onClose={() => setOpen(null)}
            onTalk={(alias) => {
              setOpen(null);
              onTalk(alias);
            }}
            onShow={(sequence) => showInLog(sequence, setLogOpen)}
          />
        ) : null}
      </div>
    </section>
  );
}

interface DialogueProps {
  who: string | "boss";
  seated: Seated[];
  events: RoomEvent[];
  tasks: Task[];
  motion: boolean;
  blip: (seed: number) => void;
  onClose: () => void;
  /** Put @alias in the composer. */
  onTalk: (alias: string) => void;
  /** Scroll the conversation to an event. */
  onShow: (sequence: number) => void;
}

/** The dialogue box at the foot of the scene: a name tag, the words typed out, ▼ when there is no more. */
function Dialogue({ who, seated, events, tasks, motion, blip, onClose, onTalk, onShow }: DialogueProps) {
  const member = who === "boss" ? null : seated.find((s) => s.participant.id === who) ?? null;
  const { name, colour, text, status, shown: shownEvent } = useMemo(() => {
    if (!member) {
      const busy = seated.filter((s) => s.actor.pose === "work").map((s) => s.participant.alias);
      const needs = seated.filter((s) => s.actor.mark === "!" || s.actor.mark === "?").map((s) => s.participant.alias);
      const last = [...events].reverse().find((event) => event.kind === "user.message");
      const parts = [
        seated.length === 0 ? "Nobody at the table yet. Seat someone from the crew." : `${seated.length} at the table.`,
        busy.length > 0 ? `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} on the job.` : "Nobody's working right now.",
        needs.length > 0 ? `${needs.join(", ")} ${needs.length === 1 ? "needs" : "need"} a word with you.` : "",
        last ? `Your last word: "${lineOf(last.text, 160)}"` : "",
      ];
      return { name: "you", colour: "#1b1c1f", text: parts.filter(Boolean).join(" "), status: "the boss", shown: last ?? null };
    }
    const reply = [...events].reverse().find((event) => isReply(event) && event.speaker.type === "participant" && event.speaker.participantId === member.participant.id);
    const task = tasks.find((t) => t.participantId === member.participant.id && ACTIVE_STATES.has(t.state));
    const detail = [member.activity.label, member.activity.detail, task ? `task ${task.number}: ${lineOf(task.instruction, 60)}` : null].filter(Boolean).join(" · ");
    return { name: member.participant.alias, colour: member.actor.colour, text: reply ? lineOf(reply.text, 520) : idleLine(member.actor), status: detail, shown: reply ?? null };
  }, [member, seated, events, tasks]);

  const [shown, setShown] = useState(motion ? 0 : text.length);
  const seed = seedOf(who);
  useEffect(() => {
    if (shown >= text.length) return;
    const timer = window.setTimeout(() => {
      setShown((n) => Math.min(text.length, n + 2));
      if (/\w/.test(text[shown] ?? "")) blip(seed);
    }, 28);
    return () => window.clearTimeout(timer);
  }, [shown, text, blip, seed]);
  const done = shown >= text.length;

  return (
    <div className="opus-dialogue" role="dialog" aria-label={`${name} says`}>
      <span className="opus-nametag" style={{ background: colour, color: colour === "#1b1c1f" ? "#f2ecd9" : "#1b1510" }}>
        {name}
      </span>
      <p className="opus-status">{status}</p>
      <p className="opus-words" onClick={() => setShown(text.length)} aria-label={text}>
        <span aria-hidden="true">{text.slice(0, shown)}</span>
        {done ? <span className="opus-more" aria-hidden="true">▼</span> : null}
      </p>
      <div className="opus-choices">
        {member ? (
          <button type="button" onClick={() => onTalk(member.participant.alias)} title={`Put @${member.participant.alias} in the composer`}>
            Talk
          </button>
        ) : null}
        {shownEvent ? (
          <button type="button" onClick={() => onShow(shownEvent.sequence)}>
            Show in log
          </button>
        ) : null}
        <button type="button" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </div>
  );
}

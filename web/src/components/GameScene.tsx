import { useEffect, useMemo, useRef, useState } from "react";
import { useRoom } from "../context.tsx";
import { describeStatus } from "../memberActivity.ts";
import { useSkin } from "../skin.ts";
import { isActiveParticipant, type Participant, type RoomEvent } from "../types.ts";
import { BOSS_LOOK, drawVillager, lookFor, memberSeats, type VillagerLook, type VillagerMotion } from "./pixelSprites.ts";

const DIARY_KEY = "backroom.gameDiary";

function motionOf(tone: string, motion: "working" | "monitoring" | null): VillagerMotion {
  if (tone === "approval" || tone === "input") return "needs";
  if (tone === "error" || tone === "missing") return "error";
  if (motion === "working") return "working";
  if (motion === "monitoring") return "monitoring";
  return "idle";
}

function bubbleText(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 140 ? `${plain.slice(0, 137)}…` : plain;
}

function latestBySpeaker(events: RoomEvent[]): Map<string, RoomEvent> {
  const map = new Map<string, RoomEvent>();
  for (const event of events) {
    if (event.kind !== "assistant.reply" && event.kind !== "user.message" && event.kind !== "t3.turn" && event.kind !== "note") continue;
    const key = event.speaker.type === "participant" ? event.speaker.participantId : event.speaker.type === "user" ? "user" : null;
    if (key) map.set(key, event);
  }
  return map;
}

function PixelSprite({
  look,
  motion,
  boss = false,
  ghost = false,
  label,
}: {
  look: VillagerLook;
  motion: VillagerMotion;
  boss?: boolean;
  ghost?: boolean;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (ghost) return;
    let timeout = 0;
    let interval = 0;
    const loop = () => {
      interval = window.setTimeout(
        () => {
          setBlink(true);
          timeout = window.setTimeout(() => {
            setBlink(false);
            loop();
          }, 140);
        },
        2400 + Math.random() * 2200,
      );
    };
    loop();
    return () => {
      window.clearTimeout(interval);
      window.clearTimeout(timeout);
    };
  }, [ghost]);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    drawVillager(ctx, look, { blink, boss, ghost });
  }, [look, blink, boss, ghost]);
  return <canvas ref={canvas} className={`pixel-sprite motion-${motion}`} width={16} height={22} aria-hidden="true" title={label} />;
}

function Seat({
  alias,
  look,
  motion,
  detail,
  bubble,
  selected,
  boss = false,
  ghost = false,
  hint,
  onClick,
  onOpenLog,
}: {
  alias: string;
  look: VillagerLook;
  motion: VillagerMotion;
  detail: string | null;
  bubble: string | null;
  selected: boolean;
  boss?: boolean;
  ghost?: boolean;
  hint: string;
  onClick: () => void;
  onOpenLog?: () => void;
}) {
  return (
    <div className={`game-seat${selected ? " selected" : ""}${boss ? " is-boss" : ""}`} data-motion={motion}>
      {bubble ? (
        <button type="button" className="game-bubble" onClick={onOpenLog} title="Open this in the log">
          {bubble}
        </button>
      ) : motion === "working" || motion === "monitoring" ? (
        <span className="game-thought" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      ) : motion === "needs" ? (
        <span className="game-bang" aria-hidden="true">
          !
        </span>
      ) : null}
      <button type="button" className="game-body" onClick={onClick} title={hint} aria-label={hint} aria-pressed={selected} disabled={ghost}>
        <PixelSprite look={look} motion={motion} boss={boss} ghost={ghost} label={alias} />
        {ghost ? null : <span className="game-name">{alias}</span>}
        {detail ? <span className="game-doing">{detail}</span> : null}
      </button>
    </div>
  );
}

/**
 * Pixel back room: the boss at the foot of the table, the crew around it. Click someone to address them.
 * The ordinary timeline stays under the scene as a "log"; hide it to sit with the table.
 */
export function GameScene({ onTalk }: { onTalk: (alias: string) => void }) {
  const [skin] = useSkin();
  const { snapshot, desk } = useRoom();
  const [selected, setSelected] = useState<string | null>(null);
  const [diaryOpen, setDiaryOpen] = useState(() => localStorage.getItem(DIARY_KEY) !== "min");
  const crew = useMemo(() => snapshot.participants.filter(isActiveParticipant), [snapshot.participants]);
  const seats = useMemo(() => memberSeats(crew.length), [crew.length]);
  const latest = useMemo(() => latestBySpeaker(snapshot.events), [snapshot.events]);
  const newestId = snapshot.events.at(-1)?.id;
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (skin !== "game") return;
    const id = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, [skin]);

  useEffect(() => {
    if (skin !== "game") {
      delete document.documentElement.dataset.gameDiary;
      return;
    }
    document.documentElement.dataset.gameDiary = diaryOpen ? "open" : "min";
    localStorage.setItem(DIARY_KEY, diaryOpen ? "open" : "min");
    return () => {
      delete document.documentElement.dataset.gameDiary;
    };
  }, [skin, diaryOpen]);

  if (skin !== "game") return null;

  const hour = clock.getHours();
  const night = hour < 7 || hour >= 19;
  const clockLabel = clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const userEvent = latest.get("user");
  const userBubble = userEvent && (userEvent.id === newestId || selected === "you") ? bubbleText(userEvent.text) : null;

  const talkTo = (participant: Participant) => {
    setSelected(participant.id);
    onTalk(participant.alias);
  };

  const openLog = (event: RoomEvent | undefined) => {
    if (!event) return;
    document.querySelector(`[data-sequence="${event.sequence}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (!diaryOpen) setDiaryOpen(true);
  };

  return (
    <section className={`game-scene${night ? " is-night" : ""}`} aria-label="The back room">
      <div className="game-sky" aria-hidden="true">
        <span className="game-cloud c1" />
        <span className="game-cloud c2" />
        {night ? (
          <>
            <span className="game-star s1" />
            <span className="game-star s2" />
            <span className="game-star s3" />
          </>
        ) : (
          <span className="game-sun" />
        )}
      </div>
      <div className="game-wall" aria-hidden="true">
        <div className="game-window">
          <span className="game-pane" />
          <span className="game-pane" />
        </div>
        <div className="game-clock" title={clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}>
          {clockLabel}
        </div>
        <h2 className="game-sign">{snapshot.room.title}</h2>
        <div className="game-plant" />
      </div>
      <div className="game-floor">
        <div className="game-rug" />
        <div className="game-table" aria-hidden="true">
          <span className="game-table-top" />
          <span className="game-table-shadow" />
          <span className="game-papers" />
        </div>

        {crew.map((participant, index) => {
          const seat = seats[index];
          if (!seat) return null;
          const activity = describeStatus(snapshot.participantStatus[participant.id], desk?.participants[participant.id]);
          const motion = motionOf(activity.tone, activity.motion);
          const event = latest.get(participant.id);
          const showBubble = Boolean(event && (event.id === newestId || selected === participant.id || motion === "needs"));
          const back = seat.y < 52;
          const hint = `@${participant.alias}: ${activity.label}${activity.detail ? ` · ${activity.detail}` : ""}. Click to talk.`;
          return (
            <div
              key={participant.id}
              className={`game-anchor${back ? " is-back" : ""}`}
              style={{ left: `${seat.x}%`, top: `${seat.y}%`, zIndex: back ? 4 : 20 + Math.round(seat.depth) }}
            >
              <Seat
                alias={participant.alias}
                look={lookFor(participant.alias)}
                motion={motion}
                detail={activity.motion ? activity.label : motion === "needs" ? activity.label : null}
                bubble={showBubble && event ? bubbleText(event.text) : null}
                selected={selected === participant.id}
                hint={hint}
                onClick={() => talkTo(participant)}
                onOpenLog={() => openLog(event)}
              />
            </div>
          );
        })}

        {crew.length === 0
          ? [0, 1, 2].map((i) => {
              const seat = memberSeats(3)[i];
              if (!seat) return null;
              return (
                <div key={i} className="game-anchor is-empty" style={{ left: `${seat.x}%`, top: `${seat.y}%`, zIndex: 8 }}>
                  <Seat
                    alias="vacant"
                    look={lookFor(`empty-${i}`)}
                    motion="idle"
                    detail={null}
                    bubble={null}
                    selected={false}
                    ghost
                    hint="Nobody in this chair. Open People to seat a member."
                    onClick={() => undefined}
                  />
                </div>
              );
            })
          : null}

        <div className="game-anchor is-boss" style={{ left: "50%", top: "86%", zIndex: 40 }}>
          <Seat
            alias="you"
            look={BOSS_LOOK}
            motion="idle"
            detail={null}
            bubble={userBubble}
            selected={selected === "you"}
            boss
            hint="You, at the head of the table"
            onClick={() => setSelected("you")}
            onOpenLog={() => openLog(userEvent)}
          />
        </div>
      </div>
      <div className="game-hud">
        <p className="game-hint">
          {crew.length === 0
            ? "The table is empty. Open People to seat someone, then @them from here."
            : "Click a member to talk · their bubble opens the log"}
        </p>
        <button
          type="button"
          className="game-log-toggle"
          aria-pressed={diaryOpen}
          onClick={() => setDiaryOpen((open) => !open)}
          title={diaryOpen ? "Hide the chat log and sit with the table" : "Show the chat log under the table"}
        >
          {diaryOpen ? "Hide log" : "Show log"}
        </button>
      </div>
    </section>
  );
}

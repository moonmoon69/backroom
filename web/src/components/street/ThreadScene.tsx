import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { drawOffice, OFFICE_DOOR, OFFICE_H, OFFICE_SEAT, OFFICE_W, type Actor } from "../../street/backroomScene.ts";
import { HATS } from "../../street/sprites.ts";
import type { T3ThreadShell } from "../../types.ts";
import { useCatalog } from "../catalog.ts";
import { threadActivity } from "../ThreadView.tsx";
import { HARNESS_COLOUR, SPARE_COLOURS } from "./BackRoomScene.tsx";

const motionAllowed = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What the member at the desk is doing, from the thread's state. */
function actorOf(thread: T3ThreadShell, colour: string): Actor {
  const status = thread.session?.status;
  const base = { id: thread.id, alias: thread.title, colour, hat: HATS[Math.abs(thread.id.charCodeAt(0)) % HATS.length]!, subagents: 0, dizzy: false };
  if (thread.hasPendingApprovals) return { ...base, pose: "idle", mark: "!" };
  if (thread.hasPendingUserInput) return { ...base, pose: "idle", mark: "?" };
  if (status === "running" || status === "starting") return { ...base, pose: "work", mark: "typing" };
  if (thread.backgroundLiveness === "working") return { ...base, pose: "work", mark: null };
  if (thread.backgroundLiveness === "monitoring") return { ...base, pose: "read", mark: null };
  if (status === "error") return { ...base, pose: "idle", mark: "x", dizzy: true };
  if (status === "stopped" || status === "interrupted") return { ...base, pose: "sleep", mark: "z" };
  return { ...base, pose: "idle", mark: null };
}

/**
 * A thread on its own, on the street: its office, one member at a desk doing what the thread is doing (typing while a
 * turn runs, a "!" or "?" when it needs you, asleep when its session stopped). The door goes back out to the street;
 * the conversation is the thread's own page under it.
 */
export function ThreadScene({ thread, night, onLeave }: { thread: T3ThreadShell; night: boolean; onLeave: () => void }) {
  const catalog = useCatalog();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(2);
  const motion = useMemo(motionAllowed, []);
  const driver = catalog?.find((e) => e.instanceId === thread.modelSelection.instanceId)?.driver;
  const colour = HARNESS_COLOUR[driver ?? ""] ?? HARNESS_COLOUR[thread.modelSelection.instanceId] ?? SPARE_COLOURS[0]!;
  const actor = actorOf(thread, colour);
  const activity = threadActivity(thread);
  const frameRef = useRef({ actor, night });
  frameRef.current = { actor, night };

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < (motion ? 50 : 1000)) return;
      last = t;
      drawOffice(ctx, { actor: frameRef.current.actor, night: frameRef.current.night, t: motion ? t : 0, now: new Date(), motion });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [motion]);

  // Whole pixels, as wide as fits, and no taller than about a fifth of the screen.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const fitted = Math.min(stage.clientWidth / OFFICE_W, (window.innerHeight * 0.24) / OFFICE_H);
      setScale(fitted >= 2 ? Math.floor(fitted) : Math.max(1, fitted));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  const pct = (value: number, of: number) => `${(value / of) * 100}%`;
  return (
    <section className={`br-room br-office${night ? " is-night" : " is-day"}`} ref={stageRef} aria-label="The office" style={{ height: OFFICE_H * scale }}>
      <div className="br-stage" style={{ width: OFFICE_W * scale, height: OFFICE_H * scale, "--px": `${scale}px` } as CSSProperties}>
        <canvas ref={canvasRef} className="br-canvas" width={OFFICE_W} height={OFFICE_H} aria-hidden="true" />
        <button
          type="button"
          className="br-thing br-door"
          style={{ left: pct(OFFICE_DOOR.x, OFFICE_W), top: pct(OFFICE_DOOR.y, OFFICE_H), width: pct(OFFICE_DOOR.w, OFFICE_W), height: pct(OFFICE_DOOR.h, OFFICE_H) }}
          onClick={onLeave}
          title="Back to the street (Esc)"
          aria-label="Back out to the street"
        >
          <span className="br-tag">← Street</span>
        </button>
        <p className={`br-office-plate tone-${activity.tone}`} style={{ left: pct(OFFICE_SEAT.x, OFFICE_W), top: pct(OFFICE_H - 12, OFFICE_H) }}>
          <b>{thread.title}</b>
          <span>{activity.label}</span>
        </p>
      </div>
    </section>
  );
}

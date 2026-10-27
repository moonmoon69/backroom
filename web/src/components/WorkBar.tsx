import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, type EnginePost, type EngineRunView, type Participant } from "../types.ts";
import { betweenTurns, describeStatus } from "../memberActivity.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { keepAnswers, NativeRequestsPanel } from "./NativeRequests.tsx";
import { flashPost, NoticeActions } from "./Timeline.tsx";
import { ControlsStrip } from "./ControlsStrip.tsx";
import type { StripAction } from "./ActionStrip.tsx";
import { lastInputWasKey, navProps, showsNow } from "../keys.ts";
import { chipOffers, openLanding, runCanStop } from "../keyOrder.ts";

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
  /** The posts it is about, which its action strip shows ("show #33"): a failed turn's notice, what a turn works on. */
  posts?: number[];
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
 * question T3 is waiting on; "Working" is a run (an uncertain one says so), a turn the room did not start, and a
 * member between turns with background work or monitoring, as T3 reports it; "Waiting" is a member with posts it has
 * not been given yet (its unread backlog), or a delivery that cannot be made. Clicking a chip opens what can be done
 * about it. The chips with something to open are a lane of the room's keys (keys.ts): Left and Right between them,
 * Enter opens one with its choices as an action strip under the bar (K1-6), the ring on the first: the strip's buttons
 * press the choices' own.
 */
export function WorkBar() {
  const { snapshot, desk, colorOf, participantById, seatOf, nameOf, runCommand } = useRoom();
  const [open, setOpen] = useState<string | null>(null);
  // The chip whose choices the keys opened, as an action strip: folded with the strip (Esc, Backspace, the ring or a
  // click elsewhere), except by a click on the chip itself, which then folds it as it always has.
  const [strip, setStrip] = useState<string | null>(null);
  // What was chosen on an approval or question goes once it no longer waits.
  useEffect(() => keepAnswers(snapshot.nativeRequests), [snapshot.nativeRequests]);
  // A strip closed by the pointer (pressed on something else) goes once the pointer is released, its click delivered:
  // the bar shrinks only then, so what was pressed stays under the pointer and gets its click.
  const pressing = useRef(false);
  const released = useRef<Array<() => void>>([]);
  useEffect(() => {
    // The main button only: another opens a menu (the page's, a select's), which may keep its release from the page.
    const down = (event: PointerEvent) => {
      if (event.button === 0) pressing.current = true;
    };
    const up = () => {
      pressing.current = false;
      const then = released.current.splice(0);
      if (then.length > 0) setTimeout(() => then.forEach((done) => done()), 0);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
    };
  }, []);
  // Esc folds the open chip (keys.ts), once a menu, a dialog, a post's action strip or the composer in front of it has
  // closed; the focus, if it was in the choices or nowhere, goes back to the chip.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      const root = bar.current;
      const choices = root?.querySelector(".work-open");
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !root || !choices || root.closest("[inert]")) return;
      if ([...document.querySelectorAll(".dialog-backdrop, .menu, .action-strip, .composer-overlay")].some((element) => !element.closest("[inert]"))) return;
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
  const numbers = (ids: readonly string[]) => ids.map(numberOf).filter((n): n is number => n !== null);
  const refs = (ids: readonly string[]) =>
    numbers(ids)
      .map((n) => `#${n}`)
      .join(" ");

  // Approvals and questions T3 is waiting on, one chip per member.
  const asking = new Map<string, number>();
  for (const request of snapshot.nativeRequests) asking.set(request.participantId, (asking.get(request.participantId) ?? 0) + 1);
  for (const [participantId, count] of asking) {
    const kinds = snapshot.nativeRequests.filter((r) => r.participantId === participantId).map((r) => r.kind);
    const what = kinds.every((kind) => kind === "approval") ? "approval" : kinds.every((kind) => kind !== "approval") ? "question" : "approval and question";
    const on = snapshot.runs.filter((run) => run.phase !== "terminal" && seatOf(run.seatId).participant?.id === participantId).flatMap((run) => numbers(run.requestIds));
    items.push({ key: `ask:${participantId}`, group: "needs", participant: participantById(participantId), what: count > 1 ? `${count} × ${what}` : what, text: "waiting for you", open: { asking: true }, posts: on });
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
      posts: [notice.number],
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
      posts: numbers(run.requestIds),
    });
  }
  // Busy without a room run: a turn someone typed in T3, or the agent continued on its own. Else between turns with
  // work left running, as T3 lists it, in the Members panel's words ("background work", "monitoring").
  const now = Date.now();
  for (const participant of snapshot.participants.filter(isActiveParticipant)) {
    if (busy.has(participant.id)) continue;
    const status = snapshot.participantStatus[participant.id];
    const memberDesk = desk?.participants[participant.id];
    const running = memberDesk?.runningRun;
    if ((running && !running.startedByRoom) || (!running && status?.externalActivity)) {
      items.push({ key: `turn:${participant.id}`, group: "working", participant, what: running?.prompt ? "in T3" : "on its own", text: running?.prompt ?? "" });
    } else if (betweenTurns(status, memberDesk)) {
      const jobs = memberDesk?.backgroundTasks ?? [];
      const text =
        jobs.length > 0
          ? jobs.map((job) => `${job.title} (${job.kind === "agent" ? "subagent" : job.type === "monitor" ? "monitor" : "command"}, ${Math.max(1, Math.round((now - Date.parse(job.startedAt)) / 60000))}m)`).join(" · ")
          : "will continue when it finishes";
      items.push({ key: `background:${participant.id}`, group: "working", participant, what: describeStatus(status, memberDesk).label, text });
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
      items.push({ key: `waiting:${seat.seatId}`, group: "waiting", participant, what: `${seat.unread} unread`, text: `not given to ${nameOf(seat.seatId)} yet` });
    }
  }

  // The room around the bar, kept for when the bar goes (nothing left going on).
  const room = useRef<HTMLElement | null>(null);
  /** A post the open view draws, by its number (the chat leaves some out; a long board draws only its latest). */
  const post = (n: number) => room.current?.querySelector<HTMLElement>(`.timeline [data-number="${n}"]`) ?? null;
  // The chip the ring is on, or in its strip or choices, by its key (focus events on the bar, below).
  const holding = useRef<string | null>(null);
  // The chip gone with the ring on it or in its strip (its request answered, its turn retried, dismissed or ended):
  // after a key, the ring goes where a room opens (keyOrder.ts, openLanding), on something in view, the board not moved:
  // the first chip that needs you, else the newest post if it shows, else a running turn's chip, else the composer's
  // strip. Its strip, if open, goes with it.
  const gone = strip !== null && !items.some((item) => item.key === strip);
  useLayoutEffect(() => {
    if (bar.current) room.current = bar.current.parentElement;
    if (gone) {
      setStrip(null);
      setOpen(null);
    }
    if (holding.current === null || items.some((item) => item.key === holding.current)) return;
    holding.current = null;
    const now = document.activeElement;
    if (!lastInputWasKey() || (now && now !== document.body && now.isConnected)) return;
    const root = room.current;
    const newest = [...(root?.querySelectorAll<HTMLElement>('.timeline [data-nav="post"]') ?? [])].at(-1) ?? null;
    openLanding({
      needs: root?.querySelector<HTMLElement>('.work-needs [data-nav="chip"]') ?? null,
      newest,
      newestInView: newest !== null && showsNow(newest),
      running: root?.querySelector<HTMLElement>('[data-nav-key^="chip:run:"]') ?? null,
      strip: root?.querySelector<HTMLElement>(".composer-strip") ?? null,
    })?.focus({ preventScroll: true });
  });

  const opened = items.find((item) => item.key === open) ?? null;
  // "show #n" for each post the chip is about that the open view draws (a click on a #ref shows only those; a post
  // the chat leaves out, or older than the posts drawn, is not offered): the ring goes to the post, brought into view.
  // Whether it is drawn is read as the bar draws, which it does at every poll.
  // Kept while the same posts are drawn: a poll redrawing the bar leaves the strip as it is.
  const drawn = (opened?.posts ?? []).filter((n) => post(n) !== null).join(" ");
  const shows = useMemo<StripAction[]>(
    () =>
      drawn
        .split(" ")
        .filter(Boolean)
        .map(Number)
        .map((n) => ({
          key: `show:${n}`,
          label: `show #${n}`,
          name: `show #${n}`,
          title: `Show #${n}`,
          press: () => {
            const shown = room.current?.querySelector<HTMLElement>(`.timeline [data-number="${n}"]`);
            if (!shown) return;
            flashPost(shown);
            shown.closest<HTMLElement>("[data-nav]")?.focus({ preventScroll: true });
          },
        })),
    [drawn],
  );
  if (items.length === 0) return null;
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  /** The key bar's words for a chip ("@fable working: on #88"); on the chip itself after its lane, "status · …". */
  const whereOf = (item: Item) => `${item.participant ? `@${item.participant.alias}` : "Backroom"} ${item.what}${item.text ? `: ${oneLine(item.text).slice(0, 200)}` : ""}`;
  return (
    <div
      className="work-bar"
      role="status"
      aria-label="What is going on in this room"
      ref={bar}
      data-nav-lane="status"
      onFocus={(event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-nav="chip"]');
        holding.current = chip ? (chip.dataset.navKey ?? "").replace(/^chip:/, "") : (event.target as HTMLElement).closest(".action-strip, .work-open") ? open : null;
      }}
      onBlur={(event) => {
        // Off to somewhere else in the page (not lost with its chip, which leaves it nowhere).
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) holding.current = null;
      }}
    >
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
                // A chip is a stop only with something to press (keyOrder.ts, chipOffers); a click opens any.
                const stop =
                  item.open !== undefined &&
                  chipOffers("asking" in item.open ? { kind: "ask" } : "notice" in item.open ? { kind: "notice" } : { kind: "run", phase: item.open.run.phase, member: item.participant !== undefined, posts: (item.posts ?? []).filter((n) => post(n) !== null).length });
                return item.open ? (
                  <button
                    key={item.key}
                    type="button"
                    className={`work-chip${open === item.key ? " open" : ""}`}
                    style={style}
                    title={title}
                    aria-expanded={open === item.key}
                    onClick={(event) => {
                      // Enter (a click with no pointer behind it): its choices, as a strip with the ring in it. A click
                      // opens or folds them, as before.
                      if (event.detail === 0) {
                        setOpen(item.key);
                        setStrip(item.key);
                        return;
                      }
                      setStrip(null);
                      setOpen(open === item.key ? null : item.key);
                    }}
                    {...(stop ? navProps("chip", `chip:${item.key}`, `status · ${whereOf(item)}`) : {})}
                  >
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
      {opened && strip === opened.key ? (
        <ControlsStrip
          key={opened.key}
          item={(element) => element.parentElement?.querySelector<HTMLElement>(`[data-nav-key="chip:${opened.key}"]`) ?? null}
          from={(element) => element.parentElement?.querySelector<HTMLElement>(".work-open") ?? null}
          // An approval's or a question's chip is its member's: the choices drawn are every member's.
          within={opened.open && "asking" in opened.open ? (control) => control.closest<HTMLElement>(".native-card")?.dataset.participant === opened.participant?.id : undefined}
          extra={shows}
          where={whereOf(opened)}
          // An answer of your own, which Custom answer focuses, is in the choices: the strip stays.
          keeps={(element) => Boolean(bar.current?.contains(element) && element.closest(".work-open"))}
          onClose={(cause) => {
            const key = opened.key;
            // Closed by the pointer pressed elsewhere (not by a key meanwhile): once it is released. Pressed on the chip
            // itself: its click folds it, as a click on an open chip does (↑ onto it folds it here).
            const byPointer = pressing.current && !lastInputWasKey();
            const onChip = byPointer && cause?.target instanceof Element && cause.target.closest(`[data-nav-key="chip:${key}"]`) !== null;
            // Only what is still this chip's: a click meanwhile may have opened another chip.
            const close = () => {
              setStrip((now) => (now === key ? null : now));
              if (!onChip) setOpen((now) => (now === key ? null : now));
            };
            if (byPointer) released.current.push(close);
            else close();
          }}
          // Nothing to press (a turn being prepared, or refused): the choices stay open, the ring on the chip.
          onEmpty={() => setStrip(null)}
        />
      ) : null}
    </div>
  );
}

/** What can be done about a run: stop it (through T3). An uncertain one is explained. */
function RunActions({ run, onStop }: { run: EngineRunView; onStop: (participantId: string) => void }) {
  const { seatOf } = useRoom();
  const participant = seatOf(run.seatId).participant;
  return (
    <div className="work-actions run-actions">
      <span className="work-open-text">
        {run.phase === "uncertain"
          ? "Uncertain: Backroom cannot tell whether T3 received this turn. It keeps checking and never sends it twice."
          : run.phase === "rejected"
            ? `T3 refused this turn${run.failure ? `: ${run.failure}` : ""}.`
            : `${PHASE[run.phase]}${run.startedAt ? ` since ${new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`}
      </span>
      {participant && runCanStop(run.phase) ? (
        <button type="button" className="small danger" title="Stop the turn through T3" onClick={() => onStop(participant.id)}>
          Stop
        </button>
      ) : null}
    </div>
  );
}

import { useRoom } from "../context.tsx";
import { isActiveParticipant } from "../types.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";

/**
 * Who is between turns but not done: T3 reports background work (subagents, shell jobs) or monitoring on the thread,
 * and the agent will wake itself when it finishes. Mirrors T3's "Background work" strip above its composer.
 */
export function BackgroundBar() {
  const { snapshot, desk, colorOf } = useRoom();
  const rows = snapshot.participants.filter(isActiveParticipant).flatMap((participant) => {
    const status = snapshot.participantStatus[participant.id];
    const participantDesk = desk?.participants[participant.id];
    const liveness = participantDesk?.backgroundLiveness ?? status?.background ?? null;
    const midTurn = status?.session === "running" || status?.session === "starting";
    if (!liveness || midTurn) return [];
    return [{ participant, liveness, jobs: participantDesk?.backgroundTasks ?? [] }];
  });
  if (rows.length === 0) return null;
  const now = Date.now();
  return (
    <div className="background-bar" role="status" aria-label="Background work">
      {rows.map(({ participant, liveness, jobs }) => (
        <div key={participant.id} className="bg-row" style={identityStyle(colorOf(participant.id))}>
          <span className="dot dot-working" aria-hidden="true" />
          <Monogram participant={participant} size="xs" />
          <span className="speaker mono identity">{participant.alias}</span>
          <span className="mono">{liveness === "monitoring" ? "monitoring" : "background work"}</span>
          <span
            className="bg-jobs mono"
            title={jobs.map((job) => `${job.kind === "agent" ? "subagent" : "shell"}: ${job.title}${job.detail ? ` · ${job.detail}` : ""}`).join("\n")}
          >
            {jobs.length > 0
              ? jobs
                  .map((job) => `${job.title} (${job.kind === "agent" ? "subagent" : "shell"}, ${Math.max(1, Math.round((now - Date.parse(job.startedAt)) / 60000))}m)`)
                  .join(" · ")
              : "will continue when it finishes"}
          </span>
        </div>
      ))}
    </div>
  );
}

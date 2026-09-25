import { useState } from "react";
import { useRoom } from "../context.tsx";
import type { Desk, DeskCheckpoint, Participant, PullRequestRef, T3Activity } from "../types.ts";
import { ageOf, shortId, timeOf } from "./deskFormat.ts";
import { Dialog } from "./Dialog.tsx";
import { CopyButton } from "./pickers.tsx";

const ACTIVITY_COLLAPSED = 8;

/**
 * What T3 reports about a participant's thread that the room shows nowhere else: session detail, branch and
 * worktree, pull requests, the proposed plan, per-turn checkpoints, and the tool log. Status, model, role and
 * context are on the participant tile and its usage card; live output is in the timeline and on the Board.
 */
export function ThreadDetailsDialog({ participant, onClose }: { participant: Participant; onClose: () => void }) {
  const { desk: roomDesk } = useRoom();
  const desk = roomDesk?.participants[participant.id] ?? null;
  const error = roomDesk?.errors[participant.id] ?? null;
  return (
    <Dialog title={`${participant.alias} · thread details`} onClose={onClose} wide>
      <div className="desk-body thread-details">
        {error ? <div className="desk-row status-error">{error}</div> : null}
        {!desk && !error ? <div className="desk-row muted mono">loading…</div> : null}
        {desk ? (
          <>
            <SessionRow desk={desk} />
            <WorkspaceRow desk={desk} />
            <PullRequestsRow desk={desk} />
            {desk.proposedPlan ? <PlanRow plan={desk.proposedPlan} /> : null}
            <CheckpointsRow checkpoints={desk.checkpoints} />
            <ToolsRow desk={desk} />
          </>
        ) : null}
        {roomDesk ? <div className="muted mono dim">updated {ageOf(roomDesk.fetchedAt)}</div> : null}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

function SessionRow({ desk }: { desk: Desk }) {
  if (!desk.session && !desk.latestTurn && !desk.backgroundLiveness && !desk.planProgress) return null;
  const parts: string[] = [];
  if (desk.session) parts.push(desk.session.status);
  if (desk.latestTurn) parts.push(`turn ${desk.latestTurn.state}`);
  if (desk.backgroundLiveness) parts.push(`background: ${desk.backgroundLiveness}`);
  if (desk.planProgress) parts.push(`step ${desk.planProgress.completedSteps}/${desk.planProgress.totalSteps}: ${desk.planProgress.step}`);
  return (
    <div className="desk-row desk-session">
      <span className="desk-label">Session</span>
      <span className="mono">{parts.join(" · ")}</span>
      {desk.latestTurn?.completedAt ? <span className="muted mono"> · {timeOf(desk.latestTurn.completedAt)}</span> : null}
      {desk.session?.lastError ? <div className="status-error">{desk.session.lastError}</div> : null}
    </div>
  );
}

function WorkspaceRow({ desk }: { desk: Desk }) {
  return (
    <div className="desk-row desk-workspace">
      <span className="desk-label">Workspace</span>
      {desk.branch ? (
        <span className="mono branch" title={`branch ${desk.branch}`}>
          <span aria-hidden="true">⎇ </span>
          {desk.branch}
        </span>
      ) : null}
      {desk.worktreePath ? (
        <span className="mono dim worktree" title={desk.worktreePath}>
          {desk.worktreePath}
        </span>
      ) : null}
      {!desk.branch && !desk.worktreePath ? <span className="muted mono">no branch reported</span> : null}
      <span className="workspace-thread">
        <span className="desk-label">Thread</span>
        {desk.threadId ? (
          <>
            <code title={desk.threadId}>{shortId(desk.threadId)}</code>
            <CopyButton text={desk.threadId} label="Copy thread id" />
          </>
        ) : (
          <span className="muted">unbound</span>
        )}
      </span>
    </div>
  );
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const pickString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

function PullRequestsRow({ desk }: { desk: Desk }) {
  if (desk.pullRequests.length === 0 && !desk.linkedPullRequest) return null;
  const list: PullRequestRef[] = [...desk.pullRequests];
  if (desk.linkedPullRequest && !list.some((pr) => pr.repository === desk.linkedPullRequest?.repository && pr.number === desk.linkedPullRequest.number)) {
    list.push({ ...desk.linkedPullRequest });
  }
  return (
    <div className="desk-row desk-prs">
      <span className="desk-label">Pull requests</span>
      <ul className="pr-list">
        {list.map((pr) => {
          const snapshot = asRecord(pr.snapshot);
          const state = pickString(snapshot, ["state", "status", "mergeState", "reviewDecision"]);
          const title = pickString(snapshot, ["title"]);
          const checks = pickString(snapshot, ["checks", "checkStatus", "checksState", "ciStatus"]);
          const linked = desk.linkedPullRequest?.repository === pr.repository && desk.linkedPullRequest.number === pr.number;
          return (
            <li key={`${pr.repository}#${pr.number}`}>
              <a className="mono" href={pr.url} target="_blank" rel="noreferrer noopener">
                {pr.repository}#{pr.number}
              </a>
              {linked ? <span className="pill">linked</span> : null}
              {state ? <span className="pill pill-option">{state}</span> : null}
              {checks ? <span className="pill pill-option">checks: {checks}</span> : null}
              {title ? <span className="muted"> {title}</span> : null}
              {pr.source ? <span className="muted mono dim"> · {pr.source}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CheckpointsRow({ checkpoints }: { checkpoints: DeskCheckpoint[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (checkpoints.length === 0) return null;
  return (
    <div className="desk-row desk-checkpoints">
      <span className="desk-label">Checkpoints</span>
      <ul className="checkpoint-list">
        {checkpoints.map((checkpoint) => {
          const isOpen = expanded[checkpoint.turnId] ?? false;
          return (
            <li key={checkpoint.turnId} className={`checkpoint status-${checkpoint.status}`}>
              <button
                type="button"
                className="checkpoint-row mono"
                aria-expanded={isOpen}
                disabled={checkpoint.files.length === 0}
                onClick={() => setExpanded((state) => ({ ...state, [checkpoint.turnId]: !isOpen }))}
              >
                <span className="chevron" aria-hidden="true">
                  {checkpoint.files.length === 0 ? "·" : isOpen ? "▾" : "▸"}
                </span>
                <span>turn {shortId(checkpoint.turnId)}</span>
                <span>
                  <span className="add">+{checkpoint.additions}</span> <span className="del">−{checkpoint.deletions}</span>
                </span>
                <span>
                  {checkpoint.files.length} file{checkpoint.files.length === 1 ? "" : "s"}
                </span>
                <span className="muted">{timeOf(checkpoint.completedAt)}</span>
                {checkpoint.status !== "ready" ? <span className={checkpoint.status === "error" ? "status-error" : "muted"}>{checkpoint.status}</span> : null}
              </button>
              {isOpen ? (
                <ul className="file-list mono">
                  {checkpoint.files.map((file) => (
                    <li key={file.path}>
                      <span className="path">{file.path}</span>
                      <span className="file-meta">
                        <span className="tag mono">{file.kind}</span>
                        <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlanRow({ plan }: { plan: NonNullable<Desk["proposedPlan"]> }) {
  const [open, setOpen] = useState(false);
  const lines = plan.markdown.split("\n");
  return (
    <div className="desk-row desk-plan">
      <button type="button" className="plan-head mono" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="desk-label">Plan</span>
        <span className="muted">{timeOf(plan.createdAt)}</span>
        {plan.implementedAt ? (
          <span className="pill pill-ok" title={`implemented ${timeOf(plan.implementedAt)}`}>
            implemented
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="plan-body">
          {lines.map((line, index) => {
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) {
              return (
                <div key={index} className={`plan-line plan-h plan-h${Math.min(heading[1]!.length, 3)}`}>
                  {heading[2]}
                </div>
              );
            }
            return (
              <div key={index} className="plan-line">
                {line.length > 0 ? line : " "}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ToolsRow({ desk }: { desk: Desk }) {
  const [showAll, setShowAll] = useState(false);
  const { toolSummary, activities } = desk;
  if (toolSummary.started === 0 && activities.length === 0) return null;
  const shown = showAll ? activities : activities.slice(-ACTIVITY_COLLAPSED);
  return (
    <div className="desk-row desk-tools">
      <span className="desk-label">Tools</span>
      <span className="mono">
        {toolSummary.started} tool call{toolSummary.started === 1 ? "" : "s"}
        {toolSummary.completed !== toolSummary.started ? ` · ${toolSummary.completed} completed` : ""}
        {toolSummary.errors > 0 ? <span className="status-error"> · {toolSummary.errors} errors</span> : null}
        {toolSummary.lastTool ? ` · last: ${toolSummary.lastTool}` : ""}
      </span>
      {activities.length > 0 ? (
        <>
          <ActivityList activities={shown} />
          <div className="row">
            {activities.length > ACTIVITY_COLLAPSED ? (
              <button type="button" className="small ghost mono" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                {showAll ? `show last ${ACTIVITY_COLLAPSED}` : `show all ${activities.length}`}
              </button>
            ) : null}
            {desk.partial ? <span className="muted hint">Showing recent activity; the complete record is in T3.</span> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ActivityList({ activities }: { activities: T3Activity[] }) {
  return (
    <ol className="activity-list" aria-label="Recent T3 activity">
      {activities.map((activity) => (
        <li key={activity.id} className={`activity tone-${activity.tone}`} title={ageOf(activity.createdAt)}>
          <span className="activity-head">
            <span className="time mono">{timeOf(activity.createdAt)}</span>
            <span className="activity-kind">{activity.kind}</span>
          </span>
          <span className="activity-summary">{activity.summary}</span>
        </li>
      ))}
    </ol>
  );
}

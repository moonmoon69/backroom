import { useMemo } from "react";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, type ChangedFile } from "../types.ts";
import { identityStyle, Monogram } from "./Monogram.tsx";

/** Files changed across the room, per participant, with overlaps flagged for integration. */
export function ChangesTab() {
  const { snapshot, desk, colorOf } = useRoom();

  const sections = useMemo(() => {
    const list = snapshot.participants
      .filter(isActiveParticipant)
      .map((participant) => ({ participant, desk: desk?.participants[participant.id] ?? null }))
      .filter((entry) => entry.desk && entry.desk.changedFiles.length > 0)
      .map((entry) => ({ participant: entry.participant, desk: entry.desk!, files: [...entry.desk!.changedFiles].sort((a, b) => a.path.localeCompare(b.path)) }));
    const touchedBy = new Map<string, string[]>();
    for (const section of list) {
      for (const file of section.files) {
        const owners = touchedBy.get(file.path) ?? [];
        owners.push(section.participant.id);
        touchedBy.set(file.path, owners);
      }
    }
    const totals = list.reduce(
      (acc, section) => {
        for (const file of section.files) {
          acc.files += 1;
          acc.additions += file.additions;
          acc.deletions += file.deletions;
        }
        return acc;
      },
      { files: 0, additions: 0, deletions: 0 },
    );
    return { list, touchedBy, totals };
  }, [snapshot.participants, desk]);

  if (!desk) {
    return (
      <div className="inspector-empty">
        <p className="mono muted">loading desk…</p>
      </div>
    );
  }
  if (sections.list.length === 0) {
    return (
      <div className="inspector-empty">
        <p className="serif">Nothing changed yet; files appear here as checkpoints land.</p>
        <p className="mono muted">turn · +A −D · N files</p>
      </div>
    );
  }

  const { totals, list, touchedBy } = sections;
  return (
    <>
      <div className="changes-total mono">
        {totals.files} file{totals.files === 1 ? "" : "s"} · <span className="add">+{totals.additions}</span> <span className="del">−{totals.deletions}</span> across{" "}
        {list.length} participant{list.length === 1 ? "" : "s"}
      </div>
      {list.map((section) => (
        <section key={section.participant.id} className="changes-section" style={identityStyle(colorOf(section.participant.id))} aria-label={`${section.participant.alias} changes`}>
          <h3>
            <Monogram participant={section.participant} size="xs" />
            <span className="alias mono identity">{section.participant.alias}</span>
            {section.desk.branch ? (
              <span className="mono muted branch">
                <span aria-hidden="true">⎇ </span>
                {section.desk.branch}
              </span>
            ) : null}
            <span className="spacer" />
            <span className="lane-count mono">{section.files.length}</span>
          </h3>
          <ul className="file-list mono">
            {section.files.map((file: ChangedFile) => {
              const others = (touchedBy.get(file.path) ?? []).filter((id) => id !== section.participant.id);
              return (
                <li key={file.path} className={others.length > 0 ? "overlap" : ""}>
                  <span className="path">{file.path}</span>
                  <span className="file-meta">
                    <span className="tag mono">{file.kind}</span>
                    <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
                    {file.turns > 1 ? <span className="muted">×{file.turns} turns</span> : null}
                    {others.length > 0 ? (
                      <span className="overlap-note" title="Another participant changed the same path">
                        also: {others.map((id) => `@${snapshot.participants.find((p) => p.id === id)?.alias ?? id}`).join(", ")}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

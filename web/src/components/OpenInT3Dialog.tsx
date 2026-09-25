import { useRoom } from "../context.tsx";
import type { Participant } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { CopyButton } from "./pickers.tsx";

/** There is no deep link into T3; show the ids needed to find the thread by hand. */
export function OpenInT3Dialog({ participant, onClose }: { participant: Pick<Participant, "id" | "alias" | "bindingGeneration">; onClose: () => void }) {
  const { snapshot } = useRoom();
  const binding = snapshot.bindings.find((b) => b.participantId === participant.id && b.retiredAt === null);
  return (
    <Dialog title={`Open ${participant.alias} in T3`} onClose={onClose}>
      <p>
        There is no deep link into T3 Code. Open T3, select the project below, and find the thread by its id
        (thread titles begin with the room name). Full native tool output lives in T3; the room shows an
        abbreviated view.
      </p>
      <dl className="kv">
        <dt>Project id</dt>
        <dd>
          <code>{snapshot.room.projectId}</code> <CopyButton text={snapshot.room.projectId} label="Copy project id" />
        </dd>
        <dt>Thread id</dt>
        <dd>
          {binding ? (
            <>
              <code>{binding.threadId}</code> <CopyButton text={binding.threadId} label="Copy thread id" />
            </>
          ) : (
            <span className="muted">no active binding</span>
          )}
        </dd>
        <dt>Binding generation</dt>
        <dd>{participant.bindingGeneration}</dd>
      </dl>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

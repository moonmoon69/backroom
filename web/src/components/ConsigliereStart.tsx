import { useRef, type ReactNode } from "react";
import { useConsigliereSetting } from "../consigliere.ts";
import type { CommandResult, RoomCommand, T3Project } from "../types.ts";
import { PageTitle } from "./PageTitle.tsx";
import { usePresets, usePresetText } from "./presets.tsx";
import { ThreadComposer } from "./ThreadView.tsx";
import { useToast } from "./Toast.tsx";
import { CloseIcon } from "./icons.tsx";

/**
 * "Talk to the Consigliere": an empty chat in a project. Sending the first message makes the room, seats the saved
 * crew member the setting names as its Consigliere, and delivers the message to him; the room then opens like any
 * other. The attempt has one id for as long as this page is open, so sending again after an error carries on with
 * the same room instead of making another.
 */
export function ConsigliereStart({
  projectId,
  projects,
  runCommand,
  onStarted,
  onCancel,
  headerStart,
}: {
  projectId: string;
  projects: T3Project[];
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  onStarted: (roomId: string) => void;
  onCancel: () => void;
  headerStart?: ReactNode;
}) {
  const { toast } = useToast();
  const { presets } = usePresets();
  const presetText = usePresetText();
  const presetId = useConsigliereSetting();
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const requestId = useRef(crypto.randomUUID());
  return (
    <>
      <div className="room-header thread-header">
        {headerStart}
        <PageTitle context={project?.title ?? null} contextTitle={project?.workspaceRoot} name={preset ? `Talk to ${preset.name}` : "Talk to the Consigliere"} />
        <span className="spacer" />
        <button type="button" className="small ghost icon-only" aria-label="Cancel" title="Cancel" onClick={onCancel}>
          <CloseIcon />
        </button>
      </div>
      <div className="room-under">
        <div className="room-body">
          <div className="room-centre">
            <div className="timeline-wrap">
              <div className="timeline">
                <div className="timeline-content">
                  <div className="timeline-empty">
                    {preset ? (
                      <>
                        <p className="serif">
                          Tell {preset.name} what you need. He brings in the others from your saved crew, hands out the work, and reports back.
                        </p>
                        <p className="muted">
                          {preset.name} is {presetText(preset).what}. Your first message starts a room in {project?.title ?? "this project"}; everything he and the others send each other is on its board.
                        </p>
                      </>
                    ) : (
                      <p className="serif">No Consigliere is chosen. Pick one of your saved crew under Settings → Consigliere.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <ThreadComposer
              key={projectId}
              autoFocus
              placeholder={preset ? `Message ${preset.name}` : "Choose a Consigliere in Settings first"}
              disabled={!project || !preset}
              running={false}
              onSend={async (text, images) => {
                if (images.length > 0) {
                  toast("Images can be added once the conversation has started; send the text first.");
                  return false;
                }
                const result = await runCommand({ type: "consigliere.start", projectId, text, requestId: requestId.current });
                if (result && result.type === "consigliere.started" && "roomId" in result) {
                  onStarted(result.roomId as string);
                  return true;
                }
                return false;
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useRef } from "react";
import { speak, speakable, stopSpeaking, useSpeaking, useSpeechAvailable } from "../speech.ts";
import { SpeakerIcon, StopIcon } from "./icons.tsx";

/**
 * Read this reply aloud, or stop when it is the one being read. At the foot of a reply bubble, beside its spend.
 * `lead` is said first (who is speaking), then the reply with its markup gone.
 */
export function SpeakButton({ id, text, lead }: { id: string; text: string; lead: string }) {
  const state = useSpeaking();
  const speaking = state.speaking === id;
  const preparing = state.preparing === id && !speaking;
  const canSpeak = useSpeechAvailable();
  if (!canSpeak || !text.trim()) return null;
  const label = speaking ? "Stop reading" : preparing ? "Preparing the voice; click to cancel" : "Read this reply aloud";
  return (
    <button
      type="button"
      className={`small ghost icon-only speak-button${speaking || preparing ? " on" : ""}`}
      aria-pressed={speaking || preparing}
      aria-label={speaking ? "Stop reading" : preparing ? "Preparing" : "Read aloud"}
      title={label}
      onClick={() => (speaking || preparing ? stopSpeaking() : speak(id, `${lead}. ${speakable(text)}`))}
    >
      {speaking ? <StopIcon /> : preparing ? <span className="spinner" aria-hidden="true" /> : <SpeakerIcon />}
    </button>
  );
}

/**
 * Read new items aloud as they arrive, when `enabled`: replies, or requests for approval. Items present when the
 * scope is first seen are not read (the backlog), only those that appear later; `items` is null while it is not
 * known yet. New items queue behind what is being read.
 */
export function useAnnounceNew(scope: string, enabled: boolean, items: Array<{ id: string; text: string }> | null): void {
  const seen = useRef<{ scope: string; ids: Set<string> } | null>(null);
  const key = items ? items.map((item) => item.id).join("\n") : null;
  useEffect(() => {
    if (items === null) return;
    if (seen.current === null || seen.current.scope !== scope) {
      seen.current = { scope, ids: new Set(items.map((item) => item.id)) };
      return;
    }
    const fresh = items.filter((item) => !seen.current!.ids.has(item.id));
    for (const item of items) seen.current.ids.add(item.id);
    if (!enabled) return;
    for (const item of fresh) speak(item.id, item.text, { append: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, key, enabled]);
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { preferredVoice, readBoxVoice, readRate, readSource, readVoiceURI, speak, speechSupported, stopSpeaking, useBoxStatus, useSpeaking, useVoices, writeBoxVoice, writeRate, writeSource, writeVoiceURI, type SpeechSource } from "../speech.ts";
import type { ThemeChoice } from "../theme.ts";
import type { StatusResponse } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { ConnectionChip } from "./StatusStrip.tsx";
import { BellIcon, MonitorIcon, MoonIcon, NoteIcon, SettingsIcon, SpeakerIcon, StopIcon, SunIcon } from "./icons.tsx";
import { UpdatesButton } from "./Updates.tsx";
import { notificationsSupported, setNotify, useNotifyOn } from "../news.ts";
import { useToast } from "./Toast.tsx";

const THEMES: Array<{ key: ThemeChoice; label: string; icon: ReactNode }> = [
  { key: "system", label: "System", icon: <MonitorIcon /> },
  { key: "light", label: "Light", icon: <SunIcon /> },
  { key: "dark", label: "Dark", icon: <MoonIcon /> },
];

/**
 * App-wide controls at the foot of the sidebar: the T3 connection and the updates on the left, the settings on the
 * right. Roles, notifications, the voice and the theme are set once in a while, so they share one settings menu.
 */
export function AppControls({
  status,
  onOpenConnection,
  onOpenLibrary,
  rolesDisabled,
  theme,
  onTheme,
}: {
  status: StatusResponse | null;
  onOpenConnection: () => void;
  onOpenLibrary: () => void;
  rolesDisabled: boolean;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}) {
  return (
    <span className="app-controls">
      <ConnectionChip status={status} onOpen={onOpenConnection} />
      <UpdatesButton />
      <SettingsMenu onOpenLibrary={onOpenLibrary} rolesDisabled={rolesDisabled} theme={theme} onTheme={onTheme} />
    </span>
  );
}

/** Roles, notifications on this device, the voice replies are read in, and the theme. */
function SettingsMenu({ onOpenLibrary, rolesDisabled, theme, onTheme }: { onOpenLibrary: () => void; rolesDisabled: boolean; theme: ThemeChoice; onTheme: (choice: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const notifyOn = useNotifyOn();
  const boxSpeech = Boolean(useBoxStatus()?.available);
  const { toast } = useToast();
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <span className="settings-menu" ref={wrapper}>
      <button
        type="button"
        className="small ghost icon-only"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings: roles, notifications, voice and theme"
        onClick={() => setOpen((v) => !v)}
      >
        <SettingsIcon />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Settings">
          <button type="button" role="menuitem" disabled={rolesDisabled} title="Named sets of rules assigned to members" onClick={pick(onOpenLibrary)}>
            <span className="menu-icon" aria-hidden="true">
              <NoteIcon />
            </span>
            Roles…
          </button>
          {notificationsSupported ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={notifyOn}
              title={notifyOn ? "This device tells you when a member finishes while Backroom is in the background. Click to turn them off." : "Be told on this device when a member finishes while Backroom is in the background."}
              onClick={pick(async () => {
                const problem = await setNotify(!notifyOn);
                if (problem) toast(problem);
              })}
            >
              <span className="menu-icon" aria-hidden="true">
                <BellIcon off={!notifyOn} />
              </span>
              Notifications
              <span className="menu-value">{notifyOn ? "on" : "off"}</span>
            </button>
          ) : null}
          {speechSupported || boxSpeech ? (
            <button type="button" role="menuitem" title="The voice and speed replies are read aloud in" onClick={pick(() => setVoiceOpen(true))}>
              <span className="menu-icon" aria-hidden="true">
                <SpeakerIcon />
              </span>
              Voice…
            </button>
          ) : null}
          <div className="menu-heading" role="presentation">
            Theme
          </div>
          {THEMES.map((option) => (
            <button key={option.key} type="button" role="menuitemradio" aria-checked={theme === option.key} className={theme === option.key ? "on" : ""} onClick={pick(() => onTheme(option.key))}>
              <span className="menu-icon" aria-hidden="true">
                {option.icon}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {voiceOpen ? <VoiceDialog onClose={() => setVoiceOpen(false)} /> : null}
    </span>
  );
}

const SAMPLE = "Claude. The parser test passes again; the fix is in the tokenizer, and the handoff lists two files.";

const VOICE_LANGUAGE: Record<string, string> = { "en-us": "American", "en-gb": "British" };

function VoiceDialog({ onClose }: { onClose: () => void }) {
  const box = useBoxStatus(true);
  const browserVoices = useVoices();
  const [source, setSource] = useState<SpeechSource>(() => readSource());
  const [boxVoice, setBoxVoice] = useState<string>(readBoxVoice() ?? "");
  const [voiceURI, setVoiceURI] = useState<string>(readVoiceURI() ?? "");
  const [rate, setRate] = useState<number>(readRate());
  const sample = useSpeaking();
  const speaking = sample.speaking === "voice-sample";
  const preparing = sample.preparing === "voice-sample" && !speaking;
  useEffect(() => stopSpeaking, []);
  const chosen = browserVoices.find((v) => v.voiceURI === voiceURI) ?? null;
  const best = preferredVoice(browserVoices);
  const boxAvailable = Boolean(box?.available);
  const boxState = !box ? "asking the service…" : !box.available ? "off on the service (ROOMS_SPEECH=off)" : box.state === "ready" ? "ready" : box.state === "loading" ? "getting ready: the model is loaded on the box (about 90 MB, downloaded once)" : box.state === "failed" ? `not working: ${box.error ?? "unknown error"}` : "loads when first used";
  const save = () => {
    writeSource(boxAvailable ? source : "browser");
    writeBoxVoice(boxVoice || null);
    writeVoiceURI(voiceURI || null);
    writeRate(rate);
  };
  return (
    <Dialog title="Voice" onClose={onClose}>
      <div className="form">
        <p className="muted">
          Replies are read with Backroom&rsquo;s own voice, made on the box and played here, so every device sounds the same; or with this browser&rsquo;s built-in voice. A room or thread reads its new replies aloud when its <strong>⋯</strong> menu says so; the button at the foot of any reply reads that one.
        </p>
        <div className="form-field" role="radiogroup" aria-label="Voice source">
          <span>Read with</span>
          <label className="radio">
            <input type="radio" name="speech-source" checked={source === "box" && boxAvailable} disabled={!boxAvailable} onChange={() => setSource("box")} />
            <span>
              Backroom&rsquo;s voice on the box <span className="muted">· {boxState}</span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="speech-source" checked={source === "browser" || !boxAvailable} disabled={!speechSupported} onChange={() => setSource("browser")} />
            <span>
              This browser&rsquo;s voice{speechSupported ? "" : " (none in this browser)"}
            </span>
          </label>
        </div>
        {source === "box" && boxAvailable ? (
          <label>
            Voice
            <select value={boxVoice} onChange={(e) => setBoxVoice(e.target.value)}>
              <option value="">Backroom&rsquo;s default{box?.defaultVoice ? ` (${box.voices.find((v) => v.id === box.defaultVoice)?.name ?? box.defaultVoice})` : ""}</option>
              {box?.voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} · {VOICE_LANGUAGE[voice.language] ?? voice.language} {voice.gender} · grade {voice.grade}
                </option>
              ))}
            </select>
            <span className="hint">The grades are Kokoro&rsquo;s own; Heart, Bella, Nicole and Emma are the ones worth choosing between.</span>
          </label>
        ) : (
          <label>
            Voice
            <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)}>
              <option value="">{best ? `Best available: ${best.name}` : "Browser default (no voices listed yet)"}</option>
              {browserVoices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang}){voice.localService ? "" : " · online"}
                </option>
              ))}
            </select>
            <span className="hint">
              {chosen && !chosen.localService ? "This voice needs the internet; the browser fetches the audio. " : ""}
              This device&rsquo;s own list; the ones marked online are usually the clearest.
            </span>
          </label>
        )}
        <label>
          Speed <span className="mono muted">{rate.toFixed(1)}×</span>
          <input type="range" min="0.7" max="1.6" step="0.1" value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              if (speaking || preparing) return stopSpeaking();
              save();
              speak("voice-sample", SAMPLE);
            }}
          >
            {speaking ? <StopIcon /> : preparing ? <span className="spinner" aria-hidden="true" /> : <SpeakerIcon />} {speaking ? "Stop" : preparing ? "Preparing…" : "Try it"}
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              save();
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}

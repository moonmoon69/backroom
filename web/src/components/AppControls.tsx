import { useEffect, useRef, useState, type ReactNode } from "react";
import { preferredVoice, readBoxVoice, readRate, readSource, readVoiceURI, speak, speechSupported, stopSpeaking, useBoxStatus, useSpeaking, useVoices, writeBoxVoice, writeRate, writeSource, writeVoiceURI, type SpeechSource } from "../speech.ts";
import { PALETTES, usePalette, useSkin, type SkinChoice } from "../skin.ts";
import type { ThemeChoice } from "../theme.ts";
import type { StatusResponse, ThreadLifecycleChoice } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { ConnectionChip } from "./StatusStrip.tsx";
import { GridIcon, PeopleIcon, BellIcon, MonitorIcon, MoonIcon, PixelIcon, SettingsIcon, SpeakerIcon, StopIcon, SunIcon } from "./icons.tsx";
import { UpdatesButton } from "./Updates.tsx";
import { notificationsSupported, setNotify, useNotifyOn } from "../news.ts";
import { useToast } from "./Toast.tsx";
import { api } from "../api.ts";
import { rememberConsigliereSetting, useConsigliereSetting } from "../consigliere.ts";
import { usePresets, usePresetText } from "./presets.tsx";
import { THREAD_CHOICES } from "./RoomActions.tsx";
import { useMenuFocus } from "../keys.ts";

const THEMES: Array<{ key: ThemeChoice; label: string; icon: ReactNode }> = [
  { key: "system", label: "System", icon: <MonitorIcon /> },
  { key: "light", label: "Light", icon: <SunIcon /> },
  { key: "dark", label: "Dark", icon: <MoonIcon /> },
];

const LOOKS: Array<{ key: SkinChoice; label: string; hint: string; icon: ReactNode }> = [
  { key: "plain", label: "Plain", hint: "T3 Code's look", icon: <GridIcon /> },
  { key: "pixel", label: "Pixel", hint: "Drawn like a SNES game: Final Fantasy windows by night, paper by day, the crew as capybaras", icon: <PixelIcon /> },
];

/**
 * App-wide controls in the overview's header: the T3 connection and the updates, then the settings. The Consigliere,
 * notifications, the voice, the theme and the look are set once in a while, so they share one settings menu.
 */
export function AppControls({
  status,
  onOpenConnection,
  theme,
  onTheme,
}: {
  status: StatusResponse | null;
  onOpenConnection: () => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}) {
  return (
    <span className="app-controls">
      <ConnectionChip status={status} onOpen={onOpenConnection} />
      <UpdatesButton />
      <SettingsMenu theme={theme} onTheme={onTheme} />
    </span>
  );
}

/** The Consigliere, notifications on this device, the voice replies are read in, the theme, and the look. */
function SettingsMenu({ theme, onTheme }: { theme: ThemeChoice; onTheme: (choice: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [consigliereOpen, setConsigliereOpen] = useState(false);
  const { presets } = usePresets();
  const consigliereSetting = useConsigliereSetting();
  const consigliere = presets.find((p) => p.id === consigliereSetting) ?? null;
  const [skin, setSkin] = useSkin();
  const [palette, setPalette] = usePalette();
  const wrapper = useRef<HTMLSpanElement>(null);
  const notifyOn = useNotifyOn();
  const boxSpeech = Boolean(useBoxStatus()?.available);
  const { toast } = useToast();
  useMenuFocus(wrapper, open, () => setOpen(false));
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
        title="Settings: the Consigliere, notifications, voice, theme and look"
        onClick={() => setOpen((v) => !v)}
      >
        <SettingsIcon />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Settings">
          <button
            type="button"
            role="menuitem"
            title="Which of your saved crew is seated as the Consigliere of each new room: you talk to him, he brings in the others, hands out the work and reports back"
            onClick={pick(() => setConsigliereOpen(true))}
          >
            <span className="menu-icon" aria-hidden="true">
              <PeopleIcon />
            </span>
            Consigliere…
            <span className="menu-value">{consigliere ? consigliere.name : "none"}</span>
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
          <div className="menu-heading" role="presentation">
            Look
          </div>
          {LOOKS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={skin === option.key}
              className={skin === option.key ? "on" : ""}
              title={option.hint}
              onClick={pick(() => setSkin(option.key))}
            >
              <span className="menu-icon" aria-hidden="true">
                {option.icon}
              </span>
              {option.label}
            </button>
          ))}
          {/* The pixel look's palettes, under it while it is the look. */}
          {skin === "pixel"
            ? PALETTES.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={palette === option.key}
                  className={`menu-sub${palette === option.key ? " on" : ""}`}
                  title={option.hint}
                  onClick={pick(() => setPalette(option.key))}
                >
                  <span className="menu-icon" aria-hidden="true">
                    <span className={`palette-swatch palette-${option.key}`} />
                  </span>
                  {option.label}
                </button>
              ))
            : null}
        </div>
      ) : null}
      {voiceOpen ? <VoiceDialog onClose={() => setVoiceOpen(false)} /> : null}
      {consigliereOpen ? <ConsigliereDialog onClose={() => setConsigliereOpen(false)} /> : null}
    </span>
  );
}

/**
 * The Consigliere of new rooms: a picker over the user's saved crew, with "none". Backroom ships no preset and
 * names no model; a member already seated in a room keeps his mark whatever is chosen here.
 */
function ConsigliereDialog({ onClose }: { onClose: () => void }) {
  const { presets } = usePresets();
  const presetText = usePresetText();
  const current = useConsigliereSetting();
  const { toast } = useToast();
  // His rules: the text every Consigliere is given with each briefing, to change to your liking.
  const [rules, setRules] = useState<{ text: string; saved: string; custom: boolean; defaultText: string } | null>(null);
  const [savingRules, setSavingRules] = useState(false);
  // What his retiring a member (or a reseat) does to its T3 thread; null until read, and from a service without it.
  const [retireThread, setRetireThread] = useState<ThreadLifecycleChoice | null>(null);
  useEffect(() => {
    void api
      .settings()
      .then((settings) => {
        setRules({ text: settings.consigliereRules.text, saved: settings.consigliereRules.text, custom: settings.consigliereRules.custom, defaultText: settings.consigliereRules.defaultText });
        setRetireThread(settings.retireThread ?? null);
      })
      .catch(() => undefined);
  }, []);
  const chooseRetire = async (thread: ThreadLifecycleChoice) => {
    if (thread === "delete" && !window.confirm("Delete a member's T3 thread and its history permanently each time the Consigliere retires it or a reseat replaces it?")) return;
    try {
      await api.command({ type: "consigliere.retireThread.set", thread });
      setRetireThread(thread);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  const saveRules = async (next: string | null) => {
    if (!rules) return;
    setSavingRules(true);
    try {
      await api.command({ type: "consigliere.rules.set", rules: next });
      const text = next ?? rules.defaultText;
      setRules({ ...rules, text, saved: text, custom: next !== null });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRules(false);
    }
  };
  const choose = async (presetId: string | null) => {
    try {
      await api.command({ type: "consigliere.preset.set", presetId });
      rememberConsigliereSetting(presetId);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Dialog title="Consigliere" onClose={onClose} wide>
      <p className="muted">
        The one you talk to in a new room: he is seated as its Consigliere when you make the room with + beside a project on the overview. He brings in the others from your saved crew, hands out the
        work, and reports back. In an existing room, make any member its Consigliere from his menu under Members.
      </p>
      {presets.length === 0 ? <p className="serif">You have no saved crew yet. Save a member under Crew on the overview first.</p> : null}
      <fieldset aria-label="Consigliere of new rooms">
        <label className="radio">
          <input type="radio" name="consigliere" checked={current === null} onChange={() => void choose(null)} />
          <span>
            <strong>None</strong>
            <span className="hint">A new room opens empty: you seat its members from Members.</span>
          </span>
        </label>
        {presets.map((preset) => (
          <label key={preset.id} className="radio">
            <input type="radio" name="consigliere" checked={current === preset.id} onChange={() => void choose(preset.id)} />
            <span>
              <strong>{preset.name}</strong>
              <span className="hint">{[presetText(preset).model, presetText(preset).detail].filter(Boolean).join(" · ")}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {retireThread ? (
        <label className="consigliere-retire">
          When he retires a member
          <select value={retireThread} onChange={(e) => void chooseRetire(e.target.value as ThreadLifecycleChoice)}>
            {THREAD_CHOICES.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
          <span className="hint">
            What happens to the member&rsquo;s T3 thread when he retires it with <code>rooms-board retire</code>, or when a reseat replaces it with a fresh seat.{" "}
            {THREAD_CHOICES.find((c) => c.key === retireThread)?.help}. A thread also seated in another room is always kept. When you remove a member yourself, you choose each time.
          </span>
        </label>
      ) : null}
      {rules ? (
        <label className="consigliere-rules">
          His rules
          <textarea className="mono" rows={14} value={rules.text} spellCheck={false} onChange={(e) => setRules({ ...rules, text: e.target.value })} />
          <span className="hint">
            Sent to every Consigliere with each message Backroom delivers to him, in every room. {rules.custom ? "This is your wording." : "This is Backroom's wording; change it to your liking."} A change takes effect with
            his next message. In it, <code>rooms-board</code> stands for the board command his briefing spells out.
          </span>
          <span className="task-actions">
            <button type="button" className="small primary" disabled={savingRules || rules.text.trim().length === 0 || rules.text.trim() === rules.saved.trim()} onClick={() => void saveRules(rules.text.trim())}>
              Save rules
            </button>
            <button type="button" className="small ghost" disabled={savingRules || (!rules.custom && rules.text === rules.saved)} title="Go back to Backroom's wording" onClick={() => void saveRules(null)}>
              Reset to default
            </button>
          </span>
        </label>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
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

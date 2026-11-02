import { useEffect, useRef, useState, type ReactNode } from "react";
import { PALETTES, usePalette, useSkin, type SkinChoice } from "../skin.ts";
import type { ThemeChoice } from "../theme.ts";
import type { StatusResponse, ThreadLifecycleChoice } from "../types.ts";
import { AgentsFileDialog } from "./AgentsFile.tsx";
import { Dialog } from "./Dialog.tsx";
import { ConnectionChip } from "./StatusStrip.tsx";
import { FolderIcon, GridIcon, PeopleIcon, BellIcon, CopyIcon, MonitorIcon, MoonIcon, PixelIcon, SettingsIcon, SunIcon } from "./icons.tsx";
import { copyText } from "./CopyText.tsx";
import { keyboardLog } from "../viewportFit.ts";
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
 * App-wide controls in the overview's header: the T3 connection and the updates, then the settings, each a button in the
 * header's row of the keyboard's grid. The Consigliere, notifications, the theme and the look are set once
 * in a while, so they share one settings menu.
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

/** The Consigliere, notifications on this device, the keyboard log, the theme, and the look. */
function SettingsMenu({ theme, onTheme }: { theme: ThemeChoice; onTheme: (choice: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [consigliereOpen, setConsigliereOpen] = useState(false);
  const [agentsFileOpen, setAgentsFileOpen] = useState(false);
  const { presets } = usePresets();
  const consigliereSetting = useConsigliereSetting();
  const consigliere = presets.find((p) => p.id === consigliereSetting) ?? null;
  const [skin, setSkin] = useSkin();
  const [palette, setPalette] = usePalette();
  const wrapper = useRef<HTMLSpanElement>(null);
  const notifyOn = useNotifyOn();
  const { toast } = useToast();
  // Settings → Agents file (src/app/agentsFile.ts): whether it is on, read from the service each time the menu opens; on by default.
  const [agentsFile, setAgentsFile] = useState(true);
  useEffect(() => {
    if (!open) return;
    api.settings().then(
      (settings) => setAgentsFile(settings.agentsFile ?? true),
      () => undefined,
    );
  }, [open]);
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
        title="Settings: the Consigliere, the agents file and skills, notifications, theme and look"
        onClick={() => setOpen((v) => !v)}
        data-nav="ov"
        data-nav-key="head:settings"
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
          <button
            type="button"
            role="menuitem"
            title={`The habits every agent in a project keeps, in its AGENTS.md: ${
              agentsFile ? "written once when a project with no instructions for agents yet gets its first room" : "new rooms write none (off)"
            }. Opens the template ({checks} filled per project), the switch, the projects already written, with a diff and Apply for those that differ from the saved template, and Skills: how far seats follow pstack's poteto-mode, its version, Update now and the pin (README: The agents file, Poteto mode).`}
            onClick={pick(() => setAgentsFileOpen(true))}
          >
            <span className="menu-icon" aria-hidden="true">
              <FolderIcon />
            </span>
            Agents file…
            <span className="menu-value">{agentsFile ? "on" : "off"}</span>
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
          <button
            type="button"
            role="menuitem"
            title="Copies what this device's last on-screen keyboard changes measured and how the page fitted them, to paste into a report when the keyboard covers the composer"
            onClick={pick(async () => {
              if (await copyText(keyboardLog(), toast)) toast("Keyboard log copied", "success");
            })}
          >
            <span className="menu-icon" aria-hidden="true">
              <CopyIcon />
            </span>
            Copy keyboard log
          </button>
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
      {consigliereOpen ? <ConsigliereDialog onClose={() => setConsigliereOpen(false)} /> : null}
      {agentsFileOpen ? <AgentsFileDialog onClose={() => setAgentsFileOpen(false)} /> : null}
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
            Sent to every Consigliere, in every room, with his first briefing and again after his context was compacted or the wording changed. {rules.custom ? "This is your wording." : "This is Backroom's wording; change it to your liking."} A change takes effect with
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

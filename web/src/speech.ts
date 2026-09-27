/**
 * Reading aloud. Two voices: Backroom's own on the box (Kokoro, in the service; the same voice on every device, the
 * phone included) and this browser's built-in one (nothing needed, but rough on many devices). The box voice is used
 * when the service offers it; the browser's is the fallback and a choice.
 *
 * One thing is read at a time, in sentence-sized pieces: the box makes a piece in a second or two while the previous
 * one plays, and a long browser utterance would be cut off by Chrome anyway. Whatever is playing names what is being
 * read (a reply id) so the button on that reply can offer to stop. Voice, speed and source are kept in this browser;
 * whether a room or thread reads its new replies aloud is kept per room or thread, in this browser too.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { SpeechStatus } from "./types.ts";

export { speakable, speakableSummary } from "./speechText.ts";

/** The browser has a speech engine of its own. */
export const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

const SOURCE_KEY = "backroom.speech.source";
const VOICE_KEY = "backroom.speech.voice";
const BOX_VOICE_KEY = "backroom.speech.boxVoice";
const RATE_KEY = "backroom.speech.rate";
const AUTO_KEY = "backroom.speech.auto.";

// ---- settings ----

export type SpeechSource = "box" | "browser";
export const readSource = (): SpeechSource => (localStorage.getItem(SOURCE_KEY) === "browser" ? "browser" : "box");
export const writeSource = (source: SpeechSource): void => localStorage.setItem(SOURCE_KEY, source);
export const readVoiceURI = (): string | null => localStorage.getItem(VOICE_KEY);
export const writeVoiceURI = (uri: string | null): void => (uri ? localStorage.setItem(VOICE_KEY, uri) : localStorage.removeItem(VOICE_KEY));
export const readBoxVoice = (): string | null => localStorage.getItem(BOX_VOICE_KEY);
export const writeBoxVoice = (id: string | null): void => (id ? localStorage.setItem(BOX_VOICE_KEY, id) : localStorage.removeItem(BOX_VOICE_KEY));
export const readRate = (): number => {
  const value = Number(localStorage.getItem(RATE_KEY));
  return Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : 1;
};
export const writeRate = (rate: number): void => localStorage.setItem(RATE_KEY, String(rate));

/** Whether a room ("room:<id>") or a thread ("thread:<id>") reads its new replies aloud in this browser. */
export const readAutoRead = (scope: string): boolean => localStorage.getItem(AUTO_KEY + scope) === "1";
export const writeAutoRead = (scope: string, on: boolean): void => (on ? localStorage.setItem(AUTO_KEY + scope, "1") : localStorage.removeItem(AUTO_KEY + scope));

export function useAutoRead(scope: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readAutoRead(scope));
  useEffect(() => setOn(readAutoRead(scope)), [scope]);
  return [
    on,
    (next) => {
      writeAutoRead(scope, next);
      setOn(next);
    },
  ];
}

// ---- the box voice: is it there? ----

let boxStatus: SpeechStatus | null = null;
let boxStatusAt = 0;
let boxStatusPending: Promise<SpeechStatus | null> | null = null;
/** When the box voice last failed to answer; the browser's voice stands in for a minute. */
let boxBrokenAt = 0;
const statusListeners = new Set<() => void>();
const notifyStatus = () => {
  for (const listener of statusListeners) listener();
};

/** The service's voice status, read at most once a minute (asking also loads the model on the box). */
export function ensureBoxStatus(maxAgeMs = 60_000): Promise<SpeechStatus | null> {
  if (boxStatus && Date.now() - boxStatusAt < maxAgeMs && boxStatus.state !== "loading") return Promise.resolve(boxStatus);
  if (boxStatusPending) return boxStatusPending;
  boxStatusPending = api
    .speechStatus()
    .then((status) => {
      boxStatus = status;
      boxStatusAt = Date.now();
      notifyStatus();
      return status;
    })
    .catch(() => {
      boxStatusAt = Date.now();
      return boxStatus;
    })
    .finally(() => {
      boxStatusPending = null;
    });
  return boxStatusPending;
}

/** The box voice as last seen; null before the first answer. */
export function useBoxStatus(refresh = false): SpeechStatus | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    statusListeners.add(listener);
    void ensureBoxStatus(refresh ? 0 : 60_000);
    return () => {
      statusListeners.delete(listener);
    };
  }, [refresh]);
  return boxStatus;
}

/** Whether anything can read aloud here: the box voice, or this browser's. */
export function useSpeechAvailable(): boolean {
  const status = useBoxStatus();
  return speechSupported || Boolean(status?.available);
}

const boxUsable = (): boolean => Boolean(boxStatus?.available) && boxStatus?.state !== "failed" && Date.now() - boxBrokenAt > 60_000;

/** The browser's voices. Some browsers list them only after a moment, so the list is watched. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (speechSupported ? speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!speechSupported) return;
    const update = () => setVoices(speechSynthesis.getVoices());
    update();
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}

/**
 * The best voice the browser offers when none is chosen: the browser's own default is often its worst (a compact or
 * eSpeak voice). Natural, neural and premium voices first, then Google's and Apple's better ones, in the page's
 * language, and never eSpeak while anything else exists.
 */
export function preferredVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const language = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  const primary = language.split("-")[0] ?? "en";
  const score = (voice: SpeechSynthesisVoice): number => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase().replace("_", "-");
    let points = 0;
    if (lang === language) points += 4;
    else if (lang.startsWith(`${primary}-`) || lang === primary) points += 3;
    else if (!lang.startsWith("en")) points -= 6;
    if (/natural|neural|premium|enhanced|siri/.test(name)) points += 5;
    if (/google/.test(name)) points += 3;
    if (/samantha|daniel|karen|moira|ava|allison|serena|zoe|tom/.test(name)) points += 1;
    if (/espeak|e-speak/.test(name) || /espeak/.test(voice.voiceURI.toLowerCase())) points -= 10;
    if (/compact|novelty|whisper|bells|bad news|good news|cellos|organ|zarvox|trinoids|boing|bubbles|jester|wobble/.test(name)) points -= 8;
    if (voice.localService) points += 0.5;
    if (voice.default) points += 0.25;
    return points;
  };
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

const chosenBrowserVoice = (): SpeechSynthesisVoice | null => {
  const voices = speechSynthesis.getVoices();
  const uri = readVoiceURI();
  return (uri ? voices.find((voice) => voice.voiceURI === uri) : undefined) ?? preferredVoice(voices);
};

// ---- what is being read ----

let speakingId: string | null = null;
/** What is being made ready (its first piece asked for, no sound yet); the button shows a spinner meanwhile. */
let preparingId: string | null = null;
const speakingListeners = new Set<() => void>();
const notifySpeaking = () => {
  for (const listener of speakingListeners) listener();
};
const setSpeaking = (id: string | null) => {
  if (id !== null && preparingId === id) preparingId = null;
  if (speakingId === id) return;
  speakingId = id;
  notifySpeaking();
};
const setPreparing = (id: string | null) => {
  if (preparingId === id) return;
  preparingId = id;
  notifySpeaking();
};

/** What is being read now and what is being made ready, by id (a reply's). */
export function useSpeaking(): { speaking: string | null; preparing: string | null } {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    speakingListeners.add(listener);
    return () => {
      speakingListeners.delete(listener);
    };
  }, []);
  return { speaking: speakingId, preparing: preparingId };
}

// ---- pieces ----

/**
 * Sentence-sized pieces: about `max` characters each, so no piece takes long to make or to say. The first piece is
 * shorter (`first`) when given: the box makes it in a second or so, and speech starts while the rest is made.
 */
function pieces(text: string, max: number, first = max): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const limit = out.length === 0 ? first : max;
    if (current && current.length + sentence.length + 1 > limit) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
    // A single very long sentence (a list read as one line) is cut at commas, then hard.
    while (current.length > max * 2) {
      const cut = current.lastIndexOf(", ", max * 2);
      const at = cut > max / 2 ? cut + 1 : max * 2;
      out.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  }
  if (current) out.push(current);
  return out.filter((piece) => piece.trim().length > 0);
}

// ---- the browser's voice ----

function speakBrowser(id: string, text: string, append: boolean): void {
  if (!speechSupported) return;
  const parts = pieces(text, 220);
  if (parts.length === 0) return;
  if (!append) {
    speechSynthesis.cancel();
    setSpeaking(null);
  }
  setPreparing(id);
  const voice = chosenBrowserVoice();
  const rate = readRate();
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onstart = () => setSpeaking(id);
    if (index === parts.length - 1) {
      utterance.onend = () => {
        if (speakingId === id) setSpeaking(null);
      };
    }
    utterance.onerror = () => {
      if (speakingId === id) setSpeaking(null);
    };
    speechSynthesis.speak(utterance);
  });
}

// ---- the box voice ----

interface BoxItem {
  id: string;
  pieces: string[];
}

// Two players, used in turn: the next piece is loaded into the idle one while the current one plays, so the switch
// at a seam is immediate.
let players: [HTMLAudioElement, HTMLAudioElement] | null = null;
let playerIndex = 0;
const boxQueue: BoxItem[] = [];
let boxRunning = false;
/** Bumped by stop: a run in progress sees it and gives up. */
let boxGeneration = 0;
const pieceCache = new Map<string, Blob>();
const PIECE_CACHE = 48;

// A silent moment as a WAV: playing it from a tap or click lets the element play on its own afterwards (phones
// refuse audio that no gesture started, and a new reply arrives with none).
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

function audioElements(): [HTMLAudioElement, HTMLAudioElement] {
  if (!players) {
    players = [new Audio(), new Audio()];
    for (const element of players) element.preload = "auto";
  }
  return players;
}

/** From the first tap or click in the page: unlock both players for later replies. */
if (typeof document !== "undefined") {
  const unlock = () => {
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
    for (const element of audioElements()) {
      if (element.src && !element.paused) continue;
      element.src = SILENCE;
      element.play().then(() => element.pause(), () => undefined);
    }
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

function fetchPiece(text: string, signal?: AbortSignal): Promise<Blob> {
  const voice = readBoxVoice();
  const rate = readRate();
  const key = `${voice ?? ""}\n${rate}\n${text}`;
  const cached = pieceCache.get(key);
  if (cached) return Promise.resolve(cached);
  return api.speechAudio(text, voice, rate, signal).then((blob) => {
    pieceCache.set(key, blob);
    while (pieceCache.size > PIECE_CACHE) pieceCache.delete(pieceCache.keys().next().value as string);
    return blob;
  });
}

/** A piece loaded into the idle player, ready to start the moment the current piece ends. */
interface Loaded {
  element: HTMLAudioElement;
  url: string;
}

function loadPiece(blob: Blob): Loaded {
  const element = audioElements()[playerIndex]!;
  playerIndex = 1 - playerIndex;
  const url = URL.createObjectURL(blob);
  element.src = url;
  element.load();
  return { element, url };
}

function playLoaded({ element, url }: Loaded, generation: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      element.removeEventListener("ended", done);
      element.removeEventListener("error", done);
      URL.revokeObjectURL(url);
      resolve();
    };
    // Stopped meanwhile: the players were paused and cleared; let the run end.
    const watch = setInterval(() => {
      if (generation !== boxGeneration) done();
    }, 200);
    element.addEventListener("ended", done);
    element.addEventListener("error", done);
    element.play().catch(() => done());
  });
}

async function runBox(): Promise<void> {
  if (boxRunning) return;
  boxRunning = true;
  const generation = boxGeneration;
  try {
    while (boxQueue.length > 0 && generation === boxGeneration) {
      const item = boxQueue.shift()!;
      // Two pieces are asked for ahead of the one playing (the box makes them in order), so the voice keeps up with
      // itself; the next piece is loaded into the idle player as soon as it arrives.
      const fetched: Array<Promise<Blob>> = [];
      const ahead = (index: number) => {
        while (fetched.length < Math.min(item.pieces.length, index + 3)) {
          const promise = fetchPiece(item.pieces[fetched.length]!);
          promise.catch(() => undefined);
          fetched.push(promise);
        }
      };
      let loaded: Loaded | null = null;
      setPreparing(item.id);
      for (let index = 0; index < item.pieces.length && generation === boxGeneration; index += 1) {
        ahead(index);
        let current: Loaded;
        try {
          current = loaded ?? loadPiece(await fetched[index]!);
        } catch {
          // The box could not make it: the browser's voice reads the rest of this item, and stands in for a minute.
          boxBrokenAt = Date.now();
          notifyStatus();
          if (generation === boxGeneration) speakBrowser(item.id, item.pieces.slice(index).join(" "), true);
          break;
        }
        loaded = null;
        if (generation !== boxGeneration) break;
        setSpeaking(item.id);
        const playing = playLoaded(current, generation);
        // While it plays, the following piece is loaded into the other player.
        if (index + 1 < item.pieces.length) {
          const upcoming = fetched[index + 1]!.then((blob) => (generation === boxGeneration ? loadPiece(blob) : null)).catch(() => null);
          await playing;
          loaded = (await Promise.race([upcoming, Promise.resolve(null)])) ?? null;
        } else {
          await playing;
        }
      }
      if (speakingId === item.id && generation === boxGeneration) setSpeaking(null);
    }
  } finally {
    boxRunning = false;
    if (boxQueue.length > 0 && generation === boxGeneration) void runBox();
  }
}

function stopBox(): void {
  boxGeneration += 1;
  boxQueue.length = 0;
  setPreparing(null);
  for (const element of players ?? []) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
}

function speakBox(id: string, text: string, append: boolean): void {
  const parts = pieces(text, 180, 90);
  if (parts.length === 0) return;
  if (!append) {
    stopBox();
    if (speechSupported) speechSynthesis.cancel();
    setSpeaking(null);
  }
  boxQueue.push({ id, pieces: parts });
  void runBox();
}

// ---- the one entry point ----

/**
 * Read `text` aloud as `id`, with the box voice when the service offers it and this browser has not chosen its own,
 * otherwise with the browser's. By default whatever is being read stops first; with `append`, it is read after what
 * is queued (new replies arriving while one is read).
 */
export function speak(id: string, text: string, options: { append?: boolean } = {}): void {
  const append = options.append === true;
  // From the click on: the button shows it is coming, even while the service is still being asked which voice.
  if (!append) setPreparing(id);
  const asked = boxGeneration;
  void ensureBoxStatus().then(() => {
    if (!append && asked !== boxGeneration) return; // stopped meanwhile
    if (readSource() === "box" && boxUsable()) speakBox(id, text, append);
    else speakBrowser(id, text, append);
  });
}

export function stopSpeaking(): void {
  stopBox();
  if (speechSupported) speechSynthesis.cancel();
  setPreparing(null);
  setSpeaking(null);
}

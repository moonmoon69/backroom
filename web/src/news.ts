/**
 * News: what finished while you were not looking. The service keeps, per room and per thread outside rooms, how far
 * you have seen (src/app/seen.ts), so the room and thread lists carry what is new on every device. This page marks the
 * open one seen while you are looking at it, and can tell you through the system's notifications when something
 * finishes while Backroom is open but not in front.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RoomListItem, T3ThreadShell } from "./types.ts";

/** Whether you are looking: the page is on screen and its window is the one in front. */
export function useLooking(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [looking, setLooking] = useState(read);
  useEffect(() => {
    const update = () => setLooking(read());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return looking;
}

export const roomKey = (roomId: string): string => `room:${roomId}`;
export const threadKey = (threadId: string): string => `thread:${threadId}`;

/** A room's news in words: "@sol1 replied", "@sol1's turn failed". */
export function describeRoomNews(latest: NonNullable<NonNullable<RoomListItem["news"]>["latest"]>): string {
  const who = latest.alias ? `@${latest.alias}` : "A member";
  return latest.kind === "failed" ? `${who}'s turn failed` : `${who} replied`;
}

// ---- system notifications, per device ----

const NOTIFY_KEY = "backroom.notify";
export const notificationsSupported = typeof window !== "undefined" && "Notification" in window;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const readNotify = (): boolean => notificationsSupported && localStorage.getItem(NOTIFY_KEY) === "1" && Notification.permission === "granted";

/** Whether this device shows a notification when something finishes. Stays in step across the page's tabs. */
export function useNotifyOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      window.addEventListener("storage", listener);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", listener);
      };
    },
    readNotify,
    () => false,
  );
}

/** Show one notification: through the service worker where there is one (phones allow only that), else directly. */
async function show(title: string, body: string, key: string, onClick: () => void): Promise<void> {
  const options = { body, tag: key, icon: "/icons/icon-192.png", badge: "/favicon.png", data: { key } };
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (registration?.active) {
    await registration.showNotification(title, options);
    return;
  }
  const notification = new Notification(title, options);
  notification.onclick = () => {
    window.focus();
    onClick();
    notification.close();
  };
}

/**
 * Turn notifications on (asking the browser's permission) or off. Turning on shows one at once, so you see what they
 * look like and a browser that cannot show them says so now. Returns why it could not, or null.
 */
export async function setNotify(on: boolean): Promise<string | null> {
  if (!on) {
    localStorage.removeItem(NOTIFY_KEY);
    changed();
    return null;
  }
  if (!notificationsSupported) return "This browser can't show notifications.";
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return "Notifications are blocked for this site; allow them in the browser's site settings, then try again.";
  try {
    await show("Notifications are on", "Backroom tells you here when a member finishes while it is in the background.", "backroom:notify-on", () => undefined);
  } catch (error) {
    return `This browser refused to show one: ${error instanceof Error ? error.message : String(error)}`;
  }
  localStorage.setItem(NOTIFY_KEY, "1");
  changed();
  return null;
}

/**
 * Notify about each finish that arrives while you are not looking, once. Finishes from before this page opened are
 * the sidebar's to show, not announced. `onOpen` opens what a clicked notification is about.
 */
export function useFinishNotifications(rooms: RoomListItem[], threads: T3ThreadShell[], looking: boolean, onOpen: (key: string) => void): void {
  const on = useNotifyOn();
  const openedAt = useRef(Date.now());
  const announced = useRef(new Map<string, string>());
  const open = useRef(onOpen);
  open.current = onOpen;

  // A notification clicked while the service worker showed it: the worker brings this window forward and says which.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; key?: string } | null;
      if (data?.type === "backroom.open" && typeof data.key === "string") open.current(data.key);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const finishes: Array<{ key: string; at: string; title: string; body: string }> = [];
    for (const room of rooms) {
      const latest = room.news?.latest;
      if (latest) finishes.push({ key: roomKey(room.id), at: latest.at, title: `${describeRoomNews(latest)} in ${room.title}`, body: plain(latest.preview) || (latest.kind === "failed" ? "The turn ended with an error." : "") });
    }
    for (const thread of threads) {
      if (thread.news) finishes.push({ key: threadKey(thread.id), at: thread.news.at, title: thread.title || "Thread", body: thread.news.state === "error" ? "The turn ended with an error." : "Finished." });
    }
    for (const finish of finishes) {
      if (announced.current.get(finish.key) === finish.at) continue;
      announced.current.set(finish.key, finish.at);
      if (!on || looking || Date.parse(finish.at) < openedAt.current) continue;
      void show(finish.title, finish.body, finish.key, () => open.current(finish.key)).catch(() => undefined);
    }
  }, [rooms, threads, looking, on]);
}

/** A reply's opening as plain text for a notification: no markdown marks, one line, short. */
function plain(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

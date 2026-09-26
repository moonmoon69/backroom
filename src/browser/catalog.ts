/**
 * The browser list and how rooms use it. A room with browsers on uses its default browser, or "general" when it has
 * none (or it was deleted). Profiles live under data/browsers/<browserId>; a folder there without a record (a room's
 * browser from before browsers were a list) is adopted at startup so its logins are not lost.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Repos } from "../db/repos.ts";
import { GENERAL_BROWSER_ID, type Browser, type Room } from "../domain/types.ts";

export function effectiveBrowser(repos: Repos, room: Pick<Room, "defaultBrowserId">): Browser | null {
  return (room.defaultBrowserId ? repos.getBrowser(room.defaultBrowserId) : null) ?? repos.getBrowser(GENERAL_BROWSER_ID);
}

/** Rooms with browsers on whose default is this browser. */
export function roomsUsingBrowser(repos: Repos, browserId: string): Room[] {
  return repos.listRooms().filter((room) => room.browserEnabled && effectiveBrowser(repos, room)?.id === browserId);
}

/** A browser name from free text: lowercase letters, digits and dashes, unique among the given names. */
export function browserNameFrom(text: string, taken: ReadonlySet<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "browser";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/**
 * Give every profile folder a browser record. A folder named after a room (the room's browser from before browsers
 * were a list) becomes a browser named after that room, and the room's default when it has none. Returns what was
 * adopted. Idempotent.
 */
export function reconcileBrowserCatalog(repos: Repos, dataDir: string, at = new Date().toISOString()): Browser[] {
  const root = join(dataDir, "browsers");
  if (!existsSync(root)) return [];
  const adopted: Browser[] = [];
  for (const id of readdirSync(root)) {
    if (!statSync(join(root, id)).isDirectory() || repos.getBrowser(id)) continue;
    const room = repos.getRoom(id);
    const taken = new Set(repos.listBrowsers().map((b) => b.name));
    const browser: Browser = {
      id,
      name: browserNameFrom(room ? room.title : `browser-${id.slice(0, 8)}`, taken),
      description: room ? `The "${room.title}" room's browser from before browsers were a list; it has that room's logins.` : "A browser profile found without a record.",
      createdAt: at,
      updatedAt: at,
    };
    repos.insertBrowser(browser);
    if (room && room.defaultBrowserId === null) repos.setRoomBrowser(room.id, room.browserEnabled, browser.id, at);
    adopted.push(browser);
  }
  return adopted;
}

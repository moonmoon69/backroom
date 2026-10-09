/**
 * Browser ports are the machine's (src/browser/ports.ts, #598): a Backroom with a fresh data folder (a throwaway for
 * rehearsals) never gives its browsers ports or a display that another Backroom's browsers keep, running or not.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { choosePorts, PortReservations, type Ports } from "../src/browser/ports.ts";
import { RoomBrowsers } from "../src/browser/roomBrowsers.ts";

function scratch(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rooms-ports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backroom = (name: string) => {
    const dataDir = join(root, name);
    mkdirSync(join(dataDir, "browsers"), { recursive: true });
    return { dataDir, owner: join(dataDir, "browsers") };
  };
  return { registry: join(root, "browser-ports"), backroom };
}

/** What a browser of `dataDir` would be given now on this machine with no records at all: the first free ones. */
async function firstFree(dataDir: string, browserId: string): Promise<Ports> {
  mkdirSync(join(dataDir, "browsers", browserId), { recursive: true });
  return choosePorts({ file: join(dataDir, "browsers", browserId, "ports.json"), mode: "vnc", bindHost: "127.0.0.1", taken: new Set(), takenDisplays: new Set(), reservations: null, owner: join(dataDir, "browsers") });
}

const choose = (b: { dataDir: string; owner: string }, browserId: string, reservations: PortReservations) => {
  mkdirSync(join(b.dataDir, "browsers", browserId), { recursive: true });
  return choosePorts({ file: join(b.dataDir, "browsers", browserId, "ports.json"), mode: "vnc", bindHost: "127.0.0.1", taken: new Set(), takenDisplays: new Set(), reservations, owner: b.owner });
};

test("a Backroom with a fresh data folder gives its browser no port or display that another Backroom's stopped browser keeps", async (t) => {
  const { registry, backroom } = scratch(t);
  const users = backroom("users");
  // The user's browser saved the first free ports and display, and is stopped; without the records a fresh Backroom took them.
  const kept = await firstFree(users.dataDir, "general");
  const browsers = new RoomBrowsers({ dataDir: users.dataDir, mode: "headless", portsDir: registry });
  browsers.start();
  browsers.detach();
  assert.equal(readFileSync(join(registry, `port-${kept.cdp}`), "utf8"), users.owner, "its start recorded what its browsers keep");

  const throwaway = backroom("throwaway");
  const given = await choose(throwaway, "testing", new PortReservations(registry));
  for (const key of ["cdp", "vnc", "web", "display"] as const) assert.notEqual(given[key], kept[key], `${key}: ${given[key]} is the user's`);
  assert.deepEqual(JSON.parse(readFileSync(join(throwaway.dataDir, "browsers", "testing", "ports.json"), "utf8")), given);

  // The user's browser keeps its own when it starts again.
  assert.deepEqual(await choose(users, "general", new PortReservations(registry)), kept);
});

test("a throwaway run from a worktree records the main checkout's browsers before that Backroom ever recorded them", async (t) => {
  const { registry, backroom } = scratch(t);
  const users = backroom("users");
  const kept = await firstFree(users.dataDir, "general");
  const throwaway = backroom("throwaway");
  const browsers = new RoomBrowsers({ dataDir: throwaway.dataDir, mode: "headless", portsDir: registry, knownDataDirs: [users.dataDir] });
  browsers.start();
  browsers.detach();
  const given = await choose(throwaway, "testing", new PortReservations(registry));
  assert.notEqual(given.cdp, kept.cdp);
  assert.notEqual(given.web, kept.web);
});

test("a record whose Backroom no longer keeps the port is free to take; a fresh record holds even before its ports.json", async (t) => {
  const { registry, backroom } = scratch(t);
  const users = backroom("users");
  const throwaway = backroom("throwaway");
  const kept = await firstFree(users.dataDir, "general");
  new PortReservations(registry).reserveSaved(users.owner);
  // A Backroom choosing right now: its record is good before it writes ports.json.
  assert.equal(new PortReservations(registry).heldByOther("port", 9999, throwaway.owner), null);
  new PortReservations(registry).reserve("port", 9999, users.owner);
  assert.equal(new PortReservations(registry).heldByOther("port", 9999, throwaway.owner), users.owner, "fresh");
  assert.equal(new PortReservations(registry, 0).heldByOther("port", 9999, throwaway.owner), null, "past the grace, nothing names it");

  // The user's browser was deleted (its folder with it): its ports are free for the throwaway.
  rmSync(join(users.dataDir, "browsers", "general"), { recursive: true, force: true });
  const given = await choose(throwaway, "testing", new PortReservations(registry, 0));
  assert.equal(given.cdp, kept.cdp);
  assert.equal(readFileSync(join(registry, `port-${kept.cdp}`), "utf8"), throwaway.owner);
});

test("browsers of one Backroom may still share saved ports (only one runs on them at a time)", async (t) => {
  const { registry, backroom } = scratch(t);
  const users = backroom("users");
  for (const id of ["general", "staging"]) {
    mkdirSync(join(users.owner, id), { recursive: true });
    writeFileSync(join(users.owner, id, "ports.json"), JSON.stringify({ cdp: id === "general" ? 9390 : 9391, vnc: 5990, web: 6190, display: 190 }));
  }
  assert.deepEqual(new PortReservations(registry).reserveSaved(users.owner), [], "no conflict within one Backroom");
  const other = backroom("other");
  mkdirSync(join(other.owner, "x"), { recursive: true });
  writeFileSync(join(other.owner, "x", "ports.json"), JSON.stringify({ cdp: 9390, vnc: 5991, web: 6191, display: 191 }));
  assert.deepEqual(new PortReservations(registry).reserveSaved(other.owner), [`x: port 9390 is kept by ${users.owner}`], "another Backroom's saved port is reported, not taken");
});

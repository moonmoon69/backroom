import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearRecord, ourTabs, parseArgs, portOf, recordOf, recordText, serviceRecord, stepPassed, tabGone } from "../scripts/rehearse-launch.ts";

describe("rehearsal command line and launcher (T2)", () => {
  it("reads the flags, --only as often as given", () => {
    const args = parseArgs(["--step", "keys", "--as", "me.1", "--only", "12", "--only", "/Esc/", "--keep", "--until", "Esc closes"]);
    assert.equal(args.value("--step"), "keys");
    assert.deepEqual(args.all("--only"), ["12", "/Esc/"]);
    assert.equal(args.value("--until"), "Esc closes");
    assert.equal(args.has("--keep"), true);
    assert.equal(args.has("--list"), false);
    assert.equal(args.value("--port"), undefined);
  });

  it("refuses a flag without its value, an unknown flag, a stray word and a flag given twice", () => {
    assert.throws(() => parseArgs(["--step", "keys", "--only"]), /--only needs a value/);
    assert.throws(() => parseArgs(["--only", "--keep"]), /--only needs a value/);
    assert.throws(() => parseArgs(["--step", "keys", "--onyl", "12"]), /unknown flag --onyl/);
    assert.throws(() => parseArgs(["--step", "keys", "Esc closes"]), /"Esc closes" is not a flag/);
    assert.throws(() => parseArgs(["--port", "4511", "--port", "4512"]), /--port is given twice/);
  });

  it("takes a port only from 1024 to 65535", () => {
    assert.equal(portOf(undefined, 4471), 4471);
    assert.equal(portOf("4521", 4471), 4521);
    for (const bad of ["80", "70000", "45x", "4511.5"]) assert.throws(() => portOf(bad, 4471), /is not a port/);
  });

  it("looks a tab up again only when rooms-browser says it is gone or not ours", () => {
    assert.equal(tabGone('There is no tab 12 in "general". Run "general tabs" to list them.'), true);
    assert.equal(tabGone('Tab 12 is closed. Run "general tabs" to list the tabs.'), true);
    assert.equal(tabGone("Tab 12 belongs to sol.2fa05e45. Open your own with …"), true);
    assert.equal(tabGone("Tab 12 was not opened by an agent (it may be the user's). Open your own with …"), true);
    assert.equal(tabGone("spawnSync /bin/rooms-browser ETIMEDOUT"), false);
    assert.equal(tabGone("Timed out after waiting 30000ms"), false);
    assert.equal(tabGone("Element with uid 3_14 not found"), false);
  });

  it("a step passed only if it started and exited by itself with 0", () => {
    assert.equal(stepPassed(0, null), true);
    assert.equal(stepPassed(1, null), false);
    assert.equal(stepPassed(null, "SIGKILL"), false);
    assert.equal(stepPassed(null, "SIGTERM"), false);
    assert.equal(stepPassed(null, null, new Error("spawn ENOENT")), false);
    assert.equal(stepPassed(0, null, new Error("spawn ENOENT")), false);
  });

  it("cleans up after a child only with the record that child wrote for its port", () => {
    const record = serviceRecord(recordText({ service: 4100, owner: 4000, port: 4521 }));
    assert.deepEqual(record, { service: 4100, owner: 4000, port: 4521 });
    assert.equal(recordOf(record, 4000, 4521), true);
    // A child refused at its start (port taken, folder in use) finds another run's record there.
    assert.equal(recordOf(record, 4999, 4521), false);
    assert.equal(recordOf(record, 4000, 4522), false);
    assert.equal(recordOf(record, undefined, 4521), false);
    assert.equal(recordOf(serviceRecord("4100\n"), 4000, 4521), false);
    assert.equal(serviceRecord("not a record"), null);
  });

  it("finds our tabs on the service's own address, not on a port it is the start of", () => {
    const listing = [
      "## Pages",
      "7: Backroom (http://127.0.0.1:4521/) [yours]",
      "8: Backroom (http://127.0.0.1:45210/) [yours]",
      "9: Backroom (http://127.0.0.1:4521/#room) [sol.2fa05e45's]",
      "10: Backroom (http://127.0.0.1:4521/api/status) [yours]",
    ].join("\n");
    assert.deepEqual(ourTabs(listing, "http://127.0.0.1:4521"), ["7", "10"]);
    assert.deepEqual(ourTabs(listing, "http://127.0.0.1:45210"), ["8"]);
    assert.deepEqual(ourTabs(listing, "http://127.0.0.1:4522"), []);
  });

  it("takes the service's record out of its folder once it is gone, only if the record is this run's", () => {
    const data = mkdtempSync(join(tmpdir(), "rehearse-record-"));
    try {
      const file = join(data, "service.pid");
      writeFileSync(file, recordText({ service: 4100, owner: 4000, port: 4521 }));
      assert.equal(clearRecord(data, 4999), false);
      assert.equal(existsSync(file), true);
      assert.equal(clearRecord(data, 4000), true);
      assert.equal(existsSync(file), false);
      assert.equal(clearRecord(data, 4000), false);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

/** Backroom keeps its own T3 credential with T3's CLI where T3 runs on its machine, and warns ahead of expiry where it cannot. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REQUESTED_SCOPES, readStoredAuth, writeStoredAuth, type StoredT3Auth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { T3Credential, expiryWarning, localT3Cli, t3CliBinary, type IssuedSession, type T3Cli } from "../src/app/t3Credential.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-09T02:00:00.000Z");
const BASE = "http://127.0.0.1:3773";

/** A T3 token as T3 makes them: base64url JSON claims, a dot, a signature. */
const tokenFor = (sid: string) => `${Buffer.from(JSON.stringify({ v: 1, kind: "session", sid, scopes: [] })).toString("base64url")}.sig-${sid}`;

function fakeCli(options: { fail?: string } = {}) {
  const issued: Array<{ scopes: string[]; ttl: string; label: string; subject: string }> = [];
  const revoked: string[] = [];
  let next = 1;
  const cli: T3Cli = {
    async issue(input) {
      issued.push(input);
      if (options.fail) throw new Error(options.fail);
      const sessionId = `session-${next++}`;
      return { sessionId, token: tokenFor(sessionId), scopes: input.scopes, expiresAt: new Date(NOW + 30 * DAY).toISOString() } satisfies IssuedSession;
    },
    async revoke(sessionId) {
      revoked.push(sessionId);
    },
  };
  return { cli, issued, revoked };
}

function setup(t: { after(fn: () => void): void }, options: { cli?: T3Cli | null; localOrigin?: string | null; verify?: (token: string) => Promise<boolean>; stored?: Partial<StoredT3Auth> | null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-t3-credential-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  if (options.stored !== null) {
    writeStoredAuth(dataDir, { baseUrl: BASE, accessToken: tokenFor("paired"), tokenType: "Bearer", scope: REQUESTED_SCOPES, expiresAt: new Date(NOW + 25 * DAY).toISOString(), pairedAt: new Date(NOW - 5 * DAY).toISOString(), ...options.stored });
  }
  const used: string[] = [];
  const logs: string[] = [];
  let now = NOW;
  const credential = new T3Credential({
    dataDir,
    baseUrl: BASE,
    localOrigin: options.localOrigin === undefined ? "http://127.0.0.1:3773" : options.localOrigin,
    cli: options.cli === undefined ? null : options.cli,
    use: (token) => used.push(token),
    verify: options.verify ?? (async () => true),
    log: (message) => logs.push(message),
    now: () => now,
  });
  return { dataDir, credential, used, logs, advance: (ms: number) => (now += ms) };
}

test("with no credential, Backroom issues itself one with exactly the scopes it asks for, for 30 days, and uses it once T3 takes it", async (t) => {
  const { cli, issued, revoked } = fakeCli();
  const { dataDir, credential, used } = setup(t, { cli, stored: null });
  assert.equal(credential.automatic, true);
  await credential.check();
  assert.deepEqual(issued, [{ scopes: REQUESTED_SCOPES.split(" "), ttl: "30d", label: "Backroom", subject: "backroom" }]);
  const stored = readStoredAuth(dataDir)!;
  assert.deepEqual([stored.accessToken, stored.scope, stored.sessionId, stored.source, stored.expiresAt], [tokenFor("session-1"), REQUESTED_SCOPES, "session-1", "t3-cli", new Date(NOW + 30 * DAY).toISOString()]);
  assert.deepEqual(used, [tokenFor("session-1")]);
  assert.deepEqual(revoked, [], "nothing to replace");
  assert.equal(credential.status().warning, null);
});

test("a credential short of a scope Backroom asks for, or with under 7 days left, is renewed and the session it replaced revoked", async (t) => {
  // A pairing from before Backroom asked for the update permissions (the live one until T3S): renewed at once.
  const old = fakeCli();
  const short = setup(t, { cli: old.cli, stored: { scope: "orchestration:read orchestration:operate" } });
  await short.credential.check();
  assert.equal(old.issued.length, 1);
  assert.equal(readStoredAuth(short.dataDir)!.scope, REQUESTED_SCOPES);
  assert.deepEqual(old.revoked, ["paired"], "the session is read from the paired token when the store does not name it");

  const aging = fakeCli();
  const fine = setup(t, { cli: aging.cli });
  await fine.credential.check();
  assert.equal(aging.issued.length, 0, "25 days left and every scope: nothing to do");
  fine.advance(18 * DAY + 1);
  await fine.credential.check();
  assert.equal(aging.issued.length, 1, "under 7 days left");
  await fine.credential.check();
  assert.equal(aging.issued.length, 1, "the new one has 30 days");
  fine.advance(24 * DAY);
  await fine.credential.check();
  assert.deepEqual(aging.revoked, ["paired", "session-1"], "each renewal revokes the session before it, as the store names it");
});

test("T3 refusing the token in use renews it; a refusal of a token already replaced does not", async (t) => {
  const { cli, issued } = fakeCli();
  const { credential } = setup(t, { cli });
  credential.rejected(tokenFor("someone-else"));
  await credential.check();
  assert.equal(issued.length, 0);
  credential.rejected(tokenFor("paired"));
  await credential.check();
  assert.equal(issued.length, 1, "a revoked or reset session is replaced without the user");
});

test("a session T3 does not take is revoked and not used; a failed renewal is tried again after 5 minutes and warned of ahead of expiry", async (t) => {
  const { cli, issued, revoked } = fakeCli();
  const wrong = setup(t, { cli, stored: { expiresAt: new Date(NOW + 3 * DAY).toISOString() }, verify: async () => false });
  await wrong.credential.check();
  assert.deepEqual(revoked, ["session-1"], "the session T3 did not take");
  assert.deepEqual(wrong.used, []);
  assert.equal(readStoredAuth(wrong.dataDir)!.accessToken, tokenFor("paired"), "the old token stays");
  const status = wrong.credential.status();
  assert.match(status.error ?? "", /does not take the session its CLI on this machine issued/);
  assert.equal(status.warning, expiryWarning(new Date(NOW + 3 * DAY).toISOString(), 3 * DAY, status.error));
  await wrong.credential.check();
  assert.equal(issued.length, 1, "not again within 5 minutes");
  wrong.advance(5 * 60_000);
  await wrong.credential.check();
  assert.equal(issued.length, 2);

  const broken = fakeCli({ fail: "`t3 auth session issue` failed: database is locked" });
  const failing = setup(t, { cli: broken.cli, stored: { scope: "orchestration:read" } });
  await failing.credential.check();
  assert.equal(failing.credential.status().warning, null, "25 days left: an error alone is not yet a warning");
  assert.match(failing.credential.status().error ?? "", /database is locked/);
});

test("without T3's CLI, or with T3 on another machine, renewal is the user's and the page warns from 7 days ahead of expiry", async (t) => {
  const { cli, issued } = fakeCli();
  const elsewhere = setup(t, { cli, localOrigin: "http://127.0.0.1:3999" });
  const none = setup(t, { cli: null });
  for (const { credential } of [elsewhere, none]) {
    assert.equal(credential.automatic, false);
    await credential.check();
    assert.equal(credential.status().renewal, "manual");
    assert.equal(credential.status().warning, null, "25 days left");
  }
  assert.equal(issued.length, 0);
  none.advance(19 * DAY);
  const expiresAt = new Date(NOW + 25 * DAY).toISOString();
  assert.equal(
    none.credential.status().warning,
    "Backroom's T3 credential expires on 2026-11-03, in 6 days: run `t3 pair` on T3's machine and paste the link it prints into the T3 panel (the T3 button at the top of the overview) to pair again before then.",
  );
  assert.equal(none.credential.status().expiresAt, expiresAt);
  none.advance(7 * DAY);
  assert.match(none.credential.status().warning ?? "", /^Backroom's T3 credential expired on 2026-11-03: run `t3 pair`/);
});

test("T3's CLI is the version T3's service runs (or T3_CLI), asked with the scopes, lifetime and label, and to revoke by id", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rooms-t3-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(t3CliBinary(home, null), null, "no service state: no CLI");
  assert.equal(localT3Cli(home, null), null);
  const versionDir = join(home, "runtime", "versions", "0.0.46-nightly.20261007.2787");
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(home, "runtime", "service-state.json"), JSON.stringify({ protocol: 3, activeVersion: "0.0.46-nightly.20261007.2787" }));
  // A stand-in for T3's binary: records its arguments, and answers `auth session issue --json` as T3 does.
  const binary = join(versionDir, "t3");
  const argsFile = join(home, "args.txt");
  writeFileSync(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\nif [ "$3" = issue ]; then echo '{"sessionId":"s-1","token":"tok","method":"bearer-access-token","scopes":["orchestration:read","filesystem:read"],"subject":"backroom","client":{"label":"Backroom","deviceType":"bot"},"expiresAt":"2026-11-08T02:00:00.000Z"}'; fi\n`,
  );
  chmodSync(binary, 0o755);
  assert.equal(t3CliBinary(home, null), binary);
  assert.equal(t3CliBinary(home, "off"), null);
  assert.equal(t3CliBinary(home, "/opt/t3/bin/t3"), "/opt/t3/bin/t3");
  const cli = localT3Cli(home, null)!;
  const issued = await cli.issue({ scopes: ["orchestration:read", "filesystem:read"], ttl: "30d", label: "Backroom", subject: "backroom" });
  assert.deepEqual(issued, { sessionId: "s-1", token: "tok", scopes: ["orchestration:read", "filesystem:read"], expiresAt: "2026-11-08T02:00:00.000Z" });
  await cli.revoke("s-0");
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
    `auth session issue --scope orchestration:read --scope filesystem:read --ttl 30d --label Backroom --subject backroom --json --base-dir ${home}`,
    `auth session revoke s-0 --base-dir ${home}`,
  ]);
});

test("the adapter says which token T3 refused, checks a token on its own, and the status shows how the credential is kept", async (t) => {
  const rejected: Array<string | null> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/session") return new Response(JSON.stringify({ authenticated: auth === "Bearer good" }), { status: 200 });
    return new Response("{}", { status: 401 });
  }) as typeof fetch;
  const adapter = new HttpT3Adapter({ baseUrl: BASE, accessToken: "old", fetchImpl, onCredentialRejected: (token) => rejected.push(token) });
  await assert.rejects(adapter.describe(), /pair Backroom again/);
  assert.deepEqual(rejected, ["old"]);
  assert.equal(await adapter.accepts("good"), true);
  assert.equal(await adapter.accepts("bad"), false);

  const stack = await createTestStack();
  t.after(() => stack.close());
  const { credential } = setup(t, { cli: null });
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/nonexistent/rooms-test-credential", ROOMS_PORT: "0" }), "/nonexistent/dist", undefined, null, credential);
  const status = (await (await app.request("/api/status")).json()) as { t3: { credential: unknown } };
  assert.deepEqual(status.t3.credential, credential.status());
});

/** Backroom keeps its own T3 credential with T3's CLI where T3 runs on its machine, and warns ahead of expiry where it cannot. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REQUESTED_SCOPES, missingScopeMessage, readStoredAuth, writeStoredAuth, type StoredT3Auth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { RETRY_AFTER_MS, T3Credential, expiryWarning, localT3Cli, renewalFailure, t3CliBinary, type IssuedSession, type T3Cli } from "../src/app/t3Credential.ts";
import { connectionProblem } from "../web/src/t3Connection.ts";
import type { StatusResponse } from "../web/src/types.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-09T02:00:00.000Z");
const BASE = "http://127.0.0.1:3773";

/** A T3 token as T3 makes them: base64url JSON claims, a dot, a signature. */
const tokenFor = (sid: string) => `${Buffer.from(JSON.stringify({ v: 1, kind: "session", sid, scopes: [] })).toString("base64url")}.sig-${sid}`;

/** `fail`: every issue fails with it; `failTimes`: only the first so many do. */
function fakeCli(options: { fail?: string; failTimes?: number } = {}) {
  const issued: Array<{ scopes: string[]; ttl: string; label: string; subject: string }> = [];
  const revoked: string[] = [];
  let next = 1;
  const cli: T3Cli = {
    async issue(input) {
      issued.push(input);
      if (options.fail) throw new Error(options.fail);
      if (issued.length <= (options.failTimes ?? 0)) throw new Error("`t3 auth session issue` failed: database is locked");
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
  t.after(() => credential.stop());
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

});

test("the credential is written whole (a temporary file renamed over it), and a session T3 issued that could not be stored is revoked", async (t) => {
  const { cli, revoked } = fakeCli();
  const { dataDir, credential, used } = setup(t, { cli, stored: { scope: "orchestration:read" } });
  // Something in the way of the temporary file: the write fails after T3 took the new session.
  const temporary = join(dataDir, `t3-auth.json.${process.pid}.tmp`);
  mkdirSync(temporary);
  await credential.check();
  assert.deepEqual(revoked, ["session-1"], "not left unused for 30 days");
  assert.deepEqual(used, []);
  assert.equal(readStoredAuth(dataDir)!.accessToken, tokenFor("paired"), "the old credential is whole");
  rmSync(temporary, { recursive: true });
  credential.paired();
  await credential.check();
  assert.equal(readStoredAuth(dataDir)!.sessionId, "session-2");
  assert.deepEqual(readdirSync(dataDir), ["t3-auth.json"], "no temporary file left");
  assert.equal(statSync(join(dataDir, "t3-auth.json")).mode & 0o777, 0o600);
});

/** The page's T3 status for a paired Backroom with this credential status. */
const pagedT3 = (credential: NonNullable<StatusResponse["t3"]["credential"]>): StatusResponse["t3"] => ({ baseUrl: BASE, paired: true, pairedAt: null, tokenExpiresAt: null, credential, environment: null, auth: null, error: null });

test("a failed renewal is said in the T3 panel and on the T3 button as soon as it happens, not only near expiry", async (t) => {
  // The deploy case: the live token lacks four scopes and has weeks left; the first renewal fails.
  const { cli } = fakeCli({ failTimes: 1 });
  const { credential, advance } = setup(t, { cli, stored: { scope: "orchestration:read orchestration:operate" } });
  assert.deepEqual(connectionProblem(pagedT3(credential.status())), { tone: "ok", problem: null });
  await credential.check();
  const failed = credential.status();
  assert.equal(failed.error, "`t3 auth session issue` failed: database is locked");
  assert.equal(
    failed.warning,
    "Backroom could not renew its T3 credential (`t3 auth session issue` failed: database is locked) and tries again every 5 minutes; to pair by hand, run `t3 pair` on T3's machine and paste the link it prints into the T3 panel (the T3 button at the top of the overview).",
  );
  assert.equal(failed.warning, renewalFailure(failed.error!));
  assert.deepEqual(connectionProblem(pagedT3(failed)), { tone: "warn", problem: "renewal failed" });
  // Near expiry the date leads, still with why.
  advance(20 * DAY);
  assert.equal(credential.status().warning, expiryWarning(new Date(NOW + 25 * DAY).toISOString(), 5 * DAY, failed.error));
  advance(RETRY_AFTER_MS);
  await credential.check();
  assert.deepEqual([credential.status().error, credential.status().warning], [null, null]);
  assert.deepEqual(connectionProblem(pagedT3(credential.status())), { tone: "ok", problem: null });
});

test("a failed renewal is tried again 5 minutes later by itself, a refusal's with the same force", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // The deploy case: scopes short, the first attempt fails, nobody calls check() again.
  const short = fakeCli({ failTimes: 1 });
  const deploy = setup(t, { cli: short.cli, stored: { scope: "orchestration:read orchestration:operate" } });
  await deploy.credential.check();
  assert.equal(short.issued.length, 1);
  t.mock.timers.tick(RETRY_AFTER_MS - 1);
  await settle();
  assert.equal(short.issued.length, 1, "not before 5 minutes");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(short.issued.length, 2, "tried again without a call");
  assert.equal(readStoredAuth(deploy.dataDir)!.scope, REQUESTED_SCOPES);
  assert.equal(deploy.credential.status().error, null);
  assert.match(deploy.logs.join("\n"), /not renewed \(the credential lacks providers:manage, environment:maintain, diagnostics:read, filesystem:read\): .*trying again in 5 minutes/);

  // A token T3 refused (401) that is not otherwise due: the retry renews it all the same.
  const refusedCli = fakeCli({ failTimes: 1 });
  const refused = setup(t, { cli: refusedCli.cli });
  refused.credential.rejected(tokenFor("paired"));
  await refused.credential.check();
  assert.equal(refusedCli.issued.length, 1);
  t.mock.timers.tick(RETRY_AFTER_MS);
  await settle();
  assert.equal(refusedCli.issued.length, 2);
  assert.equal(readStoredAuth(refused.dataDir)!.sessionId, "session-1");
  assert.deepEqual(refusedCli.revoked, ["paired"]);
});

test("a 403 is a permission the token lacks: it names it and renews nothing; only a 401 renews", async (t) => {
  const { cli, issued } = fakeCli();
  const { credential } = setup(t, { cli });
  const token = tokenFor("paired");
  let status = 403;
  // T3's EnvironmentScopeRequiredError, and its 401 for a token it does not take.
  const fetchImpl = (async () =>
    status === 403
      ? new Response(JSON.stringify({ _tag: "EnvironmentScopeRequiredError", code: "insufficient_scope", requiredScope: "orchestration:read", requiredPermission: "diagnostics:read", traceId: "t" }), { status: 403 })
      : new Response(JSON.stringify({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", reason: "invalid_credential", traceId: "t" }), { status: 401 })) as typeof fetch;
  const adapter = new HttpT3Adapter({ baseUrl: BASE, accessToken: token, fetchImpl, onCredentialRejected: (refused) => credential.rejected(refused) });
  for (let i = 0; i < 10; i++) await assert.rejects(adapter.describe(), (error: Error) => error.message === missingScopeMessage("diagnostics:read"));
  await credential.check();
  assert.equal(issued.length, 0, "ten refused reads, no session issued");
  status = 401;
  await assert.rejects(adapter.describe(), /rejected the credential \(HTTP 401\)/);
  await credential.check();
  assert.equal(issued.length, 1);
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

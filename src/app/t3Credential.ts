/**
 * Backroom's T3 credential, kept without the user where T3 runs on this machine.
 *
 * T3 gives a paired client a 30-day token and no way to keep it: its token exchange takes no lifetime, has no refresh
 * token, and the pairing link is spent; minting a new link over HTTP takes access:write, which manages every client.
 * T3's CLI on its own machine issues a bot session with the scopes and lifetime asked for (`t3 auth session issue`).
 * Backroom runs it when its token is missing, lacks a scope it asks for, is refused by T3, or has less than
 * RENEW_BEFORE_MS left; checks that T3 takes the new token, stores and uses it, and revokes the session it replaced.
 * Where it cannot (T3 on another machine, no CLI), the page warns from WARN_BEFORE_MS ahead of expiry.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOW_TO_PAIR, REQUESTED_SCOPES, readStoredAuth, sameT3Host, sessionIdOf, writeStoredAuth } from "../adapter/auth.ts";

const DAY_MS = 24 * 60 * 60_000;
/** How long a session T3's CLI issues lasts: as long as a paired one. */
export const TOKEN_TTL = "30d";
export const RENEW_BEFORE_MS = 7 * DAY_MS;
export const WARN_BEFORE_MS = 7 * DAY_MS;
const CHECK_EVERY_MS = 60 * 60_000;
/** A renewal that failed is tried again after this, not on every check or refusal. */
const RETRY_AFTER_MS = 5 * 60_000;

export interface IssuedSession {
  sessionId: string;
  token: string;
  scopes: string[];
  expiresAt: string;
}

/** The two things Backroom asks of T3's CLI. */
export interface T3Cli {
  issue(input: { scopes: string[]; ttl: string; label: string; subject: string }): Promise<IssuedSession>;
  revoke(sessionId: string): Promise<void>;
}

/** The T3 binary to run: `override` (T3_CLI; "off" for none), else the version T3's service runs, else null. */
export function t3CliBinary(t3Home: string, override: string | null): string | null {
  if (override) return override === "off" ? null : override;
  try {
    const state = JSON.parse(readFileSync(join(t3Home, "runtime", "service-state.json"), "utf8")) as { activeVersion?: unknown };
    if (typeof state.activeVersion !== "string" || !state.activeVersion) return null;
    const binary = join(t3Home, "runtime", "versions", state.activeVersion, "t3");
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

/** T3's CLI on this machine. The binary is looked up at each call: T3's update moves its service to another version. */
export function localT3Cli(t3Home: string, override: string | null): T3Cli | null {
  if (!t3CliBinary(t3Home, override)) return null;
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const binary = t3CliBinary(t3Home, override);
      if (!binary) return reject(new Error(`T3's CLI is no longer under ${t3Home}`));
      execFile(binary, [...args, "--base-dir", t3Home], { timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`\`t3 ${args.slice(0, 3).join(" ")}\` failed: ${(stderr || error.message).trim().slice(-300)}`));
        else resolve(stdout);
      });
    });
  return {
    async issue({ scopes, ttl, label, subject }) {
      const out = await run(["auth", "session", "issue", ...scopes.flatMap((scope) => ["--scope", scope]), "--ttl", ttl, "--label", label, "--subject", subject, "--json"]);
      const issued = JSON.parse(out) as Partial<IssuedSession>;
      if (typeof issued.sessionId !== "string" || typeof issued.token !== "string" || !Array.isArray(issued.scopes) || typeof issued.expiresAt !== "string") {
        throw new Error("`t3 auth session issue` answered without a session");
      }
      return { sessionId: issued.sessionId, token: issued.token, scopes: issued.scopes, expiresAt: issued.expiresAt };
    },
    async revoke(sessionId) {
      await run(["auth", "session", "revoke", sessionId]);
    },
  };
}

export interface CredentialStatus {
  /** automatic: Backroom renews it with T3's CLI; manual: pairing again is the user's to do. */
  renewal: "automatic" | "manual";
  expiresAt: string | null;
  /** When Backroom last renewed it itself. */
  renewedAt: string | null;
  /** Why the last renewal failed, until one succeeds. */
  error: string | null;
  /** The page's sentence ahead of expiry when nothing is going to renew it. */
  warning: string | null;
}

export interface T3CredentialOptions {
  dataDir: string;
  /** Where Backroom reaches T3. */
  baseUrl: string;
  /** T3's address in its runtime file on this machine, when it runs here: the CLI's sessions are that T3's. */
  localOrigin: string | null;
  cli: T3Cli | null;
  /** Switch the adapter to a new token. */
  use: (token: string) => void;
  /** Whether T3 at baseUrl takes a token: a new one is checked before it is used. */
  verify: (token: string) => Promise<boolean>;
  log: (message: string) => void;
  now?: () => number;
}

export class T3Credential {
  private readonly options: T3CredentialOptions;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewedAt: string | null = null;
  private error: string | null = null;
  private failedAt: number | null = null;

  constructor(options: T3CredentialOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Renewal is Backroom's own when T3's CLI is here and the T3 it serves is the one Backroom uses. */
  get automatic(): boolean {
    const { cli, localOrigin, baseUrl } = this.options;
    return cli !== null && localOrigin !== null && sameT3Host(baseUrl, localOrigin);
  }

  /** Check now, then every hour. */
  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** T3 refused `token`: renew, if it is still the one in use (a request sent before a renewal does not count). */
  rejected(token: string | null): void {
    if (token !== null && token === readStoredAuth(this.options.dataDir)?.accessToken) void this.check(true);
  }

  /** The user paired by hand: a failure before that is no longer the news. */
  paired(): void {
    this.error = null;
    this.failedAt = null;
  }

  /** Renew when due (or `force`d by a refusal); one at a time. */
  check(force = false): Promise<void> {
    this.running ??= this.renewIfDue(force).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Why the stored credential needs renewing, or null when it does not. */
  private due(): string | null {
    const stored = readStoredAuth(this.options.dataDir);
    if (!stored) return "Backroom has no T3 credential";
    const granted = new Set(stored.scope.split(" "));
    const missing = REQUESTED_SCOPES.split(" ").filter((scope) => !granted.has(scope));
    if (missing.length > 0) return `the credential lacks ${missing.join(", ")}`;
    const left = stored.expiresAt ? Date.parse(stored.expiresAt) - this.now() : Number.NaN;
    if (!(left >= RENEW_BEFORE_MS)) return stored.expiresAt ? `the credential expires ${stored.expiresAt}` : "the credential's expiry is unknown";
    return null;
  }

  private async renewIfDue(force: boolean): Promise<void> {
    const { cli, dataDir, baseUrl, log } = this.options;
    if (!this.automatic || !cli) return;
    if (this.failedAt !== null && this.now() - this.failedAt < RETRY_AFTER_MS) return;
    const reason = force ? "T3 refused the credential" : this.due();
    if (!reason) return;
    const previous = readStoredAuth(dataDir);
    try {
      const issued = await cli.issue({ scopes: REQUESTED_SCOPES.split(" "), ttl: TOKEN_TTL, label: "Backroom", subject: "backroom" });
      const taken = await this.options.verify(issued.token).catch(() => false);
      if (!taken) {
        await cli.revoke(issued.sessionId).catch(() => undefined);
        throw new Error(`T3 at ${baseUrl} does not take the session its CLI on this machine issued`);
      }
      writeStoredAuth(dataDir, {
        baseUrl,
        accessToken: issued.token,
        tokenType: "Bearer",
        scope: issued.scopes.join(" "),
        expiresAt: issued.expiresAt,
        pairedAt: new Date(this.now()).toISOString(),
        sessionId: issued.sessionId,
        source: "t3-cli",
      });
      this.options.use(issued.token);
      this.renewedAt = new Date(this.now()).toISOString();
      this.error = null;
      this.failedAt = null;
      log(`T3 credential renewed with T3's CLI (${reason}); it expires ${issued.expiresAt}`);
      const replaced = previous ? (previous.sessionId ?? sessionIdOf(previous.accessToken)) : null;
      if (replaced && replaced !== issued.sessionId) {
        await cli.revoke(replaced).then(
          () => log(`revoked the T3 session it replaced (${replaced})`),
          (error: Error) => log(`could not revoke the T3 session it replaced (${replaced}): ${error.message}`),
        );
      }
    } catch (error) {
      this.error = (error as Error).message;
      this.failedAt = this.now();
      log(`T3 credential not renewed (${reason}): ${this.error}`);
    }
  }

  status(): CredentialStatus {
    const expiresAt = readStoredAuth(this.options.dataDir)?.expiresAt ?? null;
    const renewal = this.automatic ? "automatic" : "manual";
    const left = expiresAt ? Date.parse(expiresAt) - this.now() : null;
    const unattended = renewal === "manual" || this.error !== null;
    const warning = unattended && expiresAt && left !== null && left < WARN_BEFORE_MS ? expiryWarning(expiresAt, left, this.error) : null;
    return { renewal, expiresAt, renewedAt: this.renewedAt, error: this.error, warning };
  }
}

/** The sentence ahead of (or past) expiry, with why Backroom could not renew it when it tried. */
export function expiryWarning(expiresAt: string, leftMs: number, error: string | null): string {
  const day = expiresAt.slice(0, 10);
  const why = error ? ` and Backroom could not renew it (${error})` : "";
  if (leftMs <= 0) return `Backroom's T3 credential expired on ${day}${why}: ${HOW_TO_PAIR} to pair again.`;
  const days = Math.ceil(leftMs / DAY_MS);
  return `Backroom's T3 credential expires on ${day}, in ${days} day${days === 1 ? "" : "s"}${why}: ${HOW_TO_PAIR} to pair again before then.`;
}

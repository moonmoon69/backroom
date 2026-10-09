/**
 * T3 credential handling. A pairing URL (…/pair?token=…) carries a one-time bootstrap credential;
 * it is exchanged at POST /oauth/token (RFC 8693 token exchange) for a scoped bearer access token.
 * The token is stored in the data directory with owner-only permissions and never returned to the UI.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StoredT3Auth {
  baseUrl: string;
  accessToken: string;
  tokenType: "Bearer" | "DPoP";
  scope: string;
  expiresAt: string | null;
  pairedAt: string;
  /** T3's session behind the token, when it said (its CLI does); otherwise read from the token (sessionIdOf). */
  sessionId?: string;
  /** How Backroom got it: a pairing link exchanged, or a session T3's CLI issued (src/app/t3Credential.ts). */
  source?: "pairing" | "t3-cli";
}

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/**
 * What Backroom asks T3 for when it pairs: each scope with the calls that need it (T3's RPC_REQUIRED_SCOPES). T3
 * grants those of them its pairing link holds (`t3 pair` holds them all) and silently leaves out the rest.
 */
export const SCOPE_USES = {
  "orchestration:read": "the shell and thread reads, server.getConfig, server.refreshProviders, server.reportClientActivity, vcs.listRefs",
  "orchestration:operate": "orchestration.dispatchCommand, orchestration.launchThread, projects.mutate, assets.persistChatAttachments",
  "providers:manage": "server.updateProvider (a harness's Update)",
  "environment:maintain": "server.updateServer (T3's Update)",
  "diagnostics:read": "server.getUsageSummary (today's usage)",
  "filesystem:read": "filesystem.browse (the New project dialog's folders)",
} as const;
export const REQUESTED_SCOPES = Object.keys(SCOPE_USES).join(" ");

/** How the user pairs Backroom again, in the page's sentences. */
export const HOW_TO_PAIR = "run `t3 pair` on T3's machine and paste the link it prints into the T3 panel (the T3 button at the top of the overview)";

/** The page's sentence when T3 refuses a call because Backroom's pairing lacks `scope`. */
export function missingScopeMessage(scope: string): string {
  return `Backroom's pairing with T3 does not allow this (it lacks the "${scope}" permission): ${HOW_TO_PAIR} to pair again.`;
}

export function authStorePath(dataDir: string): string {
  return join(dataDir, "t3-auth.json");
}

export function readStoredAuth(dataDir: string): StoredT3Auth | null {
  const path = authStorePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredT3Auth;
  } catch {
    return null;
  }
}

/** Written to a temporary file and renamed over the old one: a crash midway (renewals now write it unattended) leaves the old credential whole. */
export function writeStoredAuth(dataDir: string, auth: StoredT3Auth): void {
  const path = authStorePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Extract base URL and bootstrap credential from a pairing URL such as http://host:port/pair?token=abc */
export function parsePairingUrl(pairingUrl: string): { baseUrl: string; credential: string } {
  const url = new URL(pairingUrl.trim());
  const credential = url.searchParams.get("token") ?? url.hash.replace(/^#?token=/, "");
  if (!credential) throw new Error("pairing URL does not contain a token");
  return { baseUrl: `${url.protocol}//${url.host}`, credential };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether two T3 addresses name the same server: the same host and port, the loopback names counting as one (`t3 pair` prints localhost). */
export function sameT3Host(a: string, b: string): boolean {
  const x = new URL(a);
  const y = new URL(b);
  if (x.host === y.host) return true;
  return x.protocol === y.protocol && x.port === y.port && LOOPBACK_HOSTS.has(x.hostname) && LOOPBACK_HOSTS.has(y.hostname);
}

export async function exchangePairingCredential(
  baseUrl: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredT3Auth> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: credential,
    subject_token_type: BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    scope: REQUESTED_SCOPES,
    client_label: "Backroom",
    client_device_type: "bot",
  });
  const response = await fetchImpl(new URL("/oauth/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token exchange failed with HTTP ${response.status}: ${redact(text).slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as { access_token: string; token_type: "Bearer" | "DPoP"; expires_in: number; scope: string };
  const now = Date.now();
  return {
    baseUrl,
    accessToken: parsed.access_token,
    tokenType: parsed.token_type,
    scope: parsed.scope,
    expiresAt: Number.isFinite(parsed.expires_in) && parsed.expires_in > 0 ? new Date(now + parsed.expires_in * 1000).toISOString() : null,
    pairedAt: new Date(now).toISOString(),
    source: "pairing",
  };
}

/** The session a T3 token belongs to: its signed claims (base64url JSON before the dot) carry it as `sid`. */
export function sessionIdOf(token: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { sid?: unknown };
    return typeof claims.sid === "string" && claims.sid.length > 0 ? claims.sid : null;
  } catch {
    return null;
  }
}

export function redact(text: string): string {
  return text.replace(/("(?:access_token|token|credential|bearerToken)"\s*:\s*")[^"]+(")/giu, "$1[redacted]$2");
}

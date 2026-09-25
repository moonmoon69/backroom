/**
 * T3 credential handling. A pairing URL (…/pair?token=…) carries a one-time bootstrap credential;
 * it is exchanged at POST /oauth/token (RFC 8693 token exchange) for a scoped bearer access token.
 * The token is stored in the data directory with owner-only permissions and never returned to the UI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StoredT3Auth {
  baseUrl: string;
  accessToken: string;
  tokenType: "Bearer" | "DPoP";
  scope: string;
  expiresAt: string | null;
  pairedAt: string;
}

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const REQUESTED_SCOPES = "orchestration:read orchestration:operate";

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

export function writeStoredAuth(dataDir: string, auth: StoredT3Auth): void {
  const path = authStorePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Extract base URL and bootstrap credential from a pairing URL such as http://host:port/pair?token=abc */
export function parsePairingUrl(pairingUrl: string): { baseUrl: string; credential: string } {
  const url = new URL(pairingUrl.trim());
  const credential = url.searchParams.get("token") ?? url.hash.replace(/^#?token=/, "");
  if (!credential) throw new Error("pairing URL does not contain a token");
  return { baseUrl: `${url.protocol}//${url.host}`, credential };
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
    client_label: "T3 Rooms",
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
  };
}

export function redact(text: string): string {
  return text.replace(/("(?:access_token|token|credential|bearerToken)"\s*:\s*")[^"]+(")/giu, "$1[redacted]$2");
}

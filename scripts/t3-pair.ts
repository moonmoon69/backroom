#!/usr/bin/env node
/**
 * Pair the room service with a T3 Code server from the command line.
 *
 *   npm run t3:pair -- "http://127.0.0.1:3773/pair?token=..."
 *
 * The one-time credential is exchanged for a scoped bearer token stored in data/t3-auth.json (mode 0600).
 * Nothing is printed except the scope and expiry.
 */
import { exchangePairingCredential, parsePairingUrl, writeStoredAuth } from "../src/adapter/auth.ts";
import { loadConfig } from "../src/config.ts";

const pairingUrl = process.argv[2];
if (!pairingUrl) {
  console.error("usage: npm run t3:pair -- <pairing-url>");
  process.exit(2);
}
const config = loadConfig();
const { baseUrl, credential } = parsePairingUrl(pairingUrl);
try {
  const auth = await exchangePairingCredential(baseUrl, credential);
  writeStoredAuth(config.dataDir, auth);
  console.log(`paired with ${baseUrl}; scope "${auth.scope}"; expires ${auth.expiresAt ?? "unknown"}; stored in ${config.dataDir}/t3-auth.json`);
  if (config.t3BaseUrl && new URL(config.t3BaseUrl).host !== new URL(baseUrl).host) {
    console.log(`note: configured T3_BASE_URL (${config.t3BaseUrl}) differs from the pairing host; set T3_BASE_URL=${baseUrl}`);
  }
} catch (error) {
  console.error(`pairing failed: ${(error as Error).message}`);
  process.exit(1);
}

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { readSecretFile, writeSecretFile } from './secret-file';

// Keep the existing filename so relay-only upgrades preserve paired browsers.
const PAIRING_TOKEN_FILE = 'remote-bridge.token';

export async function loadOrCreatePairingToken(userDataPath: string): Promise<string> {
  const tokenPath = join(userDataPath, PAIRING_TOKEN_FILE);
  const existing = (await readSecretFile(tokenPath))?.trim();
  if (existing && /^[0-9a-f]{32,128}$/.test(existing)) return existing;
  return writePairingToken(tokenPath);
}

async function writePairingToken(tokenPath: string): Promise<string> {
  const token = randomBytes(24).toString('hex');
  await writeSecretFile(tokenPath, token);
  return token;
}

/** Mint a new relay routing token so every previously paired browser is revoked. */
export async function rotatePairingToken(userDataPath: string): Promise<string> {
  return writePairingToken(join(userDataPath, PAIRING_TOKEN_FILE));
}

import { join } from 'node:path';

import {
  generateRelayE2EEServerIdentity,
  validateRelayE2EEServerIdentity,
  type RelayE2EEServerIdentity,
} from '../shared/remote-e2ee';
import { readSecretFile, writeSecretFile } from './secret-file';

const RELAY_E2EE_IDENTITY_FILE = 'relay-e2ee.json';

async function writeIdentity(path: string): Promise<RelayE2EEServerIdentity> {
  const identity = await generateRelayE2EEServerIdentity();
  await writeSecretFile(path, JSON.stringify(identity, null, 2));
  return identity;
}

export async function loadOrCreateRelayE2EEIdentity(
  userDataPath: string,
): Promise<RelayE2EEServerIdentity> {
  const path = join(userDataPath, RELAY_E2EE_IDENTITY_FILE);
  const text = await readSecretFile(path);
  if (text) {
    try {
      const identity = JSON.parse(text) as RelayE2EEServerIdentity;
      if (await validateRelayE2EEServerIdentity(identity)) return identity;
    } catch {
      // Replace corrupt or pre-release material instead of weakening the link.
    }
  }
  return writeIdentity(path);
}

export async function rotateRelayE2EEIdentity(
  userDataPath: string,
): Promise<RelayE2EEServerIdentity> {
  return writeIdentity(join(userDataPath, RELAY_E2EE_IDENTITY_FILE));
}

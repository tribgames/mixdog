// Whether this install has ever used remote access. A fresh install must not
// register on the relay (trust-on-first-use) until the user asks for it; an
// install that already holds a relay identity or the legacy client-trust file counts as
// activated so already-paired phones keep reconnecting at boot.
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { readSecretFile, writeSecretFile } from './secret-file';

const ACTIVATION_FILE = 'remote-activated.json';
const LEGACY_EVIDENCE_FILES = ['relay-device.json', 'remote-client-trust.json'];

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

export async function isRemoteActivated(userDataPath: string): Promise<boolean> {
  if ((await readSecretFile(join(userDataPath, ACTIVATION_FILE))) !== null) return true;
  for (const name of LEGACY_EVIDENCE_FILES) {
    if (await exists(join(userDataPath, name))) {
      await activateRemote(userDataPath);
      return true;
    }
  }
  return false;
}

export async function activateRemote(userDataPath: string): Promise<void> {
  await writeSecretFile(join(userDataPath, ACTIVATION_FILE), JSON.stringify({ activatedAt: Date.now() }));
}

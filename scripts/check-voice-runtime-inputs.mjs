// Run it on a Linux checkout: the hash covers the files as checked out there.
import { readFile } from 'node:fs/promises';

import {
  VOICE_RUNTIME_VERSION,
  assertVoiceRuntimeManifestIdentity,
  compareSemver,
} from './generate-voice-runtime-manifest.mjs';

const bundled = JSON.parse(
  await readFile(new URL('../src/runtime/channels/data/voice-runtime-manifest.json', import.meta.url), 'utf8')
);

if (compareSemver(VOICE_RUNTIME_VERSION, bundled.version) > 0) {
  console.log(`voice runtime ${VOICE_RUNTIME_VERSION} is not released yet; Deploy builds it`);
} else {
  await assertVoiceRuntimeManifestIdentity(bundled);
  console.log(`voice runtime ${bundled.version} build inputs match the published runtime`);
}

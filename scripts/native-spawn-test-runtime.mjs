import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _setNativeSpawnBinaryForTest } from '../src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(
  root,
  'native/mixdog-spawn/target/debug',
  process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn',
);

if (!existsSync(binary)) {
  throw new Error(`native spawn test binary missing: run npm run build:spawn:test (${binary})`);
}
_setNativeSpawnBinaryForTest(binary);

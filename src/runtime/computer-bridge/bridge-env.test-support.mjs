import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Creates a temp directory and points the env var `name` at it until `cleanup()`.
export async function makeTempEnvDir(name, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env[name];
  process.env[name] = directory;
  return {
    directory,
    async cleanup() {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function writeBridgeDiscovery(directory, fields) {
  return writeFile(join(directory, 'computer-bridge.json'), JSON.stringify({ version: 1, ...fields }));
}

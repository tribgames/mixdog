import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { powershellHostProgram } from './program';

// build pays the C# compile; every later worker loads the cached assembly.
export const HOST_ASSEMBLY_CACHE_DIRECTORY = 'host-cache';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createHostScriptPublisher(dataDirectory: () => string) {
  let scriptPath: string | null = null;
  let build = '';
  const scriptName = `computer-host-${process.pid}-${randomBytes(12).toString('hex')}.ps1`;

  /** A host that crashed or was killed never ran remove, so its script
   *  outlives it; one whose process is gone is safe to delete. */
  function removeOrphanedScripts(directory: string): void {
    let names: string[] = [];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^computer-host-(\d+)-[0-9a-f]+\.ps1$/.exec(name);
      if (!match || name === scriptName || processAlive(Number(match[1]))) continue;
      try {
        unlinkSync(join(directory, name));
      } catch {
        /* removed concurrently */
      }
    }
  }

  function ensure(): string {
    if (scriptPath) return scriptPath;
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    const program = powershellHostProgram();
    build = createHash('sha256').update(program).digest('hex').slice(0, 16);
    scriptPath = join(directory, scriptName);
    writeFileSync(scriptPath, program);
    removeOrphanedScripts(directory);
    try {
      const cacheDirectory = join(directory, HOST_ASSEMBLY_CACHE_DIRECTORY);
      mkdirSync(cacheDirectory, { recursive: true });
      const current = `mixdog-computer-host-${build}.dll`;
      for (const name of readdirSync(cacheDirectory)) {
        if (name === current) continue;
        try {
          unlinkSync(join(cacheDirectory, name));
        } catch {
          /* a live worker holds it */
        }
      }
    } catch {
      /* the cache is an optimization, never a requirement */
    }
    return scriptPath;
  }

  /** The published script is a temp artifact; it goes when the host does. */
  function remove(): void {
    if (scriptPath) {
      try {
        unlinkSync(scriptPath);
      } catch {
        /* already gone */
      }
    }
    scriptPath = null;
  }

  return { ensure, remove, path: () => scriptPath, build: () => build };
}

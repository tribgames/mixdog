// Shared bounded child-process runner behind the dependency probes and guided
// installs (git, gh, LibreOffice): a hard timeout, the daemon's child
// environment, and ENOENT flattened to code -1 so callers can tell a missing
// binary apart from a failing one.
import { execFile } from 'node:child_process';

import { childEnvironment } from './child-environment';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(file: string, args: string[], timeout = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout,
      windowsHide: true,
      env: childEnvironment(),
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        return;
      }
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === 'ENOENT') {
        resolve({ code: -1, stdout: '', stderr: 'ENOENT' });
        return;
      }
      resolve({
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || failure.message,
      });
    });
  });
}

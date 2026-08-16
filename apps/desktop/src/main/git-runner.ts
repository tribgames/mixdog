import { execFile, spawn } from "node:child_process";
import { childEnvironment, hookEnvironment } from "./child-environment";

/**
 * The environment every git child runs with. `GIT_INDEX_FILE` is decided here
 * and nowhere else: a command either writes the scratch index it was handed,
 * or the repository's own — an inherited value can never choose for us.
 */
function gitEnvironment(indexFile?: string, protectHook = false): NodeJS.ProcessEnv {
  const env = (protectHook ? hookEnvironment : childEnvironment)({
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  });
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  else delete env.GIT_INDEX_FILE;
  return env;
}

export function scrubGitCredentials(value: unknown): string {
  return String(value || '')
    .replace(/\b(https?|ssh):\/\/[^/\s@]+@/giu, '$1://[redacted]@')
    .replace(/([?&](?:access_token|api[_-]?key|auth|password|secret|signature|token)=)[^&\s'"]+/giu, '$1[redacted]');
}

export function publicGitRemoteUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return scrubGitCredentials(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return scrubGitCredentials(raw);
  }
}

export function run(
  cwd: string,
  args: string[],
  indexFile?: string,
  protectHook = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16_000_000,
      env: gitEnvironment(indexFile, protectHook),
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(scrubGitCredentials(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

/**
 * The same child, but with git's EXIT CODE kept. Git spends exit codes on
 * meaning — `config --get` answers 1 for "not set" and something else for a
 * config it could not read — and a caller that only sees "it failed" has to
 * guess between the two. `code: -1` is a process that never ran.
 */
export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWithStatus(cwd: string, args: string[]): Promise<GitOutcome> {
  return new Promise((settle) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16_000_000,
      env: gitEnvironment(),
    }, (error, stdout, stderr) => {
      const raw = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
      settle({
        code: error ? (typeof raw === 'number' ? raw : -1) : 0,
        stdout: String(stdout),
        stderr: scrubGitCredentials(stderr || error?.message || '').trim(),
      });
    });
  });
}

export function runWithInput(
  cwd: string,
  args: string[],
  input: string,
  indexFile?: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: gitEnvironment(indexFile),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-64_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.stdin.on('error', () => {
      // A failed git process can close stdin before the buffered patch drains.
      // The close handler below reports the authoritative stderr.
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(scrubGitCredentials(stderr).trim() || `git exited with code ${code}.`));
        return;
      }
      resolvePromise(stdout);
    });
    child.stdin.end(input);
  });
}

export function streamNulRecords(
  cwd: string,
  args: string[],
  onRecord: (record: string) => void,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let separator = pending.indexOf('\0');
      while (separator >= 0) {
        onRecord(pending.slice(0, separator));
        pending = pending.slice(separator + 1);
        separator = pending.indexOf('\0');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(scrubGitCredentials(stderr).trim() || `git exited with code ${code}.`));
        return;
      }
      if (pending) onRecord(pending);
      resolvePromise();
    });
  });
}

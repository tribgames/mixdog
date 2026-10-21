import { execFile, spawn } from 'node:child_process';
import { killChildTree } from '../../../../src/runtime/shared/run-child.mjs';
import { childEnvironment, hookEnvironment } from './child-environment';

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

/** Runs one child to completion off this thread: the daemon's shared
 *  process-runner worker (src/runtime/shared/process-runner.mjs). */
export type GitProcessRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv | null; timeoutMs?: number; maxBytes?: number }
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Set by the daemon's desktop service: process creation is a synchronous
// native call (seconds long under load), and every git status, review and
// history read spawned git on the daemon's event loop. Unset (the Electron
// main process, tests), children are spawned on this thread as before.
let offThreadRunner: GitProcessRunner | null = null;

export function setGitProcessRunner(runner: GitProcessRunner | null): void {
  offThreadRunner = runner;
}

// execFile's maxBuffer bounded each stream at 16 MB; the off-thread runner
// bounds both together. A NUL-record listing streamed unbounded before; it
// is buffered off-thread now, so it gets a generous bound instead.
const RUN_MAX_BYTES = 32_000_000;
const STREAM_MAX_BYTES = 512 * 1024 * 1024;
const TAIL_CHARS = 64_000;

/** Bound on the reads the UI polls (status, review, history). Such a read is
 *  shared by every caller that asks meanwhile, so one git child that stopped
 *  answering held them all — for 89 minutes once — and each piled-up call
 *  outlived the daemon call deadline. The child is killed instead. Writes
 *  stay unbounded: git's own work bounds a commit or a push. */
export const GIT_READ_TIMEOUT_MS = 60_000;

/** Code of a git deadline. Not ETIMEDOUT: the session transport reads that as a
 *  dead daemon connection and re-attaches, dropping every subscription. */
export const GIT_TIMEOUT_CODE = 'EGITTIMEOUT';

function runOffThread(
  runner: GitProcessRunner,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  {
    input = '',
    maxBytes = RUN_MAX_BYTES,
    timeoutMs = 0,
  }: { input?: string; maxBytes?: number; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runner('git', args, { cwd, env, input, timeoutMs, maxBytes }).catch((error: NodeJS.ErrnoException) => {
    // The runner reports its deadline as ETIMEDOUT; re-code it as a git timeout.
    if (error?.code === 'ETIMEDOUT') error.code = GIT_TIMEOUT_CODE;
    throw error;
  });
}

function gitFailure(args: string[], stderr: string): Error {
  return new Error(scrubGitCredentials(stderr || `Command failed: git ${args.join(' ')}`).trim());
}

export function run(cwd: string, args: string[], indexFile?: string, protectHook = false): Promise<string> {
  return runGit(cwd, args, { indexFile, protectHook });
}

/** A git read cut off at its deadline: its answer is unknown, never "nothing". */
export function isGitTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === GIT_TIMEOUT_CODE;
}

/** A read-only git command, killed past {@link GIT_READ_TIMEOUT_MS}. */
export function runRead(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, args, { timeoutMs: GIT_READ_TIMEOUT_MS });
}

function runGit(
  cwd: string,
  args: string[],
  { indexFile, protectHook = false, timeoutMs = 0 }: { indexFile?: string; protectHook?: boolean; timeoutMs?: number }
): Promise<string> {
  if (offThreadRunner) {
    return runOffThread(offThreadRunner, cwd, args, gitEnvironment(indexFile, protectHook), { timeoutMs }).then(
      ({ code, stdout, stderr }) => {
        if (code !== 0) throw gitFailure(args, stderr);
        return stdout;
      },
      (error: NodeJS.ErrnoException) => {
        throw Object.assign(new Error(scrubGitCredentials(error?.message || error).trim()), { code: error?.code });
      }
    );
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const child = execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16_000_000,
        env: gitEnvironment(indexFile, protectHook),
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (error) reject(new Error(scrubGitCredentials(stderr || error.message).trim()));
        else resolve(String(stdout));
      }
    );
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killChildTree(child);
        reject(
          Object.assign(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`), { code: GIT_TIMEOUT_CODE })
        );
      }, timeoutMs);
    }
  });
}

/**
 * The same child, but with git's EXIT CODE kept. Git spends exit codes on
 * meaning — `config --get` answers 1 for "not set" and something else for a
 * config it could not read — and a caller that only sees "it failed" has to
 * guess between the two. `code: -1` is a process that never ran.
 */
interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWithStatus(cwd: string, args: string[]): Promise<GitOutcome> {
  if (offThreadRunner) {
    return runOffThread(offThreadRunner, cwd, args, gitEnvironment()).then(
      ({ code, stdout, stderr }) => ({ code, stdout, stderr: scrubGitCredentials(stderr).trim() }),
      (error: Error) => ({ code: -1, stdout: '', stderr: scrubGitCredentials(error?.message || error).trim() })
    );
  }
  return new Promise((settle) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16_000_000,
        env: gitEnvironment(),
      },
      (error, stdout, stderr) => {
        const raw = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
        let code = 0;
        if (error) code = typeof raw === 'number' ? raw : -1;
        settle({
          code,
          stdout: String(stdout),
          stderr: scrubGitCredentials(stderr || error?.message || '').trim(),
        });
      }
    );
  });
}

export function runWithInput(cwd: string, args: string[], input: string, indexFile?: string): Promise<string> {
  if (offThreadRunner) {
    return runOffThread(offThreadRunner, cwd, args, gitEnvironment(indexFile), {
      input,
      maxBytes: STREAM_MAX_BYTES,
    }).then(({ code, stdout, stderr }) => {
      if (code !== 0) {
        throw new Error(scrubGitCredentials(stderr.slice(-TAIL_CHARS)).trim() || `git exited with code ${code}.`);
      }
      return stdout.slice(-TAIL_CHARS);
    });
  }
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

/** `timeoutMs` (0: none) kills a child that runs longer, as {@link runRead} does. */
export function streamNulRecords(
  cwd: string,
  args: string[],
  onRecord: (record: string) => void,
  { timeoutMs = 0 }: { timeoutMs?: number } = {}
): Promise<void> {
  if (offThreadRunner) {
    // Delivered once the child has finished (the worker returns its whole
    // output), in the same order and with the same trailing-record rule.
    return runOffThread(offThreadRunner, cwd, args, gitEnvironment(), { maxBytes: STREAM_MAX_BYTES, timeoutMs }).then(
      ({ code, stdout, stderr }) => {
        if (code !== 0) {
          throw new Error(scrubGitCredentials(stderr.slice(-TAIL_CHARS)).trim() || `git exited with code ${code}.`);
        }
        const records = stdout.split('\0');
        const last = records.pop();
        for (const record of records) onRecord(record);
        if (last) onRecord(last);
      }
    );
  }
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
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            killChildTree(child);
            reject(
              Object.assign(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`), {
                code: GIT_TIMEOUT_CODE,
              })
            );
          }, timeoutMs)
        : null;
    child.once('close', () => {
      if (timer) clearTimeout(timer);
    });
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

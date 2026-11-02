import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { startGit } from '../../../../src/runtime/shared/git-launch.mjs';
import { killChildTree } from '../../../../src/runtime/shared/run-child.mjs';
import { childEnvironment, hookEnvironment } from './child-environment';

// Every child starts through startGit (git-launch.mjs): Git for Windows' real
// binary rather than its launcher when the environment's PATH names one, and
// the launcher's environment on top of the one built here.

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

/** A spawn error (ENOENT, EACCES, a buffer limit) — never an exit code — kept on
 *  the scrubbed error, as the off-thread runner keeps it. */
function spawnFailure(message: string, error: { code?: unknown }): Error {
  const code = error?.code;
  return Object.assign(new Error(message), typeof code === 'string' ? { code } : {});
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
const GIT_TIMEOUT_CODE = 'EGITTIMEOUT';

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
  return startGit(env, (command, childEnv) =>
    runner(command, args, { cwd, env: childEnv, input, timeoutMs, maxBytes })
  ).catch((error: NodeJS.ErrnoException) => {
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
  return startGit(
    gitEnvironment(indexFile, protectHook),
    (command, env) =>
      new Promise<string>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const child = execFile(
          command,
          args,
          {
            cwd,
            windowsHide: true,
            maxBuffer: 16_000_000,
            env,
          },
          (error, stdout, stderr) => {
            if (timer) clearTimeout(timer);
            if (error) reject(spawnFailure(scrubGitCredentials(stderr || error.message).trim(), error));
            else resolve(String(stdout));
          }
        );
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            killChildTree(child);
            reject(
              Object.assign(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`), {
                code: GIT_TIMEOUT_CODE,
              })
            );
          }, timeoutMs);
        }
      })
  );
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
  // Settles [outcome, the spawn error behind a -1 outcome].
  return startGit(
    gitEnvironment(),
    (command, env) =>
      new Promise<[GitOutcome, { code?: unknown } | null]>((settle) => {
        execFile(
          command,
          args,
          {
            cwd,
            windowsHide: true,
            maxBuffer: 16_000_000,
            env,
          },
          (error, stdout, stderr) => {
            const raw = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
            let code = 0;
            if (error) code = typeof raw === 'number' ? raw : -1;
            settle([
              {
                code,
                stdout: String(stdout),
                stderr: scrubGitCredentials(stderr || error?.message || '').trim(),
              },
              code === -1 ? error : null,
            ]);
          }
        );
      }),
    ([, error]) => error
  ).then(([outcome]) => outcome);
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
  return startGit(gitEnvironment(indexFile), (command, env) => spawnWithInput(command, env, cwd, args, input));
}

function spawnWithInput(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  input: string
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env,
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

/** NUL-terminated records in `text` from `from`, and whether an unterminated one trails them. */
function tallyRecords(text: string, from: number): { terminated: number; open: boolean } {
  let terminated = 0;
  let end = from;
  for (let at = text.indexOf('\0', from); at >= 0; at = text.indexOf('\0', at + 1)) {
    terminated += 1;
    end = at + 1;
  }
  return { terminated, open: end < text.length };
}

/** A record callback returns `false` to refuse its record and every later one. */
type NulRecordHandler = (record: string) => void | boolean;

/** Hands `text`'s records to `onRecord`; the count of those refused (never sliced out). */
function deliverNulRecords(text: string, onRecord: NulRecordHandler): number {
  let start = 0;
  for (let end = text.indexOf('\0'); end >= 0; end = text.indexOf('\0', start)) {
    if (onRecord(text.slice(start, end)) === false) {
      const { terminated, open } = tallyRecords(text, start);
      return terminated + (open ? 1 : 0);
    }
    start = end + 1;
  }
  return start < text.length && onRecord(text.slice(start)) === false ? 1 : 0;
}

/**
 * `timeoutMs` (0: none) kills a child that runs longer, as {@link runRead} does.
 * `maxBytes` fails the read (code EMAXBUFFER) once the output outgrows it.
 * Resolves to how many records `onRecord` refused (it returned `false`): those
 * are counted, not delivered, so a huge listing costs one pass, not one object
 * per record.
 */
export function streamNulRecords(
  cwd: string,
  args: string[],
  onRecord: NulRecordHandler,
  { timeoutMs = 0, maxBytes = STREAM_MAX_BYTES }: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<number> {
  if (offThreadRunner) {
    // Delivered once the child has finished (the worker returns its whole
    // output), in the same order and with the same trailing-record rule.
    return runOffThread(offThreadRunner, cwd, args, gitEnvironment(), { maxBytes, timeoutMs }).then(
      ({ code, stdout, stderr }) => {
        if (code !== 0) {
          throw new Error(scrubGitCredentials(stderr.slice(-TAIL_CHARS)).trim() || `git exited with code ${code}.`);
        }
        return deliverNulRecords(stdout, onRecord);
      }
    );
  }
  return startGit(gitEnvironment(), (command, env) =>
    spawnNulRecords(command, env, cwd, args, onRecord, timeoutMs, maxBytes)
  );
}

function spawnNulRecords(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  onRecord: NulRecordHandler,
  timeoutMs: number,
  maxBytes: number
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // stdout stays raw so the bound counts bytes; the decoder carries a
    // multibyte character split across chunks into the next write.
    const decoder = new StringDecoder('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    let stderr = '';
    let settled = false;
    let received = 0;
    // Once a record is refused the rest is only counted, chunk by chunk.
    let refusing = false;
    let refused = 0;
    let refusedOpen = false;
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
    child.stdout.on('data', (data: Buffer) => {
      if (settled) return;
      received += data.length;
      if (received > maxBytes) {
        settled = true;
        killChildTree(child);
        reject(
          Object.assign(new Error(`git ${args.join(' ')} exceeded ${maxBytes} output bytes`), { code: 'EMAXBUFFER' })
        );
        return;
      }
      const chunk = decoder.write(data);
      if (!chunk) return;
      if (refusing) {
        const { terminated, open } = tallyRecords(chunk, 0);
        refused += terminated;
        refusedOpen = terminated > 0 ? open : true;
        return;
      }
      pending += chunk;
      let separator = pending.indexOf('\0');
      while (separator >= 0) {
        if (onRecord(pending.slice(0, separator)) === false) {
          const { terminated, open } = tallyRecords(pending, 0);
          refusing = true;
          refused = terminated;
          refusedOpen = open;
          pending = '';
          return;
        }
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
      if (refusing) refused += refusedOpen ? 1 : 0;
      else if ((pending += decoder.end()) && onRecord(pending) === false) refused = 1;
      resolvePromise(refused);
    });
  });
}

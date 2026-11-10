// Starting a process and ending the WHOLE tree it grew, on Windows and on POSIX. A deadline that ends only the direct
// child leaves what it started (cargo's compilers and test binaries, an exec's tools) running.
//
// The program runs under `treerun` (scripts/rust-core/tree-helper, a small Rust program), which owns the tree and ends it
// when the program exits and when this Node process dies, however it dies. Ownership is by handle, never by number: a
// Windows job object, or on POSIX the process group of a child the helper has not reaped yet. What escapes a group (a
// descendant that made its own session) is never looked up by number: on Linux the helper is a child subreaper, so it
// becomes the helper's own child and is ended through that; macOS cannot adopt it, and the result says so
// (`escapes: 'undetectable'`). See process-probe.mjs for how a run proves it left nothing inside its own directory.
// Windows PowerShell as the owner cost 275 ms per spawn (a C# type compiled each time); the helper costs the process
// start. The helper must be built before this module
// spawns anything: `cargo build --release --manifest-path scripts/rust-core/tree-helper/Cargo.toml` (the rust-core job
// does it in its own step; MIXDOG_TREE_HELPER names a binary built elsewhere, e.g. under another CARGO_TARGET_DIR).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS = process.platform === 'win32';
// Ending a process and waiting for its exit are processes' work too: they have a deadline.
const KILL_DEADLINE_MS = 30_000;
const HELPER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tree-helper');
const BUILD_COMMAND = 'cargo build --release --manifest-path scripts/rust-core/tree-helper/Cargo.toml';

/** The built `treerun` binary: a missing one is an error that says how to build it, never a fallback to an unowned spawn. */
export function helperPath() {
  const path = process.env.MIXDOG_TREE_HELPER || join(HELPER_DIR, 'target', 'release', WINDOWS ? 'treerun.exe' : 'treerun');
  if (!existsSync(path)) throw new Error(`the process-tree helper ${path} is not built; build it with: ${BUILD_COMMAND}`);
  return path;
}

/**
 * What the helper reported besides the exit code (`launch`, `signal`), or null when it wrote nothing. The helper writes the
 * file last and ends it with `"complete":true`: a file without that record is an error, never a success, and so is a
 * record of another run (`run` is the id this invocation passed: a record left at the path by an earlier run is not ours).
 */
const readOutcome = (file, run) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(`the tree helper's result ${file} is incomplete: ${text.slice(0, 200)}`);
  }
  if (record.complete !== true) throw new Error(`the tree helper's result ${file} has no completion record: ${text.slice(0, 200)}`);
  if (record.run !== run) throw new Error(`the tree helper's result ${file} is the record of run ${JSON.stringify(record.run)}, not of this run ${run}`);
  return record;
};

/**
 * `spawn`, but the child's whole tree is owned by a helper that ends it: the returned child is the helper, with the
 * program's stdio and exit code (its 'exit' code is the program's, unchanged). A program that cannot start emits 'error'
 * with the code the helper reports (ENOENT when it is not found), as `spawn` does. `child.treeOutcome()` is what the helper
 * reported besides the exit code (`launch`, `signal`), null when it reported nothing, and throws when the report is
 * incomplete; after 'close' it answers what was read before the file was removed. Index 3 of the stdio is the helper's
 * channel to this process (POSIX), so a caller passes at most three entries.
 */
export function spawnTree(program, args, options = {}) {
  // `signal` is not forwarded to `spawn` (that would end only the helper): an abort ends the tree through the helper.
  const { shell, env, stdio = 'pipe', signal, ...rest } = options;
  const resultFile = join(tmpdir(), `treerun-${randomUUID()}.json`);
  const run = randomUUID();
  const streams = typeof stdio === 'string' ? [stdio, stdio, stdio] : [...stdio];
  if (streams.length > 3) throw new Error('spawnTree: stdio index 3 is the tree helper\'s channel; pass at most three entries');
  while (streams.length < 3) streams.push('ignore');
  // POSIX: index 3 is the parent's end of a socket pair; its EOF is how the helper learns this process died.
  const full = WINDOWS ? streams : [...streams, 'pipe'];
  const tail = shell ? ['shell', [program, ...args].join(' ')] : ['args', program, ...args];
  const child = spawn(helperPath(), [resultFile, run, String(process.pid), ...tail], {
    ...rest,
    env,
    stdio: full,
    // Detached on both: Node ties a non-detached child to its own lifetime on Windows (a job it makes itself) and on POSIX
    // by group; the helper's own watch on this process is what ends the tree, and it must be what carries it.
    detached: true,
    windowsHide: true,
  });
  child.stdio[3]?.on('error', () => {});
  if (signal) {
    const abort = () => endTree(child).catch((error) => child.emit('error', Object.assign(error, { code: 'ETREEHELPER' })));
    if (signal.aborted) abort();
    else {
      signal.addEventListener('abort', abort, { once: true });
      child.once('close', () => signal.removeEventListener('abort', abort));
    }
  }
  // Read before removed: this listener is registered first, so it runs before any caller's 'close'.
  let settled;
  child.once('close', () => {
    try {
      settled = { value: readOutcome(resultFile, run) };
    } catch (error) {
      settled = { error };
    }
    rmSync(resultFile, { force: true });
    // The helper writes the record beside the result and renames it; one that died between the two leaves this.
    rmSync(`${resultFile}.tmp`, { force: true });
  });
  child.treeOutcome = () => {
    if (!settled) return readOutcome(resultFile, run);
    if (settled.error) throw settled.error;
    return settled.value;
  };
  child.once('exit', () => {
    let outcome;
    try {
      outcome = child.treeOutcome();
    } catch (error) {
      child.emit('error', Object.assign(error, { code: 'ETREEHELPER' }));
      return;
    }
    if (outcome?.launch) {
      const message = outcome.launch === 'ENOENT' ? `spawn ${program} ENOENT` : `spawn ${program} ${outcome.launch}: ${outcome.message}`;
      child.emit('error', Object.assign(new Error(message), { code: outcome.launch, syscall: `spawn ${program}`, path: program }));
    }
  });
  return child;
}

const signalName = (number) => Object.entries(constants.signals).find(([, n]) => n === number)?.[0] ?? String(number);

const gone = (child) => child.exitCode !== null || child.signalCode !== null;

// The byte that asks a POSIX helper to end its tree (any byte does; end-of-file without one is this process's death).
const ASK = 'e';

/**
 * Why the end of a gone helper's tree is not established, or null when it is: the helper exited by itself (no signal)
 * with this run's complete record and no failure in it. A helper that died of a signal, or left no record, did not finish
 * ending its tree (POSIX: nothing else ends it), whatever its exit code says.
 */
function unestablished(child) {
  if (child.signalCode !== null) return `the tree helper of pid ${child.pid} died of ${child.signalCode}, so the end of its tree cannot be established`;
  let outcome;
  try {
    outcome = child.treeOutcome();
  } catch (error) {
    return `${error.message}, so the end of its tree cannot be established`;
  }
  if (!outcome) return `the tree helper of pid ${child.pid} exited (code ${child.exitCode}) without its completion record, so the end of its tree cannot be established`;
  if (outcome.failure) return `the tree helper of pid ${child.pid} could not show its tree ended: ${outcome.failure}`;
  return null;
}

/**
 * Ends `child`'s tree, whether or not the program is still running, and answers `{ killed }`: the helper's pid when it
 * had to be ended, empty when it had already gone. Windows: the helper is killed and its job ends every member (the
 * job's kill-on-close needs nothing of the helper, see tree-helper/src/main.rs). POSIX: the helper is asked (a byte on
 * descriptor 3 makes it end the program's group and whatever left it, and publish its record), waited for under the
 * deadline, and then held to `unestablished`, whether it was asked here or had gone before. Rejects, saying that the end
 * of the tree cannot be established, when the helper does not exit in time (it is then killed, by its handle, never by a
 * looked-up number: its tree may still run) and when a POSIX helper did not end by its own exit with its record (it died of
 * a signal, at any moment, or left none or a failure).
 * @param {import('node:child_process').ChildProcess} child started by `spawnTree`
 */
export async function endTree(child, { deadlineMs = KILL_DEADLINE_MS } = {}) {
  if (!child.pid) return { killed: [] };
  const killed = gone(child) ? [] : [child.pid];
  if (killed.length) {
    let timer;
    const exited = new Promise((resolveExit, reject) => {
      child.once('exit', resolveExit);
      timer = setTimeout(() => reject(new Error(`the tree helper of pid ${child.pid} did not exit within ${deadlineMs}ms after it was told to end the tree`)), deadlineMs);
    }).finally(() => clearTimeout(timer));
    if (WINDOWS) {
      if (!child.kill()) throw new Error(`could not kill the tree helper of pid ${child.pid}`);
    } else {
      child.stdio[3].end(ASK);
    }
    try {
      await exited;
    } catch (error) {
      child.kill('SIGKILL');
      throw new Error(`${error.message}; the helper was killed and the end of its tree cannot be established`);
    }
  }
  if (!WINDOWS) {
    const why = unestablished(child);
    if (why) throw new Error(why);
  }
  return { killed };
}

/**
 * One command to its exit under a deadline: answers `{ status, signal, stdout, stderr, stdoutBytes }`. At the
 * deadline, or when the child cannot start, the tree is ended and the run rejects with `label` in the message; a failed
 * kill is appended as its own error. A tree that could not be ended after the command finished rejects with the
 * command's own status and stderr beside the cleanup failure (and on `error.result`). `inherit` passes the child's stdio
 * through instead of capturing it; onSpawn(child) is called with the started child after every handler is installed (a
 * callback that throws ends the tree and rejects). An aborted `signal` ends the tree and rejects with code ABORT_ERR. The
 * result also carries `escapes` ('undetectable' on macOS: a descendant that left the process group cannot be found there)
 * and `escapedEnded` (pids of descendants outside the group that the helper adopted and ended); a helper that could not show
 * the tree ended rejects.
 */
export function runTree(program, args, { label, cwd, env, deadlineMs, inherit = false, shell = false, onSpawn, signal: abortSignal }) {
  return new Promise((resolveRun, reject) => {
    if (abortSignal?.aborted) return reject(Object.assign(new Error(`${label} was aborted before it started`), { code: 'ABORT_ERR' }));
    const child = spawnTree(program, args, { cwd, env, shell, windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    const stderrText = () => Buffer.concat(err).toString('utf8');
    // Once the tree is being ended, the child's own close is the kill working, not an answer; the first way out wins.
    let ending = false;
    // `code` is the spawn error's own (ENOENT for a program that is not there), so a caller can tell that from a deadline.
    const fail = async (message, code) => {
      if (ending) return;
      ending = true;
      clearTimeout(deadline);
      abortSignal?.removeEventListener('abort', onAbort);
      try {
        const { killed } = await endTree(child);
        reject(Object.assign(new Error(`${message} (ended: ${killed.length ? killed.join(', ') : 'nothing was left running'})`), { code }));
      } catch (error) {
        reject(Object.assign(new Error(`${message}; ${error.message}`), { code }));
      }
    };
    const deadline = setTimeout(() => fail(`${label} did not finish within ${deadlineMs}ms and was ended\n${stderrText().slice(-600)}`), deadlineMs);
    const onAbort = () => fail(`${label} was aborted and its tree ended`, 'ABORT_ERR');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => fail(`${label} could not run: ${error.message}`, error.code));
    // The helper ends whatever the command left behind as it exits, success included: a run owns its whole tree.
    child.once('close', async (code, signal) => {
      if (ending) return;
      ending = true;
      clearTimeout(deadline);
      abortSignal?.removeEventListener('abort', onAbort);
      // The helper is gone (it ends the tree as it exits): only one that exited by itself with this run's complete record
      // and no failure has shown its tree ended. Anything else (no record, an incomplete one, a death by a signal) is never
      // a success. On Windows a helper that exits by itself writes its record too.
      const why = unestablished(child);
      let outcome = null;
      try {
        outcome = child.treeOutcome();
      } catch {}
      const stdoutBytes = Buffer.concat(out);
      const result = { status: outcome?.signal ? null : code, signal: outcome?.signal ? signalName(outcome.signal) : signal, escapes: outcome?.escapes, escapedEnded: outcome?.escaped_ended ?? [], stdout: stdoutBytes.toString('utf8'), stderr: stderrText(), stdoutBytes };
      if (why) {
        reject(Object.assign(new Error(`${label} finished (status ${result.status}, signal ${result.signal}) but its process tree was not shown ended: ${why}\nits stderr: ${result.stderr.slice(-600)}`), { result }));
        return;
      }
      resolveRun(result);
    });
    // Last, once every handler is in place: a callback that throws leaves a tree that is still managed, and is ended.
    try {
      onSpawn?.(child);
    } catch (error) {
      fail(`${label}: the onSpawn callback threw: ${error.message}`);
    }
  });
}
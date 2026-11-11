// Starts a mixdogd a replay talks to, and ends it with everything it started. The core runs in a Windows job of its own (lib/process-job.mjs:
// no breakaway, so the PostgreSQL `pg_ctl start` leaves outside the core's process tree, an `initdb`, the core's process helper and a
// terminal's shell are all in it). Its end is asked for as the app's own quit asks (`ctl stop --when-idle`), whose stop sequence stops the
// PostgreSQL it started (the memory stop step, as Node's shutdown does, daemon.mjs:375-386); what is still in the job then is given the
// rest of the time to end by itself and is then ended with the job. Only the job's processes are ever ended: never a pid, a pid file's
// pid, or a process found by its command line.
import { openJob, spawnInJob } from './process-job.mjs';

/** How long the job's guard may take to start and to assign a process. The teardown's one deadline keeps two of them for ending the job
 *  (its wait for the ended processes and its answer) and two for closing it (the guard's exit and, if it does not, its forced end). */
const ANSWER_MS = 5_000;
const END_SHARE_MS = 2 * ANSWER_MS;
const CLOSE_SHARE_MS = 2 * ANSWER_MS;

/** Starts `command args` in a job of its own; `child` is the job's gate, whose exit and stderr are the command's. */
export async function spawnCore(command, args, { cwd, env }) {
  const job = await openJob(`${command} ${args[0]}`, { answerMs: ANSWER_MS });
  try {
    const child = await spawnInJob(job, command, args, { cwd, env });
    // Nothing reads the core's stdout; it is drained so that a write to it never blocks.
    child.stdout.resume();
    return { child, job };
  } catch (error) {
    await job.close().catch(() => undefined);
    throw error;
  }
}

const gone = (child) => child.exitCode !== null || child.signalCode !== null;

/** `promise`, or a failure naming `what` once the clock passes `until`. */
function before(until, promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not by the teardown's deadline`)), Math.max(0, until - Date.now()));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Ends the core `spawnCore` started (`child`, `job`) within `ms` in all. The stop request (`stop`: the command and its arguments, by
 *  default `<exe> ctl stop`) runs in the core's job, so a request that hangs ends with it. Resolves once nothing of the job runs; rejects
 *  when anything had to be ended, naming what. A core that is gone already stops nothing more: what it left is ended at once. */
export async function endCore({ exe, child, job, env, ms = 60_000, stop = [exe, ['ctl', 'stop', '--when-idle', '--reason', 'userStop']] }) {
  // The one deadline, taken once: each step ends by its own part of it.
  const until = Date.now() + ms;
  const endBy = until - CLOSE_SHARE_MS;
  const stopBy = endBy - END_SHARE_MS;
  const forced = [];
  let failure = null;
  try {
    const ran = !gone(child);
    if (ran) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        const request = await before(stopBy, spawnInJob(job, stop[0], stop[1], { env }), 'the stop request to start');
        let said = '';
        request.stdout.on('data', (chunk) => (said += chunk));
        request.stderr.on('data', (chunk) => (said += chunk));
        const asked = new Promise((resolve, reject) => request.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the stop request exited ${code}: ${said.trim()}`)))));
        await before(stopBy, asked.then(() => exited), `the core (pid ${child.pid}) to stop when asked`);
      } catch (error) {
        forced.push(error.message);
      }
    }
    const left = await job.end(ran && !forced.length ? Math.max(0, stopBy - Date.now()) : 0, endBy);
    if (left > 0) forced.push(`${left} process(es) of its job ended with the job`);
  } catch (error) {
    failure = error;
  }
  await job.close(until).catch((error) => (failure ??= error));
  if (failure) throw failure;
  if (forced.length) throw new Error(`the core's stop needed force: ${forced.join('; ')}`);
}

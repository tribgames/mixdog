// The Grok refresh lease between two real processes on one credential file: what Node b6f10295a does when two of its
// processes want a refresh at once, when the holder of the lease is killed while it holds it, when the lease file was
// left by a process that no longer exists, and when it names no owner and is younger or older than the stale age.
// Records Node with two Node processes (`node_child.mjs`, each running Node's own `grok-oauth.mjs` and
// `grok-oauth-tokens.mjs` under `file-lock.mjs`), and replays the same cases with core processes (the test binary
// re-run as `--core-test`, `refresh_lease/processes.rs`) or with one of each, for the core's test to compare whole.
//
// This script is the coordinator, and runs no product code itself. Every process keeps a virtual clock and runs only
// when the coordinator steps it; after each step it reports, once nothing more can run without the clock, its earliest
// timer and what happened. The coordinator keeps one time for both: the next step is the earliest of the callers still
// to start and the two processes' timers (at one instant: a caller first, then process A, then B), so every step is the
// barrier the next waits on ("A holds the lease": its token request has reached the endpoint; "B is waiting": B reported
// a lease wait; "A's token request answered": the reply was handed to A). The token endpoint is the case's script and
// counts every request; a case can leave a process's token request unanswered and kill that process at a time of the
// clock (by the pid this script started; only once its exit was seen does anything step again). Each wait for a process
// has a deadline and a message.
//
// Observed per case: each token request (its time, the process, the url and the form body), each lease or backoff wait
// as it fires (its time, the process, the delay), each kill, each caller's result (the access token, or the error's
// message, status, code and `reauthRequired`), and at the end the credential file's text and the names in its
// directory.
// Usage:
//   node processes.mjs --tree <b6f10295a export>                       records `native/core/fixtures/grok-refresh-lease-processes`
//   node processes.mjs --replay --kinds core,core --core-exe <exe> --core-test <name> --out <file> [--tree <export>] [--only <case>]
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..', '..', '..', '..');
const { commitStage, exactProductIdentity, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } = await import(
  pathToFileURL(join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs')).href
);

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const finalDir = join(repo, 'native/core/fixtures/grok-refresh-lease-processes');
const recorder = relative(repo, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const nodeChild = join(here, 'node_child.mjs');
const args = parseArgs();
const replay = args.has('replay');
const kinds = (args.get('kinds') ?? 'node,node').split(',');
const only = args.get('only') ?? null;
const tree = kinds.includes('node') ? resolveTree(args) : null;
const identity = tree ? exactProductIdentity(tree, COMMIT) : null;
const DEADLINE_MS = 60_000;

const T0 = 1_800_000_000_000;
const ENDPOINT = 'https://auth.x.ai/oauth2/token';
const ok = (access, refresh, afterMs = 1, expiresIn = 3600) => ({
  afterMs,
  status: 200,
  body: JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }),
});
const stored = (access, refresh, expiresAt) => JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: expiresAt, token_endpoint: ENDPOINT });
const both = [
  { at: 0, proc: 'A', force: false },
  { at: 0, proc: 'B', force: false },
];

function cases() {
  const list = [
    { name: 'both-want-a-refresh', file: stored('a0', 'r0', T0 + 1000), lock: null, hold: null, kills: [], replies: [ok('a1', 'r1', 1000)], callers: both },
    // A's token request is left unanswered; A is killed at 500, while B waits on the lease A holds.
    { name: 'the-holder-is-killed-while-holding', file: stored('a0', 'r0', T0 + 1000), lock: null, hold: 'A', kills: [{ at: 500, proc: 'A' }], replies: [ok('a1', 'r1', 1000)], callers: both },
    { name: 'a-lease-left-by-a-process-that-no-longer-exists', file: stored('a0', 'r0', T0 + 1000), lock: { kind: 'exited' }, hold: null, kills: [], replies: [ok('a1', 'r1', 1000)], callers: both },
    { name: 'an-ownerless-lease-younger-than-the-stale-age', file: stored('a0', 'r0', T0 + 1000), lock: { kind: 'ownerless', ageMs: 120_000 - 1 }, hold: null, kills: [], replies: [ok('a1', 'r1', 1000)], callers: both },
    { name: 'an-ownerless-lease-as-old-as-the-stale-age', file: stored('a0', 'r0', T0 + 1000), lock: { kind: 'ownerless', ageMs: 120_000 }, hold: null, kills: [], replies: [ok('a1', 'r1', 1000)], callers: both },
  ];
  return only ? list.filter((c) => c.name === only) : list;
}

/** Resolves once `child` exited, failing after the deadline with `what`. */
function exited(child, what) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no exit within ${DEADLINE_MS} ms`)), DEADLINE_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The pid of a process that has exited: started and waited for here. */
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
  await exited(child, 'the process whose pid names the left lease');
  return child.pid;
}

/** One process of a case, of `kind` (`node` or `core`), answering one line per command. */
class Proc {
  constructor(kind, label, caseName) {
    this.label = `${caseName}: process ${label} (${kind})`;
    this.child =
      kind === 'node'
        ? spawn(process.execPath, [nodeChild, '--tree', tree], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        : spawn(args.get('core-exe'), ['--exact', args.get('core-test'), '--nocapture', '--test-threads', '1'], {
            env: { ...process.env, MIXDOG_LEASE_CHILD: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
    // No child has a console of its own (`windowsHide`, every stream piped): its diagnostics go to this script's.
    this.child.stderr.pipe(process.stderr, { end: false });
    this.lines = [];
    this.taker = null;
    this.gone = false;
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      // A core process's line can follow the test harness's `test <name> ... ` on the same line.
      const at = line.indexOf('@lease ');
      if (at < 0) return;
      const message = JSON.parse(line.slice(at + '@lease '.length));
      if (this.taker) {
        const take = this.taker;
        this.taker = null;
        take(message);
      } else this.lines.push(message);
    });
    this.child.once('exit', (code, signal) => {
      this.gone = true;
      if (this.taker) this.taker(new Error(`${this.label} exited (${code ?? signal}) before it answered`));
    });
  }

  /** The next message, within the deadline. */
  next(what) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.gone) return Promise.reject(new Error(`${this.label} exited before it answered ${what}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: no answer to ${what} within ${DEADLINE_MS} ms`)), DEADLINE_MS);
      this.taker = (message) => {
        clearTimeout(timer);
        if (message instanceof Error) reject(message);
        else resolve(message);
      };
    });
  }

  async send(command) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    if (command.cmd === 'exit') return null;
    const message = await this.next(command.cmd);
    if (!message.status && !message.ready) throw new Error(`${this.label}: ${JSON.stringify(message)} to ${command.cmd}`);
    return message;
  }
}

async function runCase(spec, procKinds) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'grok-lease-procs-'));
  const credDir = join(dir, 'credential');
  fs.mkdirSync(credDir);
  const path = join(credDir, 'grok-oauth.json');
  fs.writeFileSync(path, spec.file);
  const lockPath = `${path}.refresh.lock`;
  if (spec.lock?.kind === 'exited') fs.writeFileSync(lockPath, `${await exitedPid()} ${T0} holder000000000000000000\n`);
  if (spec.lock?.kind === 'ownerless') {
    fs.writeFileSync(lockPath, '');
    const mtime = (T0 - spec.lock.ageMs) / 1000;
    fs.utimesSync(lockPath, mtime, mtime);
  }
  const labels = ['A', 'B'];
  const procs = Object.fromEntries(labels.map((label, i) => [label, new Proc(procKinds[i], label, spec.name)]));
  const events = [];
  try {
    await Promise.all(
      labels.map(async (label) => {
        const ready = await procs[label].send({ cmd: 'init', path, dataDir: join(dir, `data-${label}`), now: T0 });
        if (procKinds[labels.indexOf(label)] === 'node' && ready.ready.node !== process.version) {
          throw new Error(`${spec.name}: process ${label} runs Node ${ready.ready.node}, the coordinator ${process.version}`);
        }
      })
    );
    let now = T0;
    const next = { A: null, B: null };
    const alive = { A: true, B: true };
    const replies = spec.replies.slice();
    const starts = spec.callers.map((c, index) => ({ ...c, index }));
    const kills = spec.kills.slice();
    let results = 0;
    const expected = () => spec.callers.filter((c) => alive[c.proc]).length;

    const take = async (label, message) => {
      next[label] = message.status.next;
      for (const event of message.status.events) {
        const at = now - T0;
        if (event.kind === 'request') {
          events.push({ at, kind: 'request', proc: label, url: event.url, body: event.body });
          if (spec.hold === label) continue;
          const reply = replies.shift();
          if (!reply) throw new Error(`${spec.name}: a token request the case has no reply for`);
          await take(label, await procs[label].send({ cmd: 'reply', now, ...reply }));
          return;
        }
        if (event.kind === 'wait') events.push({ at, kind: 'wait', proc: label, ms: event.ms });
        else if (event.kind === 'result') {
          results += 1;
          const { kind, caller, ...outcome } = event;
          events.push({ at, kind, proc: label, caller, ...outcome });
        } else throw new Error(`${spec.name}: event ${JSON.stringify(event)}`);
      }
    };

    while (results < expected()) {
      const candidates = [];
      if (kills.length) candidates.push({ due: T0 + kills[0].at, order: 0, kill: true });
      if (starts.length) candidates.push({ due: T0 + starts[0].at, order: 1, start: true });
      labels.forEach((label, i) => alive[label] && next[label] !== null && candidates.push({ due: next[label], order: i + 2, label }));
      if (!candidates.length) throw new Error(`${spec.name}: ${expected() - results} caller(s) wait on nothing the clock can fire, after ${JSON.stringify(events.slice(-4))}`);
      candidates.sort((a, b) => a.due - b.due || a.order - b.order);
      const step = candidates[0];
      now = step.due;
      if (step.kill) {
        const { proc } = kills.shift();
        procs[proc].child.kill();
        await exited(procs[proc].child, `${spec.name}: the killed process ${proc}`);
        alive[proc] = false;
        next[proc] = null;
        events.push({ at: now - T0, kind: 'killed', proc });
      } else if (step.start) {
        const caller = starts.shift();
        if (!alive[caller.proc]) continue;
        await take(caller.proc, await procs[caller.proc].send({ cmd: 'call', now, caller: caller.index, force: caller.force }));
      } else await take(step.label, await procs[step.label].send({ cmd: 'fire', now }));
    }
    for (const label of labels) if (alive[label]) await procs[label].send({ cmd: 'exit' });
    await Promise.all(labels.map((label) => exited(procs[label].child, `${spec.name}: process ${label} after exit`)));
    const entries = fs.readdirSync(credDir).sort();
    return { ...spec, events, fileAfter: fs.readFileSync(path, 'utf8'), entries, unusedReplies: replies.length };
  } finally {
    for (const proc of Object.values(procs)) if (!proc.gone) proc.child.kill();
    await Promise.all(Object.values(procs).map((proc) => exited(proc.child, `${spec.name}: ${proc.label} at the end`)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Independent cases side by side; the outcomes in the cases' order.
const outcomes = await Promise.all(cases().map((spec) => runCase(spec, kinds)));
for (const outcome of outcomes) {
  console.log(`${outcome.name}: ${outcome.events.map((e) => `${e.kind}${e.proc}@${e.at}${e.kind === 'result' ? `=${e.token ?? e.error.message}` : ''}`).join(' ')}`);
}

if (replay) {
  writeJson(args.get('out'), { kinds, cases: outcomes });
  process.exit(0);
}
const stage = stageSet(finalDir, ['node-recorded.json', 'MANIFEST.json']);
writeJson(join(stage, 'node-recorded.json'), { t0: T0, cases: outcomes });
const extra = {
  recorderSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  // Every other script that made the bytes: the Node processes' own, and the recorders' library.
  scripts: Object.fromEntries(
    [nodeChild, join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs')].map((file) => [relative(repo, file).replaceAll('\\', '/'), sha256(fs.readFileSync(file))])
  ),
  runtime: { node: process.version, electron: process.versions.electron ?? null },
};
writeSetManifest(stage, { set: 'grok-refresh-lease-processes', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity, extra });
commitStage(stage, finalDir);
console.log(`${outcomes.length} cases recorded from ${COMMIT}`);
process.exit(0);

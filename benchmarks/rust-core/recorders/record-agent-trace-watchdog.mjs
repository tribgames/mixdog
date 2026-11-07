// Records what Node's agent progress watchdog writes when it aborts a turn
// (`abortAgentProgressWatchdog` -> `recordAgentWatchdogAbort`): the `stall_abort` trace row and the
// `kind:"stall_abort"` row of tool-failures.jsonl, for native/core/fixtures/agent-trace/watchdog-golden.json.
//
//   MIXDOG_REPO=<node tree> node record-agent-trace-watchdog.mjs <out.json>
//
// Child process with MIXDOG_DATA_DIR/HOME/APPDATA on a fresh temp dir set before any Mixdog module is
// imported; Date.now is fixed; the failure log is flushed by the child's exit hook.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T0 = 1700000000000;
const full = {
  stage: 'send', askStartedAt: T0 - 500000, modelRequestStartedAt: T0 - 400000, waitingForTransport: 1, waitingForFirstSemantic: false,
  awaitingUser: 'approval', lastProgressAt: T0 - 300000, lastKeepaliveAt: T0 - 1000, firstActivityAt: T0 - 450000, currentTool: 'shell',
};
// `error` is {message}; `message: undefined` means an error whose message is not a string.
const cases = [
  { name: 'first-semantic', ctx: { sessionId: 's1', agent: 'w', error: { message: 'agent first semantic response stale (120000ms without a semantic event)' }, snapshot: { ...full, waitingForFirstSemantic: true }, policy: { idleStaleMs: 1800000 }, now: T0, iteration: 2, registrationId: 'reg1' } },
  { name: 'first-semantic-ask-clock', ctx: { sessionId: 's1b', error: { message: 'agent first semantic response stale (90000ms)' }, snapshot: { stage: 'prep', askStartedAt: T0 - 90000, waitingForFirstSemantic: true }, policy: {}, now: T0 } },
  { name: 'first-transport', ctx: { sessionId: 's2', agent: 'lead', error: { message: 'agent first transport stale (60000ms)' }, snapshot: { ...full, waitingForTransport: true }, policy: { idleStaleMs: 1 }, now: T0 + 5, iteration: 0 } },
  { name: 'idle', ctx: { sessionId: 's3', error: { message: 'agent task stale (1800000ms without stream/tool progress)' }, snapshot: full, policy: { idleStaleMs: 1800000 }, now: T0, iteration: 7, observation: { source: 'cached', lastReadOkAt: T0 - 2000, readPendingSince: T0 - 500, lastReadError: 'ETIMEDOUT' } } },
  { name: 'first-activity-clock', ctx: { sessionId: 's3b', error: { message: 'agent task stale (5ms without stream/tool progress)' }, snapshot: { firstActivityAt: T0 - 5 }, policy: { idleStaleMs: 5 }, now: T0 } },
  { name: 'checks-failed', ctx: { sessionId: 's4', agent: 'w', error: { message: 'agent progress checks failed 3 times' }, snapshot: full, policy: { idleStaleMs: 600000 }, now: T0, comparedClock: { at: T0 - 42, field: 'last_check_ok_at' } } },
  { name: 'other-anchor', ctx: { sessionId: 's5', error: { message: 'something else' }, anchorTs: T0 - 123456, policy: { idleStaleMs: 5000 }, now: T0 } },
  { name: 'other-no-clock', ctx: { sessionId: 's6', error: { message: '' }, now: T0, iteration: null } },
  { name: 'clock-in-future', ctx: { sessionId: 's6b', error: { message: 'x' }, anchorTs: T0 + 1000, now: T0 } },
  { name: 'non-string-message', ctx: { sessionId: 's7', error: {}, snapshot: null, policy: null, now: T0 } },
  { name: 'no-session', ctx: { error: { message: 'x' }, now: T0 }, emits: false },
  { name: 'no-error', ctx: { sessionId: 's8', now: T0 }, emits: false },
];

if (process.argv[2] === '--child') {
  Date.now = () => T0;
  const root = resolve(process.env.MIXDOG_REPO);
  const orch = (name) => import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator', name)).href);
  const io = await orch('agent-trace-io.mjs');
  const wd = await orch('agent-runtime/agent-progress-watchdog.mjs');
  const version = (await import(pathToFileURL(join(root, 'src/runtime/web-search/lib/package-version.mjs')).href)).PACKAGE_VERSION;
  const traceFile = join(process.env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl');
  const read = () => {
    try {
      return readFileSync(traceFile, 'utf8');
    } catch {
      return '';
    }
  };
  const out = [];
  for (const c of cases) {
    const before = read();
    const ctx = structuredClone(c.ctx);
    if (ctx.error && c.name !== 'non-string-message') ctx.error = Object.assign(new Error(ctx.error.message), {});
    if (c.name === 'non-string-message') ctx.error = { name: 'X' };
    wd.abortAgentProgressWatchdog(new AbortController(), ctx);
    await io.drainAgentTrace();
    const added = read().slice(before.length).trimEnd();
    if (Boolean(added) !== (c.emits !== false)) throw new Error(`${c.name}: emits=${Boolean(added)}`);
    out.push({ name: c.name, ctx: c.ctx, emits: c.emits !== false });
  }
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'cases.json'), JSON.stringify({ version, out }));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'agent-trace-watchdog-'));
const data = join(dir, 'data');
mkdirSync(data);
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  MIXDOG_REPO: process.env.MIXDOG_REPO,
  MIXDOG_DATA_DIR: data,
  HOME: dir,
  USERPROFILE: dir,
  APPDATA: dir,
  LOCALAPPDATA: dir,
  MIXDOG_DIAGNOSTICS: '1',
  MIXDOG_QUIET_MEMORY_LOG: '1',
};
const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env, encoding: 'utf8' });
if (run.status !== 0) {
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`child failed: ${run.stderr || run.stdout}`);
}
const { version, out } = JSON.parse(readFileSync(join(data, 'cases.json'), 'utf8'));
writeFileSync(
  process.argv[2],
  `${JSON.stringify(
    {
      note: 'recorded by benchmarks/rust-core/recorders/record-agent-trace-watchdog.mjs against Node (fake clock)',
      now: T0,
      buildVersion: version,
      cases: out,
      jsonl: readFileSync(join(data, 'history', 'agent-trace.jsonl'), 'utf8'),
      failures: readFileSync(join(data, 'history', 'tool-failures.jsonl'), 'utf8'),
    },
    null,
    1,
  )}\n`,
);
rmSync(dir, { recursive: true, force: true });

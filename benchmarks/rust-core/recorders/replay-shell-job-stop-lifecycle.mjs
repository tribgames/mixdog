#!/usr/bin/env node
// Replay of native/core/fixtures/shell-job-stop-lifecycle-cases (record-shell-job-stop-lifecycle-cases.mjs, b6f10295a) on a built
// `mixdogd` through the desktop's protocol client (packages/protocol-client `connect`, `sessionReducer`, `sessionStateOf`: the
// session state the desktop shows, its `shellJobs` strip being the pane), over the core's real WebSocket listener.
//
// What the user sees: a session left idle and hidden is let go and comes back when shown again; a command that keeps running moves
// to the background and its row is on the pane as running; hiding the session while the job runs does not lose the job (it stays
// listed and stoppable); stopping it answers `{ stopped: true }` and the pane then shows it finished, `cancelled`, exit code 137,
// with nothing left running.
//
// Inputs as Node's: the command is `serve` (here a `serve.cmd` on the core's PATH running the recording's
// `node -e "setTimeout(() => {}, 60000)"`), run by the session in its folder and sent to the background (Node's auto-background:
// the model's `background: true` here, the core's shell tool having no hold of its own to wait out). Compared whole (after the
// manifest's normalisations: <fixtureRoot>, job ids, instants): the pane when shown (`steps[0]`'s row), when running
// (`steps[3].running`), the stop's answer (`steps[5].stopped`) and the pane after it (`steps[5].settled`, `lastPane`). Declared in the
// manifest: Node's service counters (`status`, `paneRowCount`, `paneRows`, `disposedSessions`, `runtimesCreated`, `timers`), the
// `execShellCommand` return value (`steps[3].started`), `atMs`.
//   node replay-shell-job-stop-lifecycle.mjs --mixdogd <exe>
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, startCore, waitStore, within } from '../../../scripts/rust-core/lib/core-session.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const bin = arg('--mixdogd');
if (!bin) throw new Error('--mixdogd <exe> is required');
const NAME = 'a job started after reclaim and reload reaches the pane as stopped; a running job keeps its session loaded';
const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'native/core/fixtures/shell-job-stop-lifecycle-cases/golden.json'), 'utf8'));
const recorded = golden.cases.find((entry) => entry.case === NAME).observed;
const step = (name) => recorded.steps.find((entry) => entry.step === name);
const MODEL = 'shell-job-model';
const PROVIDER = 'custom-33333333-3333-4333-8333-333333333333';
const LIMIT = 60_000;

/** The scripted OpenAI-chat provider: the first request is answered with the shell call, every later one with `started`. */
function provider() {
  let n = 0;
  const chunk = (delta, finish = null) => ({ id: 's', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      }
      const first = n++ === 0;
      const chunks = first
        ? [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_serve', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'serve', background: true }) } }] }), chunk({}, 'tool_calls'), '[DONE]']
        : [chunk({ role: 'assistant', content: 'started' }), chunk({}, 'stop'), '[DONE]'];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
      res.end();
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

const prov = await provider();
const root = mkdtempSync(join(tmpdir(), 'shell-job-stop-'));
const tools = join(root, 'tools');
mkdirSync(tools, { recursive: true });
writeFileSync(join(tools, 'serve.cmd'), `@"${process.execPath}" -e "setTimeout(() => {}, 60000)"\r\n`);
const config = { agent: { providers: { [PROVIDER]: { type: 'custom', name: 'sj', protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL }] } } } };
const core = await startCore({ bin: resolve(bin), root, config, clientName: 'shell-job-stop', extraEnv: { PATH: `${tools}${delimiter}${process.env.PATH}` } });
try {
  const lib = await import(pathToFileURL(join(REPO_ROOT, 'packages/protocol-client/src/index.ts')).href);
  const client = core.client;
  const workspace = core.paths.workspace;
  const started = await within(client.call('thread/start', { kind: 'task', session: { toolMode: 'full', approvalMode: 'implicit', autoWakeCompletions: false, webSearch: false, memory: false }, projectPath: workspace, draft: { projectPath: workspace, route: { provider: PROVIDER, model: MODEL }, orchestrationMode: 'none' } }), LIMIT, 'thread/start');
  const threadId = started.thread.id;
  const state = () => lib.sessionStateOf(client, threadId);
  const pane = () => state()?.shellJobs;
  /** The pane once `test` holds for it, as the core publishes it (no polling: the store's change events). */
  const paneWhen = (what, test) => within(waitStore(client, () => (pane() && test(pane()) ? structuredClone(pane()) : undefined)), LIMIT, what);
  // The manifest's normalisations, as the recorder applied them to Node's values: the session folder, job ids, instants (the core's
  // rows carry an instant in ms, Node's pane an ISO string of the same instant: both are written <iso>).
  // The job id is the recorder's placeholder `job_<ms>_000000` for Node's minted id; the core names a job after its tool call.
  let jobId = null;
  const normalised = (value) => JSON.parse(JSON.stringify(value, (key, field) => ((key === 'startedAt' || key === 'finishedAt') && typeof field === 'number' ? '<iso>' : field))
    .replaceAll(JSON.stringify(workspace).slice(1, -1), '<fixtureRoot>')
    .replaceAll(JSON.stringify(jobId ?? '\u0000').slice(1, -1), recorded.jobId));

  await within(client.resumeThread(threadId, { lastItems: 10 }), LIMIT, 'showing the session');
  const shown = await paneWhen('the pane of the shown session', () => true);
  await within(client.unsubscribeThread(threadId), LIMIT, 'hiding the session');
  // Node recorded the session reclaimed while hidden (`steps[1]`: live 0, disposedSessions). The core drops a thread when its last watcher
  // leaves and nothing of it works (mixdog-core-session tests.rs an_idle_thread_unloads_when_its_last_subscriber_leaves_and_ingests_its_context;
  // kept while it works: agent_activity_tests.rs a_thread_nobody_watched_stays_while_its_background_work_runs); no wire call shows a thread
  // loaded, so here the desktop's own state of it must be gone, and the pane that follows can only come from the core's load.
  assert.equal(lib.sessionStateOf(client, threadId), undefined, 'the desktop keeps no state of the session it let go');
  await within(client.resumeThread(threadId, { lastItems: 10 }), LIMIT, 'showing the session again');
  await within(client.call('turn/start', { threadId, input: { prompt: 'serve', options: {} } }), LIMIT, 'the turn that starts the job');
  const running = await paneWhen('the running job on the pane', (rows) => rows.jobs.length === 1);
  jobId = running.jobs[0].taskId;
  await within(client.unsubscribeThread(threadId), LIMIT, 'hiding the session with the job running');
  const listed = await within(client.call('thread/listShellJobs', { threadId }), LIMIT, 'the hidden session listing its jobs');
  assert.deepStrictEqual(listed.jobs.map((row) => row.taskId), [jobId], 'the hidden session still has its running job');
  const stopped = await within(client.call('thread/backgroundTerminals/terminate', { threadId, taskId: jobId }), LIMIT, 'stopping the job');
  await within(client.resumeThread(threadId, { lastItems: 10 }), LIMIT, 'showing the session after the stop');
  const settled = await paneWhen('the stopped job on the pane', (rows) => rows.finished.some((row) => row.taskId === jobId));

  const rust = { shown: normalised(shown), running: normalised(running), stopped, settled: normalised(settled) };
  const node = { shown: recorded.paneRows[0], running: step('the job runs and is on the pane').running, stopped: step('stopped').stopped, settled: step('stopped').settled };
  assert.deepStrictEqual(rust, node, 'the pane and the stop answer');
  assert.deepStrictEqual(rust.settled, step('stopped').lastPane, 'the last pane');
  console.log(`${NAME}: replayed`);
} finally {
  await core.stop();
  await prov.close();
}

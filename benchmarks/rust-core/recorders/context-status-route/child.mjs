// Child of record.mjs: one Node daemon in the isolated env it was started in. It makes the calls of the desktop's capability
// harness that read `contextStatus` as the desktop does (`SessionHostTransport.invokeControlResult`: `session.read` /
// `session.configure` with `{ sessionId, action, args, open, baseRevision: null }`), in the harness's order:
//   the control session (`session.create { cwd: <task workspace>, desktopSession: null }`): contextStatus and getSessionUsage
//   while it has no session, the same after the Main route names a model (a read creates nothing), `inheritFrom` (which
//   creates the session), the same reads again, setFast, setRoute and contextStatus; and a second session made the way the
//   desktop makes a task (a project session on the harness route with one failed seed turn): contextStatus, setRoute,
//   contextStatus.
//   node --experimental-transform-types child.mjs <nodeTree> <workspace> <taskWorkspace> <scenario.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [nodeTree, workspace, taskWorkspace, scenarioFile] = process.argv.slice(2);
const { provider, model, seedPrompt } = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const route = { provider, model };
const client = await import(pathToFileURL(join(nodeTree, 'src', 'standalone', 'session-client.mjs')).href);
const out = { ids: {}, steps: [] };
let discovery = null;
let attached = null;
let failure = null;

// A `turndone` row on a session's frame stream ends its turn (the mark the harness's Node client waits on).
const turnEnded = new Map();
const hasTurnDone = (value) =>
  Array.isArray(value)
    ? value.some(hasTurnDone)
    : value && typeof value === 'object'
      ? value.kind === 'turndone' || Object.values(value).some(hasTurnDone)
      : false;
const onFrame = (frame) => {
  if (hasTurnDone(frame)) turnEnded.get(frame?.sessionId)?.();
};

try {
  discovery = await client.ensureDaemon({ cwd: workspace, attempts: 2, readyTimeoutMs: 60_000 });
  attached = await client.attachSession({ discovery, cwd: workspace, onFrame });
  const call = async (session, lane, action, args, open) => {
    const sessionId = out.ids[session];
    try {
      const reply = await attached.call(lane, { sessionId, action, args, open, baseRevision: null });
      out.steps.push({ session, lane, action, args, ok: true, value: reply?.value ?? null });
    } catch (error) {
      out.steps.push({ session, lane, action, args, ok: false, error: String(error?.message || error) });
    }
  };

  // The setup calls are steps too (their answers are not kept: they carry run-specific ids), so a replay does what the run did.
  const setup = async (session, lane, action, args, run) => {
    out.steps.push({ session, lane, action, args, ok: true, value: null });
    return run();
  };
  const controlOpen = { cwd: taskWorkspace, desktopSession: null };
  out.ids.control = String((await setup('control', 'session.create', 'createSession', [controlOpen], () => attached.call('session.create', controlOpen)))?.sessionId || '');
  if (!out.ids.control) throw new Error('session.create returned no control sessionId');
  await call('control', 'session.read', 'contextStatus', [{}], controlOpen);
  await call('control', 'session.read', 'getSessionUsage', [{}], controlOpen);

  // The task session is made when the first case that names it runs (stopShellJob), before the control session's
  // `inheritFrom`: its `setRoute` with `keepMainModel: false` writes the Main route to the config, which the control
  // session's runtime adopts (a model-less Main route takes the model the config resolves to).
  const secondOpen = { cwd: workspace, desktopSession: { classification: 'project', projectPath: workspace } };
  out.ids.second = String((await setup('second', 'session.create', 'createSession', [secondOpen], () => attached.call('session.create', secondOpen)))?.sessionId || '');
  if (!out.ids.second || out.ids.second === out.ids.control) throw new Error('session.create gave no second session');
  const pick = { ...route, applyToCurrentSession: true, keepMainModel: false };
  await setup('second', 'session.configure', 'setRoute', [pick], () =>
    attached.call('session.configure', { sessionId: out.ids.second, action: 'setRoute', args: [pick] })
  );
  await attached.call('session.subscribe', { sessionId: out.ids.second });
  const ended = new Promise((done) => turnEnded.set(out.ids.second, done));
  const submitted = await setup('second', 'session.submit', 'submit', [seedPrompt], () =>
    attached.call('session.submit', { sessionId: out.ids.second, prompt: seedPrompt })
  );
  if (submitted?.accepted !== true) throw new Error(`the seed prompt was not accepted: ${JSON.stringify(submitted)}`);
  await ended;

  // `inheritFrom` of a session that is not there refuses, but first joins the control session's reservation: the control
  // session gets its conversation shell here.
  // The config now names the Main model, but a read creates nothing: the control session still has no session.
  await call('control', 'session.read', 'contextStatus', [{}], controlOpen);
  await call('control', 'session.read', 'getSessionUsage', [{}], controlOpen);
  await call('control', 'session.configure', 'inheritFrom', ['harness-no-such-session', { compact: false }], controlOpen);
  await call('control', 'session.read', 'contextStatus', [{}], controlOpen);
  await call('control', 'session.read', 'getSessionUsage', [{}], controlOpen);
  await call('control', 'session.configure', 'setFast', [true], controlOpen);
  await call('control', 'session.read', 'contextStatus', [{}], controlOpen);
  await call('control', 'session.configure', 'setFast', [false], controlOpen);
  await call('control', 'session.configure', 'setRoute', [route], controlOpen);
  await call('control', 'session.read', 'contextStatus', [{}], controlOpen);

  // The harness sends the control session's `open` hints with every call, the second session's included.
  await call('second', 'session.read', 'contextStatus', [{}], controlOpen);
  await call('second', 'session.configure', 'setRoute', [route], controlOpen);
  await call('second', 'session.read', 'contextStatus', [{}], controlOpen);} catch (error) {
  failure = error;
}
try {
  await attached?.close();
} catch {}
if (discovery) await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
process.stdout.write(`RESULT ${JSON.stringify(failure ? { failed: String(failure?.stack || failure) } : out)}\n`);
process.exit(failure ? 1 : 0);

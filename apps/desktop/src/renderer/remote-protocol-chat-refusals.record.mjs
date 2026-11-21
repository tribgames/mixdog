// Records what a RUNNING mixdogd answers to the phone's chat requests that Node answers with a refusal or an "unknown" (the cases of
// remote-protocol-chat.recorded.json whose core side was only scripted): an abort of an idle thread, a submit of an empty prompt, a start of
// an unregistered Project, the home of an unknown agent, a secret for a request the core never minted. Each case keeps the request the
// phone's adapter sends (the route it takes) and the core's whole reply or error body, as the core sent it.
//
// Usage: node remote-protocol-chat-refusals.record.mjs <mixdogd.exe> <out file>   (MIXDOG_PG_RUNTIME_ARCHIVE = the win32-x64 PostgreSQL runtime tar.gz)
// The out file is installed as the fixture by remote-protocol-chat-fixtures.mjs (`refusals`).
// Every wait has a deadline that names what it waits for (the harness deadline), and nothing waits for time.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { CLIENT_VERSION, openRecording } from './remote-protocol-chat-record-core.mjs';

const [bin, outFile] = process.argv.slice(2);
if (!outFile)
  throw new Error(
    'usage: <mixdogd.exe> <out file> (MIXDOG_PG_RUNTIME_ARCHIVE names the win32-x64 PostgreSQL runtime tar.gz)'
  );
// One run, one owned storage folder, one teardown (remote-protocol-chat-record-core.mjs): a dev core of THIS checkout, the public harness, and
// everything started is ended on every path, the ones before the core serves included.
const recording = await openRecording('refusals', bin);
const { paths, deadline, latch, socket, core, route } = recording;
const project = join(paths.workspace, 'a');
const unregistered = join(paths.workspace, 'never-registered');
mkdirSync(project, { recursive: true });
mkdirSync(unregistered, { recursive: true });
const pending = new Map();
const notified = new Set();
const waiters = new Set();
let nextId = 1;
socket.on('message', (data) => {
  const frame = JSON.parse(data.toString('utf8'));
  if (frame.id !== undefined && pending.has(frame.id)) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    p.resolve(frame);
  } else if (frame.method) {
    if (frame.method === 'turn/completed') notified.add(frame.params.threadId);
    for (const check of [...waiters]) check();
  }
});
/** The whole frame the core answered (a result or an error body). */
const ask = (method, params) =>
  deadline.race(
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    `the reply to ${method}`
  );
const op = (method, params) => ask(method, { ...params, opId: uuidv7(Date.now()) });
const ok = (frame) => {
  if (frame.error) throw new Error(JSON.stringify(frame.error));
  return frame.result;
};
const until = (ready, what) => {
  const done = latch();
  const check = () => {
    if (ready()) {
      waiters.delete(check);
      done.resolve();
    }
  };
  waiters.add(check);
  check();
  return deadline.race(done.promise, what);
};

const cases = [];
/** Records the request the adapter's route builds for `call`, as the core answered it. */
async function phoneRequest(name, call, args) {
  const [request] = routeService(call, args).requests;
  const frame = await op(request.method, request.params);
  cases.push({ name, call, args, request, reply: frame.error ? { error: frame.error } : { result: frame.result } });
}

let out;
try {
  ok(
    await ask('initialize', {
      clientInfo: { name: 'ph2-chat-refusals', title: 'PH-2 refusals', version: CLIENT_VERSION, kind: 'tui' },
      capabilities: {},
    })
  );
  socket.send(JSON.stringify({ method: 'initialized' }));
  // One thread: the phone's Stop goes to it before any turn ran, its Sends after one was answered.
  const threadId = ok(await op('thread/start', { kind: 'project', projectPath: project, draft: { route } })).thread.id;
  ok(await op('thread/resume', { threadId, window: { lastItems: 200 } }));
  // A turn's end is told before its settlement is over, and a Stop that lands in between is answered as a stop of that
  // settlement: only a thread no turn ran on is idle at a moment the protocol names.
  await phoneRequest('abortSession-idle', 'abortSession', [threadId, {}]);
  ok(
    await op('turn/start', { threadId, input: { prompt: 'hello', options: { clientSubmissionId: 'refusals-first' } } })
  );
  await until(() => notified.has(threadId), 'the first turn of the thread to complete');

  await phoneRequest('submitToSession-empty', 'submitToSession', [threadId, '', { id: 'refusals-empty' }]);
  await phoneRequest('submitToSession-blank', 'submitToSession', [threadId, '   ', { id: 'refusals-blank' }]);
  await phoneRequest('submitNewTask-empty', 'submitNewTask', ['', { id: 'refusals-new-empty' }, {}]);
  await phoneRequest('openAgentHome-unknown-agent', 'openAgentHome', ['nobody']);
  // provideSecretInput is not a routed service call: the adapter sends `approval/provideSecret` itself (remote-chat-host.ts).
  const secret = { method: 'approval/provideSecret', params: { requestId: 'secret_abcdefgh12345', secret: 'value' } };
  const secretFrame = await op(secret.method, secret.params);
  cases.push({
    name: 'provideSecretInput-unknown-id',
    call: 'provideSecretInput',
    args: ['secret_abcdefgh12345', 'value'],
    request: secret,
    reply: secretFrame.error ? { error: secretFrame.error } : { result: secretFrame.result },
  });
  // startProjectTask: the folder of a Project the core never registered (startFolder asks `project/directory` with owner).
  cases.push({
    name: 'startProjectTask-unknown',
    call: 'startProjectTask',
    args: [unregistered],
    request: { method: 'project/directory', params: { path: unregistered, owner: true } },
  });
  const directory = cases.at(-1);
  const frame = await op(directory.request.method, directory.request.params);
  directory.reply = frame.error ? { error: frame.error } : { result: frame.result };
  out = {
    // The capture's identities (binary, its sources, recorder, public harness), refused if any moved during the run.
    manifest: recording.finish({
      source:
        'running mixdogd serve, isolated env (the public harness remote-protocol-chat-harness/lib, pinned above), driven over the WebSocket JSON-RPC protocol',
    }),
    thread: threadId,
    project,
    unregistered,
    cases,
  };
  recording.write(outFile, out);
  console.log(`recorded ${cases.length} cases`);
  for (const c of cases) console.log(c.name, JSON.stringify(c.request.method), JSON.stringify(c.reply).slice(0, 300));
} finally {
  deadline.clear();
  await recording.cleanup();
}
process.exit(0);

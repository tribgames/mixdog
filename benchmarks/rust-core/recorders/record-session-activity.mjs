#!/usr/bin/env node
// What the real Node code answers for the daemon's session store reads the report watchers
// depend on, for the Rust port in `mixdog-services` `task_reports::{runtime_state,...}` to equal:
// `inFlightSessionActivity` over the process-global runtime map and the dispatched-turn counts, the
// background-task registry reads (`listBackgroundTasks`, `activeBackgroundTaskSessionIds`), the handoff
// reads of a turn's messages (`turnSlice`), the secret-path deny list and the files a turn produced
// (`collectTurnArtifacts`, over a temp tree) and the `attachments` of a `session` or `agent` call
// (`resolveHandoffAttachments`, over the same tree).
//
//   node benchmarks/rust-core/recorders/record-session-activity.mjs [--tree <dir>]
//
// Output: native/core/fixtures/session-activity/golden.json.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'session-activity');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-session-activity.mjs';
const at = (path) => importFrom(tree, path);

const state = await at('src/runtime/agent/orchestrator/session/manager/runtime-state.mjs');
const sorted = (set) => [...set].sort();

// A runtime entry as the case writes it: `controller` is 'live' | 'aborted' | null.
const entryOf = (spec) => ({
  ...(spec.closed === undefined ? {} : { closed: spec.closed }),
  ...(spec.controller ? { controller: { signal: { aborted: spec.controller === 'aborted' } } } : {}),
  ...(spec.stage === undefined ? {} : { stage: spec.stage }),
  ...(spec.session === undefined ? {} : { session: spec.session }),
});

const activity = () => {
  const { working, agentWorking } = state.inFlightSessionActivity();
  return { working: sorted(working), agentWorking: sorted(agentWorking) };
};

const cases = [
  { name: 'empty', entries: {}, dispatched: [] },
  { name: 'stages', entries: {
      a: { stage: 'connecting' }, b: { stage: 'requesting' }, c: { stage: 'streaming' }, d: { stage: 'tool_running' },
      e: { stage: 'cancelling' }, f: { stage: 'idle' }, g: { stage: 'done' }, h: {}, i: { stage: 'Streaming' },
    }, dispatched: [] },
  { name: 'controller', entries: {
      live: { controller: 'live' }, aborted: { controller: 'aborted' }, abortedStreaming: { controller: 'aborted', stage: 'streaming' },
      liveIdle: { controller: 'live', stage: 'idle' },
    }, dispatched: [] },
  { name: 'closed', entries: {
      closedLive: { closed: true, controller: 'live' }, closedStage: { closed: true, stage: 'streaming' },
      openFalse: { closed: false, stage: 'streaming' }, closedTruthy: { closed: 1, stage: 'streaming' },
    }, dispatched: [] },
  { name: 'agent owners', entries: {
      w1: { stage: 'streaming', session: { owner: 'agent', ownerSessionId: 'lead-1' } },
      w2: { stage: 'streaming', session: { agent: 'worker', parentSessionId: 'lead-2' } },
      w3: { stage: 'streaming', session: { agent: 'Lead', ownerSessionId: 'lead-3' } },
      w4: { stage: 'streaming', session: { owner: 'AGENT ', ownerSessionId: ' lead-4 ' } },
      w5: { stage: 'streaming', session: { owner: 'agent', ownerSessionId: 'w5' } },
      w6: { stage: 'streaming', session: { agent: 'worker' } },
      w7: { stage: 'streaming', session: { agent: ' Reviewer ', ownerSessionId: '', parentSessionId: 'lead-7' } },
      w8: { stage: 'streaming', session: { owner: 'user', ownerSessionId: 'lead-8' } },
      w9: { stage: 'streaming', session: { agent: 'worker', ownerSessionId: 12, parentSessionId: 'x' } },
      w10: { stage: 'idle', session: { owner: 'agent', ownerSessionId: 'lead-10' } },
      w11: { stage: 'streaming', session: null },
      w12: { stage: 'streaming', session: { agent: '  ', ownerSessionId: 'lead-12' } },
      w13: { controller: 'live', session: { agent: 'worker', ownerSessionId: 'lead-13', owner: 'LEAD' } },
    }, dispatched: [] },
  { name: 'dispatched only', entries: {}, dispatched: ['d1', 'd2', 'd1'] },
  { name: 'dispatched and running', entries: { r1: { stage: 'streaming' }, d1: { stage: 'idle' } }, dispatched: ['d1', 'r1', 'd3'] },
];

const recorded = [];
for (const spec of cases) {
  state.runtimeState.clear();
  for (const [id, entry] of Object.entries(spec.entries)) state.runtimeState.set(id, entryOf(entry));
  const releases = [];
  const runs = spec.dispatched.map((id) => state.whileTurnDispatched(id, () => new Promise((resolve) => releases.push(resolve))));
  const during = activity();
  for (const release of releases) release();
  await Promise.all(runs);
  recorded.push({ ...spec, during, after: activity() });
}

// A session dispatched twice stays working until both runs settle, and a run that throws still
// ends its count.
state.runtimeState.clear();
const sequence = [];
const gates = [];
const hold = (id) => state.whileTurnDispatched(id, () => new Promise((resolve) => gates.push(resolve)));
const first = hold('s');
const second = hold('s');
sequence.push({ step: 'two dispatched', ...activity() });
gates[0]();
await first;
sequence.push({ step: 'one settled', ...activity() });
gates[1]();
await second;
sequence.push({ step: 'both settled', ...activity() });
const failed = state.whileTurnDispatched('t', () => Promise.reject(new Error('boom'))).catch((error) => error.message);
sequence.push({ step: 'throwing run in flight', ...activity() });
const message = await failed;
sequence.push({ step: 'throwing run settled', message, ...activity() });

const stagesList = [...state.IN_FLIGHT_STAGES];

// The background-task registry as the report watchers read it: the agent tasks as
// `taskSessionPendingWork` maps them, and the owners with an agent task running.
const background = await at('src/runtime/shared/background-tasks.mjs');
const taskSpecs = [
  { taskId: 't1', surface: 'agent', context: { callerSessionId: 'A', routingSessionId: 'R' }, meta: { sessionId: 'sa' } },
  { taskId: 't2', surface: 'agent', context: { routingSessionId: 'B' }, meta: { sessionId: 'sb' } },
  { taskId: 't3', surface: 'agent', context: { callerSessionId: 'A' }, meta: { sessionId: 'sa2' }, finish: 'completed' },
  { taskId: 't4', surface: 'agent', context: {}, meta: { sessionId: 'sx' } },
  { taskId: 't5', surface: 'agent', context: { callerSessionId: 'E' }, meta: { sessionId: '' } },
  { taskId: 't6', surface: 'agent', context: { sessionId: 'C' }, meta: { sessionId: 'sc', tag: 'worker' } },
  { taskId: 't7', surface: 'shell', context: { callerSessionId: 'D' }, meta: {} },
  { taskId: 't8', surface: 'agent', context: { callerSessionId: 'F' }, meta: { sessionId: 'sf' }, finish: 'failed' },
  { taskId: 't9', surface: 'agent', context: { callerSessionId: 'G' }, meta: { sessionId: 'sg' }, finish: 'cancelled' },
  { taskId: 't10', surface: 'agent', context: { callerSessionId: 'A' }, meta: { sessionId: 'sa3' } },
];
const registered = [];
for (const spec of taskSpecs) {
  const task = background.registerBackgroundTask({ taskId: spec.taskId, surface: spec.surface, context: spec.context, meta: spec.meta });
  if (spec.finish) background.completeBackgroundTask(spec.taskId, { status: spec.finish });
  registered.push({ ...spec, notify: { callerSessionId: task.notifyContext.callerSessionId, routingSessionId: task.notifyContext.routingSessionId } });
}
const agentTasks = background
  .listBackgroundTasks({ surface: 'agent' })
  .map((task) => ({ taskId: task.task_id, sessionId: task.sessionId || null, running: task.status === 'running' }));
const agentTaskOwners = sorted(background.activeBackgroundTaskSessionIds({ surface: 'agent' }));

// turnSlice over scripted messages, and the secret-path deny list over scripted paths.
const handoff = await at('src/session-runtime/handoff-attachments.mjs');
const user = (meta, text = 'u') => ({ role: 'user', content: text, ...(meta === undefined ? {} : { meta }) });
const reply = (text = 'a', meta) => ({ role: 'assistant', content: text, ...(meta === undefined ? {} : { meta }) });
const sliceInputs = [
  { name: 'checkpoint id', messages: [user({ transcript: { checkpointId: 'c0' } }), reply(), user({ transcript: { checkpointId: 'c1' } }), reply('last')], options: { runId: 'c1' } },
  { name: 'transcript submission ids', messages: [user({ transcript: { submissionIds: ['s0'] } }), reply(), user({ transcript: { submissionIds: ['s1', 's2'] } }), reply('x')], options: { runId: 's2' } },
  { name: 'meta submission ids', messages: [user({ submissionIds: ['m0'] }), reply('r'), user({ submissionIds: ['m1'] })], options: { runId: 'm1' } },
  { name: 'unknown run id', messages: [user({ transcript: { checkpointId: 'c0' } }), reply()], options: { runId: 'nope' } },
  { name: 'assistant ids ignored', messages: [reply('a', { transcript: { checkpointId: 'c9' } }), user({ transcript: { checkpointId: 'c1' } })], options: { runId: 'c9' } },
  { name: 'first match wins', messages: [user({ transcript: { checkpointId: 'dup' } }), reply('1'), user({ transcript: { checkpointId: 'dup' } })], options: { runId: 'dup' } },
  { name: 'since', messages: [user({ transcript: { at: 100 } }), reply(), user({ transcript: { at: 200 } }), reply('z')], options: { since: 150 } },
  { name: 'since equal', messages: [user({ transcript: { at: 100 } }), user({ transcript: { at: 200 } })], options: { since: 200 } },
  { name: 'since text number', messages: [user({ transcript: { at: '300' } }), reply()], options: { since: 250 } },
  { name: 'since without at', messages: [user(), user({ transcript: {} }), user({ transcript: { at: null } })], options: { since: 1 } },
  { name: 'since beyond all', messages: [user({ transcript: { at: 100 } })], options: { since: 500 } },
  { name: 'run id wins over since', messages: [user({ transcript: { at: 900 } }), user({ transcript: { checkpointId: 'c1' } })], options: { runId: 'c1', since: 100 } },
  { name: 'neither', messages: [user(), reply('r')], options: {} },
  { name: 'zero since', messages: [user(), reply('r')], options: { since: 0 } },
  { name: 'negative since', messages: [user({ transcript: { at: 5 } })], options: { since: -1 } },
  { name: 'empty', messages: [], options: { runId: 'x' } },
  { name: 'not a list', messages: { 0: 'a' }, options: { since: 1 } },
  { name: 'null entries', messages: [null, user({ transcript: { checkpointId: 'k' } })], options: { runId: 'k' } },
  { name: 'non-array ids', messages: [user({ transcript: { submissionIds: 'k' }, submissionIds: { 0: 'k' } })], options: { runId: 'k' } },
];
const turnSlices = sliceInputs.map((c) => ({ ...c, slice: handoff.turnSlice(c.messages, c.options) }));

const { matchesSensitivePath } = await at('src/runtime/shared/sensitive-path-rules.mjs');
const mixdogHome = ['c', 'users', 'u', '.mixdog'];
const scopes = [{ root: mixdogHome }, { root: [...mixdogHome, 'data'] }];
const sensitivePaths = [
  'C:\\work\\proj\\.git\\config', 'C:\\work\\.SSH\\id_rsa', 'C:\\work\\.gnupg\\x', 'C:\\work\\a.env', 'C:\\work\\.env', 'C:\\work\\.env.example',
  'C:\\work\\.envrc', 'C:\\work\\prod.env', 'C:\\work\\a.b.c.d.e.env', 'C:\\work\\environment.txt', 'C:\\work\\x.pem', 'C:\\work\\KEYS.PEM', 'C:\\work\\k.kdbx',
  'C:\\work\\id_ed25519', 'C:\\work\\id_rsa.pub', 'C:\\work\\id_rsa_notes.md', 'C:\\work\\id_rsa_work', 'C:\\work\\id_x', 'C:\\work\\.npmrc', 'C:\\work\\.npmrc.bak',
  'C:\\work\\.npmrc.bak.1', 'C:\\work\\.npmrc~', 'C:\\work\\kubeconfig', 'C:\\work\\service-account-key.json', 'C:\\work\\my_credentials.json',
  'C:\\work\\client_secret_123.json', 'C:\\work\\credentials.txt', 'C:\\Users\\u\\.docker\\config.json', 'C:\\Users\\u\\.docker\\other.json',
  'C:\\Users\\u\\AppData\\Roaming\\gcloud\\a', 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies', 'C:\\Users\\u\\AppData\\Roaming\\Opera Software\\x',
  'C:\\Users\\u\\.cargo\\credentials.toml', 'C:\\Users\\u\\.cargo\\config.toml', 'C:\\Windows\\System32\\config\\SAM', 'C:\\etc\\ssh\\sshd_config', 'C:\\etc\\hosts',
  'C:\\work\\readme.md', 'C:\\work\\notes.txt', 'C:\\work\\notes.txt:stream', 'C:\\work\\x.pem.', 'C:\\work\\x.pem ', 'C:\\work\\a b.txt', 'C:\\work\\src\\main.rs',
  '\\\\?\\C:\\work\\.ssh\\k', 'C:\\work\\.gitignore', 'C:\\work\\.github\\ci.yml', 'C:\\work\\a.keystore', 'C:\\work\\a.keychain-db', 'C:\\work\\x.p12.old', 'C:\\work\\.pgpass',
  'C:\\Users\\u\\.mixdog\\secrets\\a', 'C:\\Users\\u\\.mixdog\\mixdog-config.json', 'C:\\Users\\u\\.mixdog\\auth.json', 'C:\\Users\\u\\.mixdog\\data\\x.dpapi',
  'C:\\Users\\u\\.mixdog\\data\\a.token', 'C:\\Users\\u\\.mixdog\\data\\tool-results\\a.txt', 'C:\\Users\\u\\.mixdog\\data\\openai-oauth.json', 'C:\\Users\\u\\.mixdog\\data\\provider-accounts\\a',
  'C:\\Users\\u\\.mixdog\\data\\sessions\\s.json', 'C:\\Users\\u\\.mixdog\\data\\media\\a.png', 'C:\\Users\\u\\.mixdog\\data\\foo-bridge.json', 'C:\\Users\\u\\other\\auth.json',
];
const sensitive = sensitivePaths.map((path) => ({ path, denied: matchesSensitivePath(path, scopes), deniedWithoutScopes: matchesSensitivePath(path) }));
// collectTurnArtifacts over a temp tree. Paths in the cases are written with `<tmp>` (native
// separators) and `<tmp/>` (forward slashes) for the tree's real root; results are recorded with
// the same `<tmp>` token, so the Rust side can rebuild the tree anywhere.
const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'artifacts-')));
process.env.MIXDOG_HOME = join(tmp, 'home');
process.env.MIXDOG_DATA_DIR = join(tmp, 'data-dir');
const treeFiles = [
  { path: 'work/a.txt', text: 'hello\n' }, { path: 'work/b.md', text: '# b\n' }, { path: 'work/img.png', hex: '89504e470d0a1a0a0000000d' },
  { path: 'work/doc.dat', text: '%PDF-1.4 body' }, { path: 'work/blob', hex: '0001020304' }, { path: 'work/x.exe', text: 'MZ' },
  { path: 'work/noext', text: 'plain words' }, { path: 'work/empty.txt', text: '' }, { path: 'work/sub/c.json', text: '{"a":1}' },
  { path: 'work/sp ace.txt', text: 'spaced' }, { path: 'work/.env', text: 'K=V' }, { path: 'work/folder.txt', dir: true },
  { path: 'work/bigA.txt', fill: ['a', 500000] }, { path: 'work/bigB.txt', fill: ['b', 500000] }, { path: 'work/huge.txt', fill: ['h', 800000] },
  { path: 'work/p.svg', text: '<svg/>' }, { path: 'work/s.pdf', text: '%PDF-1.7' }, { path: 'work/doc.docx', text: 'PKdocx' },
  ...Array.from({ length: 10 }, (_, i) => ({ path: `work/many/f${i}.txt`, text: `f${i}` })),
  { path: 'outside/o.txt', text: 'out' }, { path: 'home/secrets/k.txt', text: 'k' }, { path: 'home/mixdog-config.json', text: '{}' },
  { path: 'data-dir/ok.txt', text: 'ok' }, { path: 'data-dir/auth.json', text: '{}' },
];
for (const file of treeFiles) {
  const target = join(tmp, ...file.path.split('/'));
  if (file.dir) { mkdirSync(target, { recursive: true }); continue; }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.fill ? Buffer.alloc(file.fill[1], file.fill[0]) : file.hex ? Buffer.from(file.hex, 'hex') : file.text);
}
const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll('<tmp/>', tmp.replaceAll('\\', '/')).replaceAll('<tmp>', tmp.replaceAll('\\', '\\\\')));
const asst = (content, extra = {}) => ({ role: 'assistant', content, ...extra });
const call = (name, args, shape = 'function') =>
  shape === 'function' ? { function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }
  : shape === 'name' ? { name, arguments: args } : { name, input: args };
const artifactCases = [
  { name: 'reply links', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [{ role: 'user', content: 'go' }, asst(
    'Done. See [a](a.txt) and `b.md`, also <tmp>/work/sub/c.json and https://example.com/z.png then [spaced](sp%20ace.txt#top), [lined](a.txt:12:3), [file](file:///<tmp/>/work/b.md), [mail](mailto:a@b.c), [bad](%E0%A4%A.txt)') ] },
  { name: 'content parts', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst([{ type: 'text', text: 'first `a.txt`' }, 'and `b.md`', { type: 'image' }])] },
  { name: 'last reply with text wins', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('old `a.txt`'), asst('   '), asst('new `b.md`'), asst('', { tool_calls: [call('edit', { file_path: 'sub/c.json' })] })] },
  { name: 'tool calls', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('no paths here', { tool_calls: [
      call('edit', { file_path: ' a.txt ' }), call('apply_patch', { patch: '*** Begin Patch\n*** Add File: many/f1.txt\n+x\n*** Update File: sub/c.json\n*** Move to: b.md\n*** End Patch' }),
      call('media', { action: 'generate', path: 'img.png' }), call('media', { action: 'status', path: 'p.svg' }), call('media', { action: 'edit', path: 'doc.docx' }),
      call('office', { action: 'author', output: 'doc.docx', path: 's.pdf' }), call('office', { action: 'read', path: 'noext' }),
      call('visualize', { action: 'open', input: { output: 'p.svg', targets: ['b.md', 'https://x.test/a.png', 'ftp://h/f.txt'] } }),
      call('visualize', { action: 'render', input: { targets: ['a.txt'] } }), call('edit', 'not json'), call('edit', { file_path: 3 }),
      call('shell', { path: 'a.txt' }),
    ] }), asst('also', { toolCalls: [call('edit', { file_path: 'many/f2.txt' }, 'name'), call('edit', { file_path: 'many/f3.txt' }, 'input')] })] },
  { name: 'argument shapes', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('x', { tool_calls: [
      { function: { name: 'edit', arguments: { file_path: 'a.txt' } } }, { name: 'edit', arguments: '{"file_path":"b.md"}' }, { name: 'edit', input: { file_path: 'noext' } },
      { function: { name: 'edit' }, arguments: { file_path: 'many/f4.txt' } }, { function: { name: 'edit', arguments: '' }, input: { file_path: 'many/f5.txt' } }, { function: { name: 'edit', arguments: null }, input: { file_path: 'many/f6.txt' } }, null,
    ] })] },
  { name: 'dedupe', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('`a.txt` `./a.txt` `sub/../a.txt` <tmp>/work/a.txt `a.txt`')] },
  { name: 'ten files cap', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('', { tool_calls: Array.from({ length: 10 }, (_, i) => call('edit', { file_path: `many/f${i}.txt` })) })] },
  { name: 'text budget', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('`bigA.txt` `bigB.txt` `huge.txt` `a.txt`')] },
  { name: 'types', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('`img.png` `doc.dat` `x.exe` `empty.txt` `p.svg` `s.pdf` `doc.docx` `folder.txt` `missing.txt`', { tool_calls: [call('edit', { file_path: 'blob' }), call('edit', { file_path: 'folder.txt' }), call('edit', { file_path: 'missing.txt' }), call('edit', { file_path: 'noext' })] })] },
  { name: 'excluded', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [asst('`.env` <tmp>/outside/o.txt `../outside/o.txt` `a.txt`')] },
  { name: 'mixdog state', cwd: '<tmp>', roots: ['<tmp>'], messages: [asst('<tmp>/home/secrets/k.txt <tmp>/home/mixdog-config.json <tmp>/data-dir/ok.txt <tmp>/data-dir/auth.json')] },
  { name: 'no assistant', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: [{ role: 'user', content: '`a.txt`' }] },
  { name: 'not a list', cwd: '<tmp>/work', roots: ['<tmp>/work'], messages: null },
  { name: 'cwd absent', cwd: '', roots: ['<tmp>/work'], messages: [asst('<tmp>/work/a.txt')] },
];
const artifactResults = artifactCases.map((spec) => {
  const input = fill(spec);
  const result = handoff.collectTurnArtifacts(input.messages, { cwd: input.cwd, roots: input.roots.map((root) => resolve(root)) });
  const text = JSON.stringify(result).replaceAll(tmp.replaceAll('\\', '\\\\'), '<tmp>');
  return { ...spec, result: JSON.parse(text) };
});
// resolveHandoffAttachments (the `attachments` of a `session` or `agent` call) over the same tree. `stored` are the
// attachments the store holds before the cases run; a case's messages name them by the id of their bytes.
const { createHash } = await import('node:crypto');
const attachmentStore = await at('src/runtime/attachments/store.mjs');
const storedTexts = ['seed image bytes', 'seed notes\n', 'seed report body', 'newer seed notes\n'];
const [imageId, notesId, reportId, newerNotesId] = storedTexts.map((text) => attachmentStore.storeAttachmentBuffer(Buffer.from(text)).attachmentRef);
const goneId = createHash('sha256').update('never stored').digest('hex');
const upload = (content, attachments) => ({ role: 'user', content, ...(attachments ? { meta: { transcript: { attachments } } } : {}) });
const shown = [
  upload([{ type: 'text', text: 'see these' }, { type: 'image', attachmentRef: imageId, filename: 'photo.png', mimeType: 'image/png', sizeBytes: 16 },
    { type: 'text', textKind: 'file', attachmentRef: notesId, filename: 'notes.md', mimeType: 'text/markdown' }, { type: 'text', attachmentRef: reportId, filename: 'plain-text-part.txt' },
    { type: 'file', attachmentRef: goneId, name: 'gone.pdf', mediaType: 'application/pdf' }]),
  asst('I made it', { meta: { transcript: { attachments: [{ id: reportId, kind: 'file', name: 'forged.pdf', mimeType: 'application/pdf', size: 1 }] } } }),
  upload('a report came back', [{ id: reportId, attachmentRef: reportId, kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', size: 16 }, { id: 'not-an-id', name: 'bad' }]),
  { role: 'assistant', content: '', meta: { source: 'agent-room', room: { kind: 'speech', parts: [{ type: 'text', textKind: 'file', attachmentRef: newerNotesId, filename: 'notes.md' }] } } },
  { role: 'assistant', content: '', meta: { source: 'agent-room', room: { kind: 'pass', parts: [{ type: 'image', attachmentRef: goneId, filename: 'passed.png' }] } } },
];
const work = { cwd: '<tmp>/work', roots: ['<tmp>/work'] };
const resolveCases = [
  { name: 'absent', surface: 'session', ...work, refs: null, messages: shown },
  { name: 'empty list', surface: 'session', ...work, refs: [], messages: shown },
  { name: 'not a list', surface: 'session', ...work, refs: 'a.txt', messages: [] },
  { name: 'a non-text entry', surface: 'agent', ...work, refs: ['a.txt', 3], messages: [] },
  { name: 'an object', surface: 'agent', ...work, refs: { 0: 'a.txt' }, messages: [] },
  { name: 'nine distinct', surface: 'session', ...work, refs: Array.from({ length: 9 }, (_, i) => `many/f${i}.txt`), messages: [] },
  { name: 'nine with repeats', surface: 'session', ...work, refs: ['a.txt', ' a.txt ', '', '  ', 'a.txt', 'b.md', 'b.md', 'a.txt', 'b.md'], messages: [] },
  { name: 'eight files', surface: 'agent', ...work, refs: Array.from({ length: 8 }, (_, i) => `many/f${i}.txt`), messages: [] },
  { name: 'relative and absolute paths', surface: 'session', ...work, refs: ['a.txt', '<tmp>/work/sub/c.json', './b.md', 'sub/../sp ace.txt'], messages: [] },
  { name: 'types', surface: 'agent', ...work, refs: ['img.png', 'doc.dat', 'p.svg', 's.pdf', 'doc.docx', 'noext'], messages: [] },
  { name: 'unsupported type', surface: 'session', ...work, refs: ['a.txt', 'x.exe'], messages: [] },
  { name: 'binary without extension', surface: 'session', ...work, refs: ['blob'], messages: [] },
  { name: 'over the per-file limit', surface: 'agent', ...work, refs: ['huge.txt'], messages: [] },
  { name: 'over the total limit', surface: 'session', ...work, refs: ['bigA.txt', 'bigB.txt'], messages: [] },
  { name: 'empty file', surface: 'session', ...work, refs: ['empty.txt'], messages: [] },
  { name: 'missing', surface: 'agent', ...work, refs: ['missing.txt'], messages: [] },
  { name: 'a folder', surface: 'session', ...work, refs: ['folder.txt'], messages: [] },
  { name: 'outside the roots', surface: 'session', ...work, refs: ['<tmp>/outside/o.txt'], messages: [] },
  { name: 'outside by dot-dot', surface: 'agent', ...work, refs: ['../outside/o.txt'], messages: [] },
  { name: 'a secret file', surface: 'session', ...work, refs: ['.env'], messages: [] },
  { name: 'mixdog state', surface: 'session', cwd: '<tmp>', roots: ['<tmp>'], refs: ['<tmp>/data-dir/ok.txt', '<tmp>/home/mixdog-config.json'], messages: [] },
  { name: 'no roots', surface: 'session', cwd: '<tmp>/work', roots: [], refs: ['a.txt'], messages: [] },
  { name: 'cwd absent', surface: 'agent', cwd: '', roots: ['<tmp>/work'], refs: ['<tmp>/work/a.txt'], messages: [] },
  { name: 'a NUL in the path', surface: 'session', ...work, refs: ['a\u0000.txt'], messages: [] },
  { name: 'by id: a part', surface: 'session', ...work, refs: [imageId], messages: shown },
  { name: 'by id: a text file part', surface: 'agent', ...work, refs: [notesId], messages: shown },
  { name: 'by id: a record', surface: 'session', ...work, refs: [reportId], messages: shown },
  { name: 'by id: a room speech part', surface: 'session', ...work, refs: [newerNotesId], messages: shown },
  { name: 'by id: only an assistant names it', surface: 'session', ...work, refs: [reportId], messages: shown.slice(1, 2) },
  { name: 'by id: only a plain text part names it', surface: 'session', ...work, refs: [reportId], messages: shown.slice(0, 1) },
  { name: 'by id: unknown', surface: 'agent', ...work, refs: ['f'.repeat(64)], messages: shown },
  { name: 'by id: upper case is a path', surface: 'session', ...work, refs: [imageId.toUpperCase()], messages: shown },
  { name: 'by id: no longer stored', surface: 'session', ...work, refs: [goneId], messages: shown },
  { name: 'by id: a room pass row names nothing', surface: 'session', ...work, refs: [goneId], messages: shown.slice(4) },
  { name: 'by name', surface: 'session', ...work, refs: ['photo.png', 'report.pdf'], messages: shown },
  { name: 'by name: the newest of that name', surface: 'agent', ...work, refs: ['notes.md'], messages: shown },
  { name: 'by name: no longer stored', surface: 'agent', ...work, refs: ['gone.pdf'], messages: shown },
  { name: 'by name: a name wins over a file', surface: 'session', ...work, refs: ['a.txt'], messages: [upload([{ type: 'image', attachmentRef: imageId, filename: 'a.txt' }])] },
  { name: 'by name: the forged name is a path', surface: 'session', ...work, refs: ['forged.pdf'], messages: shown },
  { name: 'ids, names and paths', surface: 'session', ...work, refs: [imageId, 'notes.md', 'a.txt', reportId, 'photo.png'], messages: shown },
  { name: 'defaults of a bare part', surface: 'session', ...work, refs: [imageId, notesId, reportId], messages: [upload([{ type: 'image', attachmentRef: imageId }, { type: 'text', textKind: 'paste', attachmentRef: notesId }, { type: 'file', attachmentRef: reportId, filename: 'n'.repeat(250), mimeType: 'm'.repeat(150) }])] },
  { name: 'a later mention moves an id last', surface: 'session', ...work, refs: ['same.txt'], messages: [upload([{ type: 'file', attachmentRef: imageId, filename: 'same.txt' }, { type: 'file', attachmentRef: notesId, filename: 'same.txt' }]), upload([{ type: 'image', attachmentRef: imageId, filename: 'same.txt' }])] },
  { name: 'messages not a list', surface: 'session', ...work, refs: [imageId], messages: null },
];
const resolveResults = resolveCases.map((spec) => {
  const input = fill(spec);
  let result;
  try {
    result = handoff.resolveHandoffAttachments(input.refs, { messages: input.messages ?? undefined, roots: input.roots.map((root) => resolve(root)), cwd: input.cwd, surface: input.surface });
  } catch (error) {
    result = { error: error.message };
  }
  const text = JSON.stringify(result).replaceAll(tmp.replaceAll('\\', '\\\\'), '<tmp>').replaceAll(tmp.replaceAll('\\', '/'), '<tmp/>');
  return { ...spec, result: JSON.parse(text) };
});
const resolved = { stored: storedTexts, cases: resolveResults };
rmSync(tmp, { recursive: true, force: true });
const collect = { files: treeFiles, cases: artifactResults };
writeJson(join(stage, 'golden.json'), { inFlight: { stages: stagesList, cases: recorded, sequence }, backgroundTasks: { registered, agentTasks, agentTaskOwners }, handoff: { turnSlices, scopes, sensitive, collect, resolve: resolved } });
writeSetManifest(stage, { set: 'session-activity', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
process.once('beforeExit', () => process.exit(0));
console.log(`session activity: ${recorded.length} cases, ${sequence.length} sequence steps`);
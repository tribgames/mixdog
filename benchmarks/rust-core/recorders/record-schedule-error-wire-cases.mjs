#!/usr/bin/env node
// Recording of apps/desktop/src/main/schedule-error-wire.test.mjs (b6f10295a): every schedule rename refusal across every hop of the
// real path (the engine's coded error -> the daemon's POST /call envelope (createCallRoute) -> the session client
// (createAttachmentCalls) -> SessionTransport -> DesktopServiceClient -> the IPC error envelope -> the preload's contextBridge clone ->
// scheduleErrorText) with the Korean bundle. Per refusal: the error's code and name param as the Schedules view receives them, the
// translated text and the English message it is not.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-schedule-error-wire-cases.mjs --tree <export of b6f10295a with node_modules>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { scriptUuids } from './lib/scripted-uuid.mjs';
import { parseArgs, resolveTree } from './lib/common.mjs';

const scriptedUuids = scriptUuids();
const set = openSet('schedule-error-wire-cases', import.meta.url);
const tree = resolveTree(parseArgs());
const { createAttachmentCalls } = await set.load('src/standalone/session-client/attachment-calls.mjs');
const { createCallRoute } = await set.load('src/standalone/session-transport/call-route.mjs');
const { scheduleNameTakenError, scheduleRenameReloadError, scheduleRenameRunningError, scheduleRenameUncertainError } = await set.load('src/runtime/channels/lib/schedule-errors.mjs');
const { default: i18n, t } = await set.load('apps/desktop/src/renderer/i18n.ts');
const { scheduleErrorText } = await set.load('apps/desktop/src/renderer/schedule-error-text.ts');
const { errorParams, ipcErrorEnvelope, ipcErrorFromEnvelope } = await set.load('apps/desktop/src/shared/coded-error.ts');
const { scheduleErrorCode } = await set.load('apps/desktop/src/shared/schedule-error-codes.ts');
const { DesktopServiceClient } = await set.load('apps/desktop/src/main/desktop-service-client.ts');
const { SessionTransport } = await set.load('apps/desktop/src/main/session-transport.ts');

/** The /call exchange as it crossed the daemon wire: the request body the session client sent and the head and text the daemon route answered. */
let wireLog = [];
const options = { userDataPath: 'C:/tmp/mixdog', packaged: true, resourcesPath: 'C:/tmp/resources', appPath: 'C:/tmp/resources/app.asar' };
function daemonCall(failure) {
  const route = createCallRoute({ handleCall: async () => { throw failure; }, clients: new Map([['client', { leadPid: null, cwd: null, revision: 1, lastSeen: 0 }]]), lanes: { dispatch: (_owner, run) => run() }, callCache: { get: () => null, track() {} }, nowMs: () => 0, onCallStarted() {}, onCallSettled() {} });
  return createAttachmentCalls({ request: ({ body }) => new Promise((resolve) => { const head = []; const res = { writeHead(...args) { head.push(args); }, end: (text) => { wireLog.push({ direction: 'client->daemon /call', body }, { direction: 'daemon->client', writeHead: head, text }); resolve(JSON.parse(text)); } }; void route(body, res); }), port: 1, serverToken: 'server', clientToken: 'client', stopStream() {}, log() {} }).call;
}
// contextBridge hands the page an Error with only message and stack (checked against Electron 41 in the Node test).
const acrossContextBridge = (error) => { const page = new Error(error.message); page.stack = error.stack; return page; };
async function savedWith(failure) {
  const call = daemonCall(failure);
  const transport = new SessionTransport('file:///C:/tmp/daemon.cjs', process.cwd(), async () => ({
    ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
    attachSession: async () => ({ async call(name, args, callOptions) { if (name === 'desktop.init') return { desktopId: 'desktop_schedule' }; if (name === 'desktop.invoke') return call(name, args, callOptions); return { ok: true }; }, async close() {} }),
  }));
  const client = new DesktopServiceClient({ connect: () => transport, sessionOptions: () => options });
  try {
    await client.start();
    const envelope = await client.invokeCapability('saveSchedule', [{ name: 'other', newName: 'once-renamed' }]).then(() => ({ notRefused: true }), (error) => ipcErrorEnvelope(error));
    if (envelope.notRefused) return null;
    return acrossContextBridge(ipcErrorFromEnvelope(structuredClone(envelope)));
  } finally { await client.close?.(); }
}
const korean = JSON.parse(readFileSync(join(tree, 'apps/desktop/src/renderer/locales/ko.json'), 'utf8'));

await set.run('every schedule rename refusal reaches the Schedules view translated, with its code and name', async () => {
  i18n.addResourceBundle('ko', 'translation', korean);
  await i18n.changeLanguage('ko');
  try {
    const cases = [
      [scheduleNameTakenError('once-renamed'), 'A schedule named "{{name}}" already exists.', 'once-renamed'],
      [scheduleRenameRunningError('other'), 'Schedule "{{name}}" is running. Rename it after the run finishes.', 'other'],
      [scheduleRenameReloadError('once-renamed', 'timeout'), 'Renamed to "{{name}}", but the scheduler could not reload. It is armed on the next reload.', 'once-renamed'],
      [scheduleRenameUncertainError('timeout'), 'The rename may or may not have applied because the scheduler did not answer. Check the schedule list.', undefined],
    ];
    const results = [];
    for (const [failure, key, name] of cases) {
      wireLog = [];
      const received = await savedWith(failure);
      if (received === null) { results.push({ code: failure.code, refused: false }); continue; }
      const text = scheduleErrorText(received);
      results.push({
        wire: wireLog,
        engineError: failure,
        sentToPage: received, sentToPageOwnPropertyNames: Object.getOwnPropertyNames(received),
        code: scheduleErrorCode(received), nameParam: errorParams(received)?.name,
        translationKey: key, expectedText: t(key, name ? { name } : {}), text,
      });
    }
    return { language: 'ko', results };
  } finally { await i18n.changeLanguage('en'); }
});

await set.finish({
  entry: { hops: "The daemon /call exchange is the real createCallRoute + createAttachmentCalls: the request body and the response head and text of every call are recorded under each result's `wire`; the IPC envelope and the contextBridge clone are the real coded-error.ts and the Node test's message+stack Error.", runs: 'channels/lib/schedule-errors.mjs -> session-transport/call-route.mjs createCallRoute -> session-client/attachment-calls.mjs -> apps/desktop SessionTransport + DesktopServiceClient -> coded-error.ts envelope -> a contextBridge-shaped Error -> renderer schedule-error-text.ts with the Korean locale', scripted: { source: scriptedUuids.source },
  notRun: 'no real daemon or Electron: the daemon call is the real route with a throwing handler, the preload clone is the Node test\'s message+stack Error' },
  replaceRegex: [[/desktop_\d+_/g, 'desktop_<pid>_']],
  normaliseReason: 'the desktop id inside callId is desktop_<process id>_<scripted uuid>: the process id of the recording run is written <pid>',
  replay: { entry: 'mixdog-services scheduler rename errors + the desktop wire: each refusal keeps its code and name param through the envelope and renders the Korean text', normalised: {} },
});
process.exit(0);

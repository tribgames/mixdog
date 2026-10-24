// A schedule rename refused as a duplicate name must reach the Schedules view
// with its code AND `name` param across every hop of the real path: the
// engine's coded error → the daemon's POST /call envelope → the session
// client → the desktop's SessionTransport → DesktopServiceClient → the main
// IPC handler's error envelope → the preload → scheduleErrorText.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAttachmentCalls } from '../../../../src/standalone/session-client/attachment-calls.mjs';
import { createCallRoute } from '../../../../src/standalone/session-transport/call-route.mjs';
import {
  scheduleNameTakenError,
  scheduleRenameReloadError,
  scheduleRenameRunningError,
  scheduleRenameUncertainError,
} from '../../../../src/runtime/channels/lib/schedule-errors.mjs';
import i18n, { t } from '../renderer/i18n.ts';
import { scheduleErrorText } from '../renderer/schedule-error-text.ts';
import { errorParams, ipcErrorEnvelope, ipcErrorFromEnvelope } from '../shared/coded-error.ts';
import { scheduleErrorCode } from '../shared/schedule-error-codes.ts';
import { DesktopServiceClient } from './desktop-service-client.ts';
import { SessionTransport } from './session-transport.ts';

const options = {
  userDataPath: 'C:/tmp/mixdog',
  packaged: true,
  resourcesPath: 'C:/tmp/resources',
  appPath: 'C:/tmp/resources/app.asar',
};

/** The failure `desktop.invoke` throws in the daemon, carried by the real
 *  /call route and parsed by the real session-client attachment. */
function daemonCall(failure) {
  const route = createCallRoute({
    handleCall: async () => {
      throw failure;
    },
    clients: new Map([['client', { leadPid: null, cwd: null, revision: 1, lastSeen: 0 }]]),
    lanes: { dispatch: (_owner, run) => run() },
    callCache: { get: () => null, track() {} },
    nowMs: () => 0,
  });
  const attachment = createAttachmentCalls({
    request: ({ body }) =>
      new Promise((resolve) => {
        const res = {
          writeHead() {},
          end: (text) => resolve(JSON.parse(text)),
        };
        void route(body, res);
      }),
    port: 1,
    serverToken: 'server',
    clientToken: 'client',
    stopStream() {},
    log() {},
  });
  return attachment.call;
}

/** The preload exposes its API with `contextBridge`, which hands the page a
 *  rejected Error with only its `message` and `stack`: every other own
 *  property (`code`, `details`, `name`, `cause`) is gone. Checked against
 *  Electron 41 (`Object.getOwnPropertyNames` of the page's error is
 *  `["stack", "message"]`). */
function acrossContextBridge(error) {
  const page = new Error(error.message);
  page.stack = error.stack;
  return page;
}

/** What the Schedules view receives from `invokeCapability('saveSchedule')`. */
async function savedWith(failure) {
  const call = daemonCall(failure);
  const transport = new SessionTransport('file:///C:/tmp/daemon.cjs', process.cwd(), async () => ({
    ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
    attachSession: async () => ({
      async call(name, args, callOptions) {
        if (name === 'desktop.init') return { desktopId: 'desktop_schedule' };
        if (name === 'desktop.invoke') return call(name, args, callOptions);
        return { ok: true };
      },
      async close() {},
    }),
  }));
  const client = new DesktopServiceClient({ connect: () => transport, sessionOptions: () => options });
  try {
    await client.start();
    // Main's IPC handler returns the error envelope; Electron clones it; the preload rebuilds the Error.
    const envelope = await client.invokeCapability('saveSchedule', [{ name: 'other', newName: 'once-renamed' }]).then(
      () => assert.fail('the save should be refused'),
      (error) => ipcErrorEnvelope(error)
    );
    return acrossContextBridge(ipcErrorFromEnvelope(structuredClone(envelope)));
  } finally {
    await client.close?.();
  }
}

const korean = JSON.parse(readFileSync(new URL('../renderer/locales/ko.json', import.meta.url), 'utf8'));

test('every schedule rename refusal reaches the Schedules view translated, with its code and name', async () => {
  i18n.addResourceBundle('ko', 'translation', korean);
  await i18n.changeLanguage('ko');
  try {
    const cases = [
      [scheduleNameTakenError('once-renamed'), 'A schedule named "{{name}}" already exists.', 'once-renamed'],
      [
        scheduleRenameRunningError('other'),
        'Schedule "{{name}}" is running. Rename it after the run finishes.',
        'other',
      ],
      [
        scheduleRenameReloadError('once-renamed', 'timeout'),
        'Renamed to "{{name}}", but the scheduler could not reload. It is armed on the next reload.',
        'once-renamed',
      ],
      [
        scheduleRenameUncertainError('timeout'),
        'The rename may or may not have applied because the scheduler did not answer. Check the schedule list.',
        undefined,
      ],
    ];
    for (const [failure, key, name] of cases) {
      const received = await savedWith(failure);
      assert.equal(scheduleErrorCode(received), failure.code, `${failure.code}: code`);
      assert.equal(errorParams(received)?.name, name, `${failure.code}: name`);
      const text = scheduleErrorText(received);
      assert.equal(text, t(key, name ? { name } : {}), failure.code);
      assert.notEqual(text, failure.message, `${failure.code}: shown in Korean, not the English message`);
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

// A schedule rename is sent, then its socket drops and reconciliation fails. The uncertainty must reach the
// Korean Schedules view even though contextBridge strips custom Error properties.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../../packages/protocol-client/src/mock.ts';
import i18n from '../../renderer/i18n.ts';
import { scheduleErrorText } from '../../renderer/schedule-error-text.ts';
import { errorParams, ipcErrorEnvelope, ipcErrorFromEnvelope } from '../../shared/coded-error.ts';
import { scheduleErrorCode } from '../../shared/schedule-error-codes.ts';
import { createCapabilityLane } from './capability-route.ts';
import { createProtocolConnection } from './connection.ts';

const options = JSON.parse(readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8'));
const korean = JSON.parse(readFileSync(new URL('../../renderer/locales/ko.json', import.meta.url), 'utf8'));
const CONTROL = 'thr_control';
const TRANSLATION_KEY = 'The rename may or may not have applied because the scheduler did not answer. Check the schedule list.';
const KOREAN_WARNING = '스케줄러가 응답하지 않아 이름 바꾸기가 적용되었는지 알 수 없습니다. 스케줄 목록을 확인해 주세요.';
/** How long a frame of the scripted core, or the call's settlement, may take. */
const DEADLINE_MS = 10_000;

const within = (promise, what) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS} ms awaiting ${what}`)), DEADLINE_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/** The page gets an Error with only the message and stack. */
const acrossContextBridge = (error) => {
  const page = new Error(error.message);
  page.stack = error.stack;
  return page;
};

/** The scripted core of one socket: it answers the handshake and the app subscription, starts the control thread, receives
 *  the rename and drops the socket before answering it; on the next socket it answers the reconciliation with an error. */
async function serve(conn, generation, seen) {
  for (;;) {
    const frame = JSON.parse(await within(conn.nextSent(), `frame ${seen.frames.length + 1} from the client`));
    seen.frames.push(frame.method);
    switch (frame.method) {
      case 'initialize':
        conn.serverSend({ id: frame.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
        break;
      case 'initialized':
        break;
      case 'app/subscribe':
        conn.serverSend({ id: frame.id, result: { subscription: { id: 'as', mode: 'snapshot', epoch: `ae${generation}`, startSeq: 2 } } });
        conn.serverSend({ method: 'app/snapshot', params: { sections: [] }, feed: { id: 'app', epoch: `ae${generation}`, seq: 1 } });
        break;
      case 'thread/start':
      case 'thread/resume':
        // The client holds the control thread it started and resumes it after a reconnect, before any request naming it.
        conn.serverSend({
          id: frame.id,
          result: {
            thread: { id: CONTROL },
            subscription: { id: CONTROL, mode: 'snapshot', epoch: `te${generation}`, startSeq: 1, liveSeq: 1 },
          },
        });
        break;
      case 'channel/saveSchedule':
        seen.saves.push(frame.params);
        conn.serverClose(1006);
        return;
      case 'op/status':
        seen.statuses.push(frame.params);
        conn.serverSend({ id: frame.id, error: { code: -32603, message: 'internal error' } });
        return;
      default:
        throw new Error(`the scripted core was not asked for ${frame.method}`);
    }
  }
}

test('a rename whose op was cut after sending and could not be reconciled shows the uncertain-rename text', async (t) => {
  const entry = { name: 'Daily report', newName: 'Morning report' };

  const net = new MockNetwork();
  const seen = { frames: [], saves: [], statuses: [] };
  const core = (async () => {
    await serve(await net.accept(), 1, seen);
    await serve(await within(net.accept(), 'the client to reconnect'), 2, seen);
  })();
  core.catch(() => {});
  let ops = 0;
  const connection = createProtocolConnection({
    open: () =>
      connect({
        target: { id: 'core' },
        connector: net,
        clientInfo: options.clientInfo,
        capabilities: options.capabilities,
        threadReducer: sessionReducer,
        clock: { sleep: () => Promise.resolve() },
        random: () => options.jitterUnit,
        newOpId: () => `op-${++ops}`,
      }),
  });
  t.after(() => connection.close());
  await within(connection.start(), 'the connection to open');
  const lane = createCapabilityLane({ protocol: connection });

  i18n.addResourceBundle('ko', 'translation', korean);
  const previousLanguage = i18n.language;
  await i18n.changeLanguage('ko');
  try {
    const refusal = await within(
      lane.invoke('saveSchedule', [entry]).then(
        () => null,
        (error) => error
      ),
      'the rename to settle'
    );
    assert.ok(refusal, 'the rename is refused');
    // What happened on the socket: the rename op was sent once, the socket dropped before its answer, and the reconnected
    // client asked for that op's outcome and was refused.
    assert.equal(seen.saves.length, 1, `expected a sent rename before ${refusal.message}; frames: ${seen.frames.join(', ')}`);
    assert.deepEqual(seen.saves[0].entry, entry);
    assert.deepEqual(seen.statuses, [{ scope: `thread:${CONTROL}`, opIds: [seen.saves[0].opId], fence: true }]);
    await core;

    // ipc.ts `refusal`: a coded refusal is returned as an envelope; Electron clones it; the preload rebuilds it.
    const envelope = ipcErrorEnvelope(refusal);
    assert.ok(envelope, 'the refusal carries a code across IPC');
    const received = acrossContextBridge(ipcErrorFromEnvelope(structuredClone(envelope)));
    const name = errorParams(received)?.name;
    assert.deepEqual(
      {
        sentToPage: { name: received.name, message: received.message },
        sentToPageOwnPropertyNames: Object.getOwnPropertyNames(received),
        code: scheduleErrorCode(received),
        nameParam: name,
        expectedText: i18n.t(TRANSLATION_KEY),
        text: scheduleErrorText(received),
      },
      {
        sentToPage: {
          name: 'Error',
          message: 'The rename may or may not have applied (the scheduler did not answer: opOutcomeUnknown). Check the schedule list.\n[worktree-details] {"code":"SCHEDULE_RENAME_UNCERTAIN"}',
        },
        sentToPageOwnPropertyNames: ['stack', 'message'],
        code: 'SCHEDULE_RENAME_UNCERTAIN',
        nameParam: undefined,
        expectedText: KOREAN_WARNING,
        text: KOREAN_WARNING,
      }
    );
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

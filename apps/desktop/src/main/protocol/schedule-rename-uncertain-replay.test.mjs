// Replay of the fourth case of native/core/fixtures/schedule-error-wire-cases (record-schedule-error-wire-cases.mjs, Node
// b6f10295a): a schedule rename whose answer never came back. Node raised SCHEDULE_RENAME_UNCERTAIN when the session runtime's
// call to its channel worker failed (src/session-runtime/channel-config-api.mjs:63), and the Schedules view showed
// "the rename may or may not have applied" in Korean. The core has no worker hop; what leaves a K1 user with the same unknown
// outcome is the rename op cut after it was sent and its reconciliation failing (`op/status` answering an error, client.ts
// reconcileScope: `opOutcomeUnknown`). That is what runs here, through the product's own pieces: the client library over a
// scripted core socket, the desktop's protocol connection and capability lane (the Schedules view's `saveSchedule`), the IPC
// envelope the main process returns (ipc.ts `refusal`), its structured clone, the preload's rebuild and the contextBridge
// clone (message and stack, as the recorder made it), then `scheduleErrorText` with the Korean bundle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../../packages/protocol-client/src/mock.ts';
import i18n, { t } from '../../renderer/i18n.ts';
import { scheduleErrorText } from '../../renderer/schedule-error-text.ts';
import { errorParams, ipcErrorEnvelope, ipcErrorFromEnvelope } from '../../shared/coded-error.ts';
import { scheduleErrorCode } from '../../shared/schedule-error-codes.ts';
import { createCapabilityLane } from './capability-route.ts';
import { createProtocolConnection } from './connection.ts';

const fixture = (path) => new URL(`../../../../../${path}`, import.meta.url);
const golden = JSON.parse(readFileSync(fixture('native/core/fixtures/schedule-error-wire-cases/golden.json'), 'utf8'));
const options = JSON.parse(readFileSync(fixture('packages/protocol-client/conformance/options.json'), 'utf8'));
const korean = JSON.parse(readFileSync(new URL('../../renderer/locales/ko.json', import.meta.url), 'utf8'));
const CONTROL = 'thr_control';
/** How long a frame of the scripted core, or the call's settlement, may take. */
const DEADLINE_MS = 10_000;

const within = (promise, what) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS} ms awaiting ${what}`)), DEADLINE_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/** The recorder's contextBridge clone: the page gets an Error with only the message and stack. */
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
        conn.serverSend({ id: frame.id, result: { thread: { id: CONTROL } } });
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

test('a rename whose op was cut after sending and could not be reconciled shows Node\'s uncertain-rename text', async () => {
  const [recorded] = golden.cases;
  const node = recorded.observed.results[3];
  assert.equal(node.code, 'SCHEDULE_RENAME_UNCERTAIN');
  const entry = node.wire[0].request.body.args.args[1][0];

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
  await within(connection.start(), 'the connection to open');
  const lane = createCapabilityLane({ protocol: connection });

  i18n.addResourceBundle('ko', 'translation', korean);
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
    assert.equal(seen.saves.length, 1);
    assert.deepEqual(seen.saves[0].entry, entry);
    assert.deepEqual(seen.statuses, [{ scope: `thread:${CONTROL}`, opIds: [seen.saves[0].opId], fence: true }]);

    // ipc.ts `refusal`: a coded refusal is returned as an envelope; Electron clones it; the preload rebuilds it.
    const envelope = ipcErrorEnvelope(refusal);
    assert.ok(envelope, 'the refusal carries a code across IPC');
    const received = acrossContextBridge(ipcErrorFromEnvelope(structuredClone(envelope)));
    const translationKey = node.translationKey;
    const name = errorParams(received)?.name;
    // Node's message names the cause its worker transport gave (`timeout`); the core's is the client's (`opOutcomeUnknown`):
    // the one difference, declared in the manifest. The page never shows the message, only `text`.
    const nodeMessage = node.sentToPage.message.replace('(the scheduler did not answer: timeout)', '(the scheduler did not answer: opOutcomeUnknown)');
    assert.deepEqual(
      {
        sentToPage: { name: received.name, message: received.message },
        sentToPageOwnPropertyNames: Object.getOwnPropertyNames(received),
        code: scheduleErrorCode(received),
        nameParam: name,
        expectedText: t(translationKey, name ? { name } : {}),
        text: scheduleErrorText(received),
      },
      {
        sentToPage: { name: node.sentToPage.name, message: nodeMessage },
        sentToPageOwnPropertyNames: node.sentToPageOwnPropertyNames,
        code: node.code,
        nameParam: node.nameParam.$exact === 'undefined' ? undefined : node.nameParam,
        expectedText: node.expectedText,
        text: node.text,
      }
    );
  } finally {
    await i18n.changeLanguage('en');
    await connection.close();
  }
});

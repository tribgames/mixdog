// The cases of apps/desktop/src/main/approval-grant-change.test.mjs (b6f10295a), as functions of the modules they drive, so the recorder
// runs them on the Node tree and the desktop's replay runs the same steps on the product's own modules. Each returns what the test
// asserted on: the answer an approval got and the desktop operations it issued.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;
// The test's own scheduling hop: an operation announced after the answer is issued on a later turn.
const tick = () => new Promise((resolve) => setImmediate(resolve));

const TOOL = 'mcp__alpha__write_it';
const BOT = 'inspector';
const BOT_SESSION = 'sess_home_inspector';

export function approvalGrantScenarios({ DESKTOP_IPC, registerSessionIpc, registerDesktopIpc, createRemoteMethods, createDesktopOperations, createRelayPushLanes, applyConnectorApproval, setConnectorToolPermissionWriter, dataDir }) {
  function desktopAnswer(accepted = true) {
    const handlers = new Map();
    const ops = [];
    registerSessionIpc({
      handle: (channel, fn) => handlers.set(channel, fn),
      host: { resolveToolApprovalForSession: async () => accepted },
      invokeDesktopOperation: async (...args) => ops.push(args),
    });
    return { ops, answer: (decision) => handlers.get(DESKTOP_IPC.resolveToolApprovalForSession)({}, SESSION, 'a1', decision) };
  }
  function remoteAnswer(accepted = true) {
    const ops = [];
    const methods = createRemoteMethods(
      { host: { resolveToolApprovalForSession: async () => accepted, invokeDesktopOperation: async (...args) => ops.push(args) } },
      { deviceName: async () => 'Pixel 9' },
    );
    return { ops, answer: (decision) => methods.resolveToolApprovalForSession([SESSION, 'a1', decision]) };
  }
  const scenarios = {};
  for (const [label, make] of [['this PC', desktopAnswer], ['a paired phone', remoteAnswer]]) {
    scenarios[`${label}: an approval that remembers a grant broadcasts the permissions change`] = async () => {
      const runs = [];
      for (const remember of ['agent', 'always']) {
        const { ops, answer } = make();
        const answered = await answer({ approved: true, remember });
        await tick();
        runs.push({ remember, answered, ops });
      }
      return runs;
    };
    scenarios[`${label}: an approval without a remembered grant, or one not accepted, broadcasts nothing`] = async () => {
      const plain = make();
      const withoutRemember = await plain.answer({ approved: true });
      const once = await plain.answer({ approved: true, remember: 'once' });
      const refused = make(false);
      const refusedAnswer = await refused.answer({ approved: true, remember: 'agent' });
      await tick();
      return { withoutRemember, once, plainOps: plain.ops, refusedAnswer, refusedOps: refused.ops };
    };
  }

  // Who hears the announcement, through the real operations (`notifySettingsChanged`), the window's IPC and the relay's push lanes over
  // one desktop event bus (the listeners `emit` reaches, as in provider-models-changed.test.mjs): the window's deliveries of the settings
  // change, and each relay frame with the paired phones it went to. Two phones are paired; `phone-1` is the one that answers.
  const PHONES = ['phone-1', 'phone-2'];
  async function hearing(resolve) {
    const directory = mkdtempSync(join(tmpdir(), 'mixdog-approval-grant-'));
    const listeners = new Set();
    const operations = createDesktopOperations({
      userDataPath: directory,
      loadConfig: async () => ({ readConfig: () => ({}), updateConfigAsync: async (update) => update({}) }),
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
    });
    const host = {
      subscribe: () => () => {},
      subscribeSessionStates: () => () => {},
      getSnapshot: () => ({}),
      invokeDesktopOperation: operations.invoke,
      resolveToolApprovalForSession: resolve,
      subscribeDesktopEvents: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const handlers = new Map();
    const window = [];
    const mainFrame = {};
    const webContents = {
      mainFrame,
      isDestroyed: () => false,
      send: (channel, value) => channel === DESKTOP_IPC.settingsChanged && window.push(value),
      on() {},
      removeListener() {},
    };
    const ipcMain = new EventEmitter();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = (channel) => handlers.delete(channel);
    const removeIpc = registerDesktopIpc({ webContents, isDestroyed: () => false }, host, {
      app: { quit() {} },
      ipcMain,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openPath: async () => '', openExternal: async () => {} },
    });
    const clients = new Map(PHONES.map((id) => [id, { lanes: new Set(['state']) }]));
    const relay = [];
    const push = createRelayPushLanes({
      clients,
      subscribeDesktopEvents: host.subscribeDesktopEvents,
      broadcastEncrypted: (payload, droppable, include) =>
        relay.push({ payload, droppable, to: [...clients].filter(([, state]) => !include || include(state)).map(([id]) => id) }),
    });
    const methods = createRemoteMethods({ host });
    return {
      window,
      relay,
      fromThisPc: (decision) => handlers.get(DESKTOP_IPC.resolveToolApprovalForSession)({ sender: webContents, senderFrame: mainFrame }, SESSION, 'a1', decision),
      fromPhone: (decision) => methods.resolveToolApprovalForSession([SESSION, 'a1', decision]),
      /** Resolves when the first settings change reached the relay, or never (a case that announces nothing does not wait). */
      announced: new Promise((done) => {
        listeners.add(({ name }) => name === 'settings-changed' && setImmediate(done));
      }),
      async dispose() {
        push.dispose();
        removeIpc();
        await operations.dispose();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }
  scenarios['the announcement reaches this PC\'s window and every paired phone, the answering one included'] = async () => {
    const out = {};
    for (const [label, answerer] of [['thisPc', 'fromThisPc'], ['phone1', 'fromPhone']]) {
      const heard = await hearing(async () => true);
      try {
        const answered = await heard[answerer]({ approved: true, remember: 'agent' });
        await heard.announced;
        out[label] = { answered, window: heard.window, relay: heard.relay };
      } finally {
        await heard.dispose();
      }
    }
    return out;
  };

  // A grant that cannot be saved: the real connector approval of a bot's own session (applyConnectorApproval) waits on the card, the
  // card's answer goes through the desktop (the host resolves the waiting approval and accepts it), and the save is refused by the writer.
  // The call still runs once, the person is told, the stored permission is unchanged and the answer is still accepted and announced.
  const agentFile = join(dataDir, 'agents', BOT, 'agent.json');
  const policy = (permission) => JSON.stringify({ name: BOT, connectors: { off: [], tools: { alpha: { write_it: permission } } } });
  const stored = () => JSON.parse(readFileSync(agentFile, 'utf8')).connectors.tools.alpha.write_it;
  scenarios['an approval whose grant cannot be saved is accepted, announced and runs the call once'] = async () => {
    mkdirSync(join(dataDir, 'agents', BOT), { recursive: true });
    writeFileSync(join(dataDir, 'agents', BOT, 'AGENT.md'), `---\nkind: bot\n---\nYou are ${BOT}.\n`);
    const out = {};
    for (const [label, writer] of [
      ['saved', async (_agent, _server, _tool, permission) => writeFileSync(agentFile, policy(permission))],
      ['refused', async () => { throw new Error('disk full'); }],
    ]) {
      writeFileSync(agentFile, policy('needs_approval'));
      setConnectorToolPermissionWriter(writer);
      let settle;
      const decided = new Promise((resolve) => { settle = resolve; });
      let shown;
      const cardShown = new Promise((resolve) => { shown = resolve; });
      const notices = [];
      const hook = Object.assign(async () => { shown(); return decided; }, { notice: (text, tone) => notices.push([text, tone]) });
      const heard = await hearing(async (_session, _id, decision) => { settle(decision); return true; });
      try {
        const run = applyConnectorApproval({ name: TOOL, args: {}, cwd: '/tmp' }, { agentId: BOT, callerSessionId: BOT_SESSION, executeOpts: {}, toolApprovalHook: hook });
        await cardShown;
        const answered = await heard.fromPhone({ approved: true, response: 'approve', remember: 'agent' });
        await heard.announced;
        const outcome = await run;
        out[label] = { answered, outcome, notices, stored: stored(), window: heard.window, relay: heard.relay };
      } finally {
        await heard.dispose();
        setConnectorToolPermissionWriter(null);
      }
    }
    return out;
  };
  return scenarios;
}

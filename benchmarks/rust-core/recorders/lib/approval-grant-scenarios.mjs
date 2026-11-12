// The cases of apps/desktop/src/main/approval-grant-change.test.mjs (b6f10295a), as functions of the modules they drive, so the recorder
// runs them on the Node tree and the desktop's replay runs the same steps on the product's own modules. Each returns what the test
// asserted on: the answer an approval got and the desktop operations it issued.
const SESSION = `sess_desktop_${'a'.repeat(64)}`;
// The test's own scheduling hop: an operation announced after the answer is issued on a later turn.
const tick = () => new Promise((resolve) => setImmediate(resolve));

export function approvalGrantScenarios({ DESKTOP_IPC, registerSessionIpc, createRemoteMethods }) {
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
  return scenarios;
}

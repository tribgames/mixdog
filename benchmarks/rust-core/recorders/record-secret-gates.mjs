#!/usr/bin/env node
// Goldens of the two locks a secret fill checks before it takes its value (WP-SESSION `wu-secret-input`),
// each from the real Node code that holds them today:
//   gates.json   `createTakeoverGate` of apps/desktop/src/main/takeover-gate.ts (`assertFree` of a session's
//                Browser Use) over `withHumanOnlyApproval` / `beginComputerOperation` of human-only-approval.ts
//                (the screen: Computer Use refuses new operations while a human-only approval is pending)
//
// Run from apps/desktop with tsx:
//   (cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-secret-gates.mjs --tree <tree>)
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createTakeoverGate } = await importFrom(tree, 'apps/desktop/src/main/takeover-gate.ts');
const { beginComputerOperation, withHumanOnlyApproval } = await importFrom(tree, 'apps/desktop/src/main/human-only-approval.ts');

const outDir = join(FIXTURES_ROOT, 'secret-gates');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SESSIONS = ['T', 'U', 'S'];
const computerFree = () => {
  try {
    beginComputerOperation()();
    return true;
  } catch {
    return false;
  }
};

const cases = [];
async function scenario(name, steps, { expiryMs = 15 * 60_000 } = {}) {
  const gate = createTakeoverGate(withHumanOnlyApproval, expiryMs);
  const approvals = new Map();
  const observed = [];
  const current = new Map();
  const snapshot = (sessionId, approval) => gate.onSessionState({ sessionId, snapshot: { toolApproval: approval } });
  for (const step of steps) {
    if (step.do === 'takeover') {
      current.set(step.thread, step.id);
      snapshot(step.thread, { id: step.id, kind: 'takeover', takeover: { surface: step.surface } });
      // The sub-agent's takeover is shown, as a copy, in the chat of the session that works for it.
      if (step.copyTo) snapshot(step.copyTo, { id: step.id, kind: 'takeover', surfaceSessionId: step.copyTo, takeover: { surface: step.surface } });
    } else if (step.do === 'resolve') {
      snapshot(step.thread, null);
      if (step.copyTo) snapshot(step.copyTo, null);
    } else if (step.do === 'browserApproval') {
      let finish = () => {};
      const pending = new Promise((resolve) => (finish = resolve));
      approvals.set(step.id, { finish, done: withHumanOnlyApproval(() => pending) });
    } else if (step.do === 'answerBrowserApproval') {
      const entry = approvals.get(step.id);
      entry.finish();
      await entry.done;
    } else if (step.do === 'wait') {
      await sleep(step.ms);
    } else {
      const free = {};
      for (const session of SESSIONS) {
        try {
          gate.assertFree(session);
          free[session] = true;
        } catch {
          free[session] = false;
        }
      }
      observed.push({ browserFree: free, computerFree: computerFree() });
    }
    // The screen hold of a takeover that ended lets go a few ticks later, never at once.
    await sleep(3);
  }
  gate.dispose();
  for (const entry of approvals.values()) {
    entry.finish();
    await entry.done;
  }
  await sleep(5);
  if (!computerFree()) throw new Error(`scenario "${name}" left the screen held`);
  cases.push({ name, expiryMs, steps, observed });
}
const observe = { do: 'observe' };
await scenario('nothing is held', [observe]);
await scenario('a browser takeover holds its own session only', [{ do: 'takeover', thread: 'T', id: 'a1', surface: 'browser' }, observe, { do: 'resolve', thread: 'T' }, observe]);
await scenario('a screen takeover holds its session and the screen', [{ do: 'takeover', thread: 'T', id: 'a1', surface: 'computer' }, observe, { do: 'resolve', thread: 'T' }, observe]);
await scenario('a takeover of an agent shown as a copy in its parent chat holds the agent only', [{ do: 'takeover', thread: 'T', id: 'a1', surface: 'browser', copyTo: 'S' }, observe, { do: 'resolve', thread: 'T', copyTo: 'S' }, observe]);
await scenario('two sessions are held apart', [{ do: 'takeover', thread: 'T', id: 'a1', surface: 'browser' }, { do: 'takeover', thread: 'U', id: 'b1', surface: 'browser' }, observe, { do: 'resolve', thread: 'T' }, observe, { do: 'resolve', thread: 'U' }, observe]);
await scenario('a new takeover of a session replaces its old one', [{ do: 'takeover', thread: 'T', id: 'a1', surface: 'computer' }, { do: 'takeover', thread: 'T', id: 'a2', surface: 'browser' }, observe, { do: 'resolve', thread: 'T' }, observe]);
await scenario('a pending browser approval holds the screen and no session', [{ do: 'browserApproval', id: 'p1' }, observe, { do: 'answerBrowserApproval', id: 'p1' }, observe]);
await scenario('the screen is held until the last of its holders ends', [{ do: 'browserApproval', id: 'p1' }, { do: 'takeover', thread: 'T', id: 'a1', surface: 'computer' }, observe, { do: 'answerBrowserApproval', id: 'p1' }, observe, { do: 'resolve', thread: 'T' }, observe]);
await scenario('a screen takeover of one session leaves another session browsing', [{ do: 'takeover', thread: 'U', id: 'b1', surface: 'computer' }, observe]);
await scenario('a takeover nobody finishes frees the session and the screen at its expiry', [{ do: 'takeover', thread: 'T', id: 'a1', surface: 'computer' }, observe, { do: 'wait', ms: 150 }, observe], { expiryMs: 60 });
await scenario('a browser approval has no expiry', [{ do: 'browserApproval', id: 'p1' }, { do: 'wait', ms: 150 }, observe], { expiryMs: 60 });

const stage = stageSet(outDir);
writeJson(join(stage, 'gates.json'), { sessions: SESSIONS, cases });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'secret-gates',
  recorder: 'benchmarks/rust-core/recorders/record-secret-gates.mjs',
  command: '(cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-secret-gates.mjs --tree <tree>)',
  identityTree: tree,
});
console.log(`recorded ${cases.length} gate scenarios`);
process.exit(0);

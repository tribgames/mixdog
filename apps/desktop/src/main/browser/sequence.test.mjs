import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserSettle } from './settle.ts';
import { flowActions } from './actions/flow.ts';
import { timeBrowserCommand } from './timing.ts';
import { createBrowserChangeLatch } from './document-changes.ts';

function fixture() {
  const dom = new JSDOM('<input><output></output>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const state = new BrowserGuestStateStore();
  let url = 'https://fixture.example/form';
  let loading = false;
  const guest = { getURL: () => url, isLoading: () => loading };
  const diagnostics = state.for(guest);
  const settle = createBrowserSettle({
    diagnostics: () => diagnostics,
    evaluate: async (_guest, expression) => dom.window.eval(expression),
    quietMs: 350, domTimeoutMs: 1500, loadTimeoutMs: 8000,
  });
  const calls = [];
  let snapshots = 0;
  const snapshot = async () => {
    snapshots++;
    return { text: `Observed ${dom.window.document.querySelector('input').value}` };
  };
  const services = {
    state, settle, reply: { snapshotResult: snapshot },
    documents: {
      observeChanges: async () => ({ latch: createBrowserChangeLatch(), close: async () => {} }),
      pageText: async () => dom.window.document.body.textContent,
    },
    runCommand: async (command, signal) => {
      calls.push(command.action);
      if (command.action === 'wait') {
        return flowActions.wait({ guest, command, signal, services });
      }
      dom.window.document.querySelector('input').value = command.text || '';
      return settle.stepSettleResult(guest, signal);
    },
  };
  const context = {
    guest, services, actionSnapshot: snapshot,
    command: { action: 'sequence', steps: [{ action: 'fill', text: 'one' }, { action: 'fill', text: 'two' }] },
  };
  return {
    dom, guest, diagnostics, context, calls, services, settle,
    snapshots: () => snapshots,
    setUrl: (value) => { url = value; },
    setLoading: (value) => { loading = value; },
    close: () => dom.window.close(),
  };
}

test('a batch finishes amid unrelated DOM updates, with one final observation', async (t) => {
  const f = fixture();
  t.after(f.close);
  const ticker = f.dom.window.setInterval(() => {
    f.dom.window.document.querySelector('output').textContent = String(performance.now());
  }, 5);
  t.after(() => f.dom.window.clearInterval(ticker));
  // Exercise the public result: six edits land even though the document
  // never goes quiet. The next step observes prior rendering work.
  f.context.command.steps = Array.from({ length: 6 }, (_, index) => ({ action: 'fill', text: String(index) }));
  const result = await timeBrowserCommand(0, () => flowActions.sequence(f.context));
  assert.match(result.text, /Sequence completed 6 steps/);
  assert.match(result.text, /Observed 5/);
  assert.equal(f.snapshots(), 1);
  assert.deepEqual(result.timing.steps.map((step) => step.index), [1, 2, 3, 4, 5, 6]);
  assert.ok(result.timing.steps.every((step) => step.commandMs >= step.waitMs));
  t.diagnostic(`six-step rendering checkpoints: ${result.timing.waitMs.toFixed(1)}ms`);
});

test('a conditional wait inside a sequence does not capture an intermediate snapshot', async (t) => {
  const f = fixture();
  t.after(f.close);
  f.context.command.steps = [
    { action: 'fill', text: 'one' },
    { action: 'wait', text: 'ready' },
    { action: 'fill', text: 'two' },
  ];
  f.dom.window.document.querySelector('output').textContent = 'ready';
  const result = await flowActions.sequence(f.context);
  assert.match(result.text, /Observed two/);
  assert.deepEqual(f.calls, ['fill', 'wait', 'fill']);
  assert.equal(f.snapshots(), 1);
});

test('document replacement, SPA navigation, and pending navigation fence remaining input', async (t) => {
  for (const change of ['document', 'url', 'loading']) {
    const f = fixture();
    t.after(f.close);
    const run = f.services.runCommand;
    f.services.runCommand = async (...args) => {
      const result = await run(...args);
      if (change === 'document') f.diagnostics.documentGeneration++;
      if (change === 'url') f.setUrl('https://fixture.example/next');
      if (change === 'loading') f.setLoading(true);
      return result;
    };
    await assert.rejects(flowActions.sequence(f.context), /remaining steps were not dispatched[\s\S]*Observed one/);
    assert.deepEqual(f.calls, ['fill']);
    assert.equal(f.snapshots(), 1, 'partial progress returns recovery evidence');
  }
});

test('a dialog or a failed checkpoint stops a batch without replaying input', async (t) => {
  for (const failure of ['dialog', 'checkpoint']) {
    const f = fixture();
    t.after(f.close);
    f.services.runCommand = async () => {
      f.calls.push('dispatched');
      if (failure === 'dialog') {
        f.diagnostics.pendingDialog = { type: 'alert', message: 'stop' };
        return f.settle.stepSettleResult(f.guest);
      }
      const broken = createBrowserSettle({
        diagnostics: () => f.diagnostics,
        evaluate: async () => { throw new Error('renderer disappeared'); },
      });
      return broken.stepSettleResult(f.guest);
    };
    await assert.rejects(flowActions.sequence(f.context), /Sequence stopped at step 1/);
    assert.deepEqual(f.calls, ['dispatched']);
    assert.equal(f.snapshots(), 1);
  }
});

test('a cancelled sequence dispatches no further input', async (t) => {
  const f = fixture();
  t.after(f.close);
  const controller = new AbortController();
  f.context.signal = controller.signal;
  f.services.runCommand = async () => {
    f.calls.push('dispatched');
    controller.abort(new Error('cancelled by caller'));
    return f.settle.stepSettleResult(f.guest, controller.signal);
  };
  await assert.rejects(flowActions.sequence(f.context), /cancelled by caller/);
  assert.deepEqual(f.calls, ['dispatched']);
});

test('rendering checkpoint allows queued paints and is bounded on a throttled page', async (t) => {
  for (const throttled of [false, true]) {
    const f = fixture();
    t.after(f.close);
    if (throttled) {
      f.dom.window.requestAnimationFrame = () => 1;
      f.dom.window.cancelAnimationFrame = () => {};
    } else {
      f.dom.window.requestAnimationFrame(() => {
        f.dom.window.document.querySelector('output').textContent = 'painted';
      });
    }
    const result = await f.settle.stepSettleResult(f.guest);
    assert.equal(result.outcome, 'completed');
    if (!throttled) assert.equal(f.dom.window.document.querySelector('output').textContent, 'painted');
  }
});

test('a hidden checkpoint yields queued work without relying on animation frames', async (t) => {
  const f = fixture();
  t.after(f.close);
  Object.defineProperty(f.dom.window.document, 'hidden', { value: true });
  f.dom.window.requestAnimationFrame = () => { throw new Error('hidden frame requested'); };
  f.dom.window.setTimeout(() => {
    f.dom.window.document.querySelector('output').textContent = 'rendered task';
  }, 0);
  const result = await f.settle.stepSettleResult(f.guest);
  assert.equal(result.outcome, 'completed');
  assert.equal(f.dom.window.document.querySelector('output').textContent, 'rendered task');
});

test('host background routing works even when Chromium reports a visible document', async (t) => {
  const f = fixture();
  t.after(f.close);
  assert.equal(f.dom.window.document.hidden, false);
  f.dom.window.requestAnimationFrame = () => { throw new Error('background frame requested'); };
  f.dom.window.setTimeout(() => {
    f.dom.window.document.querySelector('output').textContent = 'background task';
  }, 0);
  const result = await f.settle.stepSettleResult(f.guest, undefined, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(f.dom.window.document.querySelector('output').textContent, 'background task');
});

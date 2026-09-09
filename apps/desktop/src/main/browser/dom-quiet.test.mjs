import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserDomQuiet } from './dom-quiet.ts';

function fixture(t, options = {}) {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let active = 0;
  const Observer = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends Observer {
    observe(...args) { active++; return super.observe(...args); }
    disconnect() { active--; return super.disconnect(); }
  };
  const signals = [];
  const wait = createBrowserDomQuiet({
    quietMs: 20, timeoutMs: 100, ...options,
    evaluate: async (_guest, expression, signal) => {
      signals.push(signal);
      signal?.throwIfAborted();
      return dom.window.eval(expression);
    },
  });
  return { dom, wait, signals, active: () => active };
}

test('quiet completion and continuous mutation timeout release their observers', async (t) => {
  for (const changing of [false, true]) {
    const f = fixture(t);
    let mutations = 0;
    const timer = changing ? f.dom.window.setInterval(() => {
      mutations++;
      f.dom.window.document.querySelector('main').textContent = String(mutations);
    }, 2) : undefined;
    await f.wait({});
    if (timer) f.dom.window.clearInterval(timer);
    assert.equal(f.active(), 0);
    if (changing) assert.ok(mutations > 1);
  }
});

test('postcondition cutoff resolves the renderer wait without aborting execution, even before registration', async (t) => {
  for (const alreadyMet of [false, true]) {
    const f = fixture(t, { quietMs: 1000, timeoutMs: 2000 });
    const controller = new AbortController();
    let satisfy;
    const until = alreadyMet ? Promise.resolve() : new Promise((resolve) => { satisfy = resolve; });
    const pending = f.wait({}, controller.signal, until);
    if (satisfy) setTimeout(satisfy, 5);
    await pending;
    assert.equal(f.active(), 0);
    assert.ok(f.signals.every((signal) => signal === controller.signal && !signal.aborted));
  }
});

test('real cancellation is not treated as a satisfied postcondition', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(f.wait({}, controller.signal), (error) => error === reason);
  assert.equal(f.active(), 0);
});

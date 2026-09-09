import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_HIT_GUARD } from './hit-target.ts';

function armedGuard() {
  const listeners = new Map();
  const view = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    setTimeout: () => 1, clearTimeout() {}, frameElement: null,
  };
  const element = { isConnected: true, ownerDocument: { defaultView: view } };
  const guard = Function(`return (${BROWSER_HIT_GUARD})`)();
  guard.call(element, 'token', false);
  const fire = (path) => {
    let prevented = 0;
    listeners.get('pointerdown')({
      isTrusted: true, composedPath: () => path,
      preventDefault: () => { prevented++; }, stopImmediatePropagation() {},
    });
    return prevented;
  };
  return { element, guard, fire };
}

test('the event-time guard accepts the control\'s own label as the landing spot', () => {
  const viaLabel = armedGuard();
  const label = { nodeType: 1, tagName: 'LABEL', control: viaLabel.element };
  assert.equal(viaLabel.fire([{ nodeType: 1, tagName: 'SPAN' }, label]), 0);
  assert.deepEqual(viaLabel.guard.call(viaLabel.element, 'token', true), { blocked: false });

  const otherLabel = armedGuard();
  const stranger = { nodeType: 1, tagName: 'LABEL', control: { isConnected: true } };
  assert.equal(otherLabel.fire([stranger]), 1, 'a label for another control is still an overlay');
  assert.deepEqual(otherLabel.guard.call(otherLabel.element, 'token', true), { blocked: true });
});
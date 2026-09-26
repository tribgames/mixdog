import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinkPressIntent } from './MarkdownLink.tsx';

const at = (pointerType, clientX, clientY, pointerId = 1) => ({ pointerType, pointerId, clientX, clientY });

test('a mouse press is the open intent; its release adds nothing', () => {
  const press = createLinkPressIntent();
  assert.equal(press.down(at('mouse', 10, 10)), true);
  assert.equal(press.up(at('mouse', 10, 10)), false);
});

for (const pointerType of ['touch', 'pen']) {
  test(`a ${pointerType} press warms only as a tap, never as the start of a scroll`, () => {
    const press = createLinkPressIntent();
    assert.equal(press.down(at(pointerType, 10, 10)), false);
    assert.equal(press.up(at(pointerType, 14, 7)), true);

    // A pan hands the gesture to the browser.
    press.down(at(pointerType, 10, 10));
    press.cancel();
    assert.equal(press.up(at(pointerType, 10, 10)), false);

    // A drag released away from the press.
    press.down(at(pointerType, 10, 10));
    assert.equal(press.up(at(pointerType, 10, 60)), false);

    // Another finger's release is not this press's tap.
    press.down(at(pointerType, 10, 10, 1));
    assert.equal(press.up(at(pointerType, 10, 10, 2)), false);
  });
}

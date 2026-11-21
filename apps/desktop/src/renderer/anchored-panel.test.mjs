import assert from 'node:assert/strict';
import test from 'node:test';

const { centeredPanelOffset } = await import('./anchored-panel.ts');

// The phone composer's context gauge: a 28px ring slot, a 220px card, a 412px
// screen with a 12px edge.
const screen = { left: 0, right: 412 };

test('the context card opens centred on its ring', () => {
  const ring = { left: 190, width: 28 };
  assert.equal(centeredPanelOffset({ trigger: ring, width: 220, bounds: screen, edge: 12 }), -96);
});

test('near a screen edge the card stops at the edge instead of running past it', () => {
  // Ring near the left end: the card starts 12px in, not off the screen.
  assert.equal(centeredPanelOffset({ trigger: { left: 40, width: 28 }, width: 220, bounds: screen, edge: 12 }), -28);
  // Ring near the right end: the card ends 12px inside the screen.
  assert.equal(centeredPanelOffset({ trigger: { left: 360, width: 28 }, width: 220, bounds: screen, edge: 12 }), -180);
});

// `capture-size-cases`, "captures fit both encoder budgets before their coordinate frame is registered": in K1 a capture is the
// desktop host's (capture-source-plan.ts: `fitCaptureImage`, the compositor's and GNOME's thumbnail size), and the size every one of
// them asks for is `computerCaptureSize`. Each recorded screen's fitted size and the geometry error, compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fromExact } from '../../../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { computerCaptureSize } from '../../../../../../src/runtime/computer-bridge/capture-size.mjs';

const golden = fromExact(JSON.parse(readFileSync(new URL('../../../../../../native/core/fixtures/capture-size-cases/golden.json', import.meta.url), 'utf8')));
const recorded = golden.cases.find((c) => c.case === 'captures fit both encoder budgets before their coordinate frame is registered').observed;

test('the desktop host fits each recorded screen to the size Node fitted it to, and refuses a geometry without pixels', () => {
  const fits = recorded.fits.map(({ width, height }) => ({ width, height, image: computerCaptureSize(width, height) }));
  assert.deepEqual(fits, recorded.fits);
  const { width, height, thrown } = recorded.invalidGeometry;
  assert.throws(() => computerCaptureSize(width, height), (error) => error.name === thrown.name && error.message === thrown.message);
});

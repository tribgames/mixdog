import assert from 'node:assert/strict';
import test from 'node:test';
import { linuxComputerPermissions } from './permissions.ts';

const ready = { state: 'ready' };
function readiness(overrides) {
  return {
    session: 'wayland',
    desktop: 'gnome',
    capabilities: {
      capture: { state: 'unknown' },
      windows: ready,
      accessibility: ready,
      semanticActions: ready,
      pointer: ready,
      keyboard: ready,
      clipboard: { ...ready, optional: true },
      ocr: { ...ready, optional: true },
      ...overrides,
    },
  };
}

test('Linux permissions carry the structured readiness and summarize it in the string fields', () => {
  const linux = readiness({});
  assert.deepEqual(linuxComputerPermissions(linux), {
    screen_capture: 'unknown',
    accessibility: 'ready',
    input: 'ready',
    linux,
  });
});

test('Linux input summary is the first input capability that is not ready', () => {
  const missing = { state: 'needs_setup', fix: 'allow_input' };
  assert.equal(linuxComputerPermissions(readiness({ pointer: missing, keyboard: missing })).input, 'needs_setup');
  assert.equal(linuxComputerPermissions(readiness({ keyboard: { state: 'unknown' } })).input, 'unknown');
  const result = linuxComputerPermissions(readiness({ pointer: missing, keyboard: missing }));
  assert.deepEqual(result.linux.capabilities.pointer, missing);
});

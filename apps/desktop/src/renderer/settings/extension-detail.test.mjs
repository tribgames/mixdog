import assert from 'node:assert/strict';
import test from 'node:test';

import { samePath } from './extension-detail.tsx';

const onPlatform = (platform, run) => {
  const held = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } });
  try {
    run();
  } finally {
    if (held) Object.defineProperty(globalThis, 'navigator', held);
    else delete globalThis.navigator;
  }
};

test('paths differing only in case are one path on Windows and macOS, two on Linux', () => {
  onPlatform('Win32', () => assert.equal(samePath('C:\\Work\\App\\', 'c:/work/app'), true));
  onPlatform('MacIntel', () => assert.equal(samePath('/Users/a/Proj', '/users/a/proj/'), true));
  onPlatform('Linux x86_64', () => {
    assert.equal(samePath('/home/a/Proj', '/home/a/proj'), false);
    assert.equal(samePath('/home/a//proj/', '/home/a/proj'), true);
  });
});

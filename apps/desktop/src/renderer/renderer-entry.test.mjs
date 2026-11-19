import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

test('Electron installs direct core after language and reaches the app without loading the phone adapter graph', async (t) => {
  const { window } = installTestDom(t, { globals: { navigator: { userAgent: 'Electron/43.0.0' } } });
  window.mixdogDesktopHost = {};
  const stages = [];
  t.mock.module('./i18n.ts', { namedExports: { initUiLanguage: () => stages.push('language') } });
  t.mock.module('./core-direct/install.ts', { namedExports: { installDirectDesktopApi: () => stages.push('desktop') } });
  t.mock.module('./boot-session-read.ts', { namedExports: { startRestoredSessionReads() {} } });
  t.mock.module('./bootstrap.tsx', {});

  // The real phone adapter graph needs Vite's eager import.meta.glob. The
  // desktop entry must succeed in this harness without even evaluating it.
  await import('./main.tsx');
  assert.deepEqual(stages, ['language', 'desktop']);
});

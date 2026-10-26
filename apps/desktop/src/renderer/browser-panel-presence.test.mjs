import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

test('a rejected browser panel report reaches the renderer diagnostics', async (t) => {
  const { window } = installTestDom(t, { rootId: 'root' });
  const diagnostics = [];
  const calls = [];
  window.mixdogDesktop = {
    rendererDiagnostic: (entry) => diagnostics.push(entry),
    browserPanelShown: async (sessionId, shown, pane) => {
      calls.push([sessionId, shown, pane]);
      throw new Error(`panel host refused ${shown}`);
    },
  };
  const { reportBrowserPanelShown } = await import('./browser-panel-presence.ts');
  reportBrowserPanelShown('s1', true, '1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['s1', true, '1']]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, 'unhandled-rejection');
  assert.equal(diagnostics[0].errorName, 'Error');
});

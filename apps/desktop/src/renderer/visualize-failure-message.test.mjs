import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom();
const { visualizeFailureMessage } = await import('./VisualizePanelExtras.tsx');

test('a preview whose file was deleted says so in the UI language, not as the raw IPC error', () => {
  const file = 'C:\\Users\\me\\AppData\\Local\\Temp\\harness\\index.html';
  const message = visualizeFailureMessage(
    new Error(`Error invoking remote method 'mixdog:visualize-command': TargetNotFoundError: target not found: ${file}`)
  );
  assert.equal(message, `File not found (it may have been deleted or moved): ${file}`);
});

test('other failures keep their own reason without the IPC wrapper', () => {
  assert.equal(
    visualizeFailureMessage(new Error("Error invoking remote method 'mixdog:visualize-command': Error: panel is busy")),
    'panel is busy'
  );
});

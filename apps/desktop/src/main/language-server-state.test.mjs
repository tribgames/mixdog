import assert from 'node:assert/strict';
import test from 'node:test';
import { LanguageServerState, sessionKey } from './language-server-state.ts';

test('a recorded status is readable under the session root when it differs from the project path', () => {
  // Callers pass the renderer's project path plus a separately resolved root;
  // keying the cache by the project path hid every missing/error/stopped
  // detail from document()/request(), which only ever read the root key.
  const state = new LanguageServerState({
    specFor: async () => null,
    capabilitiesWithDynamicRegistrations: (base) => base,
  });
  const spec = { id: 'tsserver', name: 'TypeScript', command: 'typescript-language-server', args: [] };
  const events = [];
  state.subscribeStatus((event) => events.push(event));
  const emitted = state.emitStatus(
    'project-1',
    '/workspaces/project-1',
    'typescript',
    spec,
    'missing',
    'typescript-language-server is not installed.'
  );
  assert.deepEqual(state.state(sessionKey('/workspaces/project-1', spec)), emitted);
  assert.equal(state.state(sessionKey('project-1', spec)), undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].projectPath, 'project-1');
  assert.equal(events[0].detail, 'typescript-language-server is not installed.');
});

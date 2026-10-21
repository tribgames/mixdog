import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionChangesCwd, sessionOwnsWorkspace } from './workspace-targets.ts';

const registered = (path) => (path === '/projects/repo' ? path : '');

test('a bot or task session owns its workspace; a registered project session does not', () => {
  const sessions = [
    { id: 'bot', projectPath: '' },
    { id: 'task' },
    { id: 'proj', projectPath: '/projects/repo' },
    { id: 'gone', projectPath: '/projects/removed' },
  ];
  assert.equal(sessionOwnsWorkspace(sessions, registered, 'bot'), true);
  assert.equal(sessionOwnsWorkspace(sessions, registered, 'task'), true);
  assert.equal(sessionOwnsWorkspace(sessions, registered, 'gone'), true);
  assert.equal(sessionOwnsWorkspace(sessions, registered, 'proj'), false);
  assert.equal(sessionOwnsWorkspace(sessions, registered, 'unlisted'), false);
});

test('Changes of a session that owns its workspace never fall back to the pane project', () => {
  const quickAccessProject = '/home/user/huge-tree';
  assert.equal(
    sessionChangesCwd(true, '/data/workspace/unclassified', quickAccessProject),
    '/data/workspace/unclassified'
  );
  // Lane not loaded yet: no folder, so no Git read of an unrelated tree.
  assert.equal(sessionChangesCwd(true, undefined, quickAccessProject), '');
  assert.equal(sessionChangesCwd(false, '/data/workspace/unclassified', '/projects/repo'), '/projects/repo');
});

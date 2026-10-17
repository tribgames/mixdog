import assert from 'node:assert/strict';
import test from 'node:test';
import { readPromptHistory, writePromptHistory } from './composer-support.tsx';
import { purgeRemoteConversationCaches } from './remote-conversation-privacy.ts';
import { readCachedSessionCatalog, writeCachedSessionCatalog } from './session-catalog-cache.ts';
import { readStudioDraftMetadata, writeStudioDraftMetadata } from './studio-draft-cache.ts';

const originalWindow = globalThis.window;

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
  };
}

function surface(kind, local) {
  globalThis.window =
    kind === 'remote'
      ? {
          location: { pathname: '/d/device-a/', protocol: 'https:', origin: 'https://relay.test' },
          localStorage: local,
        }
      : { location: { pathname: '/', protocol: 'file:', origin: 'null' }, localStorage: local };
}

test.afterEach(() => {
  globalThis.window = originalWindow;
});

const row = { id: 'session_a', title: 'Private title', preview: 'Private preview' };
const studioDraft = {
  kind: 'image',
  laneId: '',
  model: '',
  options: { aspectRatio: '1:1', resolution: '', size: '', quality: '', duration: 5 },
  prompt: 'private studio prompt',
};

test('remote surface keeps conversation content in memory only', () => {
  const local = fakeStorage();
  surface('remote', local);
  writePromptHistory('s1', [{ text: 'private prompt' }]);
  writeCachedSessionCatalog([row]);
  writeStudioDraftMetadata(studioDraft);
  assert.equal(local.values.size, 0);
  assert.equal(readPromptHistory('s1')[0].text, 'private prompt');
  assert.equal(readCachedSessionCatalog()[0].title, 'Private title');
  assert.equal(readStudioDraftMetadata().prompt, 'private studio prompt');
});

test('desktop still persists conversation content', () => {
  const local = fakeStorage();
  surface('desktop', local);
  writePromptHistory('s1', [{ text: 'prompt' }]);
  writeCachedSessionCatalog([row]);
  writeStudioDraftMetadata(studioDraft);
  assert.equal(local.values.size, 3);
  assert.equal(readPromptHistory('s1')[0].text, 'prompt');
  assert.equal(readCachedSessionCatalog()[0].title, 'Private title');
});

test('remote startup clears legacy conversation caches but keeps settings', () => {
  const local = fakeStorage({
    'mixdog.desktop-session-catalog.v1:scope:remote%3Ax': '{}',
    'mixdog.desktop.prompt-history.v1:s1': '[]',
    'mixdog.studio-draft.v1': '{}',
    'mixdog.remote-token': 'keep',
    'mixdog.theme': 'dark',
  });
  const session = fakeStorage({ 'mixdog:visualize-feedback:v1': '[]', other: '1' });
  const deleted = [];
  surface('remote', local);
  purgeRemoteConversationCaches(local, session, { deleteDatabase: (name) => deleted.push(name) });
  assert.deepEqual([...local.values.keys()], ['mixdog.remote-token', 'mixdog.theme']);
  assert.deepEqual([...session.values.keys()], ['other']);
  assert.deepEqual(deleted, ['mixdog-image-previews', 'mixdog-studio-cache', 'mixdog-remote-roster']);
});

test('desktop startup leaves its caches alone', () => {
  const local = fakeStorage({ 'mixdog.desktop.prompt-history.v1:s1': '[]' });
  const deleted = [];
  surface('desktop', local);
  purgeRemoteConversationCaches(local, fakeStorage(), { deleteDatabase: (name) => deleted.push(name) });
  assert.equal(local.values.size, 1);
  assert.deepEqual(deleted, []);
});

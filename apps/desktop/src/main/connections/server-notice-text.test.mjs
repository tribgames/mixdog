import assert from 'node:assert/strict';
import test from 'node:test';

import { localizeServerNotice } from './server-notice-text.ts';

const german = (key) =>
  ({
    'Connection to {{name}} lost': 'Verbindung zu {{name}} getrennt',
    'Reconnected to {{name}}': 'Wieder verbunden mit {{name}}',
    'Mixdog is reconnecting automatically.': 'Mixdog verbindet sich automatisch neu.',
  })[key] ?? key;

test('the fixed words of a server notice are shown in this PC’s language, with the server’s name in place', () => {
  assert.deepEqual(
    localizeServerNotice({ title: 'Connection to My Box lost', body: 'Mixdog is reconnecting automatically.' }, german),
    { title: 'Verbindung zu My Box getrennt', body: 'Mixdog verbindet sich automatisch neu.' }
  );
  assert.equal(localizeServerNotice({ title: 'Reconnected to a.b (x)', body: 'x' }, german).title, 'Wieder verbunden mit a.b (x)');
});

test('a session’s own words and a title that only resembles a fixed one are left as they are', () => {
  const content = { title: 'Box · Connection to the database lost', body: 'The build finished.' };
  assert.deepEqual(localizeServerNotice(content, german), content);
  assert.deepEqual(localizeServerNotice({ title: 'Reconnected to', body: 'b' }, german), { title: 'Reconnected to', body: 'b' });
});

test('a word the language does not translate stays English', () => {
  assert.equal(localizeServerNotice({ title: 't', body: 'The turn stopped with an error.' }, german).body, 'The turn stopped with an error.');
});

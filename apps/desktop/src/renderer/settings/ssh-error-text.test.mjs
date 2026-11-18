// The connection code's English sentences are found by their text and told through the catalog with their names filled in.
import assert from 'node:assert/strict';
import test from 'node:test';

import { sshErrorText } from './ssh-error-text.ts';

const SENTENCES = [
  'An older version is still running on me@box. Open Settings → Connections, choose “Clean up the server…” for it, then connect again.',
  'The server on me@box is not ready to accept connections. Try connecting again.',
  'The server is not ready to accept connections. Try connecting again.',
  'The server on me@box did not respond over SSH. Try connecting again.',
  'The server on me@box did not accept this app: The server said no.',
  'Another program answered over SSH on me@box instead of the server the app started. The connection was stopped and nothing was sent to it. Connect again to start over.',
  'The SSH connection to me@box is not ready after 200 ms.',
  'The SSH connection to me@box is closed.',
  'The connection to the server is closed.',
  'This app ({{client}}) is older than the version on me@box (2.0.0). Update the app on this PC, then reconnect.'.replace('{{client}}', '1.0.0'),
  'The version running on me@box (2.0.0) does not match this app (1.0.0). Reconnect to install the matching version on the server.',
  'The password was not accepted. Check it and try again.',
  'The passphrase for the key was not accepted. Check it and try again.',
  'The code was not accepted. Check it and try again.',
  'The SSH host keys saved on this PC could not be read: access denied',
  'The SSH host keys saved on this PC were written by a newer version of the app. Update the app and try again. (h ssh-ed25519 K)',
  'The SSH host keys saved on this PC contain an entry the app cannot read. Fix or remove that entry in the known_hosts file, then try again. (h ssh-ed25519 K)',
  'The SSH settings on this PC could not be updated: access denied',
  'This host key is also listed in an entry the app did not add, or in several entries, so it cannot be replaced automatically. Edit the known_hosts file by hand, then try again. (C:\\data\\ssh\\known_hosts)',
  'The SSH settings on this PC could not be updated: access denied The server is still in the list. Click Forget to try again.',
];

test('every sentence the connection code words in English reads the same in English, names and details kept', () => {
  for (const sentence of SENTENCES) assert.equal(sshErrorText(sentence), sentence);
});

test('a message that is none of them is shown as it came', () => {
  assert.equal(sshErrorText('Something else happened.'), 'Something else happened.');
});

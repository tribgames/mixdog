import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publicGitRemoteUrl,
  scrubGitCredentials,
} from './git-cli';

test('Git remote state strips URL credentials and query secrets', () => {
  const safe = publicGitRemoteUrl(
    'https://user:secret@example.com/owner/repo.git?token=query-secret#fragment',
  );
  assert.equal(safe, 'https://example.com/owner/repo.git');
});

test('Git errors redact URL userinfo and sensitive query values', () => {
  const safe = scrubGitCredentials(
    "fatal: unable to access 'https://user:secret@example.com/repo?token=query-secret'",
  );
  assert.doesNotMatch(safe, /user:secret|query-secret/);
  assert.match(safe, /redacted/);
});

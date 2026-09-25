import './lib/isolated-test-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDestructiveCommandWarning } from './destructive-warning.mjs';

test('git global pathspec options are skipped only as whole tokens', () => {
  for (const option of ['--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']) {
    assert.equal(getDestructiveCommandWarning(`git ${option} reset --hard`), 'may discard uncommitted changes');
  }
  // A token that merely CONTAINS an option name is not that global option: it
  // occupies the subcommand position, so nothing after it is classified.
  for (const token of ['--literal-pathspecs-x', 'x--glob-pathspecs', 'x--noglob-pathspecs-y', 'x--icase-pathspecs']) {
    assert.equal(getDestructiveCommandWarning(`git ${token} reset --hard`), null, token);
  }
});

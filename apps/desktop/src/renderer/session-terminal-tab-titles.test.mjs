import assert from 'node:assert/strict';
import test from 'node:test';

import { knownDefaultShellLabel, terminalTabTitles } from './SessionTerminalTabs.tsx';

const pwsh = { id: 'pwsh', label: 'PowerShell (pwsh)' };
const tab = (id, shell = '') => ({ id, shell, cwd: '' });

test('a default tab opened before shell detection answers already shows the remembered shell name', () => {
  const label = knownDefaultShellLabel(null, null, () => 'PowerShell (pwsh)');
  assert.equal(label, 'PowerShell (pwsh)');
  assert.deepEqual([...terminalTabTitles([tab('a')], null, label).values()], ['PowerShell (pwsh)']);
});

test('the detected default wins over the remembered name once profiles answer', () => {
  assert.equal(
    knownDefaultShellLabel(pwsh, [pwsh], () => 'cmd'),
    'PowerShell (pwsh)'
  );
  // Detection answered with no default: nothing stale is shown.
  assert.equal(
    knownDefaultShellLabel(null, [pwsh], () => 'cmd'),
    ''
  );
});

test('with no known name the default tab falls back to the generic label and repeats are numbered', () => {
  const titles = terminalTabTitles([tab('a'), tab('b'), tab('c', 'pwsh')], [pwsh], '');
  const [first, second, third] = [...titles.values()];
  assert.ok(first.length > 0);
  assert.equal(second, `${first} 2`);
  assert.equal(third, 'PowerShell (pwsh)');
});

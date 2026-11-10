import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorktreeSetupNotices } from './worktree-setup-notice.mjs';

function surface() {
  const items = [];
  let sequence = 0;
  const render = createWorktreeSetupNotices({
    nextId: () => `n${++sequence}`,
    pushItem: (item) => items.push({ ...item }),
    patchItem: (id, patch) =>
      Object.assign(
        items.find((item) => item.id === id),
        patch
      ),
  });
  return { items, render };
}

test('one one-line notice per install run, updated in place; output never reaches it', () => {
  const { items, render } = surface();
  const run = { id: 'run-1', total: 2, status: 'running', truncated: false };
  render({ ...run, index: 0, label: 'npm (project root)', command: '"npm" ci', output: '' });
  render({ ...run, index: 0, label: 'npm (project root)', command: '"npm" ci', output: 'added 12 packages\n' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'notice');
  assert.equal(items[0].text, 'Installing worktree dependencies [1/2]: npm (project root)');
  render({ ...run, index: 1, label: 'uv (api)', command: '"uv" sync --frozen', output: '' });
  assert.equal(items[0].text, 'Installing worktree dependencies [2/2]: uv (api)');
  render({ id: 'run-1', final: true, status: 'failed', total: 2, steps: [] });
  assert.equal(items.length, 1);
  assert.deepEqual(
    [items[0].text, items[0].tone],
    ['Some worktree dependencies were not installed; the agent has the details.', 'warn']
  );
  render({ ...run, id: 'run-2', index: 0, command: '"npm" ci', output: '' });
  render({ id: 'run-2', final: true, status: 'completed', total: 1, steps: [] });
  assert.equal(items.length, 2, 'a later run gets its own notice');
  assert.deepEqual([items[1].text, items[1].tone], ['Worktree dependencies installed.', 'info']);
});

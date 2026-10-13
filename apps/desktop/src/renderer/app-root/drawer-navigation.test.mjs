import assert from 'node:assert/strict';
import test from 'node:test';
import { closingDrawerFirst } from './drawer-navigation.ts';

test('closingDrawerFirst closes the drawer before opening and forwards args and result', () => {
  const log = [];
  const open = closingDrawerFirst(
    () => log.push('close'),
    (project, rel) => {
      log.push(`open:${project}:${rel}`);
      return 7;
    }
  );
  assert.equal(open('p', 'a.ts'), 7);
  assert.deepEqual(log, ['close', 'open:p:a.ts']);
});

test('closingDrawerFirst leaves the handler untouched without a drawer close', () => {
  const open = () => 1;
  assert.equal(closingDrawerFirst(undefined, open), open);
});

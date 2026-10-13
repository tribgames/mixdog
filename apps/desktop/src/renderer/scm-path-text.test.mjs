import assert from 'node:assert/strict';
import test from 'node:test';
import { splitScmPath, truncateScmPath } from './ScmPathText.tsx';

const shown = (path, length) => {
  const slash = path.lastIndexOf('/');
  return splitScmPath(truncateScmPath(path, length), slash >= 0 ? path.slice(0, slash + 1) : '');
};

test('SCM paths shorten the directory and keep the file name whole', () => {
  const path = 'apps/desktop/src/renderer/Button.tsx';
  assert.deepEqual(shown(path, path.length), { directoryText: 'apps/desktop/src/renderer/', fileText: 'Button.tsx' });
  assert.deepEqual(shown(path, 20), { directoryText: 'apps/des…/', fileText: 'Button.tsx' });
  assert.deepEqual(shown(path, 12), { directoryText: '…/', fileText: 'Button.tsx' });
});

test('a name too long for `…/name` drops the directory instead of cutting the path mid-string', () => {
  const path = 'src/components/AVeryLongComponentName.tsx';
  const narrow = shown(path, 16);
  assert.equal(narrow.directoryText, '', 'no half directory beside a cut name');
  assert.equal(narrow.fileText.length, 16);
  // The cut stays inside the name: its start and its extension remain.
  assert.ok(narrow.fileText.startsWith('AVeryLo'), narrow.fileText);
  assert.ok(narrow.fileText.endsWith('me.tsx'), narrow.fileText);
  assert.equal(narrow.fileText.includes('/'), false);
  // A name that only shares its first letters with the directory is still all name.
  assert.deepEqual(shown('src/srcmap-generator-utils.ts', 10), { directoryText: '', fileText: 'srcm…ls.ts' });
});

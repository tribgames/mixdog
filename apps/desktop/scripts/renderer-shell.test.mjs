import assert from 'node:assert/strict';
import test from 'node:test';
import { stampRendererShell } from './renderer-shell.ts';

test('a release identifies all bootstrap imports, not unused lazy feature chunks', () => {
  const bundle = {
    'assets/main-12345678.js': {
      type: 'chunk', fileName: 'assets/main-12345678.js', isEntry: true, imports: ['assets/react-12345678.js'],
    },
    'assets/react-12345678.js': { type: 'chunk', fileName: 'assets/react-12345678.js', imports: [] },
    'assets/bootstrap-12345678.js': {
      type: 'chunk', fileName: 'assets/bootstrap-12345678.js', name: 'bootstrap', imports: ['assets/react-12345678.js'],
    },
    'assets/unused-12345678.js': { type: 'chunk', fileName: 'assets/unused-12345678.js', name: 'unused', imports: [] },
  };
  const html = '<head></head><body>app</body>';
  const stamped = stampRendererShell(html, bundle);
  const assets = /name="mixdog-shell-assets" content="([^"]+)"/.exec(stamped)[1].split(',');
  assert.deepEqual(new Set(assets), new Set(Object.keys(bundle).filter((key) => !key.includes('unused'))));
  const version = (body) => /name="mixdog-shell-version" content="([^"]+)"/.exec(body)[1];
  assert.equal(version(stamped), version(stampRendererShell(html, bundle)));
  assert.notEqual(version(stamped), version(stampRendererShell(html.replace('app', 'new app'), bundle)));
});

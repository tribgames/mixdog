import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stampRendererShell } from './renderer-shell.ts';

test('a release identifies all bootstrap imports, not unused lazy feature chunks', () => {
  const bundle = {
    'assets/main-12345678.js': {
      type: 'chunk',
      fileName: 'assets/main-12345678.js',
      isEntry: true,
      imports: ['assets/react-12345678.js'],
    },
    'assets/react-12345678.js': { type: 'chunk', fileName: 'assets/react-12345678.js', imports: [] },
    'assets/bootstrap-12345678.js': {
      type: 'chunk',
      fileName: 'assets/bootstrap-12345678.js',
      name: 'bootstrap',
      imports: ['assets/react-12345678.js'],
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
  const { 'assets/unused-12345678.js': lazy, ...rest } = bundle;
  const changed = 'assets/unused-87654321.js';
  const rebuilt = stampRendererShell(html, { ...rest, [changed]: { ...lazy, fileName: changed } });
  assert.notEqual(version(rebuilt), version(stamped));
});

test('same-path public worker bytes change the shell release', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-shell-public-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = join(dir, 'sw-shell.js');
  writeFileSync(worker, '/* old worker */');
  const html = '<head></head><body>app</body>';
  const before = stampRendererShell(html, {}, dir);
  writeFileSync(worker, '/* new worker */');
  const after = stampRendererShell(html, {}, dir);
  const version = (body) => /name="mixdog-shell-version" content="([^"]+)"/.exec(body)[1];
  assert.notEqual(version(before), version(after));
});

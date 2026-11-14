import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { claimResources } from './claim-resources.ts';

const resources = join('/app', 'resources');
const cores = join(resources, 'server-cores');
const helper = (name) => join(resources, 'core', name);

test('a packaged desktop names the server cores and the askpass helper beside the core binary', () => {
  const exists = (path) => path === cores || path === helper('mixdog-askpass');
  assert.deepEqual(claimResources(true, resources, exists, 'linux'), {
    serverCoresDir: cores,
    askpassHelper: helper('mixdog-askpass'),
  });
});

test('the askpass helper is an .exe on Windows', () => {
  const exists = (path) => path === helper('mixdog-askpass.exe');
  assert.deepEqual(claimResources(true, resources, exists, 'win32'), { askpassHelper: helper('mixdog-askpass.exe') });
});

test('a path that is not there is left out of the claim', () => {
  assert.deepEqual(claimResources(true, resources, () => false, 'linux'), {});
});

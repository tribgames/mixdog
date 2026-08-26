// Transport selection for the resident search engine. The engine itself is
// covered by the search suites; what matters here is that an operator can
// always steer WHICH transport runs, because the in-process addon trades the
// child process's crash isolation away and must stay switchable at runtime.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNativeSearchTransport,
  resolveNativeSearchAddon,
  _resetNativeSearchAddonPathForTest,
} from './native-search-transport.mjs';

function withAddonEnv(value, run) {
  const previous = process.env.MIXDOG_SEARCH_SERVER_ADDON;
  if (value === undefined) delete process.env.MIXDOG_SEARCH_SERVER_ADDON;
  else process.env.MIXDOG_SEARCH_SERVER_ADDON = value;
  _resetNativeSearchAddonPathForTest();
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_SEARCH_SERVER_ADDON;
    else process.env.MIXDOG_SEARCH_SERVER_ADDON = previous;
    _resetNativeSearchAddonPathForTest();
  }
}

test('the addon kill switch forces the child transport', () => {
  withAddonEnv('0', () => {
    assert.equal(resolveNativeSearchAddon(), null);
    // No executable either: the caller must be told there is nothing to attach
    // rather than receiving a half-built transport.
    assert.equal(createNativeSearchTransport({ binaryPath: null, cwd: process.cwd() }), null);
  });
});

test('an explicit addon path is honored only when the file exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-search-addon-'));
  const present = join(directory, 'mixdog-graph.node');
  await writeFile(present, '');
  withAddonEnv(present, () => {
    assert.equal(resolveNativeSearchAddon(), present);
  });
  withAddonEnv(join(directory, 'missing.node'), () => {
    // A stale override must fall through to the remaining candidates instead
    // of disabling search outright.
    assert.notEqual(resolveNativeSearchAddon(), join(directory, 'missing.node'));
  });
});

test('a failed addon load falls back to the child transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-search-addon-bad-'));
  const broken = join(directory, 'mixdog-graph.node');
  // Present but not loadable: exactly what an ABI-mismatched or truncated
  // addon looks like, and the case that must never take search down with it.
  await writeFile(broken, 'not a native module');
  withAddonEnv(broken, () => {
    assert.equal(resolveNativeSearchAddon(), broken);
    const transport = createNativeSearchTransport({ binaryPath: null, cwd: process.cwd() });
    // binaryPath is null here, so the fallback has nothing to spawn and
    // reports unavailable — the point is that the broken addon threw no
    // exception past the boundary.
    assert.equal(transport, null);
    // The failed load is remembered, so the next attempt does not re-dlopen.
    assert.equal(resolveNativeSearchAddon(), null);
  });
});

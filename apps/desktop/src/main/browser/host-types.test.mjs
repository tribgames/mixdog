import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as commandModule from './command.ts';
import * as guestStateModule from './guest-state.ts';
import * as hostState from './host-state.ts';
import * as hostTypes from './host-types.ts';

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('command.ts and guest-state.ts only re-export what host-types.ts and host-state.ts hold', () => {
  for (const [name, value] of Object.entries(commandModule)) assert.equal(hostTypes[name], value, name);
  for (const [name, value] of Object.entries(guestStateModule)) assert.equal(hostState[name], value, name);
  assert.equal(typeof hostState.BrowserGuestStateStore, 'function');
  assert.equal(typeof hostState.browserDocumentId, 'function');
  assert.equal(typeof hostState.pushBounded, 'function');
});

test('the command limits keep their values', () => {
  assert.equal(hostTypes.BROWSER_PARTITION, 'persist:mixdog-browser');
  assert.equal(hostTypes.COMMAND_TIMEOUT_MS, 42_000);
  assert.equal(hostTypes.boundedInteger(undefined, 5, 1, 9), 5);
  assert.equal(hostTypes.boundedInteger(99, 5, 1, 9), 9);
  assert.equal(hostTypes.browserCharLimit(-1, 7, 20), 7);
  assert.equal(hostTypes.normalizeBrowserAction({ action: '  Click ' }), 'click');
  assert.equal(hostTypes.snapshotTextLimit({ action: 'evaluate', maxChars: 9000 }), 2400);
});

test('no staying module reaches the host through guest-state.ts, command.ts, host.ts types or host-foundation.ts', () => {
  const allowed = new Set([
    'browser/guest-state.ts',
    'browser/command.ts',
    'browser/host-types.ts',
    'browser/host-types.test.mjs',
    // Owned by other tasks (the host itself, the shell entry points, the screen switch).
    'browser/host.ts',
    'index.ts',
    'ipc.ts',
    'browser/login-persistence.integration.ts',
  ]);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|mjs)$/.test(entry.name)) {
        const rel = relative(mainDir, path).split(sep).join('/');
        if (allowed.has(rel) || !/^(browser|host)\//.test(rel)) continue;
        const text = readFileSync(path, 'utf8');
        const viaOldModule = /from\s+'[^']*\/(?:guest-state|command|host-foundation)(?:\.ts)?'/;
        const hostType = /import type \{[^}]*\bBrowserHost\b[^}]*\}\s*from\s+'[^']*\/host'/;
        if (viaOldModule.test(text) || hostType.test(text)) found.push(rel);
      }
    }
  };
  walk(mainDir);
  assert.deepEqual(found, []);
});

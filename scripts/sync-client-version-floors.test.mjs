import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cursorBuildNewer } from '../src/runtime/agent/orchestrator/providers/cursor-client-version.mjs';
import { FLOORS, raiseFloor, semverNewer } from './sync-client-version-floors.mjs';

const CODEX = "// floor\nconst CODEX_CLIENT_VERSION_FLOOR = '0.155.1';\nconst OTHER = '1.0.0';\n";
const CURSOR = "export const CURSOR_CLIENT_VERSION_FLOOR = 'cli-2026.10.01-e373342';\r\n";

test('a newer published version raises the floor and leaves the rest of the file alone', () => {
  const result = raiseFloor(CODEX, 'CODEX_CLIENT_VERSION_FLOOR', '0.162.0', semverNewer);
  assert.equal(result.current, '0.155.1');
  assert.equal(result.next, '0.162.0');
  assert.equal(result.source, CODEX.replace("'0.155.1'", "'0.162.0'"));
});

test('a floor never moves down or sideways', () => {
  for (const latest of ['0.155.1', '0.150.9', null]) {
    const result = raiseFloor(CODEX, 'CODEX_CLIENT_VERSION_FLOOR', latest, semverNewer);
    assert.equal(result.source, CODEX, `published ${latest}`);
    assert.equal(result.next, '0.155.1');
  }
});

test('cursor builds move forward by date, keep exports and CRLF, and ignore malformed ids', () => {
  const raised = raiseFloor(CURSOR, 'CURSOR_CLIENT_VERSION_FLOOR', 'cli-2026.10.08-abc1234', cursorBuildNewer);
  assert.equal(raised.source, "export const CURSOR_CLIENT_VERSION_FLOOR = 'cli-2026.10.08-abc1234';\r\n");
  for (const latest of ['cli-2026.09.30-fff0000', 'cli-2026.10.01-e373342', 'build-2026.12.01-abc1234']) {
    assert.equal(raiseFloor(CURSOR, 'CURSOR_CLIENT_VERSION_FLOOR', latest, cursorBuildNewer).source, CURSOR, latest);
  }
});

test('a renamed floor fails loudly instead of silently skipping', () => {
  assert.throws(() => raiseFloor(CODEX, 'MISSING_FLOOR', '9.9.9', semverNewer), /MISSING_FLOOR declaration not found/);
});

test('every synced provider file still declares its floor', () => {
  for (const floor of FLOORS) {
    const { current } = raiseFloor(readFileSync(floor.file, 'utf8'), floor.constant, null, floor.isNewer);
    assert.ok(current, floor.constant);
  }
});

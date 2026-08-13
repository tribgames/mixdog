#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeNativePatchServerForTests,
  runServerEdit,
} from '../src/runtime/agent/orchestrator/tools/patch/native-server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-native-edit-wire-'));
const target = join(dir, 'target.txt');

try {
  writeFileSync(target, 'alpha beta alpha\n', 'utf8');
  const result = await runServerEdit({
    fullPath: target,
    oldBuf: Buffer.from('alpha', 'utf8'),
    newBuf: Buffer.from('omega', 'utf8'),
    replaceAll: true,
  });

  assert.equal(result.replacements, 2);
  assert.equal(result.tier, 'exact');
  assert.match(result.contentHash || '', /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(target, 'utf8'), 'omega beta omega\n');
  process.stdout.write('native EDIT wire integration passed\n');
} finally {
  await closeNativePatchServerForTests();
  rmSync(dir, { recursive: true, force: true });
}

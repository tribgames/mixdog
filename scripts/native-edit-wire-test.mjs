#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeNativePatchServerForTests,
  runServerEdit,
} from '../src/runtime/agent/orchestrator/tools/patch.mjs';

const binary = process.env.MIXDOG_EDIT_NATIVE_BIN;
assert.ok(binary, 'MIXDOG_EDIT_NATIVE_BIN must point to the release mixdog-patch binary');
assert.ok(existsSync(binary), `native EDIT test binary does not exist: ${binary}`);

const responseFields = [
  'replacements',
  'readMs',
  'applyMs',
  'writeMs',
  'totalMs',
  'tier',
  'contentHash',
  'roundtripMs',
];

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function assertCompleteResponse(response, { replacements, tier, content }) {
  assert.deepEqual(Object.keys(response), responseFields, 'EDIT response must expose all eight decoded fields');
  assert.equal(response.replacements, replacements);
  assert.equal(response.tier, tier);
  assert.match(response.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(response.contentHash, digest(content), 'EDIT response hash must describe the resulting bytes');
  for (const field of ['readMs', 'applyMs', 'writeMs', 'totalMs', 'roundtripMs']) {
    assert.ok(Number.isFinite(response[field]) && response[field] >= 0, `${field} must be a non-negative number`);
  }
}

function edit(fullPath, oldString, newString, options = {}) {
  return runServerEdit({
    fullPath,
    oldBuf: Buffer.from(oldString, 'utf8'),
    newBuf: Buffer.from(newString, 'utf8'),
    ...options,
  });
}

async function rawEdit(fullPath, oldString, newString, { replaceAll = false, dryRun = false } = {}) {
  const pathBuf = Buffer.from(fullPath, 'utf8');
  const oldBuf = Buffer.from(oldString, 'utf8');
  const newBuf = Buffer.from(newString, 'utf8');
  const child = spawn(binary, ['--server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(Buffer.concat([
    Buffer.from(`EDIT ${pathBuf.length} ${oldBuf.length} ${newBuf.length} ${replaceAll ? 1 : 0} ${dryRun ? 1 : 0}\n`),
    pathBuf,
    oldBuf,
    newBuf,
    Buffer.from('QUIT\n'),
  ]));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `raw native EDIT server failed: ${Buffer.concat(stderr).toString('utf8')}`);
  return Buffer.concat(stdout).toString('utf8').trimEnd();
}

function assertRawResponse(line) {
  const fields = line.split('\t');
  assert.equal(fields.length, 8, 'raw EDIT response must contain exactly eight tab-delimited fields');
  assert.equal(fields[0], 'OK');
  for (const index of [2, 3, 4, 5]) {
    assert.notEqual(fields[index], '', `raw EDIT timing field ${index} must be present`);
    assert.match(fields[index], /^\d+(?:\.\d+)?$/, `raw EDIT timing field ${index} must be numeric`);
  }
}

test('native EDIT production wire path preserves matching and response invariants', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-native-edit-wire-'));
  try {
    await t.test('rejects ambiguity, then reports the replace-all repeat count and full response', async () => {
      const path = join(root, 'repeats.txt');
      writeFileSync(path, 'token token token\n', 'utf8');

      await assert.rejects(
        edit(path, 'token', 'value'),
        (error) => {
          assert.equal(error.message, 'old_string found 3 times');
          return true;
        },
      );
      assert.equal(readFileSync(path, 'utf8'), 'token token token\n');

      const expected = 'value value value\n';
      assertRawResponse(await rawEdit(path, 'token', 'value', { replaceAll: true, dryRun: true }));
      const response = await edit(path, 'token', 'value', { replaceAll: true });
      assert.equal(readFileSync(path, 'utf8'), expected);
      assertCompleteResponse(response, { replacements: 3, tier: 'exact', content: expected });
    });

    await t.test('rejects a 30-line folded match without writing', async () => {
      const path = join(root, 'folded-30.txt');
      const source = Array.from({ length: 30 }, (_, i) => `line ${i + 1} “value”`).join('\n');
      const foldedNeedle = Array.from({ length: 30 }, (_, i) => `line ${i + 1} "value"`).join('\n');
      writeFileSync(path, source, 'utf8');

      await assert.rejects(
        edit(path, foldedNeedle, 'unsafe replacement'),
        /old_string is 30 lines \(>= 30\)\./,
      );
      assert.equal(readFileSync(path, 'utf8'), source);
    });

    await t.test('absorbs the deleted line newline', async () => {
      const path = join(root, 'delete-crlf.txt');
      const source = 'keep\r\ndelete me\r\nafter\r\n';
      const expected = 'keep\r\nafter\r\n';
      writeFileSync(path, source, 'utf8');

      const response = await edit(path, 'delete me', '');
      assert.equal(readFileSync(path, 'utf8'), expected);
      assertCompleteResponse(response, { replacements: 1, tier: 'exact', content: expected });
    });

    await t.test('preserves CRLF while lowering an LF-authored replacement', async () => {
      const path = join(root, 'preserve-crlf.txt');
      const source = 'head\r\nold a\r\nold b\r\ntail\r\n';
      const expected = 'head\r\nnew a\r\nnew b\r\ntail\r\n';
      writeFileSync(path, source, 'utf8');

      const response = await edit(path, 'old a\nold b', 'new a\nnew b');
      assert.equal(readFileSync(path, 'utf8'), expected);
      assertCompleteResponse(response, { replacements: 1, tier: 'crlf', content: expected });
    });
  } finally {
    await closeNativePatchServerForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

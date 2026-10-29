// The Node side of the Chrome import envelope: readEncryptedChildJson spawns the
// importer, sends a one-time AES-256 key on stdin, and decrypts the AES-256-GCM
// envelope the child prints. These suites drive it against a tiny fake child that
// speaks the same protocol (reads the base64 key, prints an envelope), so the
// exit-code, auth-tag, size-limit and key-wipe behaviour is exercised for real
// instead of read out of the source text.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const app={isPackaged:false},safeStorage={};export const session={},BrowserWindow={};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { readEncryptedChildJson } = await import('./profile-import.ts');

const LARGE_UNIT = 'abcdefghij';
const LARGE_REPEAT = 600_000; // 6 MB of plaintext, ~8 MB of base64 envelope

const FAKE_IMPORTER = String.raw`
const { createCipheriv, randomBytes } = require('node:crypto');
const mode = process.argv[2];
const importerArgs = process.argv.slice(3);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const encoded = input.trim();
  const key = Buffer.from(encoded, 'base64');
  const seal = (payload, { flipTag = false, version = 1 } = {}) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (flipTag) tag[tag.length - 1] ^= 0xff;
    return JSON.stringify({
      version,
      nonce: nonce.toString('base64'),
      ciphertext: Buffer.concat([body, tag]).toString('base64'),
    });
  };
  const report = {
    argv: importerArgs,
    keyLength: key.length,
    canonicalBase64: key.toString('base64') === encoded,
    keyInArgv: process.argv.some((value) => value.includes(encoded)),
    keyInEnvironment: Object.values(process.env).some((value) => value.includes(encoded)),
    credentials: [{ url: 'https://example.com/', username: 'user', password: 'p\u00e4ss' }],
  };
  if (mode === 'ok') process.stdout.write(seal(report));
  else if (mode === 'large-delayed') {
    // Multi-megabyte envelope whose tail is written by a grandchild once this
    // process has exited (it watches the parent pid), so stdout drains after the exit event.
    const envelope = seal({ filler: ${JSON.stringify(LARGE_UNIT)}.repeat(${LARGE_REPEAT}) });
    const cut = envelope.length - 256 * 1024;
    const tailFile = require('node:path').join(require('node:os').tmpdir(), 'mixdog-import-tail-' + process.pid);
    require('node:fs').writeFileSync(tailFile, envelope.slice(cut));
    process.stdout.write(envelope.slice(0, cut), () => {
      require('node:child_process')
        .spawn(process.execPath, ['-e', 'const fs = require("node:fs"); const wait = () => { try { process.kill(Number(process.argv[2]), 0); setTimeout(wait, 5); } catch { process.stdout.write(fs.readFileSync(process.argv[1])); fs.rmSync(process.argv[1]); } }; wait();', tailFile, String(process.pid)], {
          // Detached so it outlives this process (Windows kills job children on exit).
          stdio: ['ignore', 'inherit', 'inherit'],
          detached: true,
          windowsHide: true,
        })
        .unref();
    });
  }
  else if (mode === 'bad-tag') process.stdout.write(seal(report, { flipTag: true }));
  else if (mode === 'bad-version') process.stdout.write(seal(report, { version: 2 }));
  else if (mode === 'exit') {
    // A complete, valid envelope must still not be trusted after a failure.
    process.stdout.write(seal(report));
    process.stderr.write('Chrome is still running.\n');
    process.exitCode = 3;
  } else if (mode === 'exit-silent') process.exitCode = 4;
  else if (mode === 'oversize') {
    // Past the 64 MiB limit, then hang: only a kill ends this child early.
    process.stdout.on('error', () => process.exit(0));
    const chunk = Buffer.alloc(1024 * 1024, 120);
    let sent = 0;
    const pump = () => {
      while (sent < 66) {
        sent += 1;
        if (!process.stdout.write(chunk)) {
          process.stdout.once('drain', pump);
          return;
        }
      }
    };
    pump();
    setTimeout(() => process.exit(9), 30000);
  }
});
`;

const root = mkdtempSync(join(tmpdir(), 'mixdog-import-native-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const script = join(root, 'fake-importer.cjs');
writeFileSync(script, FAKE_IMPORTER);
// The fake child is node itself; the function hashes the executable it spawns.
const executable = process.execPath;
const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');

/** Runs one fake-child mode and records the transport key the function made. */
async function run(mode, extraArgs = []) {
  const created = [];
  const outcome = await readEncryptedChildJson(executable, [script, mode, ...extraArgs], executableSha256, () => {
    const key = randomBytes(32);
    created.push({ key, original: Buffer.from(key) });
    return key;
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  assert.equal(created.length, 1, 'exactly one transport key is made per call');
  const [{ key, original }] = created;
  assert.equal(original.length, 32);
  assert.ok(original.some((byte) => byte !== 0));
  assert.deepEqual(key, Buffer.alloc(32), 'the transport key is wiped once the call settles');
  return outcome;
}

test('a sealed envelope is decrypted with the stdin key and the key never leaves stdin', async () => {
  const { value, error } = await run('ok', ['import-passwords', '--browser', 'chrome', '--json']);
  assert.equal(error, undefined);
  assert.deepEqual(value, {
    argv: ['import-passwords', '--browser', 'chrome', '--json'],
    keyLength: 32,
    canonicalBase64: true,
    keyInArgv: false,
    keyInEnvironment: false,
    credentials: [{ url: 'https://example.com/', username: 'user', password: 'päss' }],
  });
});

test('a multi-megabyte payload still draining after the child exits is read in full', { timeout: 20_000 }, async () => {
  const { value, error } = await run('large-delayed');
  assert.equal(error, undefined);
  assert.equal(value.filler.length, LARGE_UNIT.length * LARGE_REPEAT);
  assert.equal(value.filler, LARGE_UNIT.repeat(LARGE_REPEAT));
});

test('a spawn that throws synchronously still wipes the transport key', async () => {
  // A NUL byte in an argument makes child_process.spawn throw before any child exists.
  const { value, error } = await run('ok', ['bad\0argument']);
  assert.equal(value, undefined);
  assert.equal(error.code, 'ERR_INVALID_ARG_VALUE');
});

test('an envelope with a bad authentication tag is rejected and yields no data', async () => {
  const { value, error } = await run('bad-tag');
  assert.equal(value, undefined);
  assert.match(error.message, /authenticate/i);
});

test('an envelope of an unknown version is rejected before decryption', async () => {
  const { error } = await run('bad-version');
  assert.equal(error.message, 'Native password importer returned an invalid envelope.');
});

test('a non-zero exit rejects with the child stderr even when it printed a valid envelope', async () => {
  const { value, error } = await run('exit');
  assert.equal(value, undefined);
  assert.equal(error.message, 'Chrome is still running.');
});

test('a silent non-zero exit reports the exit code', async () => {
  const { error } = await run('exit-silent');
  assert.equal(error.message, 'Native browser importer exited with code 4.');
});

test('output past the limit is rejected and the child is killed', { timeout: 20_000 }, async () => {
  const { value, error } = await run('oversize');
  assert.equal(value, undefined);
  assert.equal(error.message, 'Native browser importer returned too much data.');
});

test('an executable that no longer matches its hash is never spawned or given a key', async () => {
  let keysMade = 0;
  await assert.rejects(
    readEncryptedChildJson(executable, [script, 'ok'], '0'.repeat(64), () => {
      keysMade += 1;
      return randomBytes(32);
    }),
    /changed after signature verification/
  );
  assert.equal(keysMade, 0);
});

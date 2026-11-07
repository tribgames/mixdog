#!/usr/bin/env node
// Golden twin of the text a failed start of the native computer helper gives the model.
// Node's `launchHostProcess` (host-worker-process.ts) spawns `computerNativeBinary()` with
// `child_process.spawn`; `watchHostWorker` turns an async 'error' into
// `computer host failed to start: ${error.message}`, and a synchronous throw reaches the caller as
// the bare `error.message`. The bridge reports either as the `error` of its reply, so the model
// reads it. This runs the real `spawn` against a missing file, a plain file that is not an
// executable, and a missing directory, and applies the same two templates.
//
//   node benchmarks/rust-core/recorders/record-computer-spawn-error.mjs
// No Mixdog module is imported and nothing outside the temp directory is touched.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, REPO_ROOT, writeJson } from './lib/common.mjs';

const dir = mkdtempSync(join(tmpdir(), 'computer-spawn-'));
const plain = join(dir, 'plain.txt');
writeFileSync(plain, 'not an executable\n');
const targets = {
  'missing file': join(dir, 'gone-helper'),
  'not an executable': plain,
  'missing directory': join(dir, 'nodir', 'helper'),
};
const mask = (text) => text.replaceAll(dir, '<DIR>');

const cases = [];
for (const [name, binary] of Object.entries(targets)) {
  const text = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, [], { env: process.env });
    } catch (error) {
      resolve({ how: 'throw', code: error.code, text: error.message });
      return;
    }
    child.once('error', (error) =>
      resolve({ how: 'error', code: error.code, text: `computer host failed to start: ${error.message}` })
    );
    child.once('exit', () => resolve({ how: 'exit', code: null, text: 'computer host exited' }));
  });
  cases.push({ name, binary: mask(binary), platform: process.platform, how: text.how, code: text.code, text: mask(text.text) });
}
rmSync(dir, { recursive: true, force: true });
const out = parseArgs().get('out') ?? join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-tools', 'src', 'desktop', 'golden', 'computer_spawn_error.json');
writeJson(out, { cases });
console.log(`computer spawn error: ${cases.map((c) => `${c.name}=${c.text}`).join(' | ')}`);

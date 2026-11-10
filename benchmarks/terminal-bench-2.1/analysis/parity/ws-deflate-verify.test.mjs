// Runs the Rust WebSocket writer and has `ws`'s own receiver read what it wrote: the Rust test `what_we_send_is_what_ws_sends_in_every_negotiation`
// dumps its frames to MIXDOG_WS_OUT, and `ws-deflate-verify.mjs` feeds them to `ws` 8.22.0's Receiver in every negotiation.
// Usage: MIXDOG_NODE_TREE=<node tree with ws installed> node --test ws-deflate-verify.test.mjs
// (cargo must be on PATH; set CARGO_TARGET_DIR to reuse a build.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** The longest the Rust test run (a build included) and the verification may each take. */
const CARGO_DEADLINE_MS = 30 * 60 * 1000;
const VERIFY_DEADLINE_MS = 2 * 60 * 1000;

test('ws reads every frame the Rust client writes, in every negotiation', () => {
  const tree = process.env.MIXDOG_NODE_TREE;
  assert.ok(tree, 'MIXDOG_NODE_TREE must name a Node tree with ws installed');
  const out = join(mkdtempSync(join(tmpdir(), 'ws-verify-')), 'rust-frames.json');
  const core = resolve(here, '../../../../native/core');
  const cargo = spawnSync('cargo', ['test', '-p', 'mixdog-ai', '--lib', 'what_we_send_is_what_ws_sends_in_every_negotiation'], {
    cwd: core, env: { ...process.env, MIXDOG_WS_OUT: out }, stdio: 'inherit', timeout: CARGO_DEADLINE_MS, killSignal: 'SIGKILL',
  });
  assert.equal(cargo.error, undefined, `cargo did not finish within ${CARGO_DEADLINE_MS} ms`);
  assert.equal(cargo.status, 0, 'the Rust test passes');
  const verify = spawnSync(process.execPath, [join(here, 'ws-deflate-verify.mjs'), tree, out, join(here, 'fixtures/ws-deflate-vectors.json')], {
    stdio: 'inherit', timeout: VERIFY_DEADLINE_MS, killSignal: 'SIGKILL',
  });
  assert.equal(verify.error, undefined, `verification did not finish within ${VERIFY_DEADLINE_MS} ms`);
  assert.equal(verify.status, 0, 'ws reads the frames as the messages sent');
});

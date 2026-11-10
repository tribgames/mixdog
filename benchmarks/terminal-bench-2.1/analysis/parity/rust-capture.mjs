#!/usr/bin/env node
// The Rust-core half of the contract parity check: starts an isolated `mixdogd` with FAKE credentials (never the
// user's, no network is reached: the snapshot is built before any send) and writes the `tools/toolsStatus`
// snapshot of the same four routes node-capture.mjs captures.
// Usage: node rust-capture.mjs --mixdogd <bin> --out <file.json>
import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../../../scripts/rust-core/lib/core-session.mjs';
import { snapshotRoute } from '../contract-hash-rust.mjs';
import { ROUTES } from './node-capture.mjs';

const FAKE = 'fake-credential-not-a-secret';
const SOON = Date.now() + 86_400_000;

/** Fake signed-in credentials for the four providers, under the isolated data dir only. */
export function writeFakeCredentials(dataDir, write) {
  write(join(dataDir, 'anthropic-oauth-credentials.json'), { claudeAiOauth: { accessToken: FAKE, refreshToken: FAKE, expiresAt: SOON, scopes: ['user:inference'] } });
  write(join(dataDir, 'openai-oauth.json'), { access_token: FAKE, refresh_token: FAKE, account_id: 'fake', expires_at: SOON });
  write(join(dataDir, 'grok-oauth.json'), { access_token: FAKE, refresh_token: FAKE, expires_at: SOON });
  write(join(dataDir, 'gemini-api-key.json'), { apiKey: FAKE });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const root = mkdtempSync(join(tmpdir(), 'mixdog-parity-'));
  let core;
  try {
    const { writeFileSync: put } = await import('node:fs');
    core = await startCore({
      bin: resolve(arg('--mixdogd')),
      root,
      config: { outputStyle: 'simple', agent: { profile: { language: 'en' } } },
      prepare: (paths) => writeFakeCredentials(paths.dataDir, (file, value) => put(file, JSON.stringify(value))),
    });
    const out = [];
    for (const route of ROUTES) {
      try {
        out.push({ ...route, snapshot: await snapshotRoute(core, route, 'headless', 'parity probe') });
      } catch (error) {
        out.push({ ...route, error: String(error?.message || error).slice(0, 400) });
      }
    }
    writeFileSync(resolve(arg('--out')), `${JSON.stringify(out, null, 2)}\n`);
  } finally {
    await core?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}


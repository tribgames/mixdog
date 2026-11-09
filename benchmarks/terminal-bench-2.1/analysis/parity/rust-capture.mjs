#!/usr/bin/env node
// The Rust-core half of the wire parity check: starts an isolated `mixdogd` with FAKE credentials (never the user's, no
// network is reached: the snapshot is built before any send), with the live client-version lookup off as Node's capture
// has it, and writes
//   --out      the `tools/toolsStatus` snapshot of the four routes node-capture.mjs captures, and
//   --session  the session document both halves of the scenario run read: the thread and installation ids of the core's
//              own first request, its system texts and its tools, and the host it described itself as. (The turn ids and
//              the clock are scenario inputs, scenarios.json: the snapshot of a thread with no turn yet derives its own.)
// Usage: node rust-capture.mjs --mixdogd <bin> --out <rust.json> --session <session.json>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../../../scripts/rust-core/lib/core-session.mjs';
import { snapshotRoute } from '../contract-hash-rust.mjs';
import { ROUTES } from './node-capture.mjs';
import { writeFakeCredentials } from './fake-credentials.mjs';

/** The session document of the first OpenAI request in `snapshots` (see the header). */
export function sessionDocument(snapshots) {
  const { snapshot } = snapshots.find((route) => route.provider === 'openai-oauth');
  const frame = snapshot.body.client_metadata;
  const threadId = snapshot.headers.find(([name]) => name === 'session-id')[1];
  return {
    threadId,
    installationId: frame['x-codex-installation-id'],
    host: { type: os.type(), release: os.release(), arch: os.arch() },
    system: snapshot.system,
    tools: snapshot.tools,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const root = mkdtempSync(join(tmpdir(), 'mixdog-parity-'));
  let core;
  try {
    core = await startCore({
      bin: resolve(arg('--mixdogd')),
      root,
      config: { outputStyle: 'simple', agent: { profile: { language: 'en' } } },
      prepare: (paths) => writeFakeCredentials(paths.dataDir, (file, value) => writeFileSync(file, JSON.stringify(value))),
      extraEnv: { MIXDOG_DISABLE_LIVE_CLI_VERSIONS: '1' },
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
    writeFileSync(resolve(arg('--session')), `${JSON.stringify(sessionDocument(out), null, 2)}\n`);
  } finally {
    await core?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
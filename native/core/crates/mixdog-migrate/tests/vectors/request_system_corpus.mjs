// The system messages Node sends for every session of one corpus scenario: the leading
// `system` messages of `loadSession(id).messages`, as the provider request carries them
// (`cacheTier`, content). Run against the Node build that wrote the scenario, over a copy of
// its data dir (Node's reader may create files):
//   node request_system_corpus.mjs <v145>/src <corpus>/v145 > request_system_v145.json
//   node request_system_corpus.mjs <dev146>/src <corpus>/dev146 > request_system_dev146.json
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, corpus] = process.argv.slice(2);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-system-golden-'));
cpSync(corpus, process.env.MIXDOG_DATA_DIR, { recursive: true });
const { loadSession } = await import(
  pathToFileURL(join(root, 'runtime/agent/orchestrator/session/store/load-session.mjs')).href
);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const ids = new Set();
for (const name of readdirSync(join(process.env.MIXDOG_DATA_DIR, 'sessions'))) {
  const id = /^(.+?)(?:\.log\.jsonl|\.json)$/.exec(name)?.[1];
  if (id && !id.includes('.')) ids.add(id);
}
const out = {};
for (const id of [...ids].sort()) {
  const session = loadSession(id);
  if (!session) continue;
  const messages = session.messages || [];
  const system = [];
  for (const m of messages) {
    if (m.role !== 'system') break;
    system.push({ cacheTier: m.cacheTier ?? null, length: m.content.length, sha256: sha256(m.content) });
  }
  out[id] = system;
}
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);

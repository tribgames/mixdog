// Records, for every session of the migration corpus (kept outside the repository), the system messages that lead its
// transcript as Node b6f10295a reads them: expected.systemMessages = [{cacheTier, length, sha256}] in order, in the corpus's
// manifest.json, with the provenance `systemMessagesRecording` (Node commit, this recorder and its libraries by sha256, the
// corpus identity). The migrate gates (`mixdog-migrate` src/run/tests.rs) compare the migrated header's prompt blocks with it
// and refuse an expectation whose provenance is not this recorder's.
//
// Each session is opened by Node's own session-record reader (`readSessionRecordSync` + `recordSession`, the one seam
// `loadSession` goes through: the log, the legacy json, torn tails and divergence resolved by the product), not by a fold here.
//
//   node benchmarks/rust-core/recorders/record-migration-system-messages.mjs --tree <b6f10295a export with node_modules> --corpus <migration-corpus dir>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { importFrom, nodeTreeIdentity, parseArgs, resolveTree } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SESSION_DIRS = { v145: 'v145/sessions', dev146: 'dev146/sessions', 'fixture-busy-seed': 'fixture-busy-seed/data/sessions' };

const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const corpus = resolve(args.get('corpus') ?? process.env.MIXDOG_MIGRATION_CORPUS ?? (() => { throw new Error('pass --corpus <migration-corpus dir>'); })());
const file = join(corpus, 'manifest.json');
const manifest = JSON.parse(readFileSync(file, 'utf8'));

const { readSessionRecordSync, recordSession } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/session-record.mjs');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const scenarios = Object.keys(manifest.scenarios).sort();
// What the corpus is: its generation stamp and every session's recorded digests, in a fixed order (the Rust gate folds the same).
const corpusIdentity = sha256(
  [manifest.generated, ...scenarios.flatMap((name) => manifest.scenarios[name].sessions.map((s) => `${name}/${s.id} ${s.expected.transcriptDigest} ${s.expected.headerDigest}`))].join('\n'),
);

for (const name of scenarios) {
  const dir = join(corpus, SESSION_DIRS[name]);
  for (const s of manifest.scenarios[name].sessions) {
    const session = recordSession(readSessionRecordSync(dir, s.id), s.id);
    if (!session) throw new Error(`Node reads no session for ${name}/${s.id}`);
    const messages = session.messages;
    if (messages.length !== s.expected.messageCount) throw new Error(`${name}/${s.id}: Node reads ${messages.length} messages, the corpus manifest ${s.expected.messageCount}`);
    const system = [];
    for (const m of messages) {
      if (m.role !== 'system') break;
      if (typeof m.content !== 'string') throw new Error(`${name}/${s.id}: a system message whose content is not a string`);
      system.push({ cacheTier: m.cacheTier ?? null, length: m.content.length, sha256: sha256(m.content) });
    }
    s.expected.systemMessages = system;
  }
}

manifest.systemMessagesRecording = {
  nodeCommit: identity.commit,
  corpusIdentity,
  ...recorderProvenance(import.meta.url),
  regenerate: 'node benchmarks/rust-core/recorders/record-migration-system-messages.mjs --tree <b6f10295a export with node_modules> --corpus <migration-corpus dir>',
};
writeFileSync(file, JSON.stringify(manifest, null, 1));

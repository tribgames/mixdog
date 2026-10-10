#!/usr/bin/env node
/**
 * scripts/build-shipped-history.mjs — emit src/defaults/shipped-history.json:
 * normalised-content hashes of every past shipped version of the agents,
 * workflows, output styles and bundled skills, read from git history.
 *
 * The startup migration (src/session-runtime/services/seeds.mjs) treats a data
 * dir copy matching any of these hashes as "unchanged" and moves it to a
 * backup so the current shipped version applies. Hash and normalisation code
 * is shared with the runtime (services/defaults-separation.mjs).
 *
 * Run:  node scripts/build-shipped-history.mjs   (also part of `prepack`)
 *       node scripts/build-shipped-history.mjs --check   (release workflow)
 * A shallow clone has no history: the committed file is left untouched.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIPPED_HISTORY_FILE,
  hashDefinition,
  hashText,
  hashTree,
  packDefinitionFrom,
} from '../src/session-runtime/services/defaults-separation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', ...SHIPPED_HISTORY_FILE);
// --check: write nothing, exit 1 when the committed file differs (release gate).
const CHECK = process.argv.includes('--check');

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
const lines = (buffer) => buffer.toString('utf8').split('\n').filter(Boolean);

if (git('rev-parse', '--is-shallow-repository').toString().trim() === 'true') {
  console.warn('build-shipped-history: shallow clone, keeping the committed src/defaults/shipped-history.json');
  process.exit(0);
}

const blobs = new Map();
const blob = (sha) => {
  if (!blobs.has(sha)) blobs.set(sha, git('cat-file', 'blob', sha));
  return blobs.get(sha);
};

/** Names (path segment after `prefix`) that ever existed under prefix. */
function everNames(prefix) {
  const names = new Set();
  for (const file of lines(git('log', '--name-only', '--format=', '--', prefix))) {
    if (file.startsWith(`${prefix}/`)) names.add(file.slice(prefix.length + 1).split('/')[0]);
  }
  return [...names].sort();
}

/** Every version of `path`: Map of relative path -> blob sha, one per commit that touched it. */
function versionsOf(path) {
  const versions = [];
  for (const commit of lines(git('log', '--format=%H', '--', path))) {
    const files = new Map();
    for (const row of lines(git('ls-tree', '-r', commit, '--', path))) {
      const [meta, file] = row.split('\t');
      files.set(file.slice(path.length + 1) || file.split('/').pop(), meta.split(' ')[2]);
    }
    if (files.size) versions.push(files);
  }
  return versions;
}

const unique = (hashes) => [...new Set(hashes)].sort();

function packHistory(dir, entry) {
  const out = {};
  for (const id of everNames(dir)) {
    const hashes = [];
    for (const files of versionsOf(`${dir}/${id}`)) {
      const read = (name) => (files.has(name) ? blob(files.get(name)).toString('utf8') : null);
      const definition = packDefinitionFrom(read, entry, id);
      if (definition) hashes.push(hashDefinition(definition));
    }
    if (hashes.length) out[id] = unique(hashes);
  }
  return out;
}

function outputStyleHistory() {
  const out = {};
  for (const name of everNames('src/output-styles')) {
    const hashes = versionsOf(`src/output-styles/${name}`).map((files) => hashText(blob([...files.values()][0])));
    if (hashes.length) out[name] = unique(hashes);
  }
  return out;
}

function skillHistory() {
  const out = {};
  for (const name of everNames('src/defaults/skills')) {
    const hashes = versionsOf(`src/defaults/skills/${name}`).map((files) =>
      hashTree([...files].map(([rel, sha]) => [rel, blob(sha)]))
    );
    if (hashes.length) out[name] = unique(hashes);
  }
  return out;
}

const history = {
  agents: packHistory('src/agents', 'AGENT.md'),
  workflows: packHistory('src/workflows', 'WORKFLOW.md'),
  outputStyles: outputStyleHistory(),
  skills: skillHistory(),
};
const text = `${JSON.stringify(history, null, 2)}\n`;
if (CHECK) {
  let committed = '';
  try {
    committed = readFileSync(OUT, 'utf8');
  } catch {
    committed = '';
  }
  if (committed !== text) {
    console.error(
      'build-shipped-history: src/defaults/shipped-history.json is stale; run `npm run build:shipped-history` and commit it'
    );
    process.exit(1);
  }
  console.log('build-shipped-history: committed history is current');
} else {
  writeFileSync(OUT, text);
  console.log(`build-shipped-history: wrote ${OUT}`);
}

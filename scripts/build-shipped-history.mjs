#!/usr/bin/env node
/**
 * scripts/build-shipped-history.mjs — emit src/defaults/shipped-history.json:
 * normalised-content hashes of every past shipped version of the agents,
 * workflows, output styles and bundled skills, read from git history.
 *
 * The startup migration (src/session-runtime/services/seeds.mjs) treats a data
 * dir copy matching any of these hashes as "unchanged" and moves it to a
 * backup so the current shipped version applies. Hash and normalisation code
 * is shared with the runtime (src/runtime/shared/shipped-definitions.mjs).
 *
 * Run:  node scripts/build-shipped-history.mjs   (also part of `prepack`)
 *       node scripts/build-shipped-history.mjs --check   (release workflow)
 * A shallow clone has no history: the committed file is left untouched.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIPPED_HISTORY_FILE,
  hashDefinition,
  hashText,
  hashTree,
  packDefinitionFrom,
} from '../src/runtime/shared/shipped-definitions.mjs';

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

/**
 * One long-lived `git cat-file --batch` answers every object read, so the whole
 * history costs a single process. `read(spec)` resolves to {sha, type, body}
 * or null when the object is missing.
 */
const catFile = spawn('git', ['cat-file', '--batch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = [];
let pending = Buffer.alloc(0);
catFile.stdout.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const eol = pending.indexOf(10);
    if (eol < 0) return;
    const header = pending.toString('utf8', 0, eol);
    if (header.endsWith(' missing')) {
      pending = pending.subarray(eol + 1);
      waiting.shift()(null);
      continue;
    }
    const [sha, type, size] = header.split(' ');
    const end = eol + 1 + Number(size);
    if (pending.length < end + 1) return;
    const body = pending.subarray(eol + 1, end);
    pending = pending.subarray(end + 1);
    waiting.shift()({ sha, type, body });
  }
});
const read = (spec) =>
  new Promise((resolve) => {
    waiting.push(resolve);
    catFile.stdin.write(`${spec}\n`);
  });

/** Entries of a tree object body: [{ name, tree, sha }] in git (ls-tree) order. */
function parseTree(body) {
  const entries = [];
  for (let at = 0; at < body.length; ) {
    const space = body.indexOf(32, at);
    const nul = body.indexOf(0, space);
    const mode = body.toString('latin1', at, space);
    entries.push({
      name: body.toString('utf8', space + 1, nul),
      tree: mode === '40000',
      sha: body.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

const treeCache = new Map();
const blobCache = new Map();
const treeOf = async (sha) => {
  if (!treeCache.has(sha)) treeCache.set(sha, read(sha).then(({ body }) => parseTree(body)));
  return treeCache.get(sha);
};
const blobOf = async (sha) => {
  if (!blobCache.has(sha)) blobCache.set(sha, read(sha).then(({ body }) => body));
  return blobCache.get(sha);
};

/** Relative path -> blob sha for every file under a tree entry (a lone file keeps its own name). */
async function filesOf({ name, tree, sha }) {
  if (!tree) return new Map([[name, sha]]);
  const files = new Map();
  const walk = async (treeSha, base) => {
    for (const entry of await treeOf(treeSha)) {
      if (entry.tree) await walk(entry.sha, `${base}${entry.name}/`);
      else files.set(`${base}${entry.name}`, entry.sha);
    }
  };
  await walk(sha, '');
  return files;
}

/** Names (path segment after `prefix`) that ever existed under prefix. */
function everNames(prefix) {
  const names = new Set();
  for (const file of lines(git('log', '--name-only', '--format=', '--', prefix))) {
    if (file.startsWith(`${prefix}/`)) names.add(file.slice(prefix.length + 1).split('/')[0]);
  }
  return [...names].sort();
}

/**
 * Every distinct state `prefix/<name>` had in the commits the path-limited
 * `git log -- path` lists (its history simplification decides which commits
 * count). Only the object reads are batched through `cat-file`.
 */
async function everVersions(prefix) {
  const out = new Map();
  for (const name of everNames(prefix)) {
    const path = `${prefix}/${name}`;
    const states = new Map();
    for (const commit of lines(git('log', '--format=%H', '--', path))) {
      const object = await read(`${commit}:${path}`);
      if (object) states.set(object.sha, { name, tree: object.type === 'tree', sha: object.sha });
    }
    const versions = [];
    for (const entry of states.values()) {
      const files = await filesOf(entry);
      if (files.size) versions.push(files);
    }
    out.set(name, versions);
  }
  return out;
}
const unique = (hashes) => [...new Set(hashes)].sort();

async function packHistory(dir, entry) {
  const out = {};
  for (const [id, versions] of await everVersions(dir)) {
    const hashes = [];
    for (const files of versions) {
      const texts = new Map();
      for (const [file, sha] of files) texts.set(file, (await blobOf(sha)).toString('utf8'));
      const definition = packDefinitionFrom((name) => texts.get(name) ?? null, entry, id);
      if (definition) hashes.push(hashDefinition(definition));
    }
    if (hashes.length) out[id] = unique(hashes);
  }
  return out;
}

async function outputStyleHistory() {
  const out = {};
  for (const [name, versions] of await everVersions('src/output-styles')) {
    const hashes = [];
    for (const files of versions) hashes.push(hashText(await blobOf([...files.values()][0])));
    if (hashes.length) out[name] = unique(hashes);
  }
  return out;
}

async function skillHistory() {
  const out = {};
  for (const [name, versions] of await everVersions('src/defaults/skills')) {
    const hashes = [];
    for (const files of versions) {
      hashes.push(hashTree(await Promise.all([...files].map(async ([rel, sha]) => [rel, await blobOf(sha)]))));
    }
    if (hashes.length) out[name] = unique(hashes);
  }
  return out;
}

const history = {
  agents: await packHistory('src/agents', 'AGENT.md'),
  workflows: await packHistory('src/workflows', 'WORKFLOW.md'),
  outputStyles: await outputStyleHistory(),
  skills: await skillHistory(),
};
catFile.stdin.end();
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

#!/usr/bin/env node
// Contract digests for a benchmark run.
//
// A preset fingerprint pins the dataset, suite, and routes — never the prompt
// surface. Two runs of one preset can therefore ship different rules and tool
// schemas under an identical fingerprint. These digests close that gap so a
// report says exactly which contract produced it.
//
// The tool catalog is hashed as the benchmark container sees it (linux), not
// as the host platform renders it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

function rulesDigest(repoRoot) {
  const dir = join(repoRoot, 'src', 'rules');
  const files = markdownFiles(dir)
    .map((path) => [relative(dir, path).split('\\').join('/'), readFileSync(path, 'utf8')])
    .sort(([left], [right]) => left.localeCompare(right));
  const payload = files.map(([name, body]) => `${name}\n${body}`).join('\n\0\n');
  return { hash: sha256(payload), files: files.length, bytes: Buffer.byteLength(payload) };
}

async function toolCatalogDigest(repoRoot) {
  // The container runs linux; hash the schema that ships there.
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const load = (path) => import(pathToFileURL(join(repoRoot, path)).href);
  const { BUILTIN_TOOLS } = await load('src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
  const { PATCH_TOOL_DEFS } = await load('src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs');
  const catalog = [...BUILTIN_TOOLS, ...PATCH_TOOL_DEFS]
    .map((tool) => [String(tool?.name || ''), tool])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, tool]) => tool);
  const payload = JSON.stringify(catalog);
  return { hash: sha256(payload), tools: catalog.length, bytes: Buffer.byteLength(payload) };
}

// Source bytes and delivered prompt are different contracts: build-time
// metadata (tool markers, comments) changes the former without changing what
// the model reads. Hash both so a source edit that must be prompt-neutral can
// be proven so.
function promptSurfaceDigest(repoRoot) {
  const require = createRequire(import.meta.url);
  const builder = require(join(repoRoot, 'src', 'lib', 'rules-builder.cjs'));
  const PLUGIN_ROOT = join(repoRoot, 'src');
  const shared = builder.buildSharedToolContent({ PLUGIN_ROOT });
  const lead = builder.buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR: '', includeLeadBrief: false });
  const payload = `${shared}\n\0\n${lead}`;
  return { hash: sha256(payload), bytes: Buffer.byteLength(payload) };
}

export async function buildContractDigest(repoRoot = REPO_ROOT) {
  const rules = rulesDigest(repoRoot);
  const prompt = promptSurfaceDigest(repoRoot);
  const tools = await toolCatalogDigest(repoRoot);
  return {
    schemaVersion: 1,
    rulesHash: rules.hash,
    rulesFiles: rules.files,
    rulesBytes: rules.bytes,
    promptSurfaceHash: prompt.hash,
    promptSurfaceBytes: prompt.bytes,
    toolCatalogHash: tools.hash,
    toolCount: tools.tools,
    toolSchemaBytes: tools.bytes,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf('--repo-root');
  const root = index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : REPO_ROOT;
  process.stdout.write(`${JSON.stringify(await buildContractDigest(root))}\n`);
}

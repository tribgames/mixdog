import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginSkillsRoots } from '../runtime/shared/plugin-manifest.mjs';
import { readMarkdownDocument } from '../runtime/shared/markdown-frontmatter.mjs';

export function ensureStandaloneEnvironment({ rootDir, dataDir }) {
  if (!rootDir) throw new Error('standalone rootDir is required');
  if (!dataDir) throw new Error('standalone dataDir is required');

  // Standalone owns its roots. All default state is scoped to Mixdog's resource
  // root and data dir regardless of install location.
  process.env.MIXDOG_ROOT = rootDir;
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_STANDALONE ??= '1';
  process.env.MIXDOG_EMBED_WARMUP ??= '0';
  process.env.MIXDOG_QUIET_MEMORY_LOG ??= '1';
  process.env.MIXDOG_PATCH_NATIVE_PREWARM ??= '0';

  mkdirSync(dataDir, { recursive: true });
  retireSeededSkillCopies({ rootDir, dataDir });
  retireSeededPackCopies({ rootDir, dataDir });
  cleanupRetiredChannelSecrets(dataDir);
}

// One-shot keychain cleanup: Discord/Telegram messaging is retired, so any
// stored bot tokens are orphans. Marker-gated so the (potentially slow) OS
// keychain roundtrip runs once per install; lazy import so shared config
// resolves its paths only after the env above is established.
function cleanupRetiredChannelSecrets(dataDir) {
  const marker = join(dataDir, '.retired-channel-secrets-cleaned');
  if (existsSync(marker)) return;
  void import('../runtime/shared/config.mjs')
    .then(({ deleteSecret }) => {
      try {
        deleteSecret('discord.token');
      } catch {
        /* best-effort */
      }
      try {
        deleteSecret('telegram.token');
      } catch {
        /* best-effort */
      }
      try {
        writeFileSync(marker, `${new Date().toISOString()}\n`);
      } catch {
        /* marker only */
      }
    })
    .catch(() => {
      /* cleanup is best-effort */
    });
}

// Built-in skills (src/defaults/skills/<name>/) used to be copied into the
// user data skills dir once and never refreshed, so every install kept the
// version it first saw. They are now read in place by the skill collector and
// a user-global skill of the same name shadows them. A leftover seeded copy
// would therefore pin the old text forever: remove it when it is still
// byte-identical to some bundled skill (the user never touched it) and keep
// it when it differs, because then it is the user's own override.
export function retireSeededSkillCopies({ rootDir, dataDir }) {
  const targetRoot = join(dataDir, 'skills');
  if (!existsSync(targetRoot)) return [];
  const retired = [];
  // The bundle is a plugin root; walk the same skill roots the collector reads.
  for (const bundledDir of pluginSkillsRoots(join(rootDir, 'defaults'))) {
    let names;
    try {
      names = readdirSync(bundledDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const copy = join(targetRoot, entry.name);
      if (!existsSync(copy)) continue;
      if (!sameTree(join(bundledDir, entry.name), copy)) continue;
      if (removeEntry(copy)) retired.push(entry.name);
    }
  }
  return retired;
}

function sameTree(left, right) {
  let leftEntries;
  let rightEntries;
  try {
    leftEntries = readdirSync(left, { withFileTypes: true });
    rightEntries = readdirSync(right, { withFileTypes: true });
  } catch {
    return false;
  }
  const names = (entries) => entries.map((entry) => entry.name).sort();
  if (names(leftEntries).join('\0') !== names(rightEntries).join('\0')) return false;
  for (const entry of leftEntries) {
    const a = join(left, entry.name);
    const b = join(right, entry.name);
    if (entry.isDirectory()) {
      if (!sameTree(a, b)) return false;
      continue;
    }
    if (!sameFile(a, b)) return false;
  }
  return true;
}

// A seed copied from a CRLF checkout and a package shipped with LF are the
// same text; only carriage returns are ignored, nothing else.
function sameBytes(left, right) {
  const strip = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return strip(left).equals(strip(right));
}

// Shipped workflows (<root>/workflows/<id>/WORKFLOW.md), agents
// (<root>/agents/<id>/AGENT.md + agent.json) and output styles
// (<root>/output-styles/<name>.md) are read in place, and a data-dir entry of
// the same id shadows them. The editors save a full copy, so saving a built-in
// pack without changing anything pins the text that shipped that day and no
// later app update ever reaches that user. Such a copy holds nothing of the
// user's: drop it so the current built-in applies again.
//
// "Unchanged" is the editable surface — name, description, body — because the
// editors cannot round-trip the rest (frontmatter flags, manifest id/entry),
// so a byte compare would read every no-op save as an override. A copy holding
// any other file (added references, a `.deleted` tombstone) is the user's own
// and is never touched.
const PACK_KINDS = [
  { dir: 'workflows', entry: 'WORKFLOW.md', files: ['WORKFLOW.md'] },
  { dir: 'agents', entry: 'AGENT.md', files: ['AGENT.md', 'agent.json'] },
];

export function retireSeededPackCopies({ rootDir, dataDir }) {
  const retired = [];
  for (const kind of PACK_KINDS) {
    for (const name of childNames(join(dataDir, kind.dir), 'dir')) {
      const bundled = join(rootDir, kind.dir, name);
      const copy = join(dataDir, kind.dir, name);
      if (!existsSync(join(bundled, kind.entry))) continue;
      if (!holdsOnly(copy, kind.files)) continue;
      if (!samePackDefinition(bundled, copy, kind.entry)) continue;
      if (removeEntry(copy)) retired.push(`${kind.dir}/${name}`);
    }
  }
  for (const name of childNames(join(dataDir, 'output-styles'), 'md')) {
    const bundled = join(rootDir, 'output-styles', name);
    const copy = join(dataDir, 'output-styles', name);
    if (!existsSync(bundled)) continue;
    if (!sameFile(bundled, copy)) continue;
    if (removeEntry(copy)) retired.push(`output-styles/${name}`);
  }
  return retired;
}

function childNames(root, kind) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const wanted = (entry) =>
    kind === 'dir' ? entry.isDirectory() : entry.isFile() && entry.name.toLowerCase().endsWith('.md');
  return entries.filter(wanted).map((entry) => entry.name);
}

// The copy may hold only the files an editor save writes; anything else in
// there was put there by the user and outranks the shipped pack.
function holdsOnly(dir, allowed) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.length > 0 && entries.every((entry) => entry.isFile() && allowed.includes(entry.name));
}

function samePackDefinition(bundledDir, copyDir, entry) {
  const bundled = packDefinition(bundledDir, entry);
  const copy = packDefinition(copyDir, entry);
  if (!bundled || !copy) return false;
  return bundled.name === copy.name && bundled.description === copy.description && bundled.body === copy.body;
}

// Same resolution the pack loaders use: agent.json wins over the markdown
// frontmatter for name/description, and the body is the markdown minus it.
function packDefinition(dir, entry) {
  const manifest = readJsonFile(join(dir, 'agent.json'));
  const raw = readTextFile(join(dir, oneLine(manifest.entry) || entry));
  const doc = readMarkdownDocument(raw);
  const body = String(doc.body || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!body) return null;
  return {
    name: oneLine(manifest.name || doc.frontmatter.name),
    description: oneLine(manifest.description || doc.frontmatter.description),
    body,
  };
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function oneLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameFile(left, right) {
  try {
    return sameBytes(readFileSync(left), readFileSync(right));
  } catch {
    return false;
  }
}

function removeEntry(target) {
  try {
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    // best-effort; a stuck copy simply keeps shadowing until removed by hand
    return false;
  }
}

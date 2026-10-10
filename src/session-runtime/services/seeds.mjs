import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginSkillsRoots } from '../../runtime/shared/plugin-manifest.mjs';
import {
  EMPTY_HISTORY,
  HISTORY_MARKER_FILE,
  fileHash,
  historyStamp,
  holdsOnlyEditorFiles,
  loadShippedHistory,
  makeBackup,
  packHashFromDir,
  treeHashFromDir,
} from '../../runtime/shared/shipped-definitions.mjs';

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
  // Copies equal to the CURRENT shipped version are retired on every start; the
  // (larger) historical comparison runs once per separation/history version.
  const backup = makeBackup(dataDir);
  const markerFile = join(dataDir, HISTORY_MARKER_FILE);
  const stamp = historyStamp(rootDir);
  let recorded = '';
  try {
    recorded = readFileSync(markerFile, 'utf8').trim();
  } catch {
    recorded = '';
  }
  const includeHistory = recorded !== stamp;
  retireSeededSkillCopies({ rootDir, dataDir, backup, includeHistory });
  retireSeededPackCopies({ rootDir, dataDir, backup, includeHistory });
  if (includeHistory && !backup.failures) {
    try {
      writeFileSync(markerFile, `${stamp}\n`);
    } catch {
      /* marker only; the sweep simply repeats */
    }
  }
  cleanupRetiredChannelSecrets(dataDir);
}

// One-shot keychain cleanup: Discord/Telegram messaging is retired, so any
// stored bot tokens are orphans. Marker-gated so the (potentially slow) OS
// keychain roundtrip runs once per install; lazy import so shared config
// resolves its paths only after the env above is established.
function cleanupRetiredChannelSecrets(dataDir) {
  const marker = join(dataDir, '.retired-channel-secrets-cleaned');
  if (existsSync(marker)) return;
  void import('../../runtime/shared/config.mjs')
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

// Shipped definitions live in code (read in place from the package); the data
// dir should hold only copies the user changed. Older releases copied, or the
// editors saved, full copies that then pin the text of the day they were made.
// A copy is "unchanged" when it equals the current shipped version or ANY past
// shipped version (hashes in defaults/shipped-history.json, generated from git
// by scripts/build-shipped-history.mjs, normalised for CRLF/trailing space).
// Unchanged copies are moved — never deleted — into
// <dataDir>/backups/defaults-separation-<timestamp>/, so the shipped version
// applies again; anything else is the user's own and stays.

// Built-in skills (<root>/defaults/skills/<name>/): compared as a whole tree.
export function retireSeededSkillCopies({ rootDir, dataDir, backup = makeBackup(dataDir), includeHistory = true }) {
  const targetRoot = join(dataDir, 'skills');
  if (!existsSync(targetRoot)) return [];
  const history = (includeHistory ? loadShippedHistory(rootDir) : EMPTY_HISTORY).skills;
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
      const copyHash = treeHashFromDir(copy);
      if (!copyHash) continue;
      const known = [treeHashFromDir(join(bundledDir, entry.name)), ...(history[entry.name] || [])];
      if (!known.includes(copyHash)) continue;
      if (backup.move(copy)) retired.push(entry.name);
    }
  }
  return retired;
}

// Shipped workflows (<root>/workflows/<id>/WORKFLOW.md), agents
// (<root>/agents/<id>/AGENT.md + agent.json) and output styles
// (<root>/output-styles/<name>.md).
//
// "Unchanged" for a pack means every loader-visible field matches: name,
// description, body and all other frontmatter/manifest fields (permission,
// hidden, model/tool fields, entry...). Only normalisation (CRLF, trailing
// space, quoting, an id equal to the folder name, the default entry) is
// ignored. A copy holding any file beyond the editor's own (added references,
// a `.deleted` tombstone) is the user's and is never touched; stray backups
// such as AGENT.md.bak do not count and travel to the backup with the copy.
const PACK_KINDS = [
  { dir: 'workflows', historyKey: 'workflows', entry: 'WORKFLOW.md', files: ['WORKFLOW.md'] },
  { dir: 'agents', historyKey: 'agents', entry: 'AGENT.md', files: ['AGENT.md', 'agent.json'] },
];

export function retireSeededPackCopies({ rootDir, dataDir, backup = makeBackup(dataDir), includeHistory = true }) {
  const history = includeHistory ? loadShippedHistory(rootDir) : EMPTY_HISTORY;
  const retired = [];
  for (const kind of PACK_KINDS) {
    for (const name of childNames(join(dataDir, kind.dir), 'dir')) {
      const bundled = join(rootDir, kind.dir, name);
      const copy = join(dataDir, kind.dir, name);
      const current = packHashFromDir(bundled, kind.entry, name);
      if (!current) continue;
      if (!holdsOnlyEditorFiles(copy, kind.files, kind.entry)) continue;
      const copyHash = packHashFromDir(copy, kind.entry, name);
      if (![current, ...(history[kind.historyKey][name] || [])].includes(copyHash)) continue;
      if (backup.move(copy)) retired.push(`${kind.dir}/${name}`);
    }
  }
  for (const name of childNames(join(dataDir, 'output-styles'), 'md')) {
    const bundled = fileHash(join(rootDir, 'output-styles', name));
    if (!bundled) continue;
    const copy = join(dataDir, 'output-styles', name);
    if (![bundled, ...(history.outputStyles[name] || [])].includes(fileHash(copy))) continue;
    if (backup.move(copy)) retired.push(`output-styles/${name}`);
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

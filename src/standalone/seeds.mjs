import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
      try { deleteSecret('discord.token'); } catch { /* best-effort */ }
      try { deleteSecret('telegram.token'); } catch { /* best-effort */ }
      try { writeFileSync(marker, `${new Date().toISOString()}\n`); } catch { /* marker only */ }
    })
    .catch(() => { /* cleanup is best-effort */ });
}

// Built-in skills (src/defaults/skills/<name>/) used to be copied into the
// user data skills dir once and never refreshed, so every install kept the
// version it first saw. They are now read in place by the skill collector and
// a user-global skill of the same name shadows them. A leftover seeded copy
// would therefore pin the old text forever: remove it when it is still
// byte-identical to some bundled skill (the user never touched it) and keep
// it when it differs, because then it is the user's own override.
export function retireSeededSkillCopies({ rootDir, dataDir }) {
  const bundledDir = join(rootDir, 'defaults', 'skills');
  const targetRoot = join(dataDir, 'skills');
  if (!existsSync(bundledDir) || !existsSync(targetRoot)) return [];
  let names;
  try {
    names = readdirSync(bundledDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const retired = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const copy = join(targetRoot, entry.name);
    if (!existsSync(copy)) continue;
    if (!sameTree(join(bundledDir, entry.name), copy)) continue;
    try {
      rmSync(copy, { recursive: true, force: true });
      retired.push(entry.name);
    } catch {
      // best-effort; a stuck copy simply keeps shadowing until removed by hand
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
    try {
      if (!sameBytes(readFileSync(a), readFileSync(b))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// A seed copied from a CRLF checkout and a package shipped with LF are the
// same text; only carriage returns are ignored, nothing else.
function sameBytes(left, right) {
  const strip = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return strip(left).equals(strip(right));
}

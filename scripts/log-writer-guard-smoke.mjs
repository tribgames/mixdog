#!/usr/bin/env node
/**
 * scripts/log-writer-guard-smoke.mjs — unbounded `.log` writer regression gate.
 *
 * A new `.log` file name that lands in src/ without being covered by one of the
 * bounded-writer contracts is an unbounded-growth footgun: the sibling-GC in
 * mixdog-debug.cjs only prunes names it knows (canonical set + stale-sibling
 * regexes), and the worker-boot rotation loop only rotates its explicit list.
 * Any other steady `.log` append grows without limit.
 *
 * This scans src/ for string-literal `.log` file names (the targets that feed
 * appendFile/appendFileSync/createWriteStream) and fails when a name is not:
 *   - in the canonical set (parsed live from mixdog-debug.cjs), or
 *   - in the worker-boot rotation list (parsed live from worker-bootstrap.mjs), or
 *   - matched by the dynamic / per-PID sibling patterns, or
 *   - in the explicit in-script allowlist below.
 *
 * Run:  node scripts/log-writer-guard-smoke.mjs   (or `npm run smoke:logguard`)
 * Exit: 0 = every writer covered, 1 = uncovered `.log` name(s) found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
// `dist` = built TUI bundle (generated from src/tui/*); vendor is third-party.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor']);
const SCAN_EXT = /\.(mjs|cjs|js|jsx)$/;

// `.log` file-name targets. Two shapes, both bounded to real string content:
//   STATIC   — a quoted/backtick literal (`'boot.log'`, `"logs\\a.log"`). The
//              `+` stem keeps us off the bare `.endsWith('.log')` guards.
//   TEMPLATE — a `${...}` interpolation immediately followed by a static `.log`
//              tail (`${jobId}.stdout.log`, `${root}.log`). The dynamic prefix
//              is unverifiable, so the trailing literal (down to bare `.log`)
//              must be covered/allowlisted or it fails.
// Separators (`/` and `\`) are captured; basename() reduces to the file name.
const STATIC_RE = /['"`]([\w.\-/\\]+\.log)\b/g;
const TEMPLATE_RE = /\$\{[^}]*\}([\w.\-/\\]*\.log)\b/g;

/** Last path segment, splitting on both POSIX and Windows separators. */
function basename(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** Parse a `new Set([...])` / array of quoted `.log` names out of a source file. */
function parseLogNames(file, anchor) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return []; }
  const at = src.indexOf(anchor);
  if (at === -1) return [];
  const tail = src.slice(at, at + 2000);
  const end = tail.indexOf(']');
  const block = end === -1 ? tail : tail.slice(0, end);
  return [...block.matchAll(/['"]([\w.\-]+\.log)['"]/g)].map((m) => m[1]);
}

// ── Covered names ────────────────────────────────────────────────────
// Parsed live so a name added to either contract auto-covers here.
const canonical = new Set(
  parseLogNames(join(SRC, 'lib/mixdog-debug.cjs'), 'CANONICAL_PLUGIN_LOG_NAMES'),
);
const rotation = new Set(
  parseLogNames(join(SRC, 'runtime/channels/lib/worker-bootstrap.mjs'), '_rotLog of ['),
);

// Explicitly bounded / non-plugin-dir writers that live outside the sibling-GC
// contract by design (size-rotated in place, per-job spill, one-shot probes).
const ALLOWLIST = new Set([
  'session-start-critical.log',      // size-bounded via rotateBoundedLog()
  'mixdog-ws-upgrade-probe.log',     // one-shot WS upgrade probe dump
  '.stdout.log',                     // shell-jobs per-jobId spill (`${jobId}.stdout.log`)
  '.stderr.log',                     // shell-jobs per-jobId spill (`${jobId}.stderr.log`)
]);

// Dynamic / per-PID sibling names (never literal, but keep the contract explicit).
const DYNAMIC_RE = [
  /^(channels|memory)-worker\.\d+\.\d+\.log$/,
  /-worker\.\d+\.\d+\.log$/,
  /^mcp-debug\.\d+\.\d+\.log$/,
  /^supervisor\.\d+\.log$/,
];

function isCovered(name) {
  return (
    canonical.has(name) ||
    rotation.has(name) ||
    ALLOWLIST.has(name) ||
    DYNAMIC_RE.some((re) => re.test(name))
  );
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (SCAN_EXT.test(name)) yield p;
  }
}

const offenders = [];
let scanned = 0;
for (const file of walk(SRC)) {
  scanned++;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of [STATIC_RE, TEMPLATE_RE]) {
      for (const m of lines[i].matchAll(re)) {
        const name = basename(m[1]);
        if (isCovered(name)) continue;
        offenders.push(`${relative(ROOT, file)}:${i + 1} — uncovered \`.log\` writer target \`${name}\``);
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('log-writer-guard: FAIL — uncovered unbounded `.log` writer(s):');
  for (const line of offenders) console.error(`  ${line}`);
  console.error(
    `log-writer-guard: ${offenders.length} offender(s). Add the name to CANONICAL_PLUGIN_LOG_NAMES ` +
    '(mixdog-debug.cjs), the worker-boot rotation list, or the ALLOWLIST in this script.',
  );
  process.exit(1);
}
console.log(`log-writer-guard: ok — ${scanned} files scanned, every \`.log\` writer covered`);

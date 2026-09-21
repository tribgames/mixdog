/**
 * read-tool/reach-preflight.mjs — the string guards every read shape shares
 * (UNC/SMB, Windows device, ADS, /dev/* block) and the reachability preflight
 * that runs before any filesystem access.
 */
import { assertPathsReachable } from '../fs-reachability.mjs';

// Same messages the inline string guards emit (image fast-path / single path).
const GUARDS = [
  ['isUncPath', 'cannot read UNC / SMB path (network credential leak risk)'],
  ['isWindowsDevicePath', 'cannot read Windows device path (reserved name or raw-device namespace)'],
  [
    'hasUnsafeWin32Component',
    'cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard)',
  ],
  ['isBlockedDevicePath', 'cannot read device file (would block or produce infinite output)'],
];
const ALL_READ_GUARDS = GUARDS.map(([name]) => name);
// The resolved (absolute) form of a path is checked for the string-shape
// guards only; the /dev/* block is decided on the normalized input.
export const PATH_STRING_GUARDS = ALL_READ_GUARDS.filter((name) => name !== 'isBlockedDevicePath');

export function guardedReadError(p, helpers, names = ALL_READ_GUARDS) {
  const { normalizeOutputPath } = helpers;
  const o = (x) => (typeof normalizeOutputPath === 'function' ? normalizeOutputPath(x) : x);
  for (const [name, message] of GUARDS) {
    if (!names.includes(name)) continue;
    const guard = helpers[name];
    if (typeof guard === 'function' && guard(p)) return `Error: ${message}: ${o(p)}`;
  }
  return null;
}

// Pure-regex strip of a trailing line coordinate (`:N`, `:N-M`, `#LN`) — NO
// filesystem access. Used only to derive a statable base path for the async
// reachability preflight; the real read path does precise line-vs-colon
// disambiguation later (which uses existsSync and would itself block on a dead
// mount). A Windows drive colon `C:\...` is not a trailing `:digits`.
export function stripLineCoordForReach(s) {
  // Mirror the real resolver's coordinate suffix shapes (read-args.mjs):
  // `:N`, `:N-M`, `:N:C` (line:col / trailing detail), and `#LN`/`#LN-M`/`#LN...`.
  return String(s)
    .replace(/#L\d+(?:-L?\d+)?(?:\b.*)?$/i, '')
    .replace(/:\d+(?:-\d+)?(?::.*)?$/, '');
}

function collectReachCandidates(p) {
  const out = [];
  const push = (s) => {
    if (typeof s === 'string' && s) out.push(s);
  };
  if (typeof p === 'string') push(p);
  else if (Array.isArray(p)) for (const e of p) push(e && typeof e === 'object' ? (e.path ?? e.file_path) : e);
  return out;
}

// Reachability preflight for EVERY read shape (scalar / array / reads[]). MUST
// run before any filesystem access. Besides bounding a dead mount, its Stats
// objects seed the real read so the common path does not immediately re-stat.
export async function readReachPreflight(rawPath, workDir, helpers) {
  const { normalizeInputPath, resolveAgainstCwd } = helpers;
  // A guarded path (UNC/SMB, Windows device, ADS, /dev/* block) must be
  // REJECTED here, not skipped: skipping would let the later guard/open
  // path touch it and trigger NTLM/raw-device access or hang. Reject up front
  // with the same message the inline guards emit.
  // normalizeInputPath FIRST (FS-pure) so we stat the same path the real read
  // opens (e.g. /mnt/z/... -> Z:\...). Reachability is per-mount/dir, so the
  // line-coordinate strip only needs to land in the right directory — exact
  // suffix parsing is not required for the stat to be representative.
  const candidates = [];
  const seenFull = new Set();
  for (const raw of collectReachCandidates(rawPath)) {
    const stripped = stripLineCoordForReach(normalizeInputPath(raw));
    const full = resolveAgainstCwd(stripped, workDir);
    const guardMsg = guardedReadError(stripped, helpers) || guardedReadError(full, helpers);
    if (guardMsg) return { error: guardMsg, statsByPath: null };
    // Dedup by resolved path so a batch repeating the same file (or the
    // same union window) issues one stat probe, not one per entry —
    // bounding the preflight's FS work to the distinct target set.
    if (seenFull.has(full)) continue;
    seenFull.add(full);
    candidates.push(full);
  }
  if (candidates.length === 0) return { error: null, statsByPath: new Map() };
  try {
    const stats = await assertPathsReachable(candidates);
    const statsByPath = new Map();
    for (let i = 0; i < candidates.length; i++) {
      if (stats[i]) statsByPath.set(candidates[i], stats[i]);
    }
    return { error: null, statsByPath };
  } catch (e) {
    return { error: `Error: ${e?.message || e}`, statsByPath: null };
  }
}

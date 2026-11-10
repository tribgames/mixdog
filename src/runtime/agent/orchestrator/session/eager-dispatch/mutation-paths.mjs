// Mutation path log for the eager mutation epoch: every epoch advance also
// records the paths that mutation touched (null = unknown), so an eager read
// can tell whether a mutation after its dispatch affected its target files.
import { isAbsolute, normalize, resolve } from 'node:path';
import { extractTouchedPathsFromPatch } from '../cache/read-cache.mjs';
import { _stripMcpPrefix } from '../loop/tool-classify.mjs';

function absPath(value, base) {
  const abs = isAbsolute(value) ? normalize(value) : resolve(base || process.cwd(), value);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function argPaths(args) {
  const raw = args?.file_path ?? args?.path;
  // Read windows arrive as { file_path, offset, limit } entries.
  const list = (Array.isArray(raw) ? raw : [raw]).map((p) => (p && typeof p === 'object' ? p.file_path : p));
  return list.every((p) => typeof p === 'string' && p.length > 0) ? list : null;
}

// Absolute paths a mutation call touches, or null when unknown.
function mutationPaths(call, cwd) {
  const name = _stripMcpPrefix(call.name);
  const args = call.arguments;
  if (name === 'edit') {
    const paths = argPaths(args);
    return paths && paths.map((p) => absPath(p, cwd));
  }
  if (name === 'apply_patch') {
    const patch = typeof args === 'string' ? args : args?.patch;
    const touched = extractTouchedPathsFromPatch(patch);
    if (touched.length === 0) return null;
    const base = typeof args?.base_path === 'string' && args.base_path ? absPath(args.base_path, cwd) : cwd;
    return touched.map((p) => absPath(p, base));
  }
  return null;
}

export function recordMutation(epoch, call, cwd) {
  const log = (epoch.log ??= []);
  log[epoch.mutation] = mutationPaths(call, cwd);
  epoch.mutation += 1;
}

// True when a mutation recorded at or after `sinceEpoch` may have changed
// the read's targets (unknown mutation paths, glob or unparseable targets).
export function mutationAffectsRead(epoch, sinceEpoch, call, cwd) {
  const targets = argPaths(call.arguments);
  const after = [];
  for (let i = sinceEpoch; i < epoch.mutation; i += 1) after.push(epoch.log?.[i] ?? null);
  if (after.length === 0) return false;
  if (!targets || targets.some((p) => /[*?[\]{}]/.test(p))) return true;
  const abs = new Set(targets.map((p) => absPath(p, cwd)));
  return after.some((paths) => paths === null || paths.some((p) => abs.has(p)));
}

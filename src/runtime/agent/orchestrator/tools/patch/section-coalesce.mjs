// V4A section coalescing: repeated plain Update sections on one file merge
// into a single section, and a Delete-then-Add pair collapses into the
// single end state it describes.
import { readFileSync } from 'node:fs';
import { normalizeOutputPath } from '../builtin.mjs';
import { splitTextLinesForPatch } from './matcher.mjs';
import { resolveV4AEntryPath } from './paths.mjs';

// A whole-file rewrite is naturally written as "delete the old file, add the
// new one", and that pair has exactly ONE possible outcome: the file ends up
// holding the Add body. Rejecting it as a conflicting target cost a full turn
// for a patch that was never ambiguous. Collapse it instead — into a full-file
// Update when the target exists, so every ordinary update guard (special
// files, reachability, verification, write locks) still runs, or into the
// plain Add when it does not exist and the Delete had nothing to remove.
// Everything else (Update+Delete, Add+Add, renames) keeps rejecting: those
// pairs genuinely describe two different end states.
function collapseDeleteThenAddSection(prior, section, fullPath) {
  if (prior?.kind !== 'delete' || section?.kind !== 'add') return null;
  if (prior.movePath || section.movePath) return null;
  const added = Array.isArray(section.lines) ? [...section.lines] : [];
  let raw;
  try {
    raw = readFileSync(fullPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
    return { ...section, lines: added, hunks: [] };
  }
  // A binary target has no line model to rewrite; leave it to the existing
  // conflict error rather than inventing one.
  if (raw.includes(0)) return null;
  const current = splitTextLinesForPatch(raw.toString('utf8'));
  return {
    kind: 'update',
    path: section.path,
    lines: [],
    hunks: [
      {
        anchors: [],
        lines: [...[...current].map((line) => `-${line}`), ...added.map((line) => `+${line}`)],
      },
    ],
  };
}

export function coalesceCompatibleV4ASections(sections, basePath) {
  const out = [];
  const indexByPath = new Map();
  for (const section of sections || []) {
    if (!section || typeof section.path !== 'string' || !section.path) {
      out.push(section);
      continue;
    }
    const fullPath = resolveV4AEntryPath(basePath, section.path);
    const key = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    const priorIndex = indexByPath.get(key);
    if (priorIndex == null) {
      indexByPath.set(key, out.length);
      out.push({
        ...section,
        hunks: Array.isArray(section.hunks) ? [...section.hunks] : [],
        lines: Array.isArray(section.lines) ? [...section.lines] : [],
      });
      continue;
    }
    const prior = out[priorIndex];
    const replaced = collapseDeleteThenAddSection(prior, section, fullPath);
    if (replaced) {
      out[priorIndex] = replaced;
      continue;
    }
    const mergeable = prior?.kind === 'update' && section.kind === 'update' && !prior.movePath && !section.movePath;
    if (!mergeable) {
      throw new Error(
        `apply_patch: conflicting operations target ${normalizeOutputPath(section.path)}; ` +
          'only repeated plain Update File sections can be merged'
      );
    }
    prior.hunks.push(...(Array.isArray(section.hunks) ? section.hunks : []));
  }
  return out;
}

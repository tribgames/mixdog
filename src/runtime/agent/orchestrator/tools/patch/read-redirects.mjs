// Patch target redirection: a header path that no longer exists on disk is
// re-pointed at the read-snapshot redirect or the unique relocated file, so a
// patch written against a moved file still lands on it.
import { existsSync, statSync } from 'node:fs';
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from 'node:path';
import { findBySuffixStrip, findFileByBasename } from '../builtin/path-diagnostics.mjs';
import { resolveReadPathRedirect } from '../builtin/snapshot-store.mjs';
import { resolveEntryPath, resolveV4AEntryPath, classifyEntry, pathKey } from './paths.mjs';

function uniqueExistingPatchTarget(basePath, requestedFullPath) {
  // Auto-relocation is only valid for a missing target lexically inside the
  // patch root. An explicit outside-root path must never be pulled back into
  // the project merely because a basename happens to match.
  const rel = pathRelative(pathResolve(basePath), pathResolve(requestedFullPath));
  if (isAbsolute(rel) || rel.split(/[\\/]+/).some((part) => part === '..')) return null;
  const asFile = (candidate) => {
    if (!candidate) return null;
    const fullPath = isAbsolute(candidate) ? pathResolve(candidate) : pathResolve(basePath, candidate);
    try {
      return statSync(fullPath).isFile() ? fullPath : null;
    } catch {
      return null;
    }
  };
  const suffix = asFile(findBySuffixStrip(basePath, requestedFullPath));
  if (suffix) return suffix;
  const basenameHits = findFileByBasename(basePath, requestedFullPath, { limit: 2 });
  return basenameHits.length === 1 ? asFile(basenameHits[0]) : null;
}

function redirectedPatchPath(requestedFullPath, readStateScope, basePath) {
  // A newly-created exact requested path always wins over an older redirect.
  if (!requestedFullPath || existsSync(requestedFullPath)) return requestedFullPath;
  const redirected = resolveReadPathRedirect(requestedFullPath, readStateScope);
  if (redirected && existsSync(redirected)) return redirected;
  return uniqueExistingPatchTarget(basePath, requestedFullPath) || requestedFullPath;
}

export function patchHeaderPathForResolved(basePath, fullPath) {
  const rel = pathRelative(pathResolve(basePath), pathResolve(fullPath));
  if (rel && !isAbsolute(rel) && !rel.split(/[\\/]+/).some((part) => part === '..')) {
    return rel.replace(/\\/g, '/');
  }
  return fullPath;
}

export function rewriteV4AReadRedirects(sections, basePath, readStateScope) {
  return (sections || []).map((section) => {
    if (!section || section.kind === 'add' || !section.path) return section;
    const requested = resolveV4AEntryPath(basePath, section.path);
    const redirected = redirectedPatchPath(requested, readStateScope, basePath);
    if (pathKey(redirected) === pathKey(requested)) return section;
    return { ...section, path: patchHeaderPathForResolved(basePath, redirected) };
  });
}

export function rewriteParsedReadRedirects(parsed, basePath, readStateScope) {
  return (parsed || []).map((entry) => {
    const kind = classifyEntry(entry);
    if (kind === 'create' || !entry?.oldFileName) return entry;
    const requested = resolveEntryPath(basePath, entry.oldFileName);
    const redirected = redirectedPatchPath(requested, readStateScope, basePath);
    if (pathKey(redirected) === pathKey(requested)) return entry;
    const rewritten = {
      ...entry,
      oldFileName: patchHeaderPathForResolved(basePath, redirected),
    };
    if (kind === 'modify' && entry.newFileName) {
      const newRequested = resolveEntryPath(basePath, entry.newFileName);
      if (pathKey(newRequested) === pathKey(requested)) {
        rewritten.newFileName = rewritten.oldFileName;
      }
    }
    return rewritten;
  });
}

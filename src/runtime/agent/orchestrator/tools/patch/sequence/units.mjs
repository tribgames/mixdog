// Ordered-section units. Each file section of the patch becomes one unit
// that resolves its parsed unified entry lazily via buildParsed(), so a V4A
// section is converted only when it is its turn — against the disk state the
// earlier sections left behind. A later section that fails to convert/apply
// never blocks the earlier ones from committing (ordered-stop). The V4A path
// AND the bare-@@ / counted-unified fallbacks share this, so those salvageable
// formats keep ordered-stop instead of aborting whole-patch.
import { parsePatch } from 'diff';
import { normalizeOutputPath } from '../../builtin.mjs';
import {
  canFallbackCountedUnified,
  hasUnifiedBareV4AHunk,
  isV4APatchInput,
  parseUnifiedBareV4APatch,
  parseUnifiedCountedAsV4APatch,
  parseV4APatch,
  prepareInput,
} from '../parsing.mjs';
import { entryHeaderName, parsedEntryResolvedPath, resolveV4AEntryPath, stripDiffPrefix } from '../paths.mjs';
import { rewriteParsedReadRedirects, rewriteV4AReadRedirects } from '../read-redirects.mjs';
import { coalesceCompatibleV4ASections } from '../section-coalesce.mjs';
import {
  applyV4ARenameSection,
  convertV4ASectionsToUnifiedPatch,
  formatV4ARenameSuccessLines,
  isV4ARenameSection,
  validateV4ARenameSection,
} from '../v4a-convert.mjs';
import { parseConvertedUnifiedPatch } from '../wave.mjs';

function sectionUnit(section, basePath, { v4aConvertOpts, readStateScope, dryRun }) {
  const displayPath = normalizeOutputPath(section.path);
  const fullPath = resolveV4AEntryPath(basePath, section.path);
  // A V4A rename runs as its own ordered unit through the atomic rename
  // executor: it validates against the disk state earlier sections left
  // behind, and the destination path joins the lock set.
  if (isV4ARenameSection(section)) {
    return {
      displayPath,
      fullPath,
      extraLockPaths: [resolveV4AEntryPath(basePath, section.movePath)],
      execute: async () => {
        const errText = validateV4ARenameSection(section, basePath, new Set());
        if (errText) throw new Error(errText);
        const result = await applyV4ARenameSection(section, basePath, { ...v4aConvertOpts, readStateScope, dryRun });
        if (dryRun) {
          return `(dry-run) would rename ${displayPath} → ${normalizeOutputPath(section.movePath)} (~${result.linesChanged} lines touched)`;
        }
        return formatV4ARenameSuccessLines([result]).join('\n');
      },
    };
  }
  return {
    displayPath,
    fullPath,
    // Honor reject_partial via v4aConvertOpts: a bad hunk throws under
    // reject_partial=true (section fails → sequence stops) but is recorded in
    // rejectedHunks and skipped under reject_partial=false.
    buildParsed: async () => {
      const unified = await convertV4ASectionsToUnifiedPatch([section], basePath, v4aConvertOpts);
      return parseConvertedUnifiedPatch(unified);
    },
  };
}

function parsedEntryUnit(entry, basePath) {
  const headerName = entryHeaderName(entry);
  if (!headerName) {
    throw new Error(
      'apply_patch: a file section header could not be parsed (no target path) — the patch body is not a valid diff. ' +
        'Each section must start with `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>` ' +
        '(V4A, wrapped in `*** Begin Patch` / `*** End Patch`), or a `--- a/<path>` + `+++ b/<path>` pair (unified).'
    );
  }
  return {
    displayPath: normalizeOutputPath(stripDiffPrefix(headerName)),
    fullPath: parsedEntryResolvedPath(entry, basePath),
    buildParsed: async () => [entry],
  };
}

// Parse the patch body into V4A-style sections (V4A envelope, bare-@@ hunks,
// or counted-unified salvaged as V4A), or into parsed unified entries for a
// plain unified diff.
function parsePatchSections(patchStr, requestedFormat, basePath, { readStateScope, coalesceByFile }) {
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      const parsedSections = rewriteV4AReadRedirects(parseV4APatch(patchStr), basePath, readStateScope);
      return { sections: coalesceByFile ? coalesceCompatibleV4ASections(parsedSections, basePath) : parsedSections };
    } catch (err) {
      throw new Error(`apply_patch: V4A parse failed — ${err?.message || String(err)}`);
    }
  }
  if (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr)) {
    // Bare `@@` V4A hunks in a unified body: parse to sections and defer each
    // section's conversion into its own unit (ordered-stop preserved) rather
    // than converting the whole patch up front.
    try {
      return { sections: rewriteV4AReadRedirects(parseUnifiedBareV4APatch(patchStr), basePath, readStateScope) };
    } catch (err) {
      throw new Error(`apply_patch: bare @@ parse failed — ${err?.message || String(err)}`);
    }
  }
  let parsed = null;
  try {
    parsed = parsePatch(prepareInput(patchStr));
  } catch (err) {
    if (!canFallbackCountedUnified(patchStr, requestedFormat, err)) {
      throw new Error(
        `apply_patch: parse failed — ${err?.message || String(err)}; prefer V4A envelope for multi-hunk edits (no @@ line counts)`
      );
    }
    // Counted-unified (`@@ -a,b +c,d @@`) that parsePatch rejects: parse to
    // V4A-style sections and defer per-section conversion — same ordered-stop
    // guarantee as the V4A path (no whole-patch up-front convert).
    try {
      return { sections: rewriteV4AReadRedirects(parseUnifiedCountedAsV4APatch(patchStr), basePath, readStateScope) };
    } catch (fallbackErr) {
      throw new Error(
        `apply_patch: parse failed — ${err?.message || String(err)}; V4A fallback failed — ${fallbackErr?.message || String(fallbackErr)}`
      );
    }
  }
  return { parsed: rewriteParsedReadRedirects(parsed, basePath, readStateScope) };
}

export function buildPatchUnits(patchStr, requestedFormat, basePath, ctx) {
  const { sections, parsed } = parsePatchSections(patchStr, requestedFormat, basePath, ctx);
  if (sections) return sections.map((section) => sectionUnit(section, basePath, ctx));
  return (parsed || []).map((entry) => parsedEntryUnit(entry, basePath));
}

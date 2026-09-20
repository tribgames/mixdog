/**
 * read-tool/glob-survey.mjs — head-glob sampling: read "/app/logs/*.log"
 * limit=5 fans out to the parallel per-file batch — same semantics as
 * `head -n5 *.log`, one result with per-file headers. Literal paths always
 * win: a REAL file named "[id].tsx" or "{slug}.md" is read as itself; only a
 * non-existent magic path expands. Cap 10 files (glob's mtime order, newest
 * first); top-level offset/limit apply per file. Zero glob matches fall
 * through to the single-read path so the raw pattern gets the standard
 * ENOENT + suggestion machinery.
 */
import { existsSync } from 'node:fs';
import { hasGlobMagic } from '../path-utils.mjs';
import { stripLineCoordForReach } from './reach-preflight.mjs';

const READ_GLOB_CAP = 10;
// Per-file hard cap for glob fan-out. Sampling many files at the single-file
// default turns one call into thousands of context lines, while format/shape
// evidence needs only a small head from each file. Exact-path reads keep the
// standard defaults.
// MIXDOG_READ_GLOB_SURVEY_LIMIT overrides for A/B runs.
const READ_GLOB_SURVEY_LIMIT = 25;
const READ_GLOB_OUTPUT_BUDGET_BYTES = 10 * 1024;
function globSurveyLimit() {
  const parsed = parseInt(process.env.MIXDOG_READ_GLOB_SURVEY_LIMIT ?? '', 10);
  return parsed > 0 ? parsed : READ_GLOB_SURVEY_LIMIT;
}

// Note lines the glob tool can emit; everything else is a path. A prefix
// filter would drop legitimate names such as `[id].tsx`, `(draft).md` or
// `...rest.ts`.
const isGlobNoteLine = (l) =>
  l.startsWith('# ') ||
  l.startsWith('... [') ||
  l.startsWith('(no ') ||
  l.startsWith('Error: ') ||
  (/^\[.+\]$/.test(l) && /\s/.test(l));

function withCapNote(expanded, capNote) {
  if (!capNote) return expanded;
  if (typeof expanded === 'string') return expanded + capNote;
  if (expanded && typeof expanded === 'object' && Array.isArray(expanded.content)) {
    return { ...expanded, content: [...expanded.content, { type: 'text', text: capNote.trim() }] };
  }
  return expanded;
}

async function globMatches(globNorm, workDir, executeChildBuiltinTool) {
  let globOut = '';
  try {
    globOut = String(
      (await executeChildBuiltinTool('glob', { pattern: globNorm, head_limit: READ_GLOB_CAP + 1 }, workDir)) || ''
    );
  } catch {
    globOut = '';
  }
  return globOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isGlobNoteLine(l));
}

// `recurse(args, options)` re-enters the read tool with the expanded batch.
// Returns null when the path is not a magic pattern, names a real file, or
// matches nothing.
export async function readGlobSurvey(args, workDir, executeChildBuiltinTool, options, helpers, recurse) {
  if (!(typeof args.path === 'string' && hasGlobMagic(args.path) && typeof executeChildBuiltinTool === 'function')) {
    return null;
  }
  const { normalizeInputPath, resolveAgainstCwd } = helpers;
  const globNorm = normalizeInputPath(args.path);
  let literalExists = false;
  try {
    literalExists = existsSync(resolveAgainstCwd(stripLineCoordForReach(globNorm), workDir));
  } catch {
    /* treat as non-literal */
  }
  if (literalExists) return null;
  const globFiles = await globMatches(globNorm, workDir, executeChildBuiltinTool);
  if (globFiles.length === 0) return null;
  const capped = globFiles.slice(0, READ_GLOB_CAP);
  const capNote =
    globFiles.length > READ_GLOB_CAP
      ? `\n[glob expansion capped at ${READ_GLOB_CAP} files (newest first); narrow the pattern for the rest]`
      : '';
  const surveyArgs = { ...args, path: capped, file_path: undefined };
  const survey = globSurveyLimit();
  const requestedLimit = Number(surveyArgs.limit);
  surveyArgs.limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.trunc(requestedLimit), survey) : survey;
  const expanded = await recurse(surveyArgs, {
    ...options,
    readOutputBudgetBytes: Math.min(
      Number(options?.readOutputBudgetBytes) > 0
        ? Number(options.readOutputBudgetBytes)
        : READ_GLOB_OUTPUT_BUDGET_BYTES,
      READ_GLOB_OUTPUT_BUDGET_BYTES
    ),
  });
  return withCapNote(expanded, capNote);
}

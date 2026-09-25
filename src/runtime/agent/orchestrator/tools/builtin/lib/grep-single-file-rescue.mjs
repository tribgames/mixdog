// Single-FILE grep rescue: scan the one explicitly targeted file in JS when
// the native search server cannot answer it.
//
// A file operand has no tree to walk — the server scans it directly — so a
// deadline reached on a file scope is never about this file. It is queue
// starvation: the resident server is shared, and one scope rooted in a virtual
// filesystem (/proc, /sys) walks a tree that cannot finish inside any budget
// and holds the queue while it burns. Measured in the wild: three /sys glob
// reads spent 17.5s each, the grep behind them failed after 17.7s on a
// six-line /proc/self/status, and a plain read of that same file answered in
// 7ms three seconds later.
//
// Reading one file is bounded work, so the call answers instead of spending a
// whole turn on someone else's walk. Anything this scanner cannot reproduce
// exactly — multiline patterns, type filters, a PCRE-only regex, a binary or
// oversized file — declines (returns null) and the caller keeps the original
// native error.
import { readFile } from 'node:fs/promises';

import { formatGrepContextOutput, formatGrepOutput, grepNoMatchesBody } from './grep-output.mjs';

/** Reading is the whole point of the rescue, so the file must stay small
 *  enough that reading it is cheaper than the failed search. */
export const MAX_RESCUE_BYTES = 8 * 1024 * 1024;
/** Bounds memory on a pathological match rate; a truncated window is reported
 *  as incomplete, exactly like a capped native result. */
const MAX_RESCUE_LINES = 5_000;

function compilePatterns(patterns, caseInsensitive) {
  const flags = caseInsensitive ? 'i' : '';
  const compiled = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(String(pattern), flags));
    } catch {
      // A PCRE-only construct (lookbehind variants, \p classes, inline
      // flags) has no faithful JS twin: decline rather than answer with
      // different semantics than the caller asked for.
      return null;
    }
  }
  return compiled.length > 0 ? compiled : null;
}

export async function runGrepSingleFileRescue({
  filePath,
  searchPath,
  patterns,
  caseInsensitive,
  multilineMode,
  onlyMatching,
  fileType,
  outputMode,
  showLineNumbers,
  withFilename,
  filenameOmitted,
  beforeN,
  afterN,
  contextN,
  headLimit,
  offset,
  workDir,
  patternCapNote = '',
}) {
  if (multilineMode || fileType) return null;
  const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean);
  const compiled = compilePatterns(list, caseInsensitive);
  if (!compiled) return null;

  let raw;
  try {
    raw = await readFile(filePath);
  } catch {
    return null;
  }
  if (raw.length > MAX_RESCUE_BYTES || raw.includes(0)) return null;
  const text = raw.toString('utf8');
  const fileLines = text.split(/\r?\n/);
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();

  const matched = [];
  for (let index = 0; index < fileLines.length; index += 1) {
    if (compiled.some((re) => re.test(fileLines[index]))) matched.push(index);
  }

  const pathPrefix = (separator) => (withFilename ? `${searchPath}${separator}` : '');
  const numberPrefix = (index, separator) => (showLineNumbers ? `${index + 1}${separator}` : '');

  // Shared by all three output modes; only `windowed`, `filenameOmitted` and
  // `totalKnown` differ per mode.
  const plainBase = {
    patternCapNote,
    outputMode,
    headLimit,
    offset,
    workDir,
    beforeN,
    afterN,
    contextN,
  };

  if (outputMode === 'files_with_matches') {
    return renderPlain({
      ...plainBase,
      windowed: matched.length > 0 ? [String(searchPath)] : [],
      filenameOmitted: false,
    });
  }
  if (outputMode === 'count') {
    return renderPlain({
      ...plainBase,
      windowed: matched.length > 0 ? [`${pathPrefix(':')}${matched.length}`] : [],
      filenameOmitted,
    });
  }

  const before = Math.max(Number(beforeN) || 0, Number(contextN) || 0);
  const after = Math.max(Number(afterN) || 0, Number(contextN) || 0);
  const hasContext = before > 0 || after > 0;
  const { lines, truncated } = renderRescueLines({
    fileLines,
    matched,
    compiled,
    onlyMatching,
    before,
    after,
    hasContext,
    pathPrefix,
    numberPrefix,
  });

  if (hasContext) {
    const body = formatGrepContextOutput({
      allLines: lines,
      workDir,
      outputMode,
      filenameOmitted,
      headLimit,
      offset,
      searchPath,
      totalKnown: !truncated,
    });
    return withRescueNotice(patternCapNote + (body.text || grepNoMatchesBody({ totalKnown: !truncated })));
  }
  return renderPlain({
    ...plainBase,
    windowed: offset > 0 ? lines.slice(offset) : lines,
    filenameOmitted,
    totalKnown: !truncated,
  });
}

/**
 * The rg-shaped body for the line-oriented modes: matched lines (or just the
 * matched substrings under onlyMatching) plus their context window, with `--`
 * between non-adjacent blocks. Stops at MAX_RESCUE_LINES and reports that the
 * total is no longer known.
 */
function renderRescueLines({
  fileLines,
  matched,
  compiled,
  onlyMatching,
  before,
  after,
  hasContext,
  pathPrefix,
  numberPrefix,
}) {
  const isMatch = new Set(matched);
  const emit = new Set();
  for (const index of matched) {
    for (let i = Math.max(0, index - before); i <= Math.min(fileLines.length - 1, index + after); i += 1) {
      emit.add(i);
    }
  }
  const ordered = [...emit].sort((left, right) => left - right);
  const lines = [];
  let previous = -1;
  let truncated = false;
  for (const index of ordered) {
    if (lines.length >= MAX_RESCUE_LINES) {
      truncated = true;
      break;
    }
    // rg separates non-adjacent context blocks; the context formatter reads
    // the same marker.
    if (hasContext && previous >= 0 && index > previous + 1) lines.push('--');
    previous = index;
    const line = fileLines[index];
    if (isMatch.has(index)) {
      if (onlyMatching) {
        for (const re of compiled) {
          const global = new RegExp(re.source, `${re.flags}g`);
          for (const found of line.matchAll(global)) {
            lines.push(`${pathPrefix(':')}${numberPrefix(index, ':')}${found[0]}`);
          }
        }
        continue;
      }
      lines.push(`${pathPrefix(':')}${numberPrefix(index, ':')}${line}`);
      continue;
    }
    lines.push(`${pathPrefix('-')}${numberPrefix(index, '-')}${line}`);
  }
  return { lines, truncated };
}

function withRescueNotice(body) {
  return `${body}\n[notice] native search could not serve this file scope; the file was scanned directly.`;
}

function renderPlain({
  windowed,
  patternCapNote,
  outputMode,
  headLimit,
  offset,
  workDir,
  filenameOmitted,
  beforeN,
  afterN,
  contextN,
  totalKnown = true,
}) {
  const body =
    formatGrepOutput({
      windowed,
      totalWindowed: windowed.length,
      totalKnown,
      headLimit,
      offset,
      outputMode,
      beforeN,
      afterN,
      contextN,
      workDir,
      filenameOmitted,
      includeMatchCount: false,
    }) || grepNoMatchesBody({ totalKnown });
  return withRescueNotice(patternCapNote + body);
}

// Line-level text handling for patches: typographic normalisation, line
// splitting with terminators, splicing, EOL detection and joining.

// --- typographic normalization + line splitters ------------------------------
const RUST_WS =
  '\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const RUST_TRIM_RE = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g');
function rustTrim(s) {
  return s.replace(RUST_TRIM_RE, '');
}
export function normalizeTypographic(s) {
  // NFC first: a decomposed sequence (Hangul jamo, or "e" + combining acute
  // from a file authored on another platform) is visually identical to its
  // composed form but byte-different, which failed an otherwise exact context.
  return rustTrim(String(s ?? '').normalize('NFC'))
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, ' ');
}

// Splits into line CONTENT plus the exact terminator that followed each line
// (`lines.terminators`). Line content is identical to the historical
// CRLF-folding split — a lone CR is only a terminator in a CR-dominant file —
// but recording the real bytes is what lets a rewrite put every untouched
// line back with its ORIGINAL terminator instead of the file's dominant one.
export function splitTextLinesForPatch(text) {
  const raw = String(text ?? '');
  const eol = detectDominantEol(raw);
  const splitLoneCr = eol === '\r';
  const lines = [];
  const terminators = [];
  let start = 0;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\n') {
      lines.push(raw.slice(start, i));
      terminators.push('\n');
      i += 1;
      start = i;
      continue;
    }
    if (ch === '\r') {
      if (raw[i + 1] === '\n') {
        lines.push(raw.slice(start, i));
        terminators.push('\r\n');
        i += 2;
        start = i;
        continue;
      }
      if (splitLoneCr) {
        lines.push(raw.slice(start, i));
        terminators.push('\r');
        i += 1;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  let hasFinalNewline = true;
  if (start < raw.length) {
    lines.push(raw.slice(start));
    terminators.push('');
    hasFinalNewline = false;
  }
  lines.hasFinalNewline = hasFinalNewline;
  lines.eol = eol;
  lines.terminators = terminators;
  return lines;
}

export function cloneTextLinesForPatch(sourceLines, eol) {
  const lines = [...(sourceLines || [])];
  lines.hasFinalNewline = sourceLines?.hasFinalNewline !== false;
  lines.eol = eol || sourceLines?.eol || '\n';
  lines.terminators = Array.isArray(sourceLines?.terminators) ? [...sourceLines.terminators] : null;
  return lines;
}

// The ONLY mutation entry point for a patch line array. Replaced lines hand
// their own terminator to the new line at the same offset (a 1:1 replacement
// is byte-identical outside the changed text), extra inserted lines adopt the
// local convention, and every line the patch did not touch keeps its bytes.
// Op-wise terminators for one hunk's output lines. Derived from the hunk's OWN
// ops — never from content similarity, which cannot describe interior context,
// several change runs, or a moved line:
//   context → keeps its source line's terminator verbatim
//   delete  → contributes its terminator to the current run
//   add     → takes the terminator of the delete it replaces inside that run,
//             else the local convention.
export function terminatorsForUnifiedOps(ops, oldTerminators, fallbackEol = '\n') {
  const olds = Array.isArray(oldTerminators) ? oldTerminators : [];
  const entries = (ops || []).map((entry) =>
    typeof entry === 'string' ? { op: entry, line: undefined } : { op: entry?.op, line: entry?.line }
  );
  const pool = deleteTerminatorPool(entries, olds);
  const out = [];
  let oldCursor = 0;
  let currentRun = 0;
  let lastClaimed = -1; // pool index claimed by the previous add
  for (const entry of entries) {
    const { op, line } = entry;
    if (op === 'context') {
      const terminator = olds[oldCursor];
      oldCursor += 1;
      currentRun += 1;
      out.push(terminator !== undefined ? terminator : fallbackEol);
    } else if (op === 'delete') {
      oldCursor += 1;
    } else if (op === 'add') {
      const index = claimableDeleteIndex(pool, line, currentRun, lastClaimed);
      let inherited;
      if (index >= 0) {
        pool[index].used = true;
        lastClaimed = index;
        inherited = pool[index].terminator;
      }
      out.push(inherited !== undefined ? inherited : fallbackEol);
    }
  }
  return out;
}

// Pre-pass: EVERY delete of the hunk with the terminator of the source line
// it consumes, tagged with its run. Building the pool as we walk only saw
// deletes already passed, so a BACKWARD move (the add precedes its delete)
// could not claim its own line and lost its terminator.
function deleteTerminatorPool(entries, olds) {
  const pool = [];
  let cursor = 0;
  let run = 0;
  for (const entry of entries) {
    if (entry.op === 'context') {
      cursor += 1;
      run += 1;
    } else if (entry.op === 'delete') {
      pool.push({ line: entry.line, terminator: olds[cursor], used: false, run });
      cursor += 1;
    }
  }
  return pool;
}

// The pool slot an added line inherits its terminator from, or -1:
// 1) identity AFTER the previously claimed delete (order-preserving, so
//    duplicates are consumed in sequence instead of first-fit),
// 2) identity ANYWHERE in the hunk (a line moved forwards or backwards
//    across context keeps its own terminator),
// 3) the next unclaimed delete OF THIS RUN (the line it replaces).
function claimableDeleteIndex(pool, line, currentRun, lastClaimed) {
  let index = -1;
  if (line !== undefined) {
    index = pool.findIndex((slot, i) => !slot.used && slot.line === line && i > lastClaimed);
    if (index < 0) index = pool.findIndex((slot) => !slot.used && slot.line === line);
  }
  if (index < 0) index = pool.findIndex((slot) => !slot.used && slot.run === currentRun);
  return index;
}

/** Local convention for a replaced window: its own last terminator, else its neighbours'. */
export function localTerminatorForWindow(lines, start, oldLen) {
  const terms = lines?.terminators;
  if (!Array.isArray(terms)) return lines?.eol || '\n';
  const replaced = terms.slice(start, start + oldLen);
  return (
    (replaced.length ? replaced[replaced.length - 1] : '') || terms[start - 1] || terms[start] || lines.eol || '\n'
  );
}

export function spliceTextLinesForPatch(lines, start, oldLen, newLines, newTerminators = null) {
  const terms = lines?.terminators;
  if (Array.isArray(terms)) {
    const replacedTerms = terms.slice(start, start + oldLen);
    const replacedLines = lines.slice(start, start + oldLen);
    const local = localTerminatorForWindow(lines, start, oldLen);
    const explicit = Array.isArray(newTerminators) && newTerminators.length === newLines.length ? newTerminators : null;
    const nextTerms = newLines.map((line, k) => {
      if (explicit) return explicit[k] !== undefined ? explicit[k] : local;
      // No op information (a caller that cannot describe its edit): keep a
      // terminator ONLY for an output line that is byte-identical to the
      // source line at the same offset; everything else takes the local
      // convention. Never guess across offsets.
      return replacedLines[k] === line && replacedTerms[k] !== undefined ? replacedTerms[k] : local;
    });
    terms.splice(start, oldLen, ...nextTerms);
  }
  lines.splice(start, oldLen, ...newLines);
}

// Explicit end-of-file intent (`\ No newline at end of file` in either
// direction). The terminator array is the state of record, so the intent is
// written INTO it; `hasFinalNewline` is kept in sync for matching code.
export function setFinalNewlineForPatch(lines, hasNewline) {
  if (!lines) return;
  lines.hasFinalNewline = hasNewline;
  const terms = lines.terminators;
  if (!Array.isArray(terms) || terms.length === 0) return;
  const last = terms.length - 1;
  if (!hasNewline) terms[last] = '';
  else if (!terms[last]) terms[last] = terms[last - 1] || lines.eol || '\n';
}

export function joinTextLinesForPatch(lines) {
  const arr = lines || [];
  const eol = arr.eol || '\n';
  const terms = Array.isArray(arr.terminators) && arr.terminators.length === arr.length ? arr.terminators : null;
  if (!terms) {
    const body = arr.join(eol);
    return arr.hasFinalNewline !== false ? `${body}${eol}` : body;
  }
  // Terminators are authoritative. The file-level `hasFinalNewline` flag must
  // NOT be re-applied here: after a tail deletion the surviving last line is a
  // line the patch never touched, and forcing the old "no final newline" state
  // onto it removed a terminator that belonged to untouched bytes.
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    const isLast = i === arr.length - 1;
    let terminator = terms[i];
    if (!terminator && !isLast) terminator = terms[i - 1] || eol;
    out += `${arr[i]}${terminator}`;
  }
  return out;
}

export function detectDominantEol(text) {
  const raw = String(text ?? '');
  if (raw.includes('\r') && !raw.includes('\n')) return '\r';
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\n') continue;
    lf++;
    if (i > 0 && raw[i - 1] === '\r') crlf++;
  }
  return lf > 0 && crlf * 2 >= lf ? '\r\n' : '\n';
}

export function splitBufferLinesForPatch(buf) {
  const empty = [];
  if (!buf || buf.length === 0) {
    empty.hasFinalNewline = true;
    return empty;
  }
  const lines = [];
  let start = 0;
  const crOnly = buf.includes(0x0d) && !buf.includes(0x0a);
  const nl = crOnly ? 0x0d : 0x0a;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === nl) {
      let end = i;
      if (!crOnly && end > start && buf[end - 1] === 0x0d) end--;
      lines.push(buf.subarray(start, end));
      start = i + 1;
    }
  }
  let hasFinalNewline;
  if (start === buf.length) {
    hasFinalNewline = true;
  } else {
    lines.push(buf.subarray(start, buf.length));
    hasFinalNewline = false;
  }
  lines.hasFinalNewline = hasFinalNewline;
  return lines;
}

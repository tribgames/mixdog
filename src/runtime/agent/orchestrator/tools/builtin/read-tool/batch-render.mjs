/**
 * read-tool/batch-render.mjs — the aggregate a batch read returns: the
 * `read N (k failed)` header with count summaries, the reject_partial
 * all-or-none gate, per-entry status tags, identical-entry dedup, and the
 * rich (image blocks) vs plain-text rendering.
 */

// Per-entry status in a batch. A conclusively missing file is not a failed
// read — that is why its body is `[path absent]` and not `Error:` — but it is
// not `ok` either: the header said `missing.png [ok]` above a body saying the
// file does not exist, which is the one line a skimming reader trusts. Absence
// gets its own tag so the header and the body agree.
function batchEntryStatus(body, failed, textBody) {
  if (failed) return 'error';
  return /^\s*\[path absent\]/.test(String(textBody ?? body ?? '')) ? 'absent' : 'ok';
}

const richPartsFor = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.content) ? value.content : null;

const bodyTextFor = (value) => {
  const parts = richPartsFor(value);
  if (!parts) return String(value || '');
  return parts
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
};

const TRUNCATED_MARKER = /\[TRUNCATED (?:—|-) file is (\d+) lines \/ (\d+) KB\./;
// When `read` emitted a smart-cap marker, surface the truncation state in the
// header so downstream skimming spots it without parsing the body.
const truncatedSuffix = (textBody) => {
  const match = TRUNCATED_MARKER.exec(textBody);
  return match ? ` (truncated ${match[1]}L/${match[2]}KB)` : '';
};

// Default full mode carries no information — tag only non-default modes.
const modeOf = (r) => (r.n !== undefined ? `${r.mode} n=${r.n}` : r.mode);
const modeTagOf = (mode) => (mode && mode !== 'full' ? ` [${mode}]` : '');

function headerLine(orderedResults, failedReads, normalizeOutputPath) {
  const summaries = [];
  for (const r of orderedResults) {
    if (r.mode === 'count') {
      const m = String(r.body || '').match(/lines\t(\d+)/);
      if (m) summaries.push(`${normalizeOutputPath(r.path)} has ${m[1]} lines`);
    }
  }
  const summaryLine = summaries.length ? ` ${summaries.join('; ')}` : '';
  // The header avoids the leading `Error:` prefix because some entries
  // succeeded; failure count is reported in parens.
  return failedReads > 0
    ? `read ${orderedResults.length} (${failedReads} failed)${summaryLine}`
    : `read ${orderedResults.length}${summaryLine}`;
}

// Structured result: image blocks stay rich; byte-identical repeats (same
// path + mode + body) collapse into a reference placeholder.
function renderRichBatch(orderedResults, header, args, { normalizeOutputPath, bodyFailed }) {
  const content = [{ type: 'text', text: header }];
  const seenTextEntryBody = new Map();
  const seenRichEntryBody = new WeakMap();
  for (let i = 0; i < orderedResults.length; i++) {
    const r = orderedResults[i];
    const path = normalizeOutputPath(r.path);
    const mode = modeOf(r);
    const textBody = bodyTextFor(r.body);
    const status = batchEntryStatus(r.body, bodyFailed(r.body), textBody);
    const entryHeader = `${path}${modeTagOf(mode)} [${status}]${truncatedSuffix(textBody)}`;
    const richParts = richPartsFor(r.body);
    let priorIdx;
    if (richParts) {
      let seenByKey = seenRichEntryBody.get(r.body);
      if (!seenByKey) {
        seenByKey = new Map();
        seenRichEntryBody.set(r.body, seenByKey);
      }
      const key = JSON.stringify([path, mode]);
      priorIdx = seenByKey.get(key);
      if (priorIdx === undefined) seenByKey.set(key, i);
    } else {
      const key = JSON.stringify([path, mode, r.body || '']);
      priorIdx = seenTextEntryBody.get(key);
      if (priorIdx === undefined) seenTextEntryBody.set(key, i);
    }
    if (priorIdx !== undefined) {
      content.push({ type: 'text', text: `${entryHeader} [= entry #${priorIdx + 1}, identical result omitted]` });
      continue;
    }
    content.push({ type: 'text', text: entryHeader });
    if (richParts) content.push(...richParts);
    else content.push({ type: 'text', text: String(r.body || '') });
  }
  if (args._batchCapNote) content.push({ type: 'text', text: args._batchCapNote });
  return { content };
}

// Identical-entry dedup: when the caller puts the exact same window twice in
// the path array, coalesceObjectReadEntries already merges the disk read, but
// the 1:1 request/response contract still renders every index. Emit a
// reference placeholder for byte-identical repeats (same path + same mode +
// same body) so the duplicate body is not materialised twice -- the entry
// keeps its index, only the body is elided. With no duplicates the output is
// byte-for-byte unchanged.
function renderTextBatch(orderedResults, header, args, { normalizeOutputPath, classifyResultKind }) {
  const seenEntryBody = new Map();
  const body = orderedResults
    .map((r, i) => {
      const path = normalizeOutputPath(r.path);
      const mode = modeOf(r);
      const status = batchEntryStatus(
        r.body,
        classifyResultKind(String(r.body || '')) === 'error',
        String(r.body || '')
      );
      const dupKey = JSON.stringify([path, mode, r.body || '']);
      const priorIdx = seenEntryBody.get(dupKey);
      if (priorIdx !== undefined) {
        return `${path}${modeTagOf(mode)} [${status}] [= entry #${priorIdx + 1}, identical result omitted]`;
      }
      seenEntryBody.set(dupKey, i);
      return `${path}${modeTagOf(mode)} [${status}]${truncatedSuffix(r.body || '')}\n${r.body}`;
    })
    .join('\n\n');
  return `${header}\n\n${body}${args._batchCapNote ? `\n\n${args._batchCapNote}` : ''}`;
}

export function renderBatchResults(orderedResults, args, { classifyResultKind, normalizeOutputPath }) {
  const bodyFailed = (value) => value?.isError === true || classifyResultKind(bodyTextFor(value)) === 'error';
  const failedReads = orderedResults.filter((r) => bodyFailed(r.body)).length;
  // reject_partial:true — when the caller asked for all-or-none, refuse to
  // return a mixed payload that downstream parsers would have to
  // disambiguate per-entry. All-or-none is about DELIVERY: an entry that
  // returned no content did not deliver, whether it failed outright or was
  // conclusively absent. Counting only hard failures let a batch with a
  // missing file through as a mixed payload — exactly what the caller asked
  // not to receive.
  const undelivered = orderedResults.filter(
    (r) => batchEntryStatus(r.body, bodyFailed(r.body), bodyTextFor(r.body)) !== 'ok'
  );
  if (undelivered.length > 0 && args.reject_partial === true) {
    const reasons = undelivered
      .map(
        (r) => `${normalizeOutputPath(r.path)}: ${bodyTextFor(r.body).split('\n')[0] || 'structured media read failed'}`
      )
      .join('; ');
    return `Error: batch read rejected (${undelivered.length} of ${orderedResults.length} failed; reject_partial:true) — ${reasons}`;
  }
  // Per-entry status tags ([ok]/[error]) let a downstream classifyResultKind
  // treat the aggregate as a structured report rather than a single error
  // string.
  const header = headerLine(orderedResults, failedReads, normalizeOutputPath);
  if (orderedResults.some((r) => richPartsFor(r.body) !== null)) {
    return renderRichBatch(orderedResults, header, args, { normalizeOutputPath, bodyFailed });
  }
  return renderTextBatch(orderedResults, header, args, { normalizeOutputPath, classifyResultKind });
}

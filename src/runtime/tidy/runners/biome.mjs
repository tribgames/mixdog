// Biome — JSON reporter for check, `--write` (1.x: `--apply`) for fix.
import { mapLimit, runProcess } from '../process.mjs';
import {
  FILES_PER_SPAWN,
  chunkFiles,
  diagnostic,
  emptyResult,
  positionAt,
  runChunked,
  spawnFailureResult,
  tail,
  toRel,
  uniquePaths,
} from './shared.mjs';

const LEGACY_WRITE_FLAG = /unexpected argument|unrecognized|unknown (?:option|argument)/i;
export const BIOME_CHECK_ARGS = ['check', '--reporter=json', '--max-diagnostics=none'];
export const BIOME_TRUNCATED_NOTE =
  'biome JSON output was truncated; split the scope and re-run to get complete diagnostics';
const EXPLAIN_TIMEOUT_MS = 8_000;
const EXPLAIN_CONCURRENCY = 4;

function severityOf(value) {
  const level = String(value || '').toLowerCase();
  if (level === 'error' || level === 'fatal') return 'error';
  if (level === 'warning' || level === 'warn') return 'warning';
  return 'info';
}

function emptyParse(truncated) {
  return truncated ? { diagnostics: [], changedFiles: [], truncated: true } : { diagnostics: [], changedFiles: [] };
}

/** Byte index just past a JSON object/array starting at `start`, or -1 if truncated. */
function endOfJsonValue(text, start = 0) {
  const source = String(text || '');
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  const open = source[index];
  if (open !== '{' && open !== '[') return -1;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return char === close ? index + 1 : -1;
    }
  }
  return -1;
}

function recoverDiagnosticsArray(text) {
  const source = String(text || '');
  const keyAt = source.indexOf('"diagnostics"');
  if (keyAt < 0) return [];
  const bracket = source.indexOf('[', keyAt + 13);
  if (bracket < 0) return [];
  const rows = [];
  let index = bracket + 1;
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index])) index += 1;
    if (index >= source.length || source[index] === ']') break;
    if (source[index] !== '{') break;
    const end = endOfJsonValue(source, index);
    if (end < 0) break;
    try {
      rows.push(JSON.parse(source.slice(index, end)));
    } catch {
      break;
    }
    index = end;
  }
  return rows;
}

function parseJsonDocuments(text) {
  const docs = [];
  let truncated = false;
  let index = 0;
  const source = String(text || '');
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;
    if (source[index] !== '{' && source[index] !== '[') {
      const next = source.indexOf('{', index);
      if (next < 0) break;
      index = next;
    }
    const end = endOfJsonValue(source, index);
    if (end < 0) {
      truncated = true;
      const recovered = recoverDiagnosticsArray(source.slice(index));
      if (recovered.length) docs.push({ diagnostics: recovered });
      break;
    }
    try {
      docs.push(JSON.parse(source.slice(index, end)));
    } catch {
      truncated = true;
      break;
    }
    index = end;
  }
  return { docs, truncated };
}

function locationOf(row, cwd) {
  const loc = row?.location || {};
  const pathValue = loc.path?.file || loc.path || '';
  const file = toRel(cwd, typeof pathValue === 'string' ? pathValue : '');
  const source = typeof loc.sourceCode === 'string' ? loc.sourceCode : '';
  const span = Array.isArray(loc.span) ? loc.span : null;
  if (span && source) {
    const at = positionAt(source, span[0]);
    return { file, line: at.line, col: at.col };
  }
  const start = loc.start || loc.range?.start || {};
  return { file, line: Number(start.line) || 0, col: Number(start.column) || 0 };
}

/** Lint/assist rule id from a diagnostic category (`lint/style/useConst` → `useConst`). */
function biomeRuleName(category) {
  const value = String(category || '');
  if (!value.startsWith('lint/') && !value.startsWith('assist/')) return '';
  return value.split('/').pop() || '';
}

/** Parse `biome explain <rule>` summary: `- Fix: safe|unsafe` or `No fix available.` */
export function parseExplainFix(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^- Fix:\s*unsafe\b/i.test(trimmed)) return 'unsafe';
    if (/^- Fix:\s*safe\b/i.test(trimmed)) return 'safe';
    if (/no fix available/i.test(trimmed)) return 'none';
  }
  return 'none';
}

function tagsOf(row) {
  return Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag).toLowerCase()) : [];
}

/** Safety from the JSON row itself. Empty string means Biome 2.5 omitted it — use explain. */
function payloadFixKind(row, category) {
  if (category.startsWith('format')) return 'safe';
  const tags = tagsOf(row);
  if (tags.includes('unsafe')) return 'unsafe';
  if (tags.includes('fixable')) return 'safe';
  return '';
}

export function applyBiomeFixKinds(diagnostics, kinds = new Map()) {
  for (const finding of diagnostics || []) {
    const code = String(finding?.code || '');
    if (code.startsWith('format')) {
      finding.fixKind = 'safe';
      finding.fixable = true;
      continue;
    }
    if (finding.codeFix === false) {
      finding.fixKind = 'manual';
      finding.fixable = false;
      continue;
    }
    const mapped = kinds.get(biomeRuleName(code));
    if (mapped === 'safe' || mapped === 'unsafe') {
      finding.fixKind = mapped;
      finding.fixable = mapped === 'safe';
      continue;
    }
    if (mapped === 'none') {
      finding.fixKind = 'manual';
      finding.fixable = false;
      continue;
    }
    if (!finding.fixKind) finding.fixKind = finding.fixable ? 'safe' : 'manual';
    finding.fixable = finding.fixKind === 'safe';
  }
  return diagnostics;
}

async function loadBiomeFixKinds({
  bin,
  names = [],
  run = runProcess,
  signal = null,
  timeoutMs = EXPLAIN_TIMEOUT_MS,
} = {}) {
  const unique = [...new Set((names || []).map((name) => String(name || '').trim()).filter(Boolean))];
  const kinds = new Map();
  await mapLimit(unique, EXPLAIN_CONCURRENCY, async (name) => {
    try {
      const result = await run(bin, ['explain', name], { timeoutMs, signal });
      kinds.set(name, parseExplainFix(`${result?.stdout || ''}\n${result?.stderr || ''}`));
    } catch {
      kinds.set(name, 'none');
    }
  });
  return kinds;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload?.diagnostics)) return payload.diagnostics;
  return [];
}

function rowsToResult(rows, cwd, truncated) {
  const diagnostics = [];
  const changedFiles = [];
  for (const row of rows) {
    const category = String(row?.category || row?.code?.value || row?.code || '');
    const { file, line, col } = locationOf(row, cwd);
    if (category.startsWith('format')) changedFiles.push(file);
    const kind = payloadFixKind(row, category);
    const rdjson = row?.code && typeof row.code === 'object' && typeof row.code.value === 'string';
    let codeFix;
    if (category.startsWith('format')) codeFix = true;
    else if (Array.isArray(row?.suggestions)) codeFix = row.suggestions.length > 0;
    else if (rdjson) codeFix = false;
    diagnostics.push(
      diagnostic({
        file,
        line,
        col,
        code: category,
        message: String(row?.description || row?.message || '').replace(/\s+/g, ' '),
        severity: severityOf(row?.severity),
        fixable: kind === 'safe',
        fixKind: kind,
        ...(codeFix === true || codeFix === false ? { codeFix } : {}),
      })
    );
  }
  return {
    diagnostics,
    changedFiles: uniquePaths(changedFiles),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Parse `biome check --reporter=json` output (one document, many, or a truncated tail). */
export function parseBiomeJson(stdout, cwd, options = {}) {
  const truncatedInput = Boolean(options.truncated);
  const text = String(stdout || '').trim();
  if (!text) return emptyParse(truncatedInput);
  const { docs, truncated: parseTruncated } = parseJsonDocuments(text);
  if (docs.length === 0) {
    if (truncatedInput || parseTruncated || text.includes('{')) return emptyParse(true);
    return emptyParse(false);
  }
  const rows = [];
  let omitted = false;
  for (const payload of docs) {
    rows.push(...rowsFromPayload(payload));
    if (Number(payload?.summary?.diagnosticsNotPrinted) > 0) omitted = true;
  }
  const parsed = rowsToResult(rows, cwd, truncatedInput || parseTruncated || omitted);
  if (options.ruleKinds) applyBiomeFixKinds(parsed.diagnostics, options.ruleKinds);
  return parsed;
}

export function mergeBiomeParses(parts) {
  const diagnostics = [];
  const changedFiles = [];
  let truncated = false;
  for (const part of parts || []) {
    diagnostics.push(...(part.diagnostics || []));
    changedFiles.push(...(part.changedFiles || []));
    if (part.truncated) truncated = true;
  }
  return {
    diagnostics,
    changedFiles: uniquePaths(changedFiles),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function biomeCounts(diagnostics = [], changedFiles = []) {
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byFixability = { safe: 0, unsafe: 0, manual: 0, fixable: 0, unfixable: 0 };
  const byRule = {};
  for (const finding of diagnostics) {
    const severity = finding?.severity === 'error' || finding?.severity === 'warning' ? finding.severity : 'info';
    bySeverity[severity] += 1;
    let kind = 'manual';
    if (finding?.fixKind === 'unsafe') kind = 'unsafe';
    else if (finding?.fixKind === 'safe' || finding?.fixable) kind = 'safe';
    byFixability[kind] += 1;
    if (kind === 'safe') byFixability.fixable += 1;
    else byFixability.unfixable += 1;
    const code = String(finding?.code || 'unknown');
    byRule[code] = (byRule[code] || 0) + 1;
  }
  return {
    filesToFormat: changedFiles.length,
    diagnostics: diagnostics.length,
    bySeverity,
    byFixability,
    byRule,
  };
}

function finalizeBiome(parsed, stderrTail) {
  return {
    diagnostics: parsed.diagnostics,
    changedFiles: parsed.changedFiles,
    counts: biomeCounts(parsed.diagnostics, parsed.changedFiles),
    stderrTail,
    ...(parsed.truncated ? { truncated: true, note: BIOME_TRUNCATED_NOTE } : {}),
  };
}

async function runBiomeJsonChunks({
  bin,
  args = [],
  files = [],
  cwd,
  timeoutMs,
  signal,
  run = runProcess,
  filesPerSpawn = FILES_PER_SPAWN,
}) {
  const parts = [];
  let failure = null;
  let stderr = '';
  for (const chunk of chunkFiles(files, filesPerSpawn)) {
    const result = await run(bin, [...args, ...BIOME_CHECK_ARGS, ...chunk], { cwd, timeoutMs, signal });
    stderr += result.stderr || '';
    if (result.error && !failure) failure = result;
    if (!result.error && result.truncated && chunk.length > 1) {
      const nested = await runBiomeJsonChunks({
        bin,
        args,
        files: chunk,
        cwd,
        timeoutMs,
        signal,
        run,
        filesPerSpawn: Math.ceil(chunk.length / 2),
      });
      parts.push(...nested.parts);
      stderr += nested.stderr;
      if (nested.failure && !failure) failure = nested.failure;
      continue;
    }
    parts.push(parseBiomeJson(result.stdout, cwd, { truncated: Boolean(result.truncated) }));
  }
  return { parts, failure, stderr };
}

export const runner = {
  id: 'biome',
  async check({ files, cwd, bin, args = [], timeoutMs, signal, run, filesPerSpawn }) {
    const spawn = run || runProcess;
    const result = await runBiomeJsonChunks({
      bin,
      args,
      files,
      cwd,
      timeoutMs,
      signal,
      run: spawn,
      filesPerSpawn,
    });
    if (result.failure) return spawnFailureResult('biome', result.failure);
    const parsed = mergeBiomeParses(result.parts);
    const names = [
      ...new Set((parsed.diagnostics || []).map((finding) => biomeRuleName(finding.code)).filter(Boolean)),
    ];
    const kinds = names.length
      ? await loadBiomeFixKinds({ bin, names, run: spawn, signal, timeoutMs: EXPLAIN_TIMEOUT_MS })
      : new Map();
    applyBiomeFixKinds(parsed.diagnostics, kinds);
    return finalizeBiome(parsed, tail(result.stderr));
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal, run }) {
    let result = await runChunked({
      bin,
      baseArgs: [...args, 'check', '--write', '--max-diagnostics=none'],
      files,
      cwd,
      timeoutMs,
      signal,
      run,
    });
    if (result.code !== 0 && LEGACY_WRITE_FLAG.test(result.stderr)) {
      result = await runChunked({
        bin,
        baseArgs: [...args, 'check', '--apply', '--max-diagnostics=none'],
        files,
        cwd,
        timeoutMs,
        signal,
        run,
      });
    }
    if (result.error) return spawnFailureResult('biome', result);
    return emptyResult(tail(result.stderr));
  },
};

export default runner;

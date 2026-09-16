// Biome — JSON reporter for check, `--write` (1.x: `--apply`) for fix.
import { diagnostic, positionAt, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

const LEGACY_WRITE_FLAG = /unexpected argument|unrecognized|unknown (?:option|argument)/i;

function severityOf(value) {
  const level = String(value || '').toLowerCase();
  if (level === 'error' || level === 'fatal') return 'error';
  if (level === 'warning' || level === 'warn') return 'warning';
  return 'info';
}

/** Parse `biome check --reporter=json` output. */
export function parseBiomeJson(stdout, cwd) {
  const text = String(stdout || '').trim();
  if (!text) return { diagnostics: [], changedFiles: [] };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start < 0) return { diagnostics: [], changedFiles: [] };
    try { payload = JSON.parse(text.slice(start)); } catch { return { diagnostics: [], changedFiles: [] }; }
  }
  const rows = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
  const diagnostics = [];
  const changedFiles = [];
  for (const row of rows) {
    const file = toRel(cwd, row?.location?.path?.file || row?.location?.path || '');
    const category = String(row?.category || '');
    const source = typeof row?.location?.sourceCode === 'string' ? row.location.sourceCode : '';
    const span = Array.isArray(row?.location?.span) ? row.location.span : null;
    const at = span && source ? positionAt(source, span[0]) : { line: 0, col: 0 };
    const tags = Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag).toLowerCase()) : [];
    const fixable = tags.includes('fixable') || Boolean(row?.suggestions?.length);
    if (category.startsWith('format')) changedFiles.push(file);
    diagnostics.push(diagnostic({
      file,
      line: at.line,
      col: at.col,
      code: category,
      message: String(row?.description || row?.message || '').replace(/\s+/g, ' '),
      severity: severityOf(row?.severity),
      fixable,
    }));
  }
  return { diagnostics, changedFiles: uniquePaths(changedFiles) };
}

export const runner = {
  id: 'biome',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({
      bin,
      baseArgs: [...args, 'check', '--reporter=json'],
      files,
      cwd,
      timeoutMs,
      signal,
    });
    if (result.error) return spawnFailureResult('biome', result);
    const parsed = parseBiomeJson(result.stdout, cwd);
    return { ...parsed, stderrTail: tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    let result = await runChunked({ bin, baseArgs: [...args, 'check', '--write'], files, cwd, timeoutMs, signal });
    if (result.code !== 0 && LEGACY_WRITE_FLAG.test(result.stderr)) {
      result = await runChunked({ bin, baseArgs: [...args, 'check', '--apply'], files, cwd, timeoutMs, signal });
    }
    if (result.error) return spawnFailureResult('biome', result);
    return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;

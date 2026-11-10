// Structural rules adapter.
//
// mixdog-graph is the ONLY structural engine: it embeds the ast-grep crates, so
// the rule packs run against the same grammars the code graph parses with, and
// there is no second implementation to disagree with it.
//   graph-binary  mixdog-graph <cwd> --scan --rules - [--files ...] [--fix]
//                 (rules YAML on stdin, JSONL on stdout, final line
//                  {"summary":...}; exit 0 ok / 1 internal / 2 usage or
//                  rule-parse; positions zero-based)
//
// Positions normalize to 1-based line/column and byte offsets stay verbatim,
// because apply.mjs edits by byte range. The engine is never allowed to write:
// tidy takes the fix payloads and applies them through the write pipeline.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';
import { filesForLanguages, parseGraphLangs } from './languages.mjs';
import { refineHistoryCommentMatches } from './history-comment.mjs';

export const RULES_DIR = fileURLToPath(new URL('./rules/', import.meta.url));
const PROBE_TIMEOUT_MS = 8000;
const STRUCTURAL_TIMEOUT_MS = 120_000;

const probeCache = new Map();

// `__tests__` holds the rule packs' own ast-grep test cases ({id, valid,
// invalid}), which are NOT rules: feeding them to a scan is a rule-parse error.
const RULE_DIR_SKIP = new Set(['__tests__', 'node_modules']);

function listYamlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (RULE_DIR_SKIP.has(entry.name)) continue;
      out.push(...listYamlFiles(full));
    } else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * Load the shipped rule packs. The packs are authored as ast-grep rule YAML;
 * an absent directory is simply "no structural rules".
 */
export function loadRulePacks({ dir = RULES_DIR } = {}) {
  const packs = [];
  for (const path of listYamlFiles(dir)) {
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const ruleIds = [...text.matchAll(/^\s*id:\s*["']?([\w.-]+)["']?\s*$/gm)].map((match) => match[1]);
    const languages = [
      ...new Set(
        [...text.matchAll(/^\s*language:\s*["']?([\w+#-]+)["']?\s*$/gm)].map((match) => match[1].toLowerCase())
      ),
    ];
    packs.push({
      id: relative(dir, path)
        .replaceAll('\\', '/')
        .replace(/\.ya?ml$/i, ''),
      path,
      languages,
      rules: ruleIds,
      text: text.trim(),
    });
  }
  return {
    packs,
    rulesText: packs.map((pack) => pack.text).join('\n---\n'),
    groups: groupRulePacks(packs),
  };
}

/**
 * Rule packs grouped by language, because a scan takes ONE rule document and a
 * single bad rule fails all of it: a `kind:` a grammar does not have makes the
 * engine exit 2 with zero matches for every language in that document. Packs
 * live at rules/<language>/<rule>.yml, which is also how their authors validate
 * them (one language directory per scan, ids unique within it).
 */
export function groupRulePacks(packs) {
  const byLanguage = new Map();
  for (const pack of packs || []) {
    const language = pack.languages?.[0] || pack.id.split('/')[0] || 'other';
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push(pack);
  }
  return [...byLanguage.entries()].map(([language, members]) => ({
    language,
    packs: members.map((pack) => pack.id),
    rulesText: members.map((pack) => pack.text).join('\n---\n'),
  }));
}

// `.tsx` is the one place the scan grammar and the detection id diverge: lang.rs
// and the binary's `--langs` table both call a .tsx file `typescript`, while the
// scan parses it with the `tsx` grammar (scan_lang.rs), so `language: typescript`
// rules never match it. The tsx packs therefore have to run whenever typescript
// is in scope, or .tsx files get no structural rules at all.
const GROUP_LANGUAGE_ALIASES = Object.freeze({ tsx: ['typescript'] });

/** Rule groups that can apply to `languages`; an empty language list means all. */
export function groupsForLanguages(groups, languages = []) {
  const wanted = new Set(languages || []);
  if (wanted.size === 0) return [...(groups || [])];
  return (groups || []).filter(
    (group) =>
      wanted.has(group.language) || (GROUP_LANGUAGE_ALIASES[group.language] || []).some((alias) => wanted.has(alias))
  );
}

/** Files one structural language group should scan; never an unfiltered tree. */
export function filesForStructuralGroup(files, group, extensions = null) {
  if (group?.language === 'tsx') {
    return (files || []).filter((rel) => /\.tsx$/i.test(String(rel || '')));
  }
  const wanted = [group?.language, ...(GROUP_LANGUAGE_ALIASES[group?.language] || [])].filter(Boolean);
  return filesForLanguages(files, wanted, extensions);
}

function toOneBased(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number + 1 : 0;
}

function byteRange(source) {
  if (Array.isArray(source)) {
    const [start, end] = source.map(Number);
    return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
  }
  if (source && typeof source === 'object') {
    const start = Number(source.start ?? source[0]);
    const end = Number(source.end ?? source[1]);
    return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
  }
  return null;
}

function normalizeFix(raw, range) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    return range ? { byteOffset: range, text: raw } : null;
  }
  const offset = byteRange(raw.byteOffset ?? raw.range ?? raw.span) || range;
  const text = [raw.text, raw.replacement].find((value) => typeof value === 'string') ?? null;
  if (!offset || text == null) return null;
  return { byteOffset: offset, text };
}

/**
 * Normalize one graph JSONL row into the adapter match shape. Returns null for
 * rows that carry no usable position.
 */
export function normalizeStructuralMatch(row, { zeroBased = true } = {}) {
  if (!row || typeof row !== 'object') return null;
  const file = String(row.file || row.rel || row.path || '').replaceAll('\\', '/');
  if (!file) return null;
  const rawRange = row.range || row.position || {};
  const start = rawRange.start || {};
  const end = rawRange.end || {};
  const shift = zeroBased ? toOneBased : (value) => Number(value) || 0;
  const offsets =
    byteRange(rawRange.byteOffset ?? rawRange.byteOffsets ?? row.byteOffset) ||
    (Number.isFinite(Number(start.byteOffset)) && Number.isFinite(Number(end.byteOffset))
      ? [Number(start.byteOffset), Number(end.byteOffset)]
      : null);
  return {
    file,
    lang: String(row.lang || row.language || ''),
    ruleId: String(row.ruleId || row.rule || row.id || ''),
    severity: String(row.severity || 'warning').toLowerCase(),
    message: String(row.message || row.text || '').trim(),
    range: {
      start: { line: shift(start.line), column: shift(start.column ?? start.col) },
      end: { line: shift(end.line), column: shift(end.column ?? end.col) },
      ...(offsets ? { byteOffset: offsets } : {}),
    },
    fix: normalizeFix(row.fix ?? row.replacement ?? null, offsets),
  };
}

function stderrError(exitCode, kind, stderr, fallback) {
  return {
    exitCode,
    kind,
    message:
      String(stderr || '')
        .trim()
        .slice(0, 400) || fallback,
  };
}

// The match rows and the summary line of a JSONL scan; unparsable lines are
// counted, not fatal.
function parseScanLines(stdout) {
  const matches = [];
  let summary = null;
  let malformed = 0;
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (row && typeof row === 'object' && row.summary) {
      summary = row.summary;
      continue;
    }
    const match = normalizeStructuralMatch(row, { zeroBased: true });
    if (match) matches.push(match);
  }
  return { matches, summary, malformed };
}

/**
 * Parse the graph binary's JSONL stream. The final `{"summary":...}` line is the
 * run summary; everything else is a match. Exit 2 is a usage or rule-parse
 * error and is reported as such (the rule pack, not the file set, is at fault).
 */
export function parseStructuralJsonl(stdout, { exitCode = 0, stderr = '' } = {}) {
  if (exitCode === 2) {
    return {
      matches: [],
      summary: { matches: 0, files: 0 },
      error: stderrError(exitCode, 'rules', stderr, 'rule parse or usage error'),
    };
  }
  const { matches, summary, malformed } = parseScanLines(stdout);
  const result = {
    matches,
    summary: summary || { matches: matches.length, files: new Set(matches.map((match) => match.file)).size },
  };
  // A scan-capable binary always emits the summary line, even for zero matches.
  // Exit 0 with empty stdout is what a pre-scan mixdog-graph does when it
  // treats `--scan` as a symbol search — that must never read as "no findings".
  if (exitCode === 0 && !summary && matches.length === 0) {
    result.error = {
      exitCode: 0,
      kind: 'protocol',
      message: 'structural scan produced no summary line; this mixdog-graph build does not own the --scan protocol',
    };
  } else if (exitCode !== 0) {
    result.error = stderrError(exitCode, 'internal', stderr, `structural scan exited ${exitCode}`);
  }
  if (malformed > 0) result.malformedLines = malformed;
  if (result.error) {
    result.matches = result.matches.map((match) => ({ ...match, fix: null, manual: true }));
  }
  return result;
}

/**
 * Probe `mixdog-graph <cwd> --langs`. A clean exit is NOT proof: a binary from
 * before the scan mode treats `--langs` as a symbol search and exits 0 with no
 * output, and answers `--scan` the same way — exit 0, empty stdout — which
 * would be read as "no matches" instead of "no scan mode". Only the language
 * registry payload proves this binary owns the scan protocol.
 */
export async function graphSupportsScan(binPath, { cwd = process.cwd(), signal = null } = {}) {
  if (!binPath || !existsSync(binPath)) return false;
  const cached = probeCache.get(binPath);
  if (typeof cached === 'boolean') return cached;
  const result = await runProcess(binPath, [cwd, '--langs'], { cwd, timeoutMs: PROBE_TIMEOUT_MS, signal });
  const supported = result.code === 0 && !result.error && Boolean(parseGraphLangs(result.stdout)?.extensions?.size);
  probeCache.set(binPath, supported);
  return supported;
}

export function resetStructuralProbeCache() {
  probeCache.clear();
}

// Reads a matched file's bytes whether the scan reported it absolute,
// cwd-relative, or with either slash style; null when no candidate opens.
function scanSourceReader(cwd) {
  return (file) => {
    const rel = String(file || '').replaceAll('\\', '/');
    const candidates = [];
    if (rel) {
      if (isAbsolute(file) || isAbsolute(rel)) candidates.push(file, rel);
      candidates.push(join(cwd, rel), join(cwd, file));
    }
    for (const candidate of candidates) {
      try {
        return readFileSync(candidate);
      } catch {
        /* try next */
      }
    }
    return null;
  };
}

export function createGraphStructuralAdapter({ binPath, timeoutMs = STRUCTURAL_TIMEOUT_MS }) {
  return {
    id: 'graph-binary',
    path: binPath,
    async scan({ cwd, rulesText, files = [], fix = false, signal = null }) {
      const args = [cwd, '--scan', '--rules', '-'];
      if (files.length > 0) args.push('--files', ...files);
      // `--fix` makes the binary EMIT fix payloads (byte range + replacement
      // text) and write nothing — verified against mixdog-graph. tidy applies
      // them itself through the write pipeline (apply.mjs), never the engine.
      if (fix) args.push('--fix');
      const result = await runProcess(binPath, args, { cwd, input: rulesText, timeoutMs, signal });
      if (result.error && result.code === -1) {
        return {
          matches: [],
          summary: { matches: 0, files: 0 },
          error: { exitCode: -1, kind: 'spawn', message: result.error },
        };
      }
      const parsed = parseStructuralJsonl(result.stdout, { exitCode: result.code, stderr: result.stderr });
      if (parsed.error?.kind === 'protocol') {
        throw new StructuralEngineUnavailableError(binPath);
      }
      if (!parsed.error) {
        parsed.matches = refineHistoryCommentMatches(parsed.matches, { sourceFor: scanSourceReader(cwd) });
        parsed.summary = {
          ...(parsed.summary || {}),
          matches: parsed.matches.length,
          files: new Set(parsed.matches.map((match) => match.file)).size,
        };
      }
      return parsed;
    },
  };
}

/** Why structural rules cannot run, and what to do about it. */
export function structuralUnavailableMessage(binPath) {
  const where = binPath ? `"${binPath}" does not answer \`--langs\`` : 'no mixdog-graph binary was found';
  return (
    'structural rules need a mixdog-graph build with the --scan mode: ' +
    `${where}. Rebuild it (cargo build --release --manifest-path native/mixdog-graph/Cargo.toml) ` +
    'or update the packaged mixdog-graph native tool; ' +
    'pass structural:false to run only the formatters and linters.'
  );
}

/**
 * Structural rules were requested but mixdog-graph cannot run them. There is no
 * fallback engine by design, so this surfaces as a tool error instead of a
 * silently empty structural section.
 */
export class StructuralEngineUnavailableError extends Error {
  constructor(binPath) {
    super(structuralUnavailableMessage(binPath));
    this.name = 'StructuralEngineUnavailableError';
    this.binPath = binPath || '';
  }
}

/**
 * The structural implementation: the local graph binary, once it proves it owns
 * the scan protocol. Throws StructuralEngineUnavailableError otherwise — an old
 * or missing binary must never read as "no findings".
 */
export async function resolveStructuralAdapter({
  cwd = process.cwd(),
  graphBinPath = null,
  // Already-probed capability table from the caller (undefined = probe here).
  graphLangs,
  signal = null,
} = {}) {
  const graphReady =
    graphLangs === undefined
      ? await graphSupportsScan(graphBinPath, { cwd, signal })
      : Boolean(graphLangs?.extensions?.size);
  if (!graphBinPath || !graphReady) throw new StructuralEngineUnavailableError(graphBinPath);
  return createGraphStructuralAdapter({ binPath: graphBinPath });
}

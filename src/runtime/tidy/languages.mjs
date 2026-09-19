// Language registry for the tidy multiplexer.
//
// CODE_LANGUAGE_EXTENSIONS mirrors `lang_for` in native/mixdog-graph/src/lang.rs
// so a file the code graph calls `typescript` is the same language here — the
// structural adapter passes rule packs to that binary and both sides must agree
// on the id. AUX_LANGUAGE_EXTENSIONS adds the config/markup languages the graph
// never parses but formatters do (PowerShell, JSON, TOML, ...).
import { extname } from 'node:path';
import { runProcess } from './process.mjs';

export const CODE_LANGUAGE_EXTENSIONS = Object.freeze({
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  python: ['py', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  csharp: ['cs'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hxx', 'hh'],
  scala: ['scala', 'sc'],
  bash: ['sh', 'bash', 'zsh'],
  lua: ['lua'],
  dart: ['dart'],
  objc: ['m', 'mm'],
  elixir: ['ex', 'exs'],
  zig: ['zig'],
  r: ['r'],
  // Extraction languages the graph binary parses; no v1 formatter/linter engine
  // ships for them, so they are detected and reported with an empty engine set.
  solidity: ['sol'],
  haskell: ['hs'],
  hcl: ['tf', 'hcl'],
});

export const AUX_LANGUAGE_EXTENSIONS = Object.freeze({
  powershell: ['ps1', 'psm1', 'psd1'],
  json: ['json', 'jsonc'],
  yaml: ['yml', 'yaml'],
  markdown: ['md', 'markdown'],
  toml: ['toml'],
  css: ['css', 'scss', 'less'],
  html: ['html', 'htm'],
});

export const LANGUAGE_EXTENSIONS = Object.freeze({
  ...CODE_LANGUAGE_EXTENSIONS,
  ...AUX_LANGUAGE_EXTENSIONS,
});

export const LANGUAGE_IDS = Object.freeze(Object.keys(LANGUAGE_EXTENSIONS));

const EXTENSION_TO_LANGUAGE = new Map();
for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
  for (const ext of extensions) EXTENSION_TO_LANGUAGE.set(ext, language);
}

/** Language id for a path, or '' when the extension is not in the registry. */
export function languageForPath(filePath) {
  const ext = extname(String(filePath || ''))
    .replace(/^\./, '')
    .toLowerCase();
  if (!ext) return '';
  return EXTENSION_TO_LANGUAGE.get(ext) || '';
}

/** Language id for a path: the graph capability table first, then the static registry. */
function languageWith(filePath, extensions) {
  if (extensions instanceof Map) {
    const ext = extname(String(filePath || ''))
      .replace(/^\./, '')
      .toLowerCase();
    const fromGraph = ext ? extensions.get(ext) : '';
    if (fromGraph) return fromGraph;
  }
  return languageForPath(filePath);
}

function normalizeRel(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

/**
 * Scope filter: a path is in scope when it equals, or sits under, one
 * of the requested paths. An empty scope list means "everything".
 */
export function withinScope(rel, scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  const path = normalizeRel(rel);
  return scopes.some((scope) => {
    const base = normalizeRel(scope).replace(/\/+$/, '');
    if (!base || base === '.') return true;
    return path === base || path.startsWith(`${base}/`);
  });
}

/**
 * Parse `mixdog-graph <cwd> --langs`. The binary answers with its language
 * CAPABILITY table, not a per-repo count:
 *   {"languages":[{"id":"javascript","extensions":["js","mjs",...],
 *                  "scan":true,"extract":true}, ...]}
 * The extension map is what matters here: when the binary is present its table
 * is authoritative (it is the same table the structural scan uses), and tidy
 * counts the tracked files itself. Returns null when nothing parses, so the
 * caller falls back to the static registry.
 */
export function parseGraphLangs(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  let rows = null;
  try {
    const whole = JSON.parse(text);
    rows = Array.isArray(whole)
      ? whole
      : Array.isArray(whole?.languages)
        ? whole.languages
        : Array.isArray(whole?.langs)
          ? whole.langs
          : null;
  } catch {
    rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const extensions = new Map();
  const ids = [];
  const scannable = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return null;
    const id = String(row.id || row.lang || row.language || '').trim();
    if (!id || !Array.isArray(row.extensions)) continue;
    ids.push(id);
    if (row.scan !== false) scannable.push(id);
    for (const raw of row.extensions) {
      const ext = String(raw || '')
        .replace(/^\./, '')
        .toLowerCase();
      // First declaration wins: the binary lists `tsx` twice (typescript first,
      // then a standalone tsx grammar), and typescript is the id lang.rs uses.
      if (ext && !extensions.has(ext)) extensions.set(ext, id);
    }
  }
  if (extensions.size === 0) return null;
  return { extensions, ids, scannable };
}

/** git-tracked files under `cwd`, filtered to the requested scope paths. */
export async function listScopedFiles({ cwd, paths = [], signal = null, timeoutMs = 20_000 } = {}) {
  const result = await runProcess(
    'git',
    [
      '-c',
      'core.quotepath=false',
      '--literal-pathspecs',
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...paths,
    ],
    { cwd, signal, timeoutMs }
  );
  if (result.code !== 0) {
    return {
      files: [],
      error: result.stderr.trim().slice(0, 200) || result.error || `git ls-files exited ${result.code}`,
    };
  }
  const files = result.stdout
    .split('\0')
    .map(normalizeRel)
    .filter(Boolean)
    .filter((rel) => withinScope(rel, paths));
  return { files, error: '' };
}

/**
 * Detect the languages present in `cwd`. Files come from git (they scope every
 * engine run) and are mapped to languages by extension: the graph binary's
 * `--langs` table wins when it is available, with the static registry covering
 * the formatter-only extensions the binary does not parse (powershell, toml, …).
 */
export async function detectLanguages({
  cwd,
  paths = [],
  languages: languageFilter = [],
  graphLangs = null,
  signal = null,
} = {}) {
  const { files, error } = await listScopedFiles({ cwd, paths, signal });
  const graphExtensions = graphLangs?.extensions instanceof Map ? graphLangs.extensions : null;
  const languageOf = (rel) => languageWith(rel, graphExtensions);
  const filtered = languageFilter.length > 0 ? files.filter((rel) => languageFilter.includes(languageOf(rel))) : files;
  const counts = new Map();
  for (const rel of filtered) {
    const language = languageOf(rel);
    if (!language) continue;
    counts.set(language, (counts.get(language) || 0) + 1);
  }
  return {
    languages: [...counts.entries()]
      .map(([id, count]) => ({ id, files: count }))
      .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id)),
    files: filtered,
    source: graphExtensions ? 'graph-binary' : 'git',
    // The same table the counts were taken with: an engine run has to scope
    // files exactly the way detection classified them.
    extensions: graphExtensions,
    ...(error ? { note: `language detection fell back to an empty file set: ${error}` } : {}),
  };
}

/**
 * Files of the requested languages, in scope order. `extensions` is the graph
 * binary's capability table when detection used it, so engine scoping and the
 * reported language counts always classify a file the same way.
 */
export function filesForLanguages(files, languages, extensions = null) {
  const wanted = new Set(languages || []);
  if (wanted.size === 0) return [];
  return files.filter((rel) => wanted.has(languageWith(rel, extensions)));
}

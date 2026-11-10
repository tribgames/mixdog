/**
 * code-graph/modes/shared.mjs — what every code_graph mode handler shares:
 * the mode context shape, argument readers, the file-not-found answer and
 * the outline language map.
 *
 * A mode handler is `async (ctx) => string` with ctx =
 * { args, cwd, signal, graph, normFile, rel, node, scopeRelPrefix, symbolsNote }.
 */
import { extname } from 'node:path';
import { _appendSameBasenameHint } from '../source-access.mjs';

export const GRAPH_LIST_CAP = 200;

const OUTLINE_LANGUAGES = [
  [['js', 'mjs', 'cjs', 'jsx'], 'javascript'],
  [['ts', 'tsx', 'mts', 'cts'], 'typescript'],
  [['py', 'pyi'], 'python'],
  [['go'], 'go'],
  [['rs'], 'rust'],
  [['java'], 'java'],
  [['kt', 'kts'], 'kotlin'],
  [['cs'], 'csharp'],
  [['rb'], 'ruby'],
  [['php'], 'php'],
  [['swift'], 'swift'],
  [['c', 'h'], 'c'],
  [['cpp', 'cc', 'cxx', 'hpp', 'hxx', 'hh'], 'cpp'],
  [['scala', 'sc'], 'scala'],
  [['sh', 'bash', 'zsh'], 'bash'],
  [['lua'], 'lua'],
  [['dart'], 'dart'],
  [['m', 'mm'], 'objc'],
  [['ex', 'exs'], 'elixir'],
  [['zig'], 'zig'],
  [['r', 'R'], 'r'],
];
const OUTLINE_LANGUAGE_BY_EXT = new Map(OUTLINE_LANGUAGES.flatMap(([exts, lang]) => exts.map((ext) => [ext, lang])));

export function outlineLanguageForPath(file) {
  const ext = extname(String(file || '')).slice(1);
  return OUTLINE_LANGUAGE_BY_EXT.get(ext) || null;
}

export function fileNotFound(mode, { normFile, graph }) {
  return _appendSameBasenameHint(
    `Error: code_graph ${mode}: file not found in graph: ${normFile || '(missing file)'}`,
    normFile,
    graph
  );
}

export function requiredSymbol(mode, args) {
  const symbol = String(args?.symbol || '').trim();
  if (!symbol) throw new Error(`code_graph ${mode}: "symbol" is required.`);
  return symbol;
}

export const languageArg = (args) => String(args?.language || '').trim() || null;

/** An explicit positive `limit`, capped at 500; null when absent. */
export function userLimitArg(args) {
  const rawLimit = Number(args?.limit);
  return Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : null;
}

const splitMulti = (s) =>
  String(s || '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

/** Every symbol named by `symbols[]`, a `symbols` string or `symbol`, deduped. */
export function collectGraphSymbolList(args) {
  return [
    ...new Set([
      ...(Array.isArray(args?.symbols) ? args.symbols.map((s) => String(s || '').trim()).filter(Boolean) : []),
      ...(typeof args?.symbols === 'string' ? splitMulti(args.symbols) : []),
      ...(typeof args?.symbol === 'string' ? splitMulti(args.symbol) : []),
    ]),
  ];
}

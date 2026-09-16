// AST call-site layer over the native per-file `calls` field — wire v2.
//
// Contract of the Rust FileRecord field (fixed, tuple wire):
//   calls: [[name, line, col, kind, recv, inSymbol], …]
//     name     callee LAST segment (non-empty string)
//     line     1-based
//     col      0-based CHAR column of the callee name
//     kind     0 = call, 1 = method, 2 = new
//     recv     receiver/qualifier text, "" when absent
//              (already whitespace-collapsed and capped at 64 chars)
//     inSymbol innermost enclosing outline symbol name, "" at top level
//   sorted by (line, col), never produced from comments or strings.
// endCol is no longer transmitted, and nothing renders one; a consumer that
// ever needs it derives `col + [...name].length` (code points, see below).
//
// The v1 object wire is GONE. `--langs` advertises `callsFormat: 2`; a binary
// whose table lacks it yields null calls for every node (graph-binary.mjs), so
// nothing here ever sees a v1 object.
//
// `node.calls === null` means UNKNOWN — older binary, an un-hydrated cache
// entry, or a rejected payload — and such a file simply contributes no call
// rows; there is no text fallback left. `[]` means the file provably has NO
// call site; the sidecar cache stores that distinction explicitly. When NO
// file of the graph has call data, the query fails loudly (callsCapabilityError)
// rather than answering "no callers".
//
// Pure over graph data: no source-text I/O and no formatting live here.
// Normalization is lazy — the tuples stay as shipped until a query touches
// that file (see _astCalls), so a graph build/cache load costs nothing.
import { _graphRel } from './source-access.mjs';
import { CONTAINER_SYMBOL_KINDS } from './constants.mjs';
import { _symbolParentIndex, _symbolAncestors } from './text-columns.mjs';

// Receivers that keep a `method` call attributable to the declaring file
// itself (an unqualified / self call), independent of imports.
const _SELF_RECEIVERS = new Set(['', 'this', 'self', 'super', 'Self', 'cls', 'me']);

// Normalized views are memoized per raw `calls` array: the caller scan walks
// every node of the graph, and normalization is otherwise repeated per query.
const _normalizedCallsCache = new WeakMap();

// kind index → the name every consumer and every rendered row uses.
const _CALL_KINDS = ['call', 'method', 'new'];

// A v2 tuple is accepted only in full: six positions, every one of the exact
// declared type. Nothing is defaulted or coerced — a tuple that misses the
// contract is a producer bug, and returning null here poisons the whole file
// (see _astCalls) instead of turning bad data into a location.
function _normalizeCallTuple(raw) {
  if (!Array.isArray(raw) || raw.length !== 6) return null;
  const [name, line, col, kind, recv, inSymbol] = raw;
  if (typeof name !== 'string' || !name) return null;
  if (!Number.isInteger(line) || line < 1) return null;
  if (!Number.isInteger(col) || col < 0) return null;
  if (!Number.isInteger(kind) || kind < 0 || kind >= _CALL_KINDS.length) return null;
  if (typeof recv !== 'string' || typeof inSymbol !== 'string') return null;
  // 0-based char column, exactly as the binary emits it.
  return { name, line, col, kind: _CALL_KINDS[kind], recv, inSymbol };
}

// endCol is not transmitted and nothing renders it: a consumer that ever needs
// one derives `col + [...name].length` (code points, the producer's unit).

// null  → this file has no USABLE AST call data: either the field is
//         absent/not an array (older binary, cache entry not hydrated from the
//         sidecar), or at least one tuple violates the contract. Such a file
//         contributes no call rows at all.
// []    → this file has no call sites at all
//
// A partially malformed array is rejected WHOLESALE on purpose: decoding the
// good tuples of a payload the producer got wrong would present a partial,
// silently wrong call list as if it were complete.
//
// The decoded view is memoized on the RAW tuple array, so it is built once per
// file on first use and shared by every later query. The rejection verdict is
// memoized too — a malformed payload is never re-scanned.
export function _astCalls(node) {
  const raw = node?.calls;
  if (!Array.isArray(raw)) return null;
  if (_normalizedCallsCache.has(raw)) return _normalizedCallsCache.get(raw);
  const out = [];
  let usable = true;
  for (const item of raw) {
    const call = _normalizeCallTuple(item);
    if (!call) { usable = false; break; }
    out.push(call);
  }
  const result = usable ? out : null;
  _normalizedCallsCache.set(raw, result);
  return result;
}

// Does ANY node of this graph carry USABLE AST call data? Call analysis has no
// fallback, so a false here is a hard error at the tool boundary rather than an
// empty answer. One (memoized) normalization per node with an early exit — no
// source I/O and no flag, so a rebuilt graph can never answer from stale state.
export function _graphHasAstCalls(graph) {
  if (!graph?.nodes) return false;
  for (const node of graph.nodes.values()) {
    if (_astCalls(node) !== null) return true;
  }
  return false;
}

// The binary reports 0-based char columns; every code_graph location line is
// 1-based, so display columns are converted here and nowhere else.
export function _astCallDisplayCol(call) {
  return (Number(call?.col) || 0) + 1;
}

// Names whose call sites belong to `symbolName`: the symbol itself plus, when
// it is a container kind (class/struct/interface/trait/enum/impl/module/…),
// the symbols the record NESTS inside it — `parent` and its transitive chain,
// so a call inside a method of a nested class still belongs to the outer type.
//
// Containment comes from the record's `parent` field only. The previous
// line-span derivation claimed every symbol that happened to sit between the
// container's start and end line, which pulled in same-span neighbours the
// extractor never nested (and silently owned nothing when `endLine` was
// missing).
function _astOwnedSymbolNames(node, symbolName) {
  const target = String(symbolName || '');
  const owned = new Set([target]);
  const symbols = Array.isArray(node?.symbols) ? node.symbols : [];
  const containers = symbols.filter((symbol) => symbol?.name === target
    && CONTAINER_SYMBOL_KINDS.has(String(symbol.kind || '')));
  if (!containers.length) return owned;
  const parentOf = _symbolParentIndex(node);
  for (const symbol of symbols) {
    if (!symbol?.name || owned.has(symbol.name)) continue;
    for (const ancestor of _symbolAncestors(node, symbol, parentOf)) {
      if (containers.includes(ancestor)) {
        owned.add(symbol.name);
        break;
      }
    }
  }
  return owned;
}

// callees(S in F): F.calls whose inSymbol is S — or one of S's member symbols
// when S is a container type the record nests members under.
export function _astCalleeCallSites(node, symbolName) {
  const calls = _astCalls(node);
  if (!calls) return null;
  const owned = _astOwnedSymbolNames(node, symbolName);
  return calls.filter((call) => owned.has(call.inSymbol));
}

// Repo-relative import targets of a node. Live graphs carry
// resolvedImportsRel; graphs assembled from absolute paths (and test
// fixtures) are mapped through the graph cwd.
export function _astImportedRels(node, cwd) {
  if (Array.isArray(node?.resolvedImportsRel)) return node.resolvedImportsRel;
  const resolved = Array.isArray(node?.resolvedImports) ? node.resolvedImports : [];
  return resolved.map((item) => (typeof item === 'string' ? _graphRel(item, cwd) : ''));
}

// The one scope predicate for the AST path: a `file` anchor matches exactly,
// a directory anchor matches the directory itself and everything under it.
export function _astRelInScope(rel, fileRel, scopeRelPrefix) {
  if (fileRel) return rel === fileRel;
  if (scopeRelPrefix) {
    const value = String(rel || '');
    return value === scopeRelPrefix.slice(0, -1) || value.startsWith(scopeRelPrefix);
  }
  return true;
}

// Import resolution is not available for every language or toolchain (Python
// package paths, path aliases, generated code). A file whose raw imports
// resolved to NOTHING cannot be judged by the import rule at all, so it counts
// as a possible importer: dropping its call sites would delete real callers
// outright, and nothing else reports them any more. Files that import nothing
// keep being judged — a call reaching no declaration stays out.
function _astImportsUnresolved(node, cwd) {
  const raw = Array.isArray(node?.rawImports) ? node.rawImports : [];
  if (!raw.length) return false;
  return _astImportedRels(node, cwd).length === 0;
}

function _nodeInAstScope(node, fileRel, scopeRelPrefix) {
  return _astRelInScope(node?.rel, fileRel, scopeRelPrefix);
}

// Re-export hops between an importer and F. `export { S } from './impl.mjs'`
// is extremely common (barrels, facades, module indexes): the caller imports
// the FORWARDING file, never F, so a strict one-hop rule would drop every one
// of its call sites.
//
// A file B forwards S when it
//   - imports F (or another forwarder of S),
//   - mentions S (identifier tokens; unknown tokens stay permissive),
//   - declares nothing named S — it is not a second, unrelated definition,
//   - and never CALLS S itself — a file that calls S is a caller, not a
//     conduit, so callers-of-callers are not pulled in.
// Walked iteratively (forwarders chain) with a visited set and a hard cap, so
// one query can never turn into a full-graph traversal.
const _FORWARD_HOP_MAX = 32;

function _astDeclaresSymbol(node, name) {
  return (Array.isArray(node?.symbols) ? node.symbols : []).some((item) => item?.name === name);
}

function _astMentionsSymbol(node, name) {
  const tokens = node?.tokenSymbols;
  return Array.isArray(tokens) ? tokens.includes(name) : true;
}

function _astCallsSymbol(node, name) {
  const calls = _astCalls(node);
  if (!calls) return false; // unknown call data cannot rule the file out
  return calls.some((call) => call.name === name);
}

function _astReachableTargetRels(graph, targetRels, name) {
  const rels = new Set(targetRels);
  const queue = [...rels];
  while (queue.length && rels.size < _FORWARD_HOP_MAX) {
    const rel = queue.shift();
    for (const importerRel of graph.reverse?.get(rel) || []) {
      if (rels.has(importerRel)) continue;
      const importer = graph.nodes?.get(importerRel);
      if (!importer) continue;
      if (_astDeclaresSymbol(importer, name)) continue;
      if (!_astMentionsSymbol(importer, name)) continue;
      if (_astCallsSymbol(importer, name)) continue;
      rels.add(importerRel);
      queue.push(importerRel);
      if (rels.size >= _FORWARD_HOP_MAX) break;
    }
  }
  return rels;
}

// callers(S declared in F…): every AST call site named S in a file that IS a
// declaring file or imports one — directly, or through the re-export
// forwarders above. `method` call sites additionally require either a self
// receiver ('', this, self, super, Self, cls, me) or a caller file that
// imports a declaring file — a qualified `other.S()` inside the declaring file
// is somebody else's method, not a call of its own S.
//
// `targetRels` is the FULL set of files declaring S, not a single anchor: one
// name is regularly declared in several files (an interface method plus its
// implementations, a test double plus the real module). Anchoring on one of
// them drops every call site reaching the others.
//
// Files whose `calls` is null contribute nothing here (non-extraction language,
// parse error, older binary). Files whose imports could not be resolved at all
// count as possible importers (_astImportsUnresolved).
//
// Node order: the cheap reachability/scope filters run BEFORE `_astCalls`, so
// a query normalizes the call arrays of the declaring files and their
// importers only — never of every node in the graph.
export function _astCallerCallSites(graph, symbol, targetRels, {
  language = null,
  fileRel = null,
  scopeRelPrefix = null,
} = {}) {
  const name = String(symbol || '');
  const out = [];
  const roots = (Array.isArray(targetRels) ? targetRels : [targetRels]).filter(Boolean);
  if (!name || !roots.length || !graph?.nodes) return out;
  const cwd = graph.cwd || '';
  const targets = _astReachableTargetRels(graph, roots, name);
  for (const node of graph.nodes.values()) {
    if (language && node.lang !== language) continue;
    if (!_nodeInAstScope(node, fileRel, scopeRelPrefix)) continue;
    const sameFile = targets.has(node.rel);
    const importsTarget = _astImportedRels(node, cwd).some((rel) => targets.has(rel));
    if (!sameFile && !importsTarget && !_astImportsUnresolved(node, cwd)) continue;
    const calls = _astCalls(node);
    if (!calls || !calls.length) continue;
    for (const call of calls) {
      if (call.name !== name) continue;
      if (call.kind === 'method' && !_SELF_RECEIVERS.has(call.recv) && !importsTarget) continue;
      out.push({ node, call });
    }
  }
  // Grouped by (file, inSymbol) — the caller identity a consumer reads —
  // then by position inside that group.
  out.sort((a, b) =>
    String(a.node.rel).localeCompare(String(b.node.rel))
    || String(a.call.inSymbol).localeCompare(String(b.call.inSymbol))
    || (a.call.line - b.call.line)
    || (a.call.col - b.call.col));
  return out;
}

// references: every AST call site of `symbol` inside one file. No import rule
// — a reference is a reference wherever it sits.
export function _astFileCallSites(node, symbol) {
  const calls = _astCalls(node);
  if (!calls) return null;
  const name = String(symbol || '');
  return calls.filter((call) => call.name === name);
}

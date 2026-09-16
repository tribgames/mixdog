// Native mixdog-graph binary runner — single source of truth for per-file
// parsing. NO JS parse fallback: absent binary throws. Extracted verbatim
// from code-graph.mjs, except _graphBinaryPath's local-build relative path,
// which gains one extra `../` because this module sits one directory deeper
// (tools/code-graph/ vs tools/). The resolved absolute path is unchanged.
import { resolve as pathResolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPluginData } from '../../config.mjs';
import { ensureGraphBinary, findCachedGraphBinary } from '../graph-binary-fetcher.mjs';
import { packageNativeToolPath } from '../../../../shared/native-tool-paths.mjs';
import { CODE_GRAPH_BINARY_TIMEOUT_MS } from './constants.mjs';

// ── Native graph binary (mixdog-graph) — single source of truth for
// per-file parsing. There is NO JS parsing fallback: if the binary is
// absent the build throws so the caller surfaces a clear, fixable error
// instead of silently degrading to a slow path.
function _graphBinaryPath() {
  const override = process.env.MIXDOG_GRAPH_BIN;
  if (override && existsSync(override)) return override;
  // fileURLToPath correctly decodes percent-encoded bytes (spaces, non-ASCII)
  // and strips the leading-slash/drive-letter quirk on Windows. Using
  // URL.pathname directly leaves `%20` etc. encoded, breaking paths with
  // spaces or non-ASCII characters.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const binName = process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph';
  // Prefer a local cargo build, then a previously fetched/cached prebuilt.
  // This module is one dir deeper than the legacy code-graph.mjs, so the
  // relative walk to repo-root native/ needs six `../` hops
  // (code-graph → tools → orchestrator → agent → runtime → src → root).
  const localBuild = pathResolve(moduleDir, '../../../../../../native/mixdog-graph/target/release', binName);
  if (existsSync(localBuild)) return localBuild;
  const installed = packageNativeToolPath('graph');
  if (existsSync(installed)) return installed;
  try { return findCachedGraphBinary(getPluginData()); } catch { return null; }
}

// Public resolver for consumers outside the graph build (the resident
// native-search-client duck-types this exact name). Returns an absolute
// path or null; never throws.
export function graphBinaryPath() {
  try { return _graphBinaryPath() || null; } catch { return null; }
}

async function _runGraphBinaryJsonl(absRoot, extraArgs, stdinLines = null, signal = null, { requireRel = true } = {}) {
  let binPath = _graphBinaryPath();
  if (!binPath) {
    // No local build or cached binary — fetch the prebuilt from the release
    // manifest (sha256-verified). No JS parse fallback: if the platform has
    // no asset or the download fails, the build throws with a fixable error.
    try {
      binPath = await ensureGraphBinary(getPluginData());
    } catch (err) {
      throw new Error(
        `[code-graph] mixdog-graph binary unavailable and could not be fetched: ${err?.message || err}. `
        + 'Build it (cargo build --release in native/mixdog-graph) or check network/release manifest.',
      );
    }
  }
  const { spawn } = await import('node:child_process');
  const timeoutMs = CODE_GRAPH_BINARY_TIMEOUT_MS;
  let retried = false;

  // Inner spawn + promise — extracted so we can retry once on EAGAIN.
  //
  // child-spawn-gate is NOT acquired here. Worker builds and main-thread
  // signature validation both hold their slot in buildCodeGraphAsync; worker
  // threads do not share module-level state with the main thread, so acquiring
  // here would create an independent semaphore that cannot coordinate with rg.
  const _spawnOnce = () => new Promise((resolve, reject) => {
    // When stdinLines is supplied (--files mode), stream one JSON object per
    // line to the child's STDIN — the reused nodes' metadata — so Rust can
    // resolve imports across the WHOLE tree (fresh + reused) while only
    // full-parsing the changed subset passed as argv.
    const wantsStdin = Array.isArray(stdinLines);
    const proc = spawn(binPath, [absRoot, ...extraArgs], {
      stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // windowsHide: native code-graph binary is a console exe; without this each
      // call flashes a console window when spawned under the detached daemon.
      windowsHide: true,
    });
    const chunks = [];
    let stderrText = '';
    const STDERR_CAP = 8 * 1024;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    // ── timeout + kill helpers (mirrors rg-runner's _killRgProc/_escalateRgKill) ──
    let timeoutTimer = null;
    let killGraceTimer = null;
    let forceSettleTimer = null;

    const _procGone = () => proc.exitCode != null || proc.signalCode != null;

    const _escalateKill = () => {
      if (_procGone()) return;
      const pid = proc.pid;
      if (!pid) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };

    const _killProc = () => {
      if (_procGone()) return;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      if (killGraceTimer) {
        clearTimeout(killGraceTimer);
        killGraceTimer = null;
      }
      killGraceTimer = setTimeout(() => {
        killGraceTimer = null;
        _escalateKill();
      }, 3000);
      if (killGraceTimer.unref) killGraceTimer.unref();
    };

    const _clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (killGraceTimer) {
        clearTimeout(killGraceTimer);
        killGraceTimer = null;
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
        forceSettleTimer = null;
      }
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        onAbort = null;
      }
    };
    let onAbort = null;

    // Arm timeout — unref so it doesn't keep the process alive. On timeout we
    // start SIGTERM→grace→force-kill but do NOT settle yet: the promise stays
    // pending until the child's 'close' fires (so the build worker — and the
    // main-thread gate slot it holds — is only released once the process is
    // actually gone). A separate force-settle deadline guarantees the promise
    // still resolves if 'close' never arrives. Mirrors rg-runner exactly.
    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      timedOut = true;
      _killProc();
      // Hard backstop: if 'close' never fires after the kill escalation,
      // escalate again and settle so we never hang (and never release the
      // gate while the child is provably still alive without a final attempt).
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      forceSettleTimer = setTimeout(() => {
        forceSettleTimer = null;
        if (settled) return;
        _escalateKill();
        settled = true;
        _clearTimers();
        reject(new Error(`[code-graph] mixdog-graph timed out after ${timeoutMs}ms`));
      }, 5000);
      if (forceSettleTimer.unref) forceSettleTimer.unref();
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();
    if (signal) {
      onAbort = () => {
        aborted = true;
        _killProc();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      if (stderrText.length >= STDERR_CAP) return;
      const piece = c.toString('utf8');
      const room = STDERR_CAP - stderrText.length;
      stderrText += piece.length > room ? piece.slice(0, room) : piece;
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      _clearTimers();
      reject(err);
    });
    if (wantsStdin) {
      proc.stdin.on('error', () => { /* child may close stdin early; ignore EPIPE */ });
      proc.stdin.write(stdinLines.length ? `${stdinLines.join('\n')}\n` : '');
      proc.stdin.end();
    }
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      _clearTimers();
      if (timedOut) {
        // Our timeout kill won the race: the child is gone now, so the gate
        // slot releases here (not at timeout-fire time). Report as a timeout.
        reject(new Error(`[code-graph] mixdog-graph timed out after ${timeoutMs}ms`));
        return;
      }
      if (aborted) {
        reject(new Error('aborted'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`[code-graph] mixdog-graph exited ${code}: ${stderrText.trim().slice(0, 200)}`));
        return;
      }
      const out = [];
      const buf = Buffer.concat(chunks).toString('utf8');
      let lineNumber = 0;
      for (const line of buf.split('\n')) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed);
          // Capability modes (--langs) answer with a single table object that
          // has no `rel`; only per-file record modes require it.
          if (!rec || (requireRel && typeof rec.rel !== 'string')) {
            throw new Error('record is missing string rel');
          }
          out.push(rec);
        } catch (error) {
          reject(new Error(
            `[code-graph] mixdog-graph emitted invalid JSONL at line ${lineNumber}: ${error?.message || error}`,
          ));
          return;
        }
      }
      resolve(out);
    });
  });

  // Outer call with one EAGAIN retry (mirrors rg-runner runRg / runRgWindowedLines).
  try {
    return await _spawnOnce();
  } catch (err) {
    if (!retried && (err?.code === 'EAGAIN' || /EAGAIN/i.test(String(err?.message || err?.stderr || '')))) {
      retried = true;
      return _spawnOnce();
    }
    throw err;
  }
}
// The manifest run also settles the calls-wire probe: it is the FIRST binary
// call of every query path (build and disk-cache validation alike), and the
// graph signature below folds in the capability, so the answer must be known
// before any signature is computed.
//
// The probe is STARTED next to the run but WAITED FOR after it: native spawns
// can be serialized (the tool-contract suites route every spawn through one
// debug mixdog-spawn), and a probe queued behind a multi-second walk used to
// lose its race against the wait budget — reporting "no v2 wire" for a binary
// that has one, which silently dropped every call site of that build.
export async function _runGraphManifest(absRoot, signal = null) {
  const probe = _ensureCallsWireProbe(absRoot);
  const records = await _runGraphBinaryJsonl(absRoot, ['--manifest'], null, signal);
  await _boundedProbeWait(probe);
  return records;
}

// ── `calls` wire capability ────────────────────────────────────────────────
// The binary advertises its call-site wire in the `--langs` capability table:
// top-level `callsFormat: 2` = the tuple wire this build understands. Anything
// else — an older binary that emits nothing, or one that emits a wire we do
// not decode — yields `calls: null` on every node, which now makes
// callers/callees fail with callsCapabilityError instead of answering empty.
// There is deliberately no v1 (object wire) compatibility path.
const CALLS_WIRE_FORMAT = 2;
let _callsWireV2 = false;
let _callsWireProbe = null;
// The memo is keyed by the RESOLVED binary path: MIXDOG_GRAPH_BIN can be
// repointed inside one process (tests, a prebuilt that lands after a failed
// local lookup), and a memo that ignores the switch answers for the wrong
// binary — discarding call data the new binary does emit, or claiming a wire
// the old one never spoke.
let _callsWireProbeKey = null;
// A probe must never hold up the parse running beside it. Past this budget the
// build proceeds with "no v2 wire" (calls: null) while the probe keeps running
// for the next build.
const CALLS_WIRE_PROBE_MAX_WAIT_MS = 3_000;

function _currentGraphBinaryKey() {
  try { return _graphBinaryPath() || ''; } catch { return ''; }
}

async function _probeCallsWireFormat(absRoot) {
  try {
    const rows = await _runGraphBinaryJsonl(absRoot, ['--langs'], null, null, { requireRel: false });
    const ok = rows.some((row) => Number(row?.callsFormat) === CALLS_WIRE_FORMAT);
    // A binary that predates the capability table accepts --langs, exits 0 and
    // prints nothing — indistinguishable from "no v2 wire" except in a trace.
    if (!ok && process.env.MIXDOG_GRAPH_TRACE) {
      process.stderr.write(`[cg-trace] calls wire v2 unavailable (--langs rows=${rows.length})\n`);
    }
    return ok;
  } catch (err) {
    // A binary too old for --langs (or a failed spawn) simply has no v2 wire.
    if (process.env.MIXDOG_GRAPH_TRACE) {
      process.stderr.write(`[cg-trace] calls-wire probe failed: ${err?.message || err}\n`);
    }
    return false;
  }
}

// One probe per binary: a parse run must not pay a second spawn, but a
// repointed MIXDOG_GRAPH_BIN (or a binary that only became available later)
// gets its own probe. Awaited by the record-producing modes below so the flag
// is set before any record is mapped.
export function _ensureCallsWireProbe(absRoot) {
  const key = _currentGraphBinaryKey();
  if (!_callsWireProbe || _callsWireProbeKey !== key) {
    _callsWireProbeKey = key;
    // Unknown until THIS binary answers: never carry the previous one's verdict.
    _callsWireV2 = false;
    _callsWireProbe = _probeCallsWireFormat(absRoot).then((ok) => {
      // OR, never assign: a run of this same binary may already have PROVEN
      // the wire by shipping call tuples (see _noteCallsWireFromRecords). A
      // probe that failed to spawn under load must not revoke that proof.
      if (_callsWireProbeKey === key) _callsWireV2 = ok || _callsWireV2;
      return ok;
    });
  }
  return _callsWireProbe;
}

// Bounded wait for the record-producing runs: the probe answer if it arrives
// in time, otherwise "no v2 wire" for this build. Exported because a build
// that received its manifest from another thread never ran one itself, yet its
// signature and node-reuse guard depend on the capability.
export async function awaitCallsWireProbe(absRoot) {
  return _awaitCallsWireProbe(absRoot);
}

async function _awaitCallsWireProbe(absRoot) {
  return _boundedProbeWait(_ensureCallsWireProbe(absRoot));
}

// Wait for an already-started probe, bounded. Returns the probe's answer, or
// `false` once the budget expires (the probe keeps running for the next call).
async function _boundedProbeWait(probe) {
  if (_callsWireV2) return true; // already proven — nothing to wait for
  let timer = null;
  const bounded = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), CALLS_WIRE_PROBE_MAX_WAIT_MS);
    timer?.unref?.();
  });
  try {
    return await Promise.race([probe, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Records are PROOF of the wire: only a binary that speaks callsFormat 2 ships
// a `calls` array. The --langs probe stays the authority for the empty case
// (a v2 binary whose files simply have no call sites), but it is no longer the
// only way to learn the capability — a probe that is slow, queued or broken
// can no longer discard call data the very same run produced.
export function _noteCallsWireFromRecords(records, key = _currentGraphBinaryKey()) {
  if (_callsWireV2 || !Array.isArray(records)) return _callsWireV2;
  if (_callsWireProbeKey !== null && _callsWireProbeKey !== key) return _callsWireV2;
  for (const rec of records) {
    if (Array.isArray(rec?.calls)) {
      _callsWireV2 = true;
      return true;
    }
  }
  return false;
}

export function _callsWireV2Enabled() { return _callsWireV2; }

// Cache-signature token for the call-site capability. Manifest fingerprints
// only change when FILES change, so a graph indexed by a binary without the v2
// wire would be served unchanged to a v2-capable process — and, with no text
// fallback left, callers/callees would fail with the capability error forever
// instead of re-indexing. Folding the capability into the signature makes that
// switch an ordinary cache miss in both directions.
export function callsWireSignatureToken() {
  return _callsWireV2Enabled() ? '#calls2' : '';
}

/**
 * One-line version of the capability diagnosis below, for `references`: that
 * mode still answers from identifier usages, but without call data its list is
 * INCOMPLETE — and an incomplete list that says nothing reads like a complete
 * one. Same two causes, same remedy, no stack.
 */
export function callsCapabilityHint() {
  const binPath = graphBinaryPath() || '(no mixdog-graph binary resolved)';
  return _callsWireV2Enabled()
    ? `no indexed file of this project carries call data (binary: ${binPath}) — the graph re-indexes on the next query`
    : `binary ${binPath} does not advertise callsFormat: ${CALLS_WIRE_FORMAT} — rebuild the native graph binary `
      + '(cargo build --release in native/mixdog-graph) or update the packaged native tool, then re-run';
}

/**
 * The tool error for callers/callees when a project has no AST call sites.
 * There is no text fallback, so an answer is impossible rather than empty:
 * the message names the binary that was used, the capability it must
 * advertise, and how to get it.
 */
export function callsCapabilityError(mode, cwd) {
  const binPath = graphBinaryPath() || '(no mixdog-graph binary resolved)';
  const capability = _callsWireV2Enabled()
    ? `\`${binPath} <cwd> --langs\` advertises callsFormat: ${CALLS_WIRE_FORMAT}, but no indexed file of this project carries call data`
      + ' (cached graph built by an older binary, or a project of languages the extractor does not parse)'
    : `\`${binPath} <cwd> --langs\` does not advertise callsFormat: ${CALLS_WIRE_FORMAT} — this binary cannot emit call sites`;
  return new Error(
    `code_graph ${mode}: no AST call sites are available for '${cwd}', and call analysis has no text fallback.\n`
    + `binary: ${binPath}\n`
    + `capability: ${capability}\n`
    + 'remedy: rebuild the native graph binary (cargo build --release in native/mixdog-graph) or update the packaged '
    + 'native tool, then re-run — the graph re-indexes itself on the next query.',
  );
}

/**
 * Same diagnosis for the OUTLINE half of the record. Symbols have no text
 * fallback either: when a project whose languages the extractor parses carries
 * no `symbols` on any indexed file, the outline/symbol modes cannot answer, and
 * "(no symbols)" would read like a verdict about the source instead of about
 * the binary.
 */
export function symbolsCapabilityHint() {
  const binPath = graphBinaryPath() || '(no mixdog-graph binary resolved)';
  return `no indexed file of this project carries native symbols (binary: ${binPath}) — rebuild the native graph `
    + 'binary (cargo build --release in native/mixdog-graph) or update the packaged native tool; the graph '
    + 're-indexes itself on the next query';
}

export function symbolsCapabilityError(mode, cwd) {
  const binPath = graphBinaryPath() || '(no mixdog-graph binary resolved)';
  return new Error(
    `code_graph ${mode}: no native symbols are available for '${cwd}', and symbol analysis has no text fallback.\n`
    + `binary: ${binPath}\n`
    + `capability: \`${binPath} <cwd> --langs\` lists the languages that emit symbols; this project's indexed files `
    + 'are extraction languages, yet not one of them carries a symbol record (cached graph built by an older binary, '
    + 'or a binary that cannot extract)\n'
    + 'remedy: rebuild the native graph binary (cargo build --release in native/mixdog-graph) or update the packaged '
    + 'native tool, then re-run — the graph re-indexes itself on the next query.',
  );
}

// Test seam: force the capability state (and drop a cached probe).
export function _setCallsWireV2ForTest(value) {
  _callsWireV2 = Boolean(value);
  _callsWireProbeKey = value === null ? null : _currentGraphBinaryKey();
  _callsWireProbe = value === null ? null : Promise.resolve(_callsWireV2);
}

export async function _runGraphWalk(absRoot) {
  const key = _currentGraphBinaryKey();
  const probe = _ensureCallsWireProbe(absRoot);
  const records = await _runGraphBinaryJsonl(absRoot, []);
  _noteCallsWireFromRecords(records, key);
  await _boundedProbeWait(probe);
  return records;
}
// --files (design A: full-graph resolution) full-parses only `rels` (argv) but
// resolves imports across the WHOLE tree. The reused nodes' metas are streamed
// to the child via STDIN as JSONL — one JSON object per line:
// {rel, lang, rawImports, packageName, namespaceName, goPackageName,
// topLevelTypes}. Rust builds the index + resolves over ALL nodes (fresh +
// reused) and emits fresh rels as full records, reused rels as lightweight
// {rel, resolvedImports, importedBy}.
export async function _runGraphFiles(absRoot, rels, reusedMetas, signal = null) {
  const lines = Array.isArray(reusedMetas)
    ? reusedMetas.map((m) => JSON.stringify({
        rel: m.rel,
        lang: m.lang,
        parseError: m.parseError || '',
        rawImports: Array.isArray(m.rawImports) ? m.rawImports : [],
        packageName: m.packageName || '',
        namespaceName: m.namespaceName || '',
        goPackageName: m.goPackageName || '',
        topLevelTypes: Array.isArray(m.topLevelTypes) ? m.topLevelTypes : [],
      }))
    : [];
  const key = _currentGraphBinaryKey();
  const probe = _ensureCallsWireProbe(absRoot);
  const records = await _runGraphBinaryJsonl(absRoot, ['--files', ...rels], lines, signal);
  _noteCallsWireFromRecords(records, key);
  await _boundedProbeWait(probe);
  return records;
}

// Map a Rust FileRecord (rel/lang/fp/tokens/rawImports/resolvedImports/
// importedBy/...) onto the JS fileInfo shape the graph assembler expects.
// Import resolution — including Go module paths — now happens entirely in
// Rust; resolvedImports/importedBy are repo-relative path lists passed
// straight through.
export function _fileInfoFromRustRecord(rec, absRoot) {
  const rel = rec.rel;
  const abs = pathResolve(absRoot, rel);
  const lang = rec.lang;
  return {
    abs,
    rel,
    lang,
    fingerprint: typeof rec.fp === 'string' ? rec.fp : '',
    parseError: typeof rec.parseError === 'string' ? rec.parseError : '',
    sourceText: null,
    rawImports: Array.isArray(rec.rawImports) ? rec.rawImports : [],
    resolvedImports: Array.isArray(rec.resolvedImports)
      ? rec.resolvedImports.filter((v) => typeof v === 'string')
      : [],
    importedBy: Array.isArray(rec.importedBy)
      ? rec.importedBy.filter((v) => typeof v === 'string')
      : [],
    packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
    namespaceName: typeof rec.namespaceName === 'string' ? rec.namespaceName : '',
    goPackageName: typeof rec.goPackageName === 'string' ? rec.goPackageName : '',
    topLevelTypes: Array.isArray(rec.topLevelTypes) ? rec.topLevelTypes : [],
    tokenSymbols: Array.isArray(rec.tokens) ? rec.tokens : null,
    symbols: Array.isArray(rec.symbols) ? rec.symbols : [],
    // AST call sites, wire v2 tuples, kept exactly as shipped (decoded lazily
    // per file by ast-calls.mjs). The record itself is the capability signal:
    // a v2 binary emits the field on every file it PARSED — `[]` included, so
    // "parsed, no call sites" arrives explicitly — and omits it for everything
    // it did not parse. So a shipped array is always kept (a probe that has
    // not answered yet must not discard data the run already produced), and an
    // absent field always means unknown (null): claiming "no call sites" for a
    // file the extractor never parsed would be a silent lie.
    calls: Array.isArray(rec.calls) ? rec.calls : null,
  };
}

// Reuse a node from the previous graph whose fp is unchanged — skips both
// the Rust call and re-parsing for files that did not change.
export function _reuseFileInfo(prevNode, previousGraph, absRoot) {
  const rel = prevNode.rel;
  const fp = prevNode.fingerprint || '';
  const cachedText = previousGraph?._sourceTextCache?.get(rel);
  return {
    abs: prevNode.abs || pathResolve(absRoot, rel),
    rel,
    lang: prevNode.lang,
    fingerprint: fp,
    parseError: prevNode.parseError || '',
    sourceText: cachedText?.fingerprint === fp ? cachedText.text : null,
    rawImports: Array.isArray(prevNode.rawImports) ? prevNode.rawImports : [],
    resolvedImports: Array.isArray(prevNode.resolvedImportsRel) ? prevNode.resolvedImportsRel : [],
    importedBy: Array.isArray(prevNode.importedBy) ? prevNode.importedBy : [],
    packageName: prevNode.packageName || '',
    namespaceName: prevNode.namespaceName || '',
    goPackageName: prevNode.goPackageName || '',
    topLevelTypes: Array.isArray(prevNode.topLevelTypes) ? prevNode.topLevelTypes : [],
    tokenSymbols: Array.isArray(prevNode.tokenSymbols) ? prevNode.tokenSymbols : null,
    symbols: Array.isArray(prevNode.symbols) ? prevNode.symbols : [],
    // Unchanged file → its AST call sites are unchanged too. Carried over
    // exactly like `symbols`; the lightweight reused record the --files run
    // emits only refreshes resolvedImports/importedBy, so this is the sole
    // survivor path for `calls` on reused nodes.
    calls: Array.isArray(prevNode.calls) ? prevNode.calls : null,
  };
}

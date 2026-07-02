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
import { acquire as acquireChildSpawnSlot } from '../../../../shared/child-spawn-gate.mjs';
import { CODE_GRAPH_BINARY_TIMEOUT_MS, CODE_GRAPH_MAX_FILES } from './constants.mjs';

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
  try { return findCachedGraphBinary(getPluginData()); } catch { return null; }
}

async function _runGraphBinaryJsonl(absRoot, extraArgs, stdinLines = null) {
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
  // child-spawn-gate is NOT acquired here. This function runs inside the
  // code-graph prewarm WORKER THREAD (via _buildCodeGraph), and worker_threads
  // do not share module-level state with the main thread — acquiring here would
  // create a SECOND, independent semaphore that never coordinates with the
  // main-thread rg gate. Instead the gate is held on the MAIN THREAD across the
  // whole graph-build worker's lifetime (see buildCodeGraphAsync). The binary
  // child is spawned exclusively from this worker path, so one main-side slot
  // per worker correctly bounds native graph spawns against rg.
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
    };

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
      if (code !== 0) {
        reject(new Error(`[code-graph] mixdog-graph exited ${code}: ${stderrText.trim().slice(0, 200)}`));
        return;
      }
      const out = [];
      const buf = Buffer.concat(chunks).toString('utf8');
      for (const line of buf.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed);
          if (rec && typeof rec.rel === 'string') out.push(rec);
        } catch { /* skip malformed line */ }
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
export function _runGraphManifest(absRoot) { return _runGraphBinaryJsonl(absRoot, ['--manifest']); }
export function _runGraphWalk(absRoot) { return _runGraphBinaryJsonl(absRoot, []); }
// --files (design A: full-graph resolution) full-parses only `rels` (argv) but
// resolves imports across the WHOLE tree. The reused nodes' metas are streamed
// to the child via STDIN as JSONL — one JSON object per line:
// {rel, lang, rawImports, packageName, namespaceName, goPackageName,
// topLevelTypes}. Rust builds the index + resolves over ALL nodes (fresh +
// reused) and emits fresh rels as full records, reused rels as lightweight
// {rel, resolvedImports, importedBy}.
export function _runGraphFiles(absRoot, rels, reusedMetas) {
  const lines = Array.isArray(reusedMetas)
    ? reusedMetas.map((m) => JSON.stringify({
        rel: m.rel,
        lang: m.lang,
        rawImports: Array.isArray(m.rawImports) ? m.rawImports : [],
        packageName: m.packageName || '',
        namespaceName: m.namespaceName || '',
        goPackageName: m.goPackageName || '',
        topLevelTypes: Array.isArray(m.topLevelTypes) ? m.topLevelTypes : [],
      }))
    : [];
  return _runGraphBinaryJsonl(absRoot, ['--files', ...rels], lines);
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
  };
}

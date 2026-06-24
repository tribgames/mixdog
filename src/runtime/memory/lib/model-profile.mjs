/**
 * model-profile.mjs — Lightweight ONNX model profiling.
 *
 * Writes one JSONL line per measurement point to
 * `history/model-profile.jsonl` (mirrors `retrieval-trace.jsonl`). Meant for
 * the embedding provider. Fire-and-forget: any I/O error is swallowed so
 * instrumentation never breaks a live bridge or memory-cycle call.
 *
 * Schema:
 *   {
 *     ts, phase, model, device, dtype,
 *     rssBytes, externalBytes, heapUsedBytes,
 *     cpuUserUs, cpuSystemUs, wallMs,
 *     docsScored?, note?
 *   }
 *
 * `phase` values used by the providers:
 *   - 'baseline'      (pre-load RSS / CPU snapshot)
 *   - 'load'          (after pipeline/model load resolves)
 *   - 'warmup'        (after the first forward pass)
 *   - 'steady'        (sampled steady-state per-query)
 *   - 'post-idle'     (after the idle dispose fires)
 *
 * No behaviour change when nobody reads the JSONL — this is telemetry only.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';

const DATA_DIR = resolvePluginData();

const PROFILE_PATH = join(DATA_DIR, 'history', 'model-profile.jsonl');

let _mkdirPromise = null;
async function ensureDir() {
  if (!_mkdirPromise) {
    _mkdirPromise = mkdir(dirname(PROFILE_PATH), { recursive: true }).catch(() => {});
  }
  return _mkdirPromise;
}

/**
 * Collect the current RSS + CPU snapshot plus caller metadata. Fire-and-forget
 * writer; errors are swallowed. Callers should pass `wallMs` measured with
 * `performance.now()` around the operation being profiled.
 *
 * @param {object} record
 * @param {string} record.phase     — 'baseline' | 'load' | 'warmup' | 'steady' | 'post-idle' | ...
 * @param {string} record.model     — model id (e.g. 'Xenova/bge-m3')
 * @param {string} [record.device]  — 'cpu' | 'dml' | 'webgpu' | …
 * @param {string} [record.dtype]
 * @param {number} [record.wallMs]
 * @param {number} [record.docsScored]
 * @param {string} [record.note]
 */
export function writeProfilePoint(record) {
  try {
    const mem = process.memoryUsage();
    const cpu = process.resourceUsage();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      phase: record.phase,
      model: record.model,
      device: record.device ?? null,
      dtype: record.dtype ?? null,
      rssBytes: mem.rss,
      externalBytes: mem.external,
      heapUsedBytes: mem.heapUsed,
      arrayBufferBytes: mem.arrayBuffers,
      cpuUserUs: cpu.userCPUTime,
      cpuSystemUs: cpu.systemCPUTime,
      wallMs: typeof record.wallMs === 'number' ? record.wallMs : null,
      docsScored: typeof record.docsScored === 'number' ? record.docsScored : undefined,
      note: record.note ?? undefined,
    });
    // Fire-and-forget: any error is swallowed so instrumentation never
    // breaks a live call path.
    ensureDir()
      .then(() => appendFile(PROFILE_PATH, line + '\n'))
      .catch(() => {});
  } catch {
    // never throw from instrumentation
  }
}

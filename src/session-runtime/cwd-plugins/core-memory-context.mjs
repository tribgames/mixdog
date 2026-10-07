// cwd-plugins/core-memory-context.mjs — the user-curated core-memory block
// injected into new sessions, read from the memory runtime's atomic snapshot.
import { featureEnvOverride } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { readSessionCoreMemoryPayload } from '../../runtime/memory/lib/core-memory-file.mjs';

// Budget for the whole injected block in UTF-8 bytes: bytes track token cost
// more evenly across scripts than characters do.
const CORE_MEMORY_MAX_BYTES = 32 * 1024;
const TRUNCATED_MARK = '\n- ...';

export function createCoreMemoryContext({ getCurrentCwd, bootProfile, clean, cfgMod, STANDALONE_DATA_DIR }) {
  function formatCoreMemoryLines(payload = {}) {
    const seen = new Set();
    const lines = [];
    for (const value of Array.isArray(payload.userLines) ? payload.userLines : []) {
      const text = clean(value).replace(/\s+/g, ' ');
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${text}`);
    }
    const out = lines.join('\n');
    if (Buffer.byteLength(out, 'utf8') <= CORE_MEMORY_MAX_BYTES) return out;
    const budget = CORE_MEMORY_MAX_BYTES - Buffer.byteLength(TRUNCATED_MARK, 'utf8');
    // A byte cut can split a multi-byte character; drop its replacement chars.
    const head = Buffer.from(out, 'utf8').subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '');
    return `${head.replace(/\s+\S*$/, '')}${TRUNCATED_MARK}`;
  }

  async function loadCoreMemoryContext() {
    // User-curated core memory always injects into new sessions: the Memory
    // install marker and toggle gate only the model-facing memory/recall tools.
    // Explicit opt-out (MIXDOG_BOOT_CORE_MEMORY=0/false/no/off) skips this
    // file-backed prompt block. Recall and memory tools remain available.
    if (featureEnvOverride('MIXDOG_BOOT_CORE_MEMORY') === false) {
      bootProfile('core-memory:skipped');
      return '';
    }
    const startedAt = performance.now();
    try {
      // The prompt path never starts or waits for PG/embedding/IPC. Memory
      // runtime maintains this atomic snapshot independently.
      const dataDir = process.env.MIXDOG_DATA_DIR || cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const payload = readSessionCoreMemoryPayload(dataDir, getCurrentCwd());
      if (!payload) {
        bootProfile('core-memory:file-missing');
        return '';
      }
      return formatCoreMemoryLines(payload);
    } catch {
      return '';
    } finally {
      bootProfile('core-memory:done', { ms: (performance.now() - startedAt).toFixed(1) });
    }
  }

  return { formatCoreMemoryLines, loadCoreMemoryContext };
}

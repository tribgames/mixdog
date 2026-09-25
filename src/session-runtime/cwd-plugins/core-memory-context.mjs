// cwd-plugins/core-memory-context.mjs — the user-curated core-memory block
// injected into new sessions, read from the memory runtime's atomic snapshot.
import { featureEnvOverride, memoryToolsEnabled } from '../config-helpers.mjs';
import { readSessionCoreMemoryPayload } from '../../runtime/memory/lib/core-memory-file.mjs';

export function createCoreMemoryContext({ getCurrentCwd, getConfig, bootProfile, clean, cfgMod, STANDALONE_DATA_DIR }) {
  function formatCoreMemoryLines(payload = {}) {
    const seen = new Set();
    const lines = [];
    for (const value of [...(Array.isArray(payload.userLines) ? payload.userLines : [])]) {
      const text = clean(value).replace(/\s+/g, ' ');
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${text}`);
      if (lines.length >= 40) break;
    }
    const out = lines.join('\n');
    const maxChars = 6000;
    return out.length > maxChars ? `${out.slice(0, maxChars).replace(/\s+\S*$/, '')}\n- ...` : out;
  }

  async function loadCoreMemoryContext() {
    // User-curated core memory injects into new sessions by default. The
    // Memory toggle (settings → General) OFF skips ONLY this accumulated
    // core-memory block — profile and Project Instructions inject regardless.
    if (!(featureEnvOverride('MIXDOG_FEATURE_MEMORY') ?? memoryToolsEnabled(getConfig(), true))) {
      bootProfile('core-memory:disabled');
      return '';
    }
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

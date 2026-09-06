/**
 * src/session-runtime/hook-payload.mjs - common payload fields for hook
 * dispatch (session id, transcript path, cwd, permission mode, effort).
 * Extracted from runtime-core.mjs.
 */
import { join } from 'node:path';
import { clean } from './session-text.mjs';
import { STANDALONE_DATA_DIR } from './runtime-paths.mjs';

export function createHookPayload({ rt, cfgMod }) {
  function hookTranscriptPath(sessionId) {
    const id = clean(sessionId);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    return join(dataDir, 'sessions', `${id}.json`);
  }
  function hookEffortPayload() {
    const level = clean(rt.route.effectiveEffort || rt.route.effort);
    return level ? { level: level.toLowerCase() } : undefined;
  }
  function hookCommonPayload(extra = {}) {
    const sid = clean(extra.session_id || extra.sessionId || rt.session?.id);
    return {
      ...(sid ? { session_id: sid, transcript_path: hookTranscriptPath(sid) } : {}),
      cwd: rt.currentCwd,
      permission_mode: rt.session?.permissionMode || 'default',
      ...(hookEffortPayload() ? { effort: hookEffortPayload() } : {}),
      ...extra,
    };
  }
  return { hookCommonPayload };
}

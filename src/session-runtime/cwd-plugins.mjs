import { saveSession } from '../runtime/agent/orchestrator/session/store.mjs';
import { createPluginStatus } from './cwd-plugins/plugin-status.mjs';
import { createCwdApply } from './cwd-plugins/cwd-apply.mjs';
import { createCoreMemoryContext } from './cwd-plugins/core-memory-context.mjs';

// cwd-plugins.mjs — cwd resolution/apply + plugins-status + core-memory context,
// Dependency-injected factory that
// closes over the facade's mutable cwd/config/session state via getter/setter
// injection (getCurrentCwd/setCurrentCwd/getConfig/getSession/...) plus the MCP
// glue + prewarm callbacks. The facade keeps ownership of the mutable locals;
// this module owns the pure logic that was previously inline. The three
// clusters live under cwd-plugins/: plugin-status, cwd-apply,
// core-memory-context.

export function createCwdPlugins(deps) {
  const resolved = {
    ...deps,
    persistSession:
      deps.persistSession === undefined ? (session) => saveSession(session, { immediate: true }) : deps.persistSession,
  };
  const { pluginsStatus } = createPluginStatus(resolved);
  const { resolveCwdPath, applyResolvedCwd } = createCwdApply(resolved);
  const { formatCoreMemoryLines, loadCoreMemoryContext } = createCoreMemoryContext(resolved);

  return {
    resolveCwdPath,
    applyResolvedCwd,
    pluginsStatus,
    formatCoreMemoryLines,
    loadCoreMemoryContext,
  };
}

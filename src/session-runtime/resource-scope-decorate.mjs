// Project scope decoration for the extension status lists. `scope` is the
// entry's own root list (null = global); `inheritedScope` is the owning
// plugin's; and `activeHere` says whether the CURRENT cwd sees the entry, so
// panels can badge "not in this project" without redoing the path match.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  cwdWithinProjects,
  extensionScopeProjects,
  extensionScopesFromConfig,
} from '../runtime/agent/orchestrator/runtime-core/extension-scopes.mjs';

function listOf(status, key) {
  return Array.isArray(status?.[key]) ? status[key] : [];
}

export function createScopeDecorators({ getConfig, getCurrentCwd }) {
  function scopeInfo(
    kind,
    name,
    pluginId = '',
    cwd = getCurrentCwd(),
    scopes = extensionScopesFromConfig(getConfig())
  ) {
    const scope = extensionScopeProjects(scopes, kind, name);
    const inheritedScope = pluginId ? extensionScopeProjects(scopes, 'plugins', pluginId) : null;
    const activeHere =
      (scope ? cwdWithinProjects(cwd, scope) : true) &&
      (inheritedScope ? cwdWithinProjects(cwd, inheritedScope) : true);
    return { scope, inheritedScope, activeHere };
  }
  return {
    mcp(status) {
      return {
        ...status,
        servers: listOf(status, 'servers').map((server) => ({
          ...server,
          ...scopeInfo('mcp', server.name, server?.owner?.kind === 'plugin' ? clean(server.owner.id) : ''),
        })),
      };
    },
    /** `cwd`: decide `activeHere` for that folder instead of the current one. */
    skills(status, cwd = getCurrentCwd()) {
      // One scope read for the whole list, not one per skill.
      const scopes = extensionScopesFromConfig(getConfig());
      return {
        ...status,
        skills: listOf(status, 'skills').map((skill) => ({
          ...skill,
          ...scopeInfo('skills', skill.name, skill?.owner?.kind === 'plugin' ? clean(skill.owner.id) : '', cwd, scopes),
        })),
      };
    },
    plugins(status) {
      return {
        ...status,
        plugins: listOf(status, 'plugins').map((plugin) => ({
          ...plugin,
          ...scopeInfo('plugins', plugin.id || plugin.name),
        })),
      };
    },
  };
}

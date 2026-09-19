// MCP servers, skills, plugins, hooks, and memory/recall surfaces of the
// runtime API. Stateless helpers are imported directly; the runtime injects
// live state getters plus the closure callbacks (`deps`). Each surface lives in
// its own module and shares the extension-change sync and scope decorators.
import { clean } from './session-text.mjs';
import { EXTENSION_SCOPE_KINDS, withExtensionScope } from './extension-scopes.mjs';
import { createExtensionSync } from './resource-extension-sync.mjs';
import { createScopeDecorators } from './resource-scope-decorate.mjs';
import { createMcpResourceApi } from './resource-mcp-api.mjs';
import { createSkillsResourceApi } from './resource-skills-api.mjs';
import { createPluginsResourceApi } from './resource-plugins-api.mjs';
import { createRecallResourceApi } from './resource-recall-api.mjs';

export function createResourceApi(deps) {
  const { getConfig, hooks, saveConfigAndAdopt, mcpStatus, skillsStatus, pluginsStatus } = deps;
  const sync = createExtensionSync(deps);
  const decorate = createScopeDecorators(deps);
  const ctx = { deps, sync, decorate };
  return {
    ...createMcpResourceApi(ctx),
    ...createSkillsResourceApi(ctx),
    ...createPluginsResourceApi(ctx),
    ...createRecallResourceApi(ctx),
    /** Limit one Skill / MCP server / Plugin to project roots; [] or null → global. */
    async setExtensionScope(kind, name, projects = null) {
      const scopeKind = clean(kind);
      if (!EXTENSION_SCOPE_KINDS.includes(scopeKind)) {
        throw new Error(`extension scope kind must be one of ${EXTENSION_SCOPE_KINDS.join(', ')}`);
      }
      const key = clean(name);
      if (!key) throw new Error('extension name is required');
      let list = [projects];
      if (Array.isArray(projects)) list = projects;
      else if (projects == null) list = [];
      saveConfigAndAdopt(withExtensionScope(getConfig(), scopeKind, key, list));
      // Connections and files are untouched; only what sessions see changes.
      await sync.announce(scopeKind);
      if (scopeKind === 'skills') return decorate.skills(skillsStatus());
      if (scopeKind === 'plugins') return decorate.plugins(pluginsStatus());
      return decorate.mcp(mcpStatus());
    },
    disposeGlobalExtensionSubscription() {
      sync.dispose();
    },
    hooksStatus() {
      return hooks.status();
    },
    addHookRule(rule) {
      return hooks.addRule(rule);
    },
    setHookRuleEnabled(index, enabled) {
      return hooks.setRuleEnabled(index, enabled);
    },
    deleteHookRule(index) {
      return hooks.deleteRule(index);
    },
  };
}

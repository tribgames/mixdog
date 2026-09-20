/**
 * extension-pickers.mjs — MCP / Skills / Plugins picker cluster.
 *
 * A dependency-injection factory that composes the three clusters in
 * extension-pickers/ (mcp-servers-picker, skills-pickers, plugins-pickers).
 * These openers drive the panel surface + setSettingsPrompt and read live
 * store state, so they can't be pure. openMcpPicker is exposed for the
 * plugin-detail enable-mcp path (also aliased on the App body).
 */
import { createMcpServersPicker } from './extension-pickers/mcp-servers-picker.mjs';
import { createPluginsPickers } from './extension-pickers/plugins-pickers.mjs';
import { createSkillsPickers } from './extension-pickers/skills-pickers.mjs';

export function createExtensionPickers({
  store,
  theme,
  clean,
  copyToClipboard,
  surface,
  getPicker,
  setProviderPrompt,
  setSettingsPrompt,
  getDisabledSkills,
  setDisabledSkills,
}) {
  const mcp = createMcpServersPicker({ store, theme, surface, getPicker, setProviderPrompt, setSettingsPrompt });
  const skills = createSkillsPickers({
    store,
    theme,
    clean,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    getDisabledSkills,
    setDisabledSkills,
  });
  const plugins = createPluginsPickers({
    store,
    clean,
    copyToClipboard,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    openMcpPicker: mcp.openMcpPicker,
  });
  return { ...mcp, ...skills, ...plugins };
}

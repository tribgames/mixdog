// extension-pickers/plugins-pickers.mjs
// The Plugins menu, the installed-plugins list, the per-plugin detail panel
// (info / update / MCP / copy / uninstall) and the add-plugin prompt.
import { readStatus, withScope } from './scope-note.mjs';

const mcpSummary = (p) => {
  if (!p.mcpScript) return '(none)';
  const state = p.mcpEnabled ? 'enabled' : 'available';
  return `${state} (${p.mcpServerName || 'plugin-mcp'})`;
};

function mcpActionItem(p) {
  if (!p.mcpScript) {
    return {
      value: 'enable-mcp',
      label: 'No MCP script',
      description: 'plugin does not expose scripts/run-mcp.mjs or mcp/server.mjs',
      _action: 'noop',
    };
  }
  return {
    value: 'enable-mcp',
    label: p.mcpEnabled ? 'Refresh MCP server' : 'Enable MCP server',
    description: `${p.mcpServerName || 'plugin-mcp'} · ${p.mcpEnabled ? 'configured' : p.mcpScript}`,
    _action: 'enable-mcp',
  };
}

function pluginSummary(plugin) {
  const version = plugin.version ? ` · ${plugin.version}` : '';
  const mcpState = plugin.mcpEnabled ? 'enabled' : plugin.mcpScript;
  const mcp = plugin.mcpScript ? ` · mcp ${mcpState}` : '';
  return `${plugin.sourceType || plugin.source}${version} · skills ${plugin.skillCount || 0}${mcp}`;
}

const pluginInfoNotice = (p) =>
  [
    `${p.title || p.name}${p.version ? ` ${p.version}` : ''}`,
    `source: ${p.sourceType || p.source}${p.sourceUrl ? ` / ${p.sourceUrl}` : ''}`,
    `skills: ${p.skillCount || 0}`,
    `mcp: ${mcpSummary(p)}`,
    `applies to: ${Array.isArray(p.scope) && p.scope.length ? p.scope.join(', ') : 'all projects'}`,
    `root: ${p.root}`,
    p.description ? `\n${p.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');

const pluginDetailItems = (p) => [
  {
    value: 'info',
    label: 'Plugin info',
    description: `${p.sourceType || p.source}${p.version ? ` · ${p.version}` : ''} · skills ${p.skillCount || 0}`,
    _action: 'info',
  },
  {
    value: 'update',
    label: p.sourceType === 'local' ? 'Refresh metadata' : 'Update plugin',
    description: p.sourceType === 'local' ? 'rescan local plugin manifest' : 'pull latest from source URL',
    _action: 'update',
  },
  mcpActionItem(p),
  {
    value: 'copy-root',
    label: 'Copy root path',
    description: p.root,
    _action: 'copy-root',
  },
  {
    value: 'copy-mcp-name',
    label: p.mcpScript ? 'Copy MCP server name' : 'No MCP server name',
    description: p.mcpServerName || '',
    _action: p.mcpScript ? 'copy-mcp-name' : 'noop',
  },
  {
    value: 'uninstall',
    label: 'Uninstall plugin',
    description: p.managed === false ? 'remove from registry only' : 'remove registry entry and installed files',
    _action: 'uninstall',
  },
];

export function createPluginsPickers({
  store,
  clean,
  copyToClipboard,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  openMcpPicker,
}) {
  const beginAddPlugin = () => {
    surface.claim().close();
    setSettingsPrompt({ kind: 'plugin-add', label: 'Plugin URL', hint: 'Git URL, owner/repo, or local path' });
  };

  const copyText = (text, doneNotice) =>
    void copyToClipboard(text)
      .then(() => store.pushNotice(doneNotice, 'plain'))
      .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));

  const openPluginDetailPicker = (p) => {
    // Synchronous detail panel for an Enter on a plugin row: an ordinary
    // claimed paint — the data is already in hand.
    const own = surface.claim();
    own.paint({
      title: p.title || p.name,
      description: clean(p.description) || 'Update, MCP, or uninstall this plugin.',
      items: pluginDetailItems(p),
      onSelect: (_detailValue, detail) => {
        // Clear-and-continue: the reopens below are bound to this keypress.
        own.paint(null);
        if (detail._action === 'info') {
          store.pushNotice(pluginInfoNotice(p), 'info');
          return;
        }
        if (detail._action === 'update') {
          // Post-write delegation: the reopen is bound to the claim of this
          // keypress, so an ack after Esc cannot re-open the plugin list.
          void store
            .updatePlugin?.(p)
            .then(own.defer(() => openInstalledPluginsPicker()))
            .catch((e) => store.pushNotice(`plugin update failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'enable-mcp') {
          void store
            .enablePluginMcp?.(p)
            .then(own.defer(() => openMcpPicker()))
            .catch((e) => store.pushNotice(`plugin MCP enable failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'copy-root') {
          copyText(p.root, `copied plugin root: ${p.name}`);
          return;
        }
        if (detail._action === 'copy-mcp-name') {
          copyText(p.mcpServerName || '', `copied plugin MCP server: ${p.mcpServerName}`);
          return;
        }
        if (detail._action === 'uninstall') {
          void store
            .removePlugin?.(p)
            .then(own.defer(() => openInstalledPluginsPicker()))
            .catch((e) => store.pushNotice(`plugin uninstall failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => {
        own.close();
        void openInstalledPluginsPicker();
      },
    });
  };

  const openInstalledPluginsPicker = async () => {
    const own = surface.claim();
    const status = await readStatus(store, 'pluginsStatus', 'plugins', 'plugins status');
    if (!status) return;
    const plugins = status.plugins;
    const items = [];
    if (plugins.length === 0) {
      items.push({
        value: 'empty',
        label: 'No installed plugins',
        description: 'Esc back · add from Plugins > Add plugin',
        _action: 'noop',
      });
    }
    for (const plugin of plugins) {
      items.push({
        value: `${plugin.id || plugin.name}:${plugin.version || ''}`,
        label: plugin.title || plugin.name,
        description: withScope(pluginSummary(plugin), plugin),
        _action: 'plugin',
        _plugin: plugin,
      });
    }
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'Installed plugins',
      description: 'Open an installed plugin to manage it.',
      items,
      onSelect: (_value, item) => {
        own.close();
        if (item._action !== 'plugin') return;
        openPluginDetailPicker(item._plugin);
      },
      onCancel: () => {
        own.close();
        void openPluginsPicker();
      },
    });
  };

  const openPluginsPicker = async () => {
    const own = surface.claim();
    const status = await readStatus(store, 'pluginsStatus', 'plugins', 'plugins status');
    if (!status) return;
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'Plugins',
      description: 'Add or manage local plugin integrations.',
      items: [
        {
          value: 'installed',
          label: 'Installed plugins',
          description: `${status.count || 0} installed`,
          _action: 'installed',
        },
        {
          value: 'add',
          label: 'Add plugin',
          description: 'Git URL, owner/repo, or local path',
          _action: 'add',
        },
      ],
      onSelect: (_value, item) => {
        own.close();
        if (item._action === 'installed') {
          openInstalledPluginsPicker();
          return;
        }
        if (item._action === 'add') beginAddPlugin();
      },
      onCancel: () => {
        own.close();
      },
    });
  };

  return { beginAddPlugin, openPluginDetailPicker, openInstalledPluginsPicker, openPluginsPicker };
}

/**
 * extension-pickers.mjs — MCP / Skills / Plugins picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. These openers drive the panel surface + setSettingsPrompt and read
 * live store state, so they can't be pure. Every function body is the original
 * App logic verbatim, with closure identifiers threaded through the factory
 * argument. `disabledSkills` is read fresh via getDisabledSkills() so toggles
 * observe the latest state at call time. openMcpPicker is exposed for the
 * plugin-detail enable-mcp path (also aliased on the App body).
 */
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
  // MCP toggle settle-guard state: bumped per toggle (epoch) and armed only
  // while the MCP picker is on screen (see openMcpServersPicker). The live
  // picker is read via getPicker() so a stale settle can also detect pickers
  // opened outside this factory replacing the MCP one.
  let mcpEpoch = 0;
  let mcpActive = false;
  // Async: these status reads are remote calls on a daemon-backed store, so the
  // sync versions handed every picker an unresolved promise (empty lists).
  const mcpStatus = async () => {
    let status;
    try {
      status = (await store.mcpStatus?.()) || { servers: [] };
    } catch (e) {
      store.pushNotice(`mcp status failed: ${e?.message || e}`, 'error');
      return null;
    }
    return { ...status, servers: status.servers || [] };
  };

  const openMcpServersPicker = async (options = {}) => {
    // Surface claim (panel-surface.mjs): the status read below is a daemon
    // round-trip, so Esc can land before this panel ever paints.
    const own = surface.claim();
    const status = await mcpStatus();
    if (!status) return;
    const servers = status.servers || [];
    const optimistic = options?.optimistic || null;
    const items = [];
    if (servers.length === 0) {
      items.push({
        value: 'empty',
        label: 'No MCP servers',
        description: 'no configured MCP servers',
        _action: 'noop',
      });
    }
    for (const server of servers) {
      const pending = optimistic && optimistic.name === server.name;
      const enabled = pending ? optimistic.enabled : server.enabled !== false;
      items.push({
        value: `server:${server.name}`,
        label: server.name,
        marker: enabled ? '●' : '○',
        markerColor: enabled ? theme.success : theme.inactive,
        description: pending
          ? `${optimistic.enabled ? 'enabling' : 'disabling'}… · ${server.transport || 'unknown'}`
          : `${server.source || 'config'} · ${server.status || 'unknown'} · ${server.transport || 'unknown'} · ${server.toolCount || 0} tools${server.error ? ` · ${server.error}` : ''}`,
        _action: 'server',
        _server: server,
        _enabled: enabled,
      });
    }
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    const toggleServer = (item) => {
      if (item._action !== 'server' || !item._server?.name) return;
      const name = item._server.name;
      const target = !item._enabled;
      const highlightValue = `server:${name}`;
      // A settle is only allowed to touch the UI if it is still the newest
      // toggle (token === mcpEpoch) and the MCP picker is still on screen.
      const token = ++mcpEpoch;
      const settle = (fn) => {
        if (token !== mcpEpoch || !mcpActive || getPicker?.()?._kind !== 'mcp-servers') return;
        fn();
      };
      // Optimistic: instantly reopen with the row flipped + pending status.
      openMcpServersPicker({ highlightValue, optimistic: { name, enabled: target } });
      Promise.resolve(store.setMcpServerEnabled?.(name, target))
        .then(() => {
          // Per-server serialization in the runtime already converged rapid
          // re-toggles to the last requested state; just refresh the row.
          settle(() => openMcpServersPicker({ highlightValue }));
        })
        .catch((e) => {
          store.pushNotice(`mcp toggle failed: ${e?.message || e}`, 'error');
          settle(() => openMcpServersPicker({ highlightValue }));
        });
    };
    own.paint({
      _kind: 'mcp-servers',
      title: 'MCP servers',
      description: 'Enable or disable configured MCP servers.',
      initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options?.highlightValue)),
      items,
      onSelect: (_value, item) => toggleServer(item),
      onLeft: (item) => toggleServer(item),
      onRight: (item) => toggleServer(item),
      onCancel: () => {
        // Leaving the picker invalidates any in-flight settle.
        mcpActive = false;
        mcpEpoch++;
        own.close();
      },
    });
    mcpActive = true;
  };

  const openMcpPicker = () => {
    return openMcpServersPicker();
  };

  const skillsStatus = async () => {
    let status;
    try {
      status = (await store.skillsStatus?.()) || { skills: [] };
    } catch (e) {
      store.pushNotice(`skills status failed: ${e?.message || e}`, 'error');
      return null;
    }
    return { ...status, skills: status.skills || [] };
  };

  const openProjectSkillsPicker = async () => {
    const own = surface.claim();
    const status = await skillsStatus();
    if (!status) return;
    const skills = status.skills || [];
    const items = [];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No project skills',
        description: 'no project skills available',
        _action: 'noop',
      });
    }
    for (const skill of skills) {
      items.push({
        value: skill.name,
        label: skill.name,
        description: `${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`,
        _action: 'view',
        _skill: skill,
      });
    }
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'Project skills',
      description: 'Skills bundled with this project.',
      items,
      onSelect: (_value, item) => {
        own.close();
        if (item._action !== 'view') return;
        openSkillDetailPicker(item._skill);
      },
      onCancel: () => {
        own.close();
        void openSkillsPicker();
      },
    });
  };

  const openSkillsPicker = async (options = {}) => {
    const own = surface.claim();
    // Reuse the skills list already fetched by the opening call when a toggle
    // reopens the picker: avoids a store.skillsStatus() round-trip per keypress.
    let skills;
    if (Array.isArray(options.skills)) {
      skills = options.skills;
    } else {
      const status = await skillsStatus();
      if (!status) return;
      skills = status.skills || [];
    }
    const disabledSet = options.disabledOverride instanceof Set ? options.disabledOverride : getDisabledSkills();
    const items = [];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No skills',
        description: 'no project skills available',
        _action: 'noop',
      });
    }
    for (const skill of skills) {
      const enabled = !disabledSet.has(skill.name);
      items.push({
        value: skill.name,
        label: skill.name,
        marker: enabled ? '●' : '○',
        markerColor: enabled ? theme.success : theme.inactive,
        description: `${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`,
        _action: 'skill',
        _skill: skill,
        _enabled: enabled,
      });
    }
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    const toggleSkill = (item) => {
      if (item._action !== 'skill' || !item._skill?.name) return;
      const name = item._skill.name;
      const next = new Set(disabledSet);
      if (item._enabled) next.add(name); else next.delete(name);
      setDisabledSkills(next);
      store.pushNotice(
        `skill ${item._enabled ? 'disabled' : 'enabled'}: ${name} (prompt updates next session /clear)`,
        'info',
      );
      openSkillsPicker({ highlightValue: name, disabledOverride: next, skills });
    };
    own.paint({
      _kind: 'skills',
      title: 'Skills',
      description: 'Enable or disable project skills.',
      initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options.highlightValue)),
      items,
      onSelect: (_value, item) => toggleSkill(item),
      onLeft: (item) => toggleSkill(item),
      onRight: (item) => toggleSkill(item),
      onCancel: () => {
        own.close();
      },
    });
  };

  const openSkillDetailPicker = (skill) => {
    // Synchronous detail panel for an Enter on a skill row: an ordinary claimed
    // paint — nothing async precedes it, and the claim proves it anyway.
    const own = surface.claim();
    const disabled = getDisabledSkills().has(skill.name);
    own.paint({
      title: `Skill · ${skill.name}`,
      description: clean(skill.description) || 'Enable, disable, or run this skill.',
      items: [
        {
          value: 'use',
          label: 'Use skill',
          description: disabled ? 'enable this skill first' : 'write a request with this skill',
          _action: disabled ? 'noop' : 'use',
        },
        {
          value: disabled ? 'enable' : 'disable',
          label: disabled ? 'Enable skill' : 'Disable skill',
          description: disabled ? 'show and allow this skill in the TUI' : 'hide use action until re-enabled',
          _action: disabled ? 'enable' : 'disable',
        },
      ],
      onSelect: (_value, item) => {
        own.close();
        if (item._action === 'enable') {
          setDisabledSkills((current) => {
            const next = new Set(current);
            next.delete(skill.name);
            return next;
          });
          store.pushNotice(`skill enabled: ${skill.name} (prompt updates next session /clear)`, 'info');
          openSkillsPicker();
          return;
        }
        if (item._action === 'disable') {
          setDisabledSkills((current) => {
            const next = new Set(current);
            next.add(skill.name);
            return next;
          });
          store.pushNotice(`skill disabled: ${skill.name} (prompt updates next session /clear)`, 'info');
          openSkillsPicker();
          return;
        }
        if (item._action === 'use') {
          setSettingsPrompt({
            kind: 'skill-use',
            label: `Skill · ${skill.name}`,
            hint: 'Write the request to run with this skill.',
            skillName: skill.name,
          });
          return;
        }
      },
      onCancel: () => {
        own.close();
        void openSkillsPicker();
      },
    });
  };

  const pluginStatus = async () => {
    let status;
    try {
      status = (await store.pluginsStatus?.()) || { plugins: [] };
    } catch (e) {
      store.pushNotice(`plugins status failed: ${e?.message || e}`, 'error');
      return null;
    }
    return { ...status, plugins: status.plugins || [] };
  };

  const beginAddPlugin = () => {
    surface.claim().close();
    setSettingsPrompt({ kind: 'plugin-add', label: 'Plugin URL', hint: 'Git URL, owner/repo, or local path' });
  };

  const openPluginDetailPicker = (p) => {
    // Synchronous detail panel for an Enter on a plugin row: an ordinary
    // claimed paint — the data is already in hand.
    const own = surface.claim();
    own.paint({
      title: p.title || p.name,
      description: clean(p.description) || 'Update, MCP, or uninstall this plugin.',
      items: [
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
        {
          value: 'enable-mcp',
          label: p.mcpScript ? (p.mcpEnabled ? 'Refresh MCP server' : 'Enable MCP server') : 'No MCP script',
          description: p.mcpScript ? `${p.mcpServerName || 'plugin-mcp'} · ${p.mcpEnabled ? 'configured' : p.mcpScript}` : 'plugin does not expose scripts/run-mcp.mjs or mcp/server.mjs',
          _action: p.mcpScript ? 'enable-mcp' : 'noop',
        },
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
      ],
      onSelect: (_detailValue, detail) => {
        // Clear-and-continue: the reopens below are bound to this keypress.
        own.paint(null);
        if (detail._action === 'info') {
          store.pushNotice([
            `${p.title || p.name}${p.version ? ` ${p.version}` : ''}`,
            `source: ${p.sourceType || p.source}${p.sourceUrl ? ` / ${p.sourceUrl}` : ''}`,
            `skills: ${p.skillCount || 0}`,
            `mcp: ${p.mcpScript ? `${p.mcpEnabled ? 'enabled' : 'available'} (${p.mcpServerName || 'plugin-mcp'})` : '(none)'}`,
            `root: ${p.root}`,
            p.description ? `\n${p.description}` : '',
          ].filter(Boolean).join('\n'), 'info');
          return;
        }
        if (detail._action === 'update') {
          // Post-write delegation: the reopen is bound to the claim of this
          // keypress, so an ack after Esc cannot re-open the plugin list.
          void store.updatePlugin?.(p)
            .then(own.defer(() => openInstalledPluginsPicker()))
            .catch((e) => store.pushNotice(`plugin update failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'enable-mcp') {
          void store.enablePluginMcp?.(p)
            .then(own.defer(() => openMcpPicker()))
            .catch((e) => store.pushNotice(`plugin MCP enable failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'copy-root') {
          void copyToClipboard(p.root)
            .then(() => store.pushNotice(`copied plugin root: ${p.name}`, 'plain'))
            .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'copy-mcp-name') {
          void copyToClipboard(p.mcpServerName || '')
            .then(() => store.pushNotice(`copied plugin MCP server: ${p.mcpServerName}`, 'plain'))
            .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'uninstall') {
          void store.removePlugin?.(p)
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
    const status = await pluginStatus();
    if (!status) return;
    const plugins = status.plugins || [];
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
        description: `${plugin.sourceType || plugin.source}${plugin.version ? ` · ${plugin.version}` : ''} · skills ${plugin.skillCount || 0}${plugin.mcpScript ? ` · mcp ${plugin.mcpEnabled ? 'enabled' : plugin.mcpScript}` : ''}`,
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
    const status = await pluginStatus();
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

  return {
    openMcpServersPicker,
    openMcpPicker,
    openProjectSkillsPicker,
    openSkillsPicker,
    openSkillDetailPicker,
    beginAddPlugin,
    openPluginDetailPicker,
    openInstalledPluginsPicker,
    openPluginsPicker,
  };
}

// extension-pickers/mcp-servers-picker.mjs
// The MCP servers list: enable/disable toggles reopen the list optimistically
// and a settle repaints only while it is still the newest toggle and the MCP
// picker is still on screen.
import { readStatus, withScope } from './scope-note.mjs';

const serverDescription = (server, pending, optimistic) => {
  const transport = server.transport || 'unknown';
  if (pending) return `${optimistic.enabled ? 'enabling' : 'disabling'}… · ${transport}`;
  const error = server.error ? ` · ${server.error}` : '';
  return withScope(
    `${server.source || 'config'} · ${server.status || 'unknown'} · ${transport} · ${server.toolCount || 0} tools${error}`,
    server
  );
};

export function createMcpServersPicker({ store, theme, surface, getPicker, setProviderPrompt, setSettingsPrompt }) {
  // MCP toggle settle-guard state: bumped per toggle (epoch) and armed only
  // while the MCP picker is on screen. The live picker is read via getPicker()
  // so a stale settle can also detect pickers opened outside this factory
  // replacing the MCP one.
  let mcpEpoch = 0;
  let mcpActive = false;

  const serverItems = (servers, optimistic) => {
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
        description: serverDescription(server, pending, optimistic),
        _action: 'server',
        _server: server,
        _enabled: enabled,
      });
    }
    return items;
  };

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

  const openMcpServersPicker = async (options = {}) => {
    // Surface claim (panel-surface.mjs): the status read below is a daemon
    // round-trip, so Esc can land before this panel ever paints.
    const own = surface.claim();
    const status = await readStatus(store, 'mcpStatus', 'servers', 'mcp status');
    if (!status) return;
    const items = serverItems(status.servers || [], options?.optimistic || null);
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      _kind: 'mcp-servers',
      title: 'MCP servers',
      description: 'Enable or disable configured MCP servers.',
      initialIndex: Math.max(
        0,
        items.findIndex((entry) => entry.value === options?.highlightValue)
      ),
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

  return { openMcpServersPicker, openMcpPicker };
}

// "사용할 커넥터": every installed connector with an on/off switch, for one
// agent (its profile) or one project (Project settings). A connector is on
// unless switched off here, and one installed later shows up on; each switch
// saves at once (setAgentConnectorEnabled / setProjectConnectorEnabled). An
// agent's connector name also opens that connector's tools, each with the
// bot's permission for it (connector-tool-permissions.tsx).
import { ChevronRight, Plug } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import type { DesktopApi } from '../shared/contract';
import { openConnectorsTab } from './connector-connect';
import { ConnectorIcon } from './connector-icon';
import {
  type ConnectorToolPermission,
  type ConnectorToolRow,
  ConnectorToolPermissions,
  connectorToolsCache,
  connectorToolsReader,
  prefetchConnectorTools,
} from './connector-tool-permissions';
import { baseConnectorId } from './connectors-model';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { createKeyedReadCache } from './keyed-read-cache';
import { subscribeSetupChanges } from './setup-change-refresh';
import { CompactSwitch } from './settings/capability-controls';

export type ConnectorSwitchApi = Partial<Pick<DesktopApi, 'invokeCapability'>>;
export interface ConnectorSwitch {
  id: string;
  enabled: boolean;
}

const CAPABILITIES = {
  agent: { read: 'getAgentConnectors', write: 'setAgentConnectorEnabled' },
  project: { read: 'getProjectConnectors', write: 'setProjectConnectorEnabled' },
} as const;

/** The host's `[{ id, enabled }]` rows, defensively typed. */
export function connectorSwitches(value: unknown): ConnectorSwitch[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row && typeof row.id === 'string' && row.id)
    .map((row) => ({ id: String(row.id), enabled: row.enabled === true }));
}

/** Each target's switches (keyed-read-cache): a list opens on the last read
 *  ones in its first frame and revalidates behind them, sharing a warm-up's
 *  read still in flight. */
const switchesCache = createKeyedReadCache<ConnectorSwitch[]>();
const switchesKey = (kind: 'agent' | 'project', target: string) => `${kind}\0${target}`;
const switchesReader = (api: ConnectorSwitchApi | undefined, kind: 'agent' | 'project', target: string) => async () =>
  connectorSwitches((await api?.invokeCapability?.({ capability: CAPABILITIES[kind].read, args: [target] }))?.value);

/** Reads a target's switches into that cache before its list opens (a bot tab
 *  turning active warms its profile's, prefetchAgentProfile); a bot's tool
 *  permissions come with them. */
export async function prefetchConnectorSwitches(
  api: ConnectorSwitchApi | undefined,
  kind: 'agent' | 'project',
  target: string
): Promise<void> {
  await Promise.all([
    switchesCache.load(switchesKey(kind, target), switchesReader(api, kind, target)),
    kind === 'agent' ? prefetchConnectorTools(api, target) : undefined,
  ]);
}

const NO_TOOLS: ConnectorToolRow[] = [];

export function ConnectorSwitchList({
  api,
  kind,
  target,
  active = true,
}: {
  api?: ConnectorSwitchApi;
  kind: 'agent' | 'project';
  /** The agent id, or the registered Project path. */
  target: string;
  active?: boolean;
}) {
  const key = switchesKey(kind, target);
  const subscribe = useCallback((listener: () => void) => switchesCache.subscribe(key, listener), [key]);
  const rows = useSyncExternalStore(subscribe, () => switchesCache.peek(key)) ?? null;
  // An agent's tool permissions (its connectors' tools), read beside the switches.
  const agentId = kind === 'agent' ? target : '';
  const subscribeTools = useCallback((listener: () => void) => connectorToolsCache.subscribe(agentId, listener), [agentId]);
  const toolRows = useSyncExternalStore(subscribeTools, () => connectorToolsCache.peek(agentId)) ?? NO_TOOLS;
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { write } = CAPABILITIES[kind];
  useEffect(() => {
    if (!active || !target) return undefined;
    let live = true;
    setError('');
    if (!api?.invokeCapability) return undefined;
    const reader = switchesReader(api, kind, target);
    const toolsReader = agentId ? connectorToolsReader(api, agentId) : null;
    const failed = (reason: unknown) => {
      if (live) setError(errorMessageText(reason));
    };
    // Each activation revalidates behind the cached rows.
    switchesCache.load(key, reader).catch(failed);
    if (toolsReader) connectorToolsCache.load(agentId, toolsReader).catch(failed);
    // A connector installed, removed or switched elsewhere (a setup tool, the
    // Extensions page, another window) arrives through the settings-changed
    // broadcast every settings reader uses; it reads after any read in flight.
    const unsubscribe = subscribeSetupChanges(() => {
      void switchesCache.refresh(key, reader).catch(failed);
      if (toolsReader) void connectorToolsCache.refresh(agentId, toolsReader).catch(failed);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, kind, target, active, key, agentId]);
  const toggle = async (ids: string[], enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      let result: { value?: unknown } | undefined;
      for (const id of ids) result = await api?.invokeCapability?.({ capability: write, args: [target, id, enabled] });
      switchesCache.write(key, connectorSwitches(result?.value));
    } catch (reason) {
      setError(errorMessageText(reason));
    } finally {
      setBusy(false);
    }
  };
  // One tool's permission (the host sets it on every account of the connector), then read back.
  const choose = async (id: string, tool: string, permission: ConnectorToolPermission) => {
    setBusy(true);
    setError('');
    try {
      await api?.invokeCapability?.({
        capability: 'setAgentConnectorToolPermission',
        args: [target, id, tool, permission],
      });
    } catch (reason) {
      setError(errorMessageText(reason));
    } finally {
      await connectorToolsCache
        .refresh(agentId, connectorToolsReader(api, agentId))
        .catch((reason) => setError(errorMessageText(reason)));
      setBusy(false);
    }
  };
  const toggleOpened = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // The Extensions → 커넥터 order: alphabetical by the name shown.
  // One row per connector: its accounts (`gmail`, `gmail-2`…) are on together
  // (every account on), and a toggle sets all of them.
  const groups = new Map<string, { id: string; ids: string[]; enabled: boolean }>();
  for (const row of rows ?? []) {
    const id = baseConnectorId(row.id);
    const group = groups.get(id);
    if (group) {
      group.ids.push(row.id);
      group.enabled = group.enabled && row.enabled;
    } else groups.set(id, { id, ids: [row.id], enabled: row.enabled });
  }
  const named = [...groups.values()]
    .map((row) => ({ ...row, name: connectorById(row.id)?.name ?? row.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="connector-switches" data-connector-switches={kind}>
      {error && <ErrorNotice error={error} />}
      {rows?.length === 0 && (
        <p className="connector-switches-empty">
          <span>{t('No connectors connected.')}</span>
          <button type="button" className="connector-switches-link" onClick={openConnectorsTab}>
            {t('Connect connectors')}
          </button>
        </p>
      )}
      {named.map((row) => {
        // The accounts of a connector share their tool permissions (the host
        // keeps them together), so the first account's rows speak for all.
        const tools = agentId ? toolRows.filter((tool) => tool.connector === row.ids[0]) : NO_TOOLS;
        const changed = tools.filter((tool) => tool.explicit).length;
        const expanded = Boolean(agentId) && opened.has(row.id);
        return (
          <Fragment key={row.id}>
            <div className="connector-switch-row" data-connector-switch={row.id}>
              <span className="connector-switch-icon" aria-hidden="true">
                {connectorById(row.id) ? (
                  <ConnectorIcon id={row.id} name={row.name} />
                ) : (
                  <Plug size={16} aria-hidden="true" />
                )}
              </span>
              {agentId ? (
                <button
                  type="button"
                  className="connector-switch-name connector-switch-disclosure"
                  aria-expanded={expanded}
                  onClick={() => toggleOpened(row.id)}
                >
                  <ChevronRight className="connector-switch-chevron" size={12} strokeWidth={2.4} aria-hidden="true" />
                  <span className="connector-switch-label">{row.name}</span>
                  {changed > 0 && (
                    <span className="connector-switch-badge">{t('· {{n}} changed', { n: changed })}</span>
                  )}
                </button>
              ) : (
                <span className="connector-switch-name">{row.name}</span>
              )}
              <CompactSwitch
                label={row.name}
                checked={row.enabled}
                disabled={busy}
                onChange={(enabled) => void toggle(row.ids, enabled)}
              />
            </div>
            {expanded && (
              <ConnectorToolPermissions
                connector={row.id}
                tools={tools}
                enabled={row.enabled}
                busy={busy}
                onChoose={(tool, permission) => void choose(row.ids[0], tool, permission)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

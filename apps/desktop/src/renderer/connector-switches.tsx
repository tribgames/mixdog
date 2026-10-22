// "사용할 커넥터": every installed connector with an on/off switch, for one
// agent (its profile) or one project (Project settings). A connector is on
// unless switched off here, and one installed later shows up on; each switch
// saves at once (setAgentConnectorEnabled / setProjectConnectorEnabled).
import { Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import type { DesktopApi } from '../shared/contract';
import { openConnectorsTab } from './connector-connect';
import { ConnectorIcon } from './connector-icon';
import { baseConnectorId } from './connectors-model';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
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
  const [rows, setRows] = useState<ConnectorSwitch[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { read, write } = CAPABILITIES[kind];
  useEffect(() => {
    if (!active || !target) return undefined;
    let live = true;
    setError('');
    api
      ?.invokeCapability?.({ capability: read, args: [target] })
      .then((result) => {
        if (live) setRows(connectorSwitches(result?.value));
      })
      .catch((reason) => {
        if (live) setError(errorMessageText(reason));
      });
    return () => {
      live = false;
    };
  }, [api, read, target, active]);
  const toggle = async (ids: string[], enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      let result: { value?: unknown } | undefined;
      for (const id of ids) result = await api?.invokeCapability?.({ capability: write, args: [target, id, enabled] });
      setRows(connectorSwitches(result?.value));
    } catch (reason) {
      setError(errorMessageText(reason));
    } finally {
      setBusy(false);
    }
  };
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
      {named.map((row) => (
        <div key={row.id} className="connector-switch-row" data-connector-switch={row.id}>
          <span className="connector-switch-icon" aria-hidden="true">
            {connectorById(row.id) ? (
              <ConnectorIcon id={row.id} name={row.name} />
            ) : (
              <Plug size={16} aria-hidden="true" />
            )}
          </span>
          <span className="connector-switch-name">{row.name}</span>
          <CompactSwitch
            label={row.name}
            checked={row.enabled}
            disabled={busy}
            onChange={(enabled) => void toggle(row.ids, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

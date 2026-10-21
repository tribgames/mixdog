// "항상 허용" the person gave one bot, listed in that bot's profile so each can
// be turned back to asking: a connector tool the bot runs without asking (its
// own policy entry) and an action kind it may do without asking (its
// permission table: form submits, send/post clicks, and the outbound kinds
// that offer "다시 묻지 않기"). Nothing shows while the bot has none.
import { useCallback, useEffect, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import { actionLabel, connectorToolLabel } from './ApprovalCard';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { subscribeSetupChanges } from './setup-change-refresh';

export type AlwaysAllowedApi = Partial<Pick<DesktopApi, 'invokeCapability'>>;

export interface AlwaysAllowedItem {
  key: string;
  label: string;
  /** The capability call that turns it back to asking. */
  revoke: { capability: 'setAgentPermission' | 'setAgentConnectorToolPermission'; args: unknown[] };
}

/** The host's two answers as rows: allowed action kinds, then allowed connector tools. */
export function alwaysAllowedItems(agentId: string, permissions: unknown, tools: unknown): AlwaysAllowedItem[] {
  const actions = (Array.isArray(permissions) ? permissions : [])
    .filter((row) => row && row.mode === 'allow' && typeof row.action === 'string')
    .map((row) => ({
      key: `action:${row.action}`,
      label: actionLabel(String(row.action)),
      revoke: { capability: 'setAgentPermission' as const, args: [agentId, row.action, 'ask'] },
    }));
  const connectorTools = (Array.isArray(tools) ? tools : [])
    .filter((row) => row && typeof row.connector === 'string' && typeof row.tool === 'string')
    .map((row) => ({
      key: `tool:${row.connector}:${row.tool}`,
      label: connectorToolLabel(`mcp__${row.connector}__${row.tool}`),
      revoke: {
        capability: 'setAgentConnectorToolPermission' as const,
        args: [agentId, row.connector, row.tool, 'needs_approval'],
      },
    }));
  return [...actions, ...connectorTools];
}

export function AlwaysAllowedList({
  api,
  agentId,
  active = true,
}: {
  api?: AlwaysAllowedApi;
  agentId: string;
  active?: boolean;
}) {
  const [items, setItems] = useState<AlwaysAllowedItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const read = (capability: 'getAgentPermissions' | 'getAgentAlwaysAllowedTools') =>
      api?.invokeCapability?.({ capability, args: [agentId] }).then((result) => result?.value);
    const [permissions, tools] = await Promise.all([read('getAgentPermissions'), read('getAgentAlwaysAllowedTools')]);
    return alwaysAllowedItems(agentId, permissions, tools);
  }, [api, agentId]);
  useEffect(() => {
    if (!active || !agentId) return undefined;
    let live = true;
    const reload = () =>
      load()
        .then((next) => {
          if (live) setItems(next);
        })
        .catch((reason) => {
          if (live) setError(errorMessageText(reason));
        });
    setError('');
    void reload();
    // A grant made while this list is open ("Always allow" on a card) arrives
    // through the same settings-changed broadcast every settings reader uses.
    const unsubscribe = subscribeSetupChanges(() => void reload());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [load, active, agentId]);
  const askAgain = async (item: AlwaysAllowedItem) => {
    setBusy(true);
    setError('');
    try {
      await api?.invokeCapability?.({ capability: item.revoke.capability, args: item.revoke.args });
      setItems(await load());
    } catch (reason) {
      setError(errorMessageText(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!items.length && !error) return null;
  return (
    <section className="agent-create-section agent-profile-always-allowed">
      <h3>{t('Always allowed')}</h3>
      <div className="connector-switches" data-always-allowed={agentId}>
        {error && <ErrorNotice error={error} />}
        {items.map((item) => (
          <div key={item.key} className="connector-switch-row" data-always-allowed-item={item.key}>
            <span className="connector-switch-name">{item.label}</span>
            <button
              type="button"
              className="connector-switches-link"
              disabled={busy}
              aria-label={t('Ask again: {{item}}', { item: item.label })}
              onClick={() => void askAgain(item)}
            >
              {t('Ask again')}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

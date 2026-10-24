// "항상 허용" the person gave one bot, listed in that bot's profile so each can
// be turned back to asking: a connector tool the bot runs without asking (its
// own policy entry) and an action kind it may do without asking (its
// permission table: form submits, send/post clicks, and the outbound kinds
// that offer "다시 묻지 않기"). Nothing shows while the bot has none.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { DesktopApi } from '../shared/contract';
import { actionLabel, connectorToolLabel } from './ApprovalCard';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { createKeyedReadCache } from './keyed-read-cache';
import { subscribeSetupChanges } from './setup-change-refresh';

const NO_ITEMS: AlwaysAllowedItem[] = [];

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

/** The host's answer for one bot, as rows. */
async function readAlwaysAllowed(api: AlwaysAllowedApi | undefined, agentId: string): Promise<AlwaysAllowedItem[]> {
  const read = (capability: 'getAgentPermissions' | 'getAgentAlwaysAllowedTools') =>
    api?.invokeCapability?.({ capability, args: [agentId] }).then((result) => result?.value);
  const [permissions, tools] = await Promise.all([read('getAgentPermissions'), read('getAgentAlwaysAllowedTools')]);
  return alwaysAllowedItems(agentId, permissions, tools);
}

/** Each bot's rows (keyed-read-cache): its profile opens on the last read ones
 *  in its first frame and revalidates behind them, sharing a warm-up's read
 *  still in flight. */
const alwaysAllowedCache = createKeyedReadCache<AlwaysAllowedItem[]>();

/** Reads a bot's rows into that cache before its profile opens (a bot tab
 *  turning active, prefetchAgentProfile). */
export async function prefetchAlwaysAllowed(api: AlwaysAllowedApi | undefined, agentId: string): Promise<void> {
  await alwaysAllowedCache.load(agentId, () => readAlwaysAllowed(api, agentId));
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
  const subscribe = useCallback((listener: () => void) => alwaysAllowedCache.subscribe(agentId, listener), [agentId]);
  const items = useSyncExternalStore(subscribe, () => alwaysAllowedCache.peek(agentId)) ?? NO_ITEMS;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reader = useCallback(() => readAlwaysAllowed(api, agentId), [api, agentId]);
  useEffect(() => {
    if (!active || !agentId) return undefined;
    let live = true;
    const failed = (reason: unknown) => {
      if (live) setError(errorMessageText(reason));
    };
    setError('');
    // Each activation revalidates behind the cached rows.
    alwaysAllowedCache.load(agentId, reader).catch(failed);
    // A grant made while this list is open ("Always allow" on a card) arrives
    // through the same settings-changed broadcast every settings reader uses.
    const unsubscribe = subscribeSetupChanges(() => void alwaysAllowedCache.refresh(agentId, reader).catch(failed));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [reader, active, agentId]);
  const askAgain = async (item: AlwaysAllowedItem) => {
    setBusy(true);
    setError('');
    try {
      await api?.invokeCapability?.({ capability: item.revoke.capability, args: item.revoke.args });
      await alwaysAllowedCache.refresh(agentId, reader);
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

// Which question the usage dialog answers when it opens: what was SPENT
// (token usage) or how a subscription's quota was used up (subscription
// usage). The last choice persists; a provider meter in the usage flyout opens
// its own subscription and window directly.
import { useCallback, useState } from 'react';

export type UsageSurfaceMode = 'tokens' | 'quota' | 'requests';
export type QuotaFocus = { provider: string; window?: string; account?: string };

const MODE_STORAGE_KEY = 'mixdog.desktop.usage-surface-mode.v1';
const SUBSCRIPTION_STORAGE_KEY = 'mixdog.desktop.usage-quota-subscription.v1';
let pendingFocus: QuotaFocus | null = null;

type QuotaSubscription = { provider: string; window: string };

/** The subscription and limit window subscription usage showed last: where
 *  it opens next. The account is never kept: it opens on the one in use. */
export function readQuotaSubscription(): QuotaSubscription | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SUBSCRIPTION_STORAGE_KEY) || 'null');
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    return text(stored?.provider) ? { provider: text(stored.provider), window: text(stored.window) } : null;
  } catch {
    return null;
  }
}

export function writeQuotaSubscription(subscription: QuotaSubscription): void {
  try {
    window.localStorage.setItem(SUBSCRIPTION_STORAGE_KEY, JSON.stringify(subscription));
  } catch {
    /* storage-less hosts start from the subscription in use */
  }
}

function readUsageSurfaceMode(): UsageSurfaceMode {
  try {
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    return stored === 'quota' || stored === 'requests' ? stored : 'tokens';
  } catch {
    return 'tokens';
  }
}

function writeUsageSurfaceMode(mode: UsageSurfaceMode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* storage-less hosts keep the choice for the open dialog only */
  }
}

/** The next opening shows this subscription's usage. */
export function focusQuotaUsage(focus: QuotaFocus): void {
  pendingFocus = focus;
  writeUsageSurfaceMode('quota');
}

/** Read without consuming: StrictMode runs state initializers twice. */
export function peekQuotaFocus(): QuotaFocus | null {
  return pendingFocus;
}

export function clearQuotaFocus(): void {
  pendingFocus = null;
}

function openingMode(): UsageSurfaceMode {
  return pendingFocus ? 'quota' : readUsageSurfaceMode();
}

/**
 * The mode of a usage dialog that stays mounted while closed. Every opening
 * decides it again before its first paint — the meter that asked, else the
 * last choice — so a stale mode never flashes.
 */
export function useUsageSurfaceMode(
  open: boolean,
  requestsSupported = true
): [UsageSurfaceMode, (mode: UsageSurfaceMode) => void] {
  const [state, setState] = useState(() => ({ open, mode: openingMode() }));
  if (state.open !== open) setState({ open, mode: open ? openingMode() : state.mode });
  const choose = useCallback((mode: UsageSurfaceMode) => {
    writeUsageSurfaceMode(mode);
    setState((current) => ({ ...current, mode }));
  }, []);
  // A host without the request log (an older remote host) shows token usage
  // instead; the stored choice stays for a host that has it.
  return [state.mode === 'requests' && !requestsSupported ? 'tokens' : state.mode, choose];
}

/** Whether the host serves the request log: a paired web app asks its host's
 *  handshake; this desktop's own host always does. */
export function usageRequestsSupported(api: object | undefined): boolean {
  return (api as { readonly remoteUsageRequests?: boolean } | undefined)?.remoteUsageRequests !== false;
}

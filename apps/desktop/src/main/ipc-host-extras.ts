// Main-process extras of the window host the core does not carry: the human-only confirmation that turns on "Allow all
// actions", the sign-in raise of a window, and the PC-side provider quota of a server window (its model calls run on
// this PC's sign-ins, so the quota is this PC's, narrowed to the providers the server may use).
import { DESKTOP_IPC } from '../shared/contract';
import type { IpcHandle } from './ipc';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation';
import type { PcQuotaHost } from './ipc-window-settings';
import type { SignInFocus } from './sign-in-focus';

/** The channels this file registers. */
export const HOST_EXTRAS_IPC = {
  enableAllowAllActions: DESKTOP_IPC.enableAllowAllActions,
  observeSignIn: DESKTOP_IPC.observeSignIn,
  pcQuotaInvoke: DESKTOP_IPC.pcQuotaInvoke,
  pcQuotaRead: DESKTOP_IPC.pcQuotaRead,
} as const;

export interface HostExtrasOptions {
  handle: IpcHandle;
  removeHandler(channel: string): void;
  host: {
    invokeCapability(capability: string, args: unknown[], sessionId?: string): Promise<{ value?: unknown }>;
  };
  /** This PC's daemon as the owner of a server window's provider quota; absent on a window of this PC. */
  pcHost?: PcQuotaHost;
  /** The person's human-only confirmation (developer-risk-confirm.ts). */
  confirmAllowAllActions: () => Promise<boolean>;
  /** The window's sign-in raise; null where the host is not this PC's daemon. */
  signInFocus: SignInFocus | null;
}

const PC_QUOTA_CAPABILITIES: ReadonlySet<string> = new Set([
  'getUsageDashboard',
  'getQuotaHistory',
  'consumeCodexRateLimitResetCredit',
]);
const CODEX_RESET_PROVIDER = 'openai-oauth';

function firstArg(args: unknown[] | undefined): Record<string, unknown> {
  const value = args?.[0];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Whether this quota read belongs to the PC's sign-ins: the call is
 *  session-less and, when it names a provider, that provider is proxied. */
function readsPcQuota(
  pc: PcQuotaHost | undefined,
  request: { capability: string; args?: unknown[]; sessionId?: string }
): boolean {
  if (!pc || pc.inUse?.() === false || request.sessionId || !PC_QUOTA_CAPABILITIES.has(request.capability)) {
    return false;
  }
  let named: unknown;
  if (request.capability === 'consumeCodexRateLimitResetCredit') named = CODEX_RESET_PROVIDER;
  else if (request.capability === 'getQuotaHistory') named = firstArg(request.args).provider;
  return typeof named !== 'string' || !named || pc.isProviderAllowed?.(named) !== false;
}

type QuotaResult = { ok?: boolean; value?: unknown };
type QuotaRecord = Record<string, unknown>;

const quotaRecord = (value: unknown): QuotaRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as QuotaRecord) : null;

/** The one provider filter every PC quota answer passes through: keeps the
 *  entries whose provider the server's turns can use. */
function keepAllowed(pc: PcQuotaHost, items: unknown, providerOf: (item: unknown) => unknown): unknown[] {
  const list = Array.isArray(items) ? items : [];
  if (!pc.isProviderAllowed) return list;
  return list.filter((item) => {
    const provider = providerOf(item);
    return typeof provider === 'string' && pc.isProviderAllowed!(provider);
  });
}

const dashboardRowProvider = (row: unknown) => quotaRecord(row)?.id;
const subscriptionProvider = (row: unknown) => quotaRecord(row)?.provider;

function filterDashboard(pc: PcQuotaHost, dashboard: unknown): unknown {
  const record = quotaRecord(dashboard);
  if (!record || !Array.isArray(record.rows)) return dashboard;
  return { ...record, rows: keepAllowed(pc, record.rows, dashboardRowProvider) };
}

/** A history answer with nothing the server may see. */
function emptyHistory(value: unknown): QuotaRecord {
  return {
    generatedAt: quotaRecord(value)?.generatedAt,
    subscriptions: [],
    selection: null,
    period: null,
    windows: [],
    page: 0,
    pageCount: 0,
    total: 0,
  };
}

const selectionProvider = (value: unknown) => quotaRecord(quotaRecord(value)?.selection)?.provider;

/** History of allowed providers only: the subscription list is filtered, and a
 *  selection on a provider the server may not use (omitted, or fallen back
 *  to) is replaced by the most recently used allowed subscription. */
async function constrainHistory(
  pc: PcQuotaHost,
  args: unknown[] | undefined,
  fetch: (args: unknown[]) => Promise<QuotaResult>,
  first: QuotaResult
): Promise<QuotaResult> {
  if (!pc.isProviderAllowed) return first;
  const filtered = (value: unknown): unknown => {
    const record = quotaRecord(value);
    return record && Array.isArray(record.subscriptions)
      ? { ...record, subscriptions: keepAllowed(pc, record.subscriptions, subscriptionProvider) }
      : value;
  };
  const selected = selectionProvider(first.value);
  if (selected === undefined || (typeof selected === 'string' && pc.isProviderAllowed(selected))) {
    // No selection means no recorded history at all.
    return { ...first, value: filtered(first.value) };
  }
  const subscriptions = quotaRecord(first.value)?.subscriptions;
  const candidates = keepAllowed(
    pc,
    Array.isArray(subscriptions) ? subscriptions : quotaRecord((await fetch([{}])).value)?.subscriptions,
    subscriptionProvider
  );
  const provider = subscriptionProvider(candidates[0]);
  if (typeof provider !== 'string') return { ...first, value: emptyHistory(first.value) };
  const question = quotaRecord(args?.[0]) ?? {};
  const second = await fetch([{ ...question, provider, account: '' }]);
  if (second.ok === false) return second;
  const reselected = selectionProvider(second.value);
  if (typeof reselected !== 'string' || !pc.isProviderAllowed(reselected)) {
    return { ...second, value: emptyHistory(second.value) };
  }
  return { ...second, value: filtered(second.value) };
}

/** Runs a PC quota read so that only providers the server may use come back:
 *  dashboard rows, history (selection + subscription metadata) and the nested
 *  dashboard of a Codex reset all pass the same provider filter. */
async function constrainedQuota<T extends QuotaResult>(
  pc: PcQuotaHost,
  capability: string,
  args: unknown[] | undefined,
  fetch: (args: unknown[]) => Promise<T>
): Promise<T> {
  const first = await fetch(args ?? []);
  if (first?.ok === false) return first;
  if (capability === 'getUsageDashboard') return { ...first, value: filterDashboard(pc, first.value) };
  if (capability === 'getQuotaHistory') return (await constrainHistory(pc, args, fetch, first)) as T;
  const reset = quotaRecord(first.value);
  if (reset && 'dashboard' in reset) {
    return { ...first, value: { ...reset, dashboard: filterDashboard(pc, reset.dashboard) } };
  }
  return first;
}

export function registerHostExtrasIpc({
  handle,
  removeHandler,
  host,
  pcHost,
  confirmAllowAllActions,
  signInFocus,
}: HostExtrasOptions): () => void {
  // Turning on "Allow all actions" is the person's, answered here under the human-only lock; a click an agent made in
  // the window cannot also confirm it. The write goes out on main's own connection (Local, not a Window, so the core's
  // Window refusal does not apply). Not confirmed: nothing changes.
  handle(HOST_EXTRAS_IPC.enableAllowAllActions, async () => {
    if ((await confirmAllowAllActions()) === true) {
      await host.invokeCapability('setDeveloperOption', ['allowAllActions', true]);
    }
    return host.invokeCapability('getDeveloperSettings', []);
  });
  handle(HOST_EXTRAS_IPC.observeSignIn, (_event, input, value) => {
    const request = requiredDesktopCapabilityRequest(input);
    signInFocus?.observe(request.capability, request.args ?? [], value);
  });
  // The answers are null for a call that is not the PC's quota (the caller sends it to the window's own host).
  handle(HOST_EXTRAS_IPC.pcQuotaInvoke, async (_event, input) => {
    const request = requiredDesktopCapabilityRequest(input);
    if (!pcHost || !readsPcQuota(pcHost, request)) return null;
    return constrainedQuota(pcHost, request.capability, request.args, (args) =>
      pcHost.invokeCapability(request.capability, args, request.sessionId)
    );
  });
  handle(HOST_EXTRAS_IPC.pcQuotaRead, (_event, input) => {
    const requests = requiredDesktopCapabilityReadRequests(input);
    return Promise.all(
      requests.map((request) => {
        if (!pcHost || !readsPcQuota(pcHost, request)) return null;
        return constrainedQuota(pcHost, request.capability, request.args, async (args) => {
          const [result] = await pcHost.readCapabilities([{ ...request, args }]);
          return result;
        });
      })
    );
  });
  return () => {
    for (const channel of Object.values(HOST_EXTRAS_IPC)) removeHandler(channel);
  };
}

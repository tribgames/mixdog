// Desktop settings, zoom, the native title bar, capability calls, and quit.
import type { App, BrowserWindow } from 'electron';
import { DESKTOP_IPC, type DesktopSettings } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { isAllowAllActionsEnable } from './developer-risk-confirm';
import { raiseDesktopWindow } from './notification-window';
import { readOnboardingStatusFromDisk } from './onboarding-status-file';
import { createSignInFocus } from './sign-in-focus';
import { listSystemFonts } from './system-fonts';
import type { DesktopSettingsStore } from './settings-store';
import { setDesktopTitleBarDim, setDesktopTitleBarTheme, setDesktopTitleBarZoom } from './window-options';
import {
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredNotificationVolume,
  requiredString,
  requiredZoomFactor,
} from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';

interface WindowSettingsIpcOptions {
  window: BrowserWindow;
  app: Pick<App, 'quit'>;
  host: Pick<DesktopService, 'invokeCapability' | 'readCapabilities' | 'getSnapshot'>;
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  settingsStore?: Pick<
    DesktopSettingsStore,
    'read' | 'update' | 'updateNotificationVolume' | 'readZoom' | 'updateZoom'
  >;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
  /** Settings → Notifications: play the notification sound at the saved volume. */
  previewNotificationSound?: () => Promise<string>;
  /** Onboarding status may come straight from this PC's status file: only
   *  when `host` is this PC's daemon. Defaults to true. */
  readsLocalOnboardingStatus?: boolean;
  /** Raise the window after a connector sign-in it started in this PC's
   *  browser: only when `host` is this PC's daemon. Defaults to false. */
  raiseOnSignIn?: boolean;
  /** A server window's model calls run on THIS PC's sign-ins (model proxy), so
   *  the provider quota reads belong to this PC's daemon, not the server's
   *  (which holds no credentials and would report nothing). */
  pcHost?: PcQuotaHost;
  /** The person's human-only confirmation to turn on "Allow all actions"
   *  (developer-risk-confirm.ts). Without it that call is refused. */
  confirmAllowAllActions?: () => Promise<boolean>;
}

/** This PC's daemon as the owner of a server window's provider quota. */
export interface PcQuotaHost extends Pick<DesktopService, 'invokeCapability' | 'readCapabilities'> {
  /** The model proxy's own consent (the server's per-host provider list): a
   *  provider the server may not use runs no call on this PC's sign-in for it. */
  isProviderAllowed?(provider: string): boolean;
  /** False while the server runs models with its own logins: its quota reads
   *  are the server's then. True when absent. */
  inUse?(): boolean;
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

export function registerWindowSettingsIpc({
  window,
  app,
  host,
  handle,
  invokeDesktopOperation,
  settingsStore,
  onDesktopSettingsChanged,
  previewNotificationSound,
  readsLocalOnboardingStatus = true,
  raiseOnSignIn = false,
  pcHost,
  confirmAllowAllActions,
}: WindowSettingsIpcOptions): void {
  const applyZoom = (factor: number) => {
    window.webContents.setZoomFactor(factor);
    setDesktopTitleBarZoom(window, factor);
  };

  handle(DESKTOP_IPC.readSettings, () => settingsStore?.read() ?? invokeDesktopOperation('readSettings', []));
  handle(DESKTOP_IPC.readActivityRailPins, () => invokeDesktopOperation('readActivityRailPins', []));
  handle(DESKTOP_IPC.updateActivityRailPins, (_event, pins, initializeIfMissing) =>
    invokeDesktopOperation('updateActivityRailPins', [pins, initializeIfMissing])
  );
  handle(DESKTOP_IPC.notifyProviderModelsChanged, (_event, origin) =>
    invokeDesktopOperation('notifyProviderModelsChanged', [requiredString(origin, 'origin', 128)])
  );
  handle(DESKTOP_IPC.updateSetting, (_event, key, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    const settingKey = requiredDesktopSettingKey(key);
    const update = settingsStore
      ? settingsStore.update(settingKey, enabled)
      : invokeDesktopOperation<DesktopSettings>('updateSetting', [settingKey, enabled]);
    return update.then((saved) => {
      onDesktopSettingsChanged?.(saved);
      // Paired browsers and any other local renderer re-read what was written.
      void invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
      return saved;
    });
  });
  handle(DESKTOP_IPC.setNotificationVolume, async (_event, value) => {
    const volume = requiredNotificationVolume(value);
    const saved = settingsStore
      ? await settingsStore.updateNotificationVolume(volume)
      : await invokeDesktopOperation<DesktopSettings>('updateNotificationVolume', [volume]);
    onDesktopSettingsChanged?.(saved);
    void invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
    return saved;
  });
  handle(DESKTOP_IPC.previewNotificationSound, () => previewNotificationSound?.() ?? 'unsupported');
  handle(DESKTOP_IPC.getZoomFactor, async () => {
    const factor = settingsStore
      ? await settingsStore.readZoom()
      : await invokeDesktopOperation<number>('readZoom', []);
    applyZoom(factor);
    return factor;
  });
  handle(DESKTOP_IPC.setZoomFactor, async (_event, value) => {
    const requested = requiredZoomFactor(value);
    const factor = settingsStore
      ? await settingsStore.updateZoom(requested)
      : await invokeDesktopOperation<number>('updateZoom', [requested]);
    applyZoom(factor);
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, factor);
    return factor;
  });
  // Renderer-resolved DESKTOP theme (system preference / stored preference)
  // is the only owner of the native band, caption symbols, and the DWM frame
  // theme. The engine/TUI theme is a separate user setting — the old
  // getTheme/setTheme capability hook let it overwrite this band with a
  // mismatched palette, so capabilities stay theme-neutral now.
  let appliedTheme: string | undefined;
  handle(DESKTOP_IPC.applyTitleBarTheme, async (_event, theme, systemPreference) => {
    const resolved = requiredString(theme, 'theme');
    setDesktopTitleBarTheme(window, resolved, systemPreference === true);
    // The first apply is the window booting; a later change is the user's choice,
    // which paired browsers without their own theme follow.
    const applied = `${resolved}|${systemPreference === true}`;
    const changed = appliedTheme !== undefined && appliedTheme !== applied;
    appliedTheme = applied;
    if (changed) void invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
  });
  // Fullscreen-modal dim for the native WCO caption band: the renderer sends
  // pre-composited hex colors; anything malformed clears back to the theme.
  handle(DESKTOP_IPC.setTitleBarDim, async (_event, dim) => {
    const record = (dim && typeof dim === 'object' ? dim : {}) as Record<string, unknown>;
    const hex = /^#[0-9a-f]{6}$/i;
    const valid =
      typeof record.color === 'string' &&
      hex.test(record.color) &&
      typeof record.symbolColor === 'string' &&
      hex.test(record.symbolColor);
    setDesktopTitleBarDim(
      window,
      valid ? { color: record.color as string, symbolColor: record.symbolColor as string } : null
    );
  });
  // Settings → Appearance: font families installed on this computer.
  handle(DESKTOP_IPC.listSystemFonts, () => listSystemFonts());
  // A connector sign-in this window started on this PC's browser brings the
  // window back once the browser callback arrived (sign-in-focus.ts).
  const signInFocus = raiseOnSignIn ? createSignInFocus({ activate: () => raiseDesktopWindow(window) }) : null;
  handle(DESKTOP_IPC.invokeCapability, async (_event, input) => {
    const request = requiredDesktopCapabilityRequest(input);
    if (readsLocalOnboardingStatus && request.capability === 'getOnboardingStatus' && !request.sessionId) {
      const status = await readOnboardingStatusFromDisk();
      if (status) return { value: status, snapshot: host.getSnapshot() };
    }
    const onPc = readsPcQuota(pcHost, request);
    if (onPc) {
      return constrainedQuota(pcHost!, request.capability, request.args, (args) =>
        pcHost!.invokeCapability(request.capability, args, request.sessionId)
      );
    }
    // Turning on "Allow all actions" is the person's, answered in the main
    // process under the human-only lock; a click an agent made in this window
    // (Computer Use) cannot also confirm it. Not confirmed: nothing changes.
    if (isAllowAllActionsEnable(request.capability, request.args) && (await confirmAllowAllActions?.()) !== true) {
      return host.invokeCapability('getDeveloperSettings', [], request.sessionId);
    }
    const result = await host.invokeCapability(request.capability, request.args, request.sessionId);
    signInFocus?.observe(request.capability, request.args ?? [], result?.value);
    // The shared Lead face changed: paired phones re-read it from the settings-changed event.
    if (request.capability === 'setLeadAppearance' || request.capability === 'setBotOrder') {
      void invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
    }
    return result;
  });
  handle(DESKTOP_IPC.readCapabilities, async (_event, input) => {
    const requests = requiredDesktopCapabilityReadRequests(input);
    const onPc = (request: (typeof requests)[number]) => readsPcQuota(pcHost, request);
    if (!requests.some(onPc)) return host.readCapabilities(requests);
    // Positional results: the PC answers its quota reads (each constrained to
    // the providers the server may use), the server the rest.
    const [pcResults, hostResults] = await Promise.all([
      Promise.all(
        requests.filter(onPc).map((request) =>
          constrainedQuota(pcHost!, request.capability, request.args, async (args) => {
            const [result] = await pcHost!.readCapabilities([{ ...request, args }]);
            return result;
          })
        )
      ),
      host.readCapabilities(requests.filter((request) => !onPc(request))),
    ]);
    const pcQueue = [...pcResults];
    const hostQueue = [...hostResults];
    return requests.map((request) => (onPc(request) ? pcQueue.shift() : hostQueue.shift()));
  });
  // before-quit owns the confirmation and the host teardown: disposing the
  // host here first would leave a cancelled quit with a dead service.
  handle(DESKTOP_IPC.quit, () => {
    app.quit();
  });
}

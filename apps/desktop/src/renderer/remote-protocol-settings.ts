// PH-2 "Settings, update, notifications and feedback" group of the phone over `mixdogd`: the settings toggles, this PC's updater
// and display preferences, Settings › Notifications and the feedback dialog. The phone still calls by Node's relay method names
// (remote-shim-api.ts); each answers as Node's host did (remote-methods.ts at b6f10295a: `settingsRemoteMethods` :1086,
// `notificationRemoteMethods` :1109, `hostWindowRemoteMethods` :1053, `submitFeedback` and `notifyProviderModelsChanged` :912-917):
// Node's argument checks first, with Node's texts, then the core request, then the value the relay frame carried.
//
// What the core publishes as state the page asked Node for is read from the sections this connection holds: the `config` subtrees
// (`desktop`, `agent`, `notifications`), the `remote` section (paired devices), `hostState.displayPreferences` and `update` (the PC
// window's updater state). The events Node's relay pushed are the core's announcements and the `update` section (install below).
// `libreOfficeStatus` and `installLibreOffice` are answered by the source-control group (remote-protocol-scm.ts).
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { normalizeDesktopFeedback } from '../shared/contract-feedback';
import { desktopSettingPath, desktopSettingsFromConfig } from '../shared/desktop-settings';
import { readHostDisplayPreferences } from '../shared/host-display-preferences';
import {
  activeOverrides,
  notificationPreferencesStateOf,
  notificationWriteMode,
  storedOverrides,
} from '../shared/notification-state';
import { announcedEvent } from '../shared/core-announcements';
import type { ProviderModelsChange } from '../shared/provider-models';
import { requiredString } from '../shared/remote-arguments';
import { SETTINGS_CHANGED_EVENT, type SettingsChange } from '../shared/settings-changed';
import {
  requiredConversationNotificationSetting,
  requiredDesktopSettingKey,
  requiredNotificationDeviceId,
  requiredNotificationPreferencesPatch,
  requiredNotificationTarget,
} from '../shared/settings-input';
import { phoneCallError } from './remote-protocol-scm';
import type { NodeCall, PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

/** What Node's host answered when the PC's window process did not answer its request (desktop-service.ts:279-284, the 20 s bound
 *  of every window request): the core says it at once, as `capabilityUnavailable{desktopHost}`, or by holding no window state. */
const NO_WINDOW = 'The desktop app did not answer the remote request.';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The held value of `(section, key)`, or undefined while the core holds none. */
const held = (client: Client, section: string, key: string | null = null): unknown =>
  client.store.section(section as never, key)?.value;

const isWindowGone = (error: unknown): boolean => {
  const failure = (error as { detail?: { kind?: unknown; data?: { reason?: unknown; capability?: unknown } } } | null)?.detail;
  return failure?.kind === 'rpc' && failure.data?.reason === 'capabilityUnavailable' && failure.data.capability === 'desktopHost';
};

/** One core request; a failure is the error Node's relay frame carried. */
async function request(host: PhoneProtocolHost, method: string, params: unknown): Promise<unknown> {
  try {
    return await (host.client().call as (m: string, p: unknown) => Promise<unknown>)(method, params);
  } catch (error) {
    throw isWindowGone(error) ? new Error(NO_WINDOW) : phoneCallError(error);
  }
}

/** The paired devices: Node asked the relay on every call (notification-center.ts listClients); `remoteAccess/state` asks it
 *  while the leg has not answered a listing yet and then answers the roster the core keeps, which the held `remote` section
 *  only shows once some window asked. */
const pairedDevices = (host: PhoneProtocolHost): Promise<unknown> => request(host, 'remoteAccess/state', {});

/** The notification settings as Node's `notificationPreferencesState(currentDeviceId, null)` answered them: whether this PC shows
 *  notifications (Node asked its window, desktop-service.ts:866) and the stored document after every listed device's default was
 *  written, from the core (`notify/state`); the devices from `pairedDevices`. The current device is this connection's paired
 *  credential. */
async function notificationState(host: PhoneProtocolHost) {
  const remote = await pairedDevices(host);
  const state = record(await request(host, 'notify/state', {}));
  return notificationPreferencesStateOf({
    remote,
    notifications: state.notifications ?? undefined,
    currentDeviceId: host.ctx.browserId ?? '',
    pcCanNotify: state.supported === true,
    // The PC's name is the remote section's (the core fills in the machine's when none was set).
    hostName: () => '',
  });
}

/** A Node call (the router hands it the arguments as Node's relay JSON carried them), the answer `undefined` as null. */
const call =
  (run: (args: unknown[], host: PhoneProtocolHost) => unknown): NodeCall =>
  async (params, host) => {
    const value = await run(params, host);
    return value === undefined ? null : value;
  };

const calls: Record<string, NodeCall> = {
  // ── settings (settingsRemoteMethods, remote-methods.ts:1086-1107) ──
  readSettings: call((_args, host) =>
    desktopSettingsFromConfig({ agent: held(host.client(), 'config', 'agent'), desktop: held(host.client(), 'config', 'desktop') })
  ),
  // Node answered the desktop settings of the config its locked update saved; the core's write answers that config. Node then
  // announced `desktop` to every client whether or not anything changed (remote-methods.ts:1098): the write's `announce`.
  updateSetting: call(async ([key, enabled], host) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    const path = desktopSettingPath(requiredDesktopSettingKey(key));
    const saved = await request(host, 'config/value/write', { path, value: enabled, announce: 'desktop' });
    return desktopSettingsFromConfig(record(saved).config);
  }),

  // ── this PC's window (hostWindowRemoteMethods, :1053-1084) ──
  readHostDisplayPreferences: call((_args, host) => {
    const entry = host.client().store.section('hostState' as never, 'displayPreferences');
    if (!entry) throw new Error(NO_WINDOW);
    return readHostDisplayPreferences(entry.value);
  }),
  getUpdaterState: call((_args, host) => {
    const entry = host.client().store.section('update' as never, null);
    if (!entry) throw new Error(NO_WINDOW);
    return entry.value;
  }),
  checkForDesktopUpdate: call((_args, host) => request(host, 'update/desktop/command', { action: 'check' })),
  showDesktopUpdate: call(([confirmed], host) =>
    request(host, 'update/desktop/command', { action: 'install', confirmed: confirmed === true })
  ),

  // ── workspace calls (:912-917) ──
  // The PC posted the feedback after the same check (feedback-client.ts `normalizeDesktopFeedback`).
  submitFeedback: call(([input], host) => {
    normalizeDesktopFeedback(input);
    return request(host, 'feedback/upload', { input });
  }),
  // Node checked the origin and told the windows and every paired device, this one included, to drop their provider model lists
  // (desktop-operations.ts:455-458, remote-relay-push-lanes.ts:53), then answered null; the core tells every client
  // (`ui/providerModels/changed`, install below). The page ignores the echo of its own origin (sidebar-reference-cache.ts).
  notifyProviderModelsChanged: call(async ([origin], host) => {
    await request(host, 'ui/providerModels/announce', { origin: requiredString(origin, 'origin', 128) });
    return null;
  }),

  // ── Settings › Notifications (notificationRemoteMethods, :1109-1131) ──
  getNotificationPreferences: call((_args, host) => notificationState(host)),
  // Node: the device must be paired, then the patch merged in one write, then the state as above (notification-center.ts:106-117).
  setNotificationPreferences: call(async ([deviceId, patch], host) => {
    const id = requiredNotificationDeviceId(deviceId);
    const value = requiredNotificationPreferencesPatch(patch);
    const mode = notificationWriteMode(id, await pairedDevices(host), held(host.client(), 'config', 'notifications'));
    await request(host, 'config/value/write', { path: `notifications.devices.${id}`, value, mode });
    return notificationState(host);
  }),
  sendTestNotification: call(([deviceId], host) =>
    request(host, 'notify/test', { target: requiredNotificationDeviceId(deviceId) })
  ),
  listConversationNotifications: call((_args, host) =>
    activeOverrides(storedOverrides(held(host.client(), 'config', 'notifications')), Date.now())
  ),
  // Node answered the overrides in force after the write: the stored list the write answers.
  setConversationNotification: call(async ([target, setting], host) => {
    const value = { target: requiredNotificationTarget(target), setting: requiredConversationNotificationSetting(setting) };
    const saved = record(await request(host, 'config/value/write', { path: 'notifications.overrides', value, mode: 'setConversation' }));
    return Array.isArray(saved.values) ? saved.values[0] : null;
  }),
};

/** Node's relay pushed `settings-changed`, `provider-models-changed` and the window's `updater-state` to every paired device
 *  (remote-relay-push-lanes.ts:50-60, :113-117). The first two are the core's announcements (`ui/settings/changed`,
 *  `ui/providerModels/changed`, shared/core-announcements.ts); the updater state is the `update` section the core publishes,
 *  each change of it that event. Wired per client: a re-pairing dials a new one. */
function install(host: PhoneProtocolHost): (() => void) | undefined {
  const { ctx } = host;
  let unwire: (() => void) | undefined;
  const wire = (client: Client): void => {
    unwire?.();
    const offStore = client.store.subscribe((change) => {
      if (change.type !== 'section' || change.section !== 'update') return;
      const state = client.store.section('update' as never, null)?.value as { status?: unknown } | undefined;
      if (state && typeof state === 'object' && typeof state.status === 'string') ctx.fanOut(ctx.updaterListeners, state as never);
    });
    const offEvents = client.on((event) => {
      if (event.type !== 'notification') return;
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      const announced = announcedEvent(method, params);
      if (!announced) return;
      if (announced.name === SETTINGS_CHANGED_EVENT) ctx.fanOut(ctx.settingsChangedListeners, announced.value as SettingsChange);
      else ctx.fanOut(ctx.providerModelsListeners, announced.value as ProviderModelsChange);
    });
    unwire = () => {
      offStore();
      offEvents();
    };
  };
  const off = host.onClient?.(wire);
  if (!off) void ctx.phone.start().then(() => wire(host.client()), () => undefined);
  return () => {
    off?.();
    unwire?.();
  };
}

export const adapter: PhoneProtocolAdapter = { group: 'settings', calls, install };

// Settings › Notifications: pick a device (this PC or a paired one), then set
// what that device is notified about. Every change is written at once with
// setNotificationPreferences(deviceId, patch); the PC decides, so the same
// page works from this PC's window and from a paired device.
import { Globe, Monitor, Smartphone } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import {
  type DesktopApi,
  NOTIFICATION_PC_DEVICE_ID,
  NOTIFICATION_VOLUME_MAX,
  type NotificationDevicePreferences,
  type NotificationDeviceSummary,
  type NotificationEvent,
  type NotificationPreferencesPatch,
  type NotificationQuietDays,
  type NotificationScope,
} from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { isSshConnectionWindow } from '../desktop-connection';
import { OpenSelect } from '../OpenSelect';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { ActionButton, Group, SelectRow, ToggleRow } from './capability-controls';
import { getCachedDesktopStatus, readDesktopStatus, storeDesktopStatus } from './desktop-status-cache';
import { quietTimeLabel, scopeLabel, useNotificationPreferences } from './notification-state';
import { DevicePushRegistration } from './push-notification-toggle';
import type { SettingsCategory } from './settings-items';

type NotificationsApi = Partial<DesktopApi>;

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{title}</span>
        {description && <span className="mixdog-settings__row-desc">{description}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SelectControl({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <OpenSelect className="settings-select" ariaLabel={title} value={value} options={normalized} onChange={onChange} />
  );
}

/** A slider drag saves once it rests: the 300 ms settle the Settings page already uses
 *  for a typed field (custom-provider-key-fields.tsx ENV_CHECK_DEBOUNCE_MS). */
const VOLUME_SAVE_DEBOUNCE_MS = 300;

const TIME_OPTIONS = Array.from(
  { length: 48 },
  (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`
);

function deviceMeta(device: NotificationDeviceSummary): string {
  if (device.kind === 'pc') return t('This computer');
  const kind = device.kind === 'phone-app' ? t('Phone app') : t('Web browser');
  return `${kind} · ${device.online ? t('Online') : t('Offline')}`;
}

function DeviceIcon({ kind }: { kind: NotificationDeviceSummary['kind'] }) {
  if (kind === 'pc') return <Monitor size={16} aria-hidden="true" />;
  if (kind === 'phone-app') return <Smartphone size={16} aria-hidden="true" />;
  return <Globe size={16} aria-hidden="true" />;
}

function DevicePicker({
  devices,
  selected,
  currentDeviceId,
  onSelect,
  onOpenConnection,
}: {
  devices: NotificationDeviceSummary[];
  selected: NotificationDeviceSummary;
  /** The device this window runs on stays selectable: its group holds the permission control. */
  currentDeviceId: string;
  onSelect(id: string): void;
  onOpenConnection?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const option = (device: NotificationDeviceSummary) => {
    const muted = !device.canNotify && device.id !== currentDeviceId;
    return (
      <div
        key={device.id}
        role="option"
        tabIndex={muted ? undefined : 0}
        aria-selected={device.id === selected.id}
        aria-disabled={muted ? 'true' : undefined}
        className="notif-device-option"
        data-device={device.id}
        onClick={() => {
          if (muted) return;
          onSelect(device.id);
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (!muted && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onSelect(device.id);
            setOpen(false);
          }
        }}
      >
        <DeviceIcon kind={device.kind} />
        <span>{device.name}</span>
        <small>{muted ? t('Notifications off — allow them on that device') : deviceMeta(device)}</small>
      </div>
    );
  };
  const pc = devices.filter((device) => device.kind === 'pc');
  const paired = devices.filter((device) => device.kind !== 'pc');
  return (
    <div className="notif-device-pick">
      <span className="notif-device-label">{t('Device to set up')}</span>
      <div className="notif-device-root" ref={root}>
        <button
          type="button"
          className="notif-device-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('Choose the device to set up')}
          onClick={() => setOpen((value) => !value)}
        >
          <DeviceIcon kind={selected.kind} />
          <b>{selected.name}</b>
          <span>{deviceMeta(selected)}</span>
        </button>
        {open && (
          <div className="notif-device-list" role="listbox" aria-label={t('Device to set up')}>
            {pc.map(option)}
            {paired.length > 0 && <div className="notif-device-head">{t('Connected devices')}</div>}
            {paired.map(option)}
            <div className="notif-device-foot">
              {t('To add, rename, or disconnect devices, go to')}{' '}
              <button type="button" className="conn-link" onClick={onOpenConnection}>
                {t('Settings › Connection')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** This PC's notification sound volume (Windows only, as before) and its test sound. */
function SoundVolumeRow({ api }: { api: NotificationsApi }) {
  const cached = getCachedDesktopStatus(api, 'settings');
  const [volume, setVolume] = useState<number | null>(() => (cached ? cached.notificationVolume : null));
  // The last volume the PC confirmed: what a failed save falls back to.
  const confirmed = useRef<number | null>(cached ? cached.notificationVolume : null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every slider move: a failed save only rolls back when no newer edit exists.
  const editGeneration = useRef(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      void readDesktopStatus(api, 'settings')
        ?.then((settings) => {
          if (!live) return;
          confirmed.current = settings.notificationVolume;
          if (!saveTimer.current) setVolume(settings.notificationVolume);
        })
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );
  const saveVolume = (next: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const generation = editGeneration.current;
    return Promise.resolve(api.setNotificationVolume?.(next))
      .then((saved) => {
        if (!saved) return;
        confirmed.current = saved.notificationVolume;
        storeDesktopStatus(api, 'settings', saved);
      })
      .catch((error) => {
        if (generation === editGeneration.current) setVolume(confirmed.current);
        throw error;
      });
  };
  if (volume === null) return null;
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{t('Notification volume')}</span>
      </div>
      <div className="settings-row-control notification-volume-control">
        <input
          type="range"
          min={0}
          max={NOTIFICATION_VOLUME_MAX}
          step={10}
          value={volume}
          aria-label={t('Notification volume')}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            setVolume(next);
            editGeneration.current += 1;
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => void saveVolume(next)?.catch(() => {}), VOLUME_SAVE_DEBOUNCE_MS);
          }}
        />
        <output>{`${volume}%`}</output>
        <ActionButton
          onClick={() =>
            void Promise.resolve(saveVolume(volume))
              .then(() => api.previewNotificationSound?.())
              .catch(() => {})
          }
        >
          {t('Play test sound')}
        </ActionButton>
      </div>
    </div>
  );
}

function TestNotificationRow({ api, deviceId }: { api: NotificationsApi; deviceId: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another device starts without the previous result.
  useEffect(() => setMessage(''), [deviceId]);
  const send = () => {
    setBusy(true);
    setMessage('');
    void Promise.resolve(api.sendTestNotification?.(deviceId))
      .then((result) =>
        setMessage(
          result?.message || (result?.ok ? t('Test notification sent.') : t('Could not send the test notification.'))
        )
      )
      .catch(() => setMessage(t('Could not send the test notification.')))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Row
        title={t('Send test notification')}
        description={t('Sends one to this device now, using the current settings.')}
      >
        <ActionButton disabled={busy || !api.sendTestNotification} onClick={send}>
          {t('Send')}
        </ActionButton>
      </Row>
      {message && (
        <p className="settings-connection-note" role="status">
          {message}
        </p>
      )}
    </>
  );
}

const EVENT_ROWS: ReadonlyArray<{ event: NotificationEvent; title: () => string; description?: () => string }> = [
  { event: 'finished', title: () => t('When a reply finishes') },
  {
    event: 'question',
    title: () => t('When a question arrives'),
    description: () => t('The agent stopped to wait for your answer.'),
  },
  { event: 'approval', title: () => t('When an approval is requested') },
  { event: 'error', title: () => t('When a turn stops on an error') },
];

function DeviceSettings({
  api,
  device,
  prefs,
  current,
  save,
}: {
  api: NotificationsApi;
  device: NotificationDeviceSummary;
  prefs: NotificationDevicePreferences;
  current: boolean;
  save(patch: NotificationPreferencesPatch): void;
}) {
  const quiet = prefs.quietHours;
  const isPc = device.kind === 'pc';
  const soundSupported =
    isPc &&
    !isRemoteHostRenderer() &&
    Boolean(api.setNotificationVolume) &&
    navigator.userAgent.includes('Windows') &&
    !isSshConnectionWindow();
  const timeOptions = TIME_OPTIONS.map((value) => ({ value, label: quietTimeLabel(value) }));
  return (
    <>
      <Group
        title={t('Conversations to notify')}
        description={t(
          'Bot chats are 1:1 chats with a bot and rooms. Task sessions are coding sessions and tasks that bots created.'
        )}
      >
        <SelectRow
          title={t('Notification scope')}
          value={prefs.scope}
          options={(['all', 'bots', 'off'] as const).map((value) => ({ value, label: scopeLabel(value) }))}
          onChange={(scope) => save({ scope: scope as NotificationScope })}
        />
      </Group>
      <Group title={t('What to notify')} description={t('You are notified of these in the conversations above.')}>
        {EVENT_ROWS.map(({ event, title, description }) => (
          <ToggleRow
            key={event}
            title={title()}
            description={description?.()}
            showDescription
            checked={prefs.events[event]}
            onChange={(value) => save({ events: { [event]: value } })}
          />
        ))}
        <ToggleRow
          title={t('Schedule and webhook results')}
          description={t('Questions and approvals from these runs still notify.')}
          showDescription
          checked={prefs.automaticRuns}
          onChange={(automaticRuns) => save({ automaticRuns })}
        />
      </Group>
      <Group
        title={t('Quiet hours')}
        description={t(
          'No notifications on this device in this window. Missed items stay as unread and “Approval needed” or “Answer needed” marks.'
        )}
      >
        <ToggleRow
          title={t('Use quiet hours')}
          checked={quiet.enabled}
          onChange={(enabled) => save({ quietHours: { enabled } })}
        />
        <Row title={t('Time')}>
          <span className="notif-times">
            <SelectControl
              title={t('Quiet hours start')}
              value={quiet.start}
              options={timeOptions}
              onChange={(start) => save({ quietHours: { start } })}
            />
            <span aria-hidden="true">–</span>
            <SelectControl
              title={t('Quiet hours end')}
              value={quiet.end}
              options={timeOptions}
              onChange={(end) => save({ quietHours: { end } })}
            />
          </span>
        </Row>
        <SelectRow
          title={t('Days')}
          value={quiet.days}
          options={[
            { value: 'every', label: t('Every day') },
            { value: 'weekdays', label: t('Weekdays') },
            { value: 'weekends', label: t('Weekends') },
          ]}
          onChange={(days) => save({ quietHours: { days: days as NotificationQuietDays } })}
        />
        <ToggleRow
          title={t('Still notify questions and approvals')}
          description={t('Only when the agent stopped to wait for your answer.')}
          showDescription
          checked={quiet.allowWaiting}
          onChange={(allowWaiting) => save({ quietHours: { allowWaiting } })}
        />
      </Group>
      {isPc ? (
        <Group title={t('On this PC')}>
          {soundSupported && <SoundVolumeRow api={api} />}
          <ToggleRow
            title={t('Taskbar flash')}
            checked={prefs.taskbarFlash}
            onChange={(taskbarFlash) => save({ taskbarFlash })}
          />
        </Group>
      ) : (
        <Group title={t('On this device')}>
          <ToggleRow
            title={t('Skip if seen on this PC')}
            description={t(
              'When this PC was used in the last 3 minutes, waits a minute and sends only if it is still unread or unanswered.'
            )}
            showDescription
            checked={prefs.holdWhileDesktopActive}
            onChange={(holdWhileDesktopActive) => save({ holdWhileDesktopActive })}
          />
          {current && <DevicePushRegistration api={api} />}
          <TestNotificationRow api={api} deviceId={device.id} />
        </Group>
      )}
    </>
  );
}

export function NotificationsPanel({
  api,
  openCategory,
}: {
  api: NotificationsApi;
  openCategory?: (category: SettingsCategory) => void;
}) {
  const { state, save, readError, writeError, retry } = useNotificationPreferences(api);
  const [picked, setPicked] = useState<string | null>(null);
  const notices = (
    <>
      {readError != null && <ErrorNotice error={readError} onRetry={retry} />}
      {writeError != null && <ErrorNotice error={writeError} />}
    </>
  );
  if (!state) return notices;
  const usable = (id: string | null) =>
    state.devices.find((device) => device.id === id && (device.canNotify || id === state.currentDeviceId));
  const selected = usable(picked) ?? usable(state.currentDeviceId) ?? state.devices.find((device) => device.canNotify);
  const prefs = selected && state.preferences[selected.id];
  if (!selected || !prefs) return notices;
  return (
    <>
      {notices}
      <DevicePicker
        devices={state.devices}
        selected={selected}
        currentDeviceId={state.currentDeviceId}
        onSelect={setPicked}
        onOpenConnection={() => openCategory?.('connection')}
      />
      <DeviceSettings
        api={api}
        device={selected}
        prefs={prefs}
        current={selected.id === state.currentDeviceId && selected.id !== NOTIFICATION_PC_DEVICE_ID}
        save={(patch) => save(selected.id, patch)}
      />
    </>
  );
}

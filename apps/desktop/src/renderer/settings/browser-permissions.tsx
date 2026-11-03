// Settings → Browser: what sites may do in the built-in browser. One default
// per permission kind, and the sites that have a setting of their own.
import { useEffect, useRef, useState } from 'react';

import {
  BROWSER_PERMISSION_KINDS,
  type BrowserPermissionKind,
  type BrowserPermissionPolicy,
  type BrowserPermissionSetting,
  type BrowserPermissionSiteRule,
  withBrowserPermissionDefault,
  withBrowserPermissionSite,
  withoutBrowserPermissionSite,
} from '../../shared/browser-permission-policy';
import type { DesktopApi } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { ActionButton, Group, SelectRow } from './capability-controls';
import { OpenSelect } from '../OpenSelect';

type PermissionsApi = Partial<Pick<DesktopApi, 'readSettings' | 'setBrowserPermissions'>>;

export function browserPermissionKindLabel(kind: BrowserPermissionKind): string {
  switch (kind) {
    case 'notifications':
      return t('Notifications');
    case 'geolocation':
      return t('Location');
    case 'clipboard-write':
      return t('Clipboard write');
    case 'clipboard-read':
      return t('Clipboard read');
    case 'media:video':
      return t('Camera');
    case 'media:audio':
      return t('Microphone');
    case 'midi':
      return t('MIDI devices');
    case 'midiSysex':
      return t('MIDI system exclusive');
    case 'idle-detection':
      return t('Idle detection');
    case 'top-level-storage-access':
      return t('Cross-site storage access');
    case 'window-management':
      return t('Window management');
    case 'speaker-selection':
      return t('Speaker selection');
    case 'fileSystem':
      return t('File editing');
  }
}

function settingOptions(): Array<{ value: BrowserPermissionSetting; label: string }> {
  return [
    { value: 'allow', label: t('Allowed') },
    { value: 'ask', label: t('Ask') },
    { value: 'block', label: t('Blocked') },
  ];
}

const withoutScheme = (origin: string) => origin.replace(/^https?:\/\//, '');

export function BrowserPermissionsGroup({ api, active }: { api: PermissionsApi; active: boolean }) {
  const [policy, setPolicy] = useState<BrowserPermissionPolicy | null>(null);
  const [error, setError] = useState('');
  const latestRead = useRef(0);

  useEffect(() => {
    if (!active || !api.readSettings) return;
    const read = ++latestRead.current;
    void Promise.resolve(api.readSettings())
      .then((settings) => {
        if (read === latestRead.current && settings?.browserPermissions) setPolicy(settings.browserPermissions);
      })
      .catch(() => undefined);
  }, [active, api]);

  if (!policy || !api.setBrowserPermissions) return null;

  const save = (next: BrowserPermissionPolicy) => {
    setPolicy(next);
    setError('');
    latestRead.current += 1;
    void Promise.resolve(api.setBrowserPermissions?.(next))
      .then((settings) => {
        if (settings?.browserPermissions) setPolicy(settings.browserPermissions);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const options = settingOptions();

  return (
    <Group
      title={t('Site permissions')}
      description={t('Set a default for each permission. Sites with a setting of their own are listed below.')}
    >
      {BROWSER_PERMISSION_KINDS.map((kind) => (
        <SelectRow
          key={kind}
          title={browserPermissionKindLabel(kind)}
          value={policy.defaults[kind]}
          options={options}
          onChange={(value) => save(withBrowserPermissionDefault(policy, kind, value as BrowserPermissionSetting))}
        />
      ))}
      {policy.sites.length > 0 && (
        <ul className="browser-permission-sites">
          {policy.sites.map((rule: BrowserPermissionSiteRule) => (
            <li
              key={`${rule.embedder ?? ''}|${rule.origin}|${rule.permission}`}
              className="mixdog-settings__row"
            >
              <div className="mixdog-settings__copy">
                <span className="mixdog-settings__row-title">{withoutScheme(rule.origin)}</span>
                <span className="mixdog-settings__row-desc">
                  {browserPermissionKindLabel(rule.permission)}
                  {rule.embedder ? ` · ${t('embedded in {{site}}', { site: withoutScheme(rule.embedder) })}` : ''}
                </span>
              </div>
              <div className="settings-row-control">
                <OpenSelect
                  className="settings-select"
                  ariaLabel={`${withoutScheme(rule.origin)} ${browserPermissionKindLabel(rule.permission)}`}
                  value={rule.setting}
                  options={options}
                  onChange={(value) => {
                    // An existing exception is replaced in place, so this is never refused.
                    const next = withBrowserPermissionSite(policy, { ...rule, setting: value as BrowserPermissionSetting });
                    if (next) save(next);
                  }}
                />
                <ActionButton onClick={() => save(withoutBrowserPermissionSite(policy, rule))}>
                  {t('Remove')}
                </ActionButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorNotice error={error} />}
    </Group>
  );
}

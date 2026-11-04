// Settings → System → Network proxy (design/mockups/proxy-settings/clean.html):
// how Mixdog reaches AI services. The setting is the PC's, read and written
// through the runtime (a paired phone edits the same one).
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopNetworkProxyCheck,
  DesktopNetworkProxyPatch,
  DesktopNetworkProxySettings,
  NetworkProxyMode,
  NetworkProxyRoute,
} from '../../shared/contract';
import { errorMessageText } from '../ErrorNotice';
import { t } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { useLeadMainRoute } from '../workflows-main-route';
import { Group } from './capability-controls';
import type { PanelContext } from './capability-data';
import './network-proxy-settings.css';

const EXCEPTIONS_PLACEHOLDER = ['localhost', '*.company.local'].join(', ');
const OPEN_EVENT ='mixdog:open-network-proxy';
let focusPending = false;

/** Asks Settings to show the System page's Network proxy group (a failed provider check links here). */
export function requestOpenNetworkProxy(): void {
  focusPending = true;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Called by the page that must switch to System when a link asks for the proxy group. */
export function onOpenNetworkProxyRequest(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

const invoke = async <T,>(capability: 'getNetworkProxy' | 'setNetworkProxy' | 'testNetworkProxy', args: unknown[]) =>
  (await window.mixdogDesktop.invokeCapability<never>({ capability, args })).value as T;

/** `text` with `code` spans where it has backticks. */
function withCode(text: string): ReactNode {
  return text.split(/`([^`]+)`/).map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

function systemName(route: NetworkProxyRoute): string {
  if (route.platform === 'windows') return 'Windows';
  if (route.platform === 'macos') return 'macOS';
  return t('system');
}

/** The one line under "Proxy": the route in effect, or what `off` ignores. */
export function routeDescription(mode: NetworkProxyMode, route: NetworkProxyRoute): string {
  if (mode === 'manual') {
    return route.error ? t('Enter a proxy address below to use it.') : t('Connecting only through the proxy below.');
  }
  if (mode === 'off') {
    const ignored = [...(route.ignored.system ? [t('{{system}} proxy', { system: systemName(route) })] : []), ...route.ignored.env];
    if (ignored.length === 0) return t('Connecting directly, without a proxy.');
    const list = ignored.map((name) => (route.ignored.env.includes(name) ? `\`${name}\`` : name));
    if (list.length === 1) return t('Connecting directly, without a proxy. Ignoring {{a}}.', { a: list[0] });
    if (list.length === 2) {
      return t('Connecting directly, without a proxy. Ignoring {{a}} and {{b}}.', { a: list[0], b: list[1] });
    }
    return t('Connecting directly, without a proxy. Ignoring {{list}}.', { list: list.join(', ') });
  }
  if (route.noProxyAll) return t('Connecting directly because `NO_PROXY` is `*`.');
  if (route.via === 'env') {
    return t('Connecting through the proxy `{{proxy}}` from `{{variable}}`.', {
      proxy: route.proxy ?? '',
      variable: route.envVar ?? '',
    });
  }
  if (route.via === 'system') {
    return t('Right now connecting through the {{source}} proxy `{{proxy}}`.', {
      source: systemName(route),
      proxy: route.proxy ?? '',
    });
  }
  return t('Connecting directly, without a proxy. No system proxy or proxy variable is set.');
}

/** The outcome line of "Check connection". */
function CheckOutcome({ check }: { check: DesktopNetworkProxyCheck }) {
  const host = new URL(check.origin).host;
  const proxy = check.route.proxy;
  if (check.ok) {
    return (
      <span className="network-proxy-ok">
        <b>{t('Connected.')}</b>{' '}
        {proxy
          ? t('It took {{ms}}ms to reach {{host}} through the proxy.', { ms: check.ms, host })
          : t('It took {{ms}}ms to reach {{host}} without a proxy.', { ms: check.ms, host })}
      </span>
    );
  }
  let reason: string;
  if (check.route.error) reason = t('No proxy address is set.');
  else if (proxy) reason = t('The proxy {{proxy}} is not responding.', { proxy });
  else reason = t('{{host}} did not answer ({{code}}).', { host, code: check.code ?? '' });
  return (
    <span className="network-proxy-bad">
      <b>{t('Could not connect.')}</b> {reason}
    </span>
  );
}

function ProxyRow({
  title,
  description,
  error,
  children,
  rowRef,
}: {
  title: string;
  description: ReactNode;
  error?: boolean;
  children: ReactNode;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className="mixdog-settings__row network-proxy-row" ref={rowRef}>
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{title}</span>
        <span className={`mixdog-settings__row-desc${error ? ' network-proxy-error' : ''}`}>{description}</span>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** A text field that saves on blur or Enter, restores on Escape, and shows `invalid` as a red outline. */
function ProxyInput({
  label,
  value,
  placeholder,
  invalid,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  invalid: boolean;
  onSave(value: string): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="network-proxy-input"
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => {
        if (text.trim() !== value) onSave(text.trim());
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setText(value);
        }
      }}
    />
  );
}

type FieldErrors = { url?: string; exceptions?: string };

/** What a rejected save says about the field it was for; anything else is a plain failure. */
function saveError(reason: unknown, field: 'url' | 'exceptions'): string {
  const message = errorMessageText(reason);
  if (field === 'url') {
    if (/user name or password/.test(message)) {
      return t('The address cannot contain a user name or password. Put it in the HTTPS_PROXY variable instead.');
    }
    if (/networkProxy\.url/.test(message)) {
      return t('The address is not valid. Example: http://proxy.company.com:8080');
    }
  }
  if (field === 'exceptions' && /networkProxy\.exceptions/.test(message)) {
    return t('An entry is not a valid address. Use host names, *.domain or IP addresses separated by commas.');
  }
  return t('Could not save the setting.');
}

/** The "Network proxy" group: the mode, the manual rows, and the connection check. */
export function NetworkProxyGroup({ active }: Pick<PanelContext, 'active'>) {
  const [mainRoute] = useLeadMainRoute(active === true, window.mixdogDesktop);
  const provider = typeof mainRoute.provider === 'string' && mainRoute.provider ? mainRoute.provider : undefined;
  const options = provider ? [{ provider }] : [];
  const [settings, setSettings] = useState<DesktopNetworkProxySettings | null>(null);
  // "Manual" picked while no address is stored: its rows show, nothing is saved until the address is valid.
  const [draftManual, setDraftManual] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [check, setCheck] = useState<DesktopNetworkProxyCheck | 'running' | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const newest = useRef(0);

  const load = useCallback(() => {
    const mine = ++newest.current;
    invoke<DesktopNetworkProxySettings>('getNetworkProxy', provider ? [{ provider }] : [])
      .then((value) => {
        if (newest.current === mine) setSettings(value);
      })
      .catch(() => {});
  }, [provider]);

  useEffect(() => {
    if (!active) return;
    load();
    return subscribeSetupChanges(load);
  }, [active, load]);

  // A link from a failed provider check lands here once the System page shows.
  const loaded = settings !== null;
  useEffect(() => {
    if (!active || !loaded) return;
    const reveal = () => {
      focusPending = false;
      groupRef.current?.scrollIntoView({ block: 'center' });
    };
    if (focusPending) reveal();
    return onOpenNetworkProxyRequest(() => queueMicrotask(reveal));
  }, [active, loaded]);

  const save = async (patch: DesktopNetworkProxyPatch, field?: 'url' | 'exceptions') => {
    setCheck(null);
    try {
      const next = await invoke<DesktopNetworkProxySettings>('setNetworkProxy', [patch, ...options]);
      newest.current += 1;
      setSettings(next);
      setErrors({});
      if (next.mode !== 'manual') setDraftManual(false);
      else if (patch.url !== undefined) setDraftManual(false);
    } catch (reason) {
      if (field) setErrors({ [field]: saveError(reason, field) });
      else setErrors({ url: saveError(reason, 'url') });
    }
  };

  if (!settings) return null;
  const mode: NetworkProxyMode = draftManual ? 'manual' : settings.mode;
  const host = new URL(settings.origin).host;
  const checking = check === 'running';
  const runCheck = () => {
    setCheck('running');
    invoke<DesktopNetworkProxyCheck>('testNetworkProxy', options.length ? [options[0]] : [])
      .then(setCheck)
      .catch(() => setCheck(null));
  };
  const choose = (value: NetworkProxyMode) => {
    setErrors({});
    if (value === 'manual' && !settings.url) {
      setDraftManual(true);
      setCheck(null);
      return;
    }
    setDraftManual(false);
    void save({ mode: value });
  };
  return (
    <div ref={groupRef}>
      <Group
        title={t('Network proxy')}
        description={t(
          'The proxy used to connect to AI services. The same rule applies to provider registration, sign-in and chat requests.'
        )}
      >
        <ProxyRow
          title={t('Proxy')}
          description={withCode(
            routeDescription(mode, draftManual ? { ...settings.route, error: 'no-address' } : settings.route)
          )}
        >
          <select
            className="network-proxy-select"
            aria-label={t('How the proxy is used')}
            value={mode}
            onChange={(event) => choose(event.currentTarget.value as NetworkProxyMode)}
          >
            <option value="system">{t('Use system settings')}</option>
            <option value="manual">{t('Manual')}</option>
            <option value="off">{t('Off')}</option>
          </select>
        </ProxyRow>
        {mode === 'manual' && (
          <>
            <ProxyRow
              title={t('Proxy address')}
              description={errors.url ?? t('You can use an http, https or socks5 address.')}
              error={Boolean(errors.url)}
            >
              <ProxyInput
                label={t('Proxy address')}
                value={settings.url}
                placeholder="http://proxy.company.com:8080"
                invalid={Boolean(errors.url)}
                onSave={(url) => {
                  if (!url) {
                    setErrors({ url: t('Enter the proxy address.') });
                    return;
                  }
                  void save({ mode: 'manual', url }, 'url');
                }}
              />
            </ProxyRow>
            <ProxyRow
              title={t('Exceptions')}
              description={errors.exceptions ?? t('Addresses reached without the proxy. Separate them with commas.')}
              error={Boolean(errors.exceptions)}
            >
              <ProxyInput
                label={t('Exceptions')}
                value={settings.exceptions}
                placeholder={EXCEPTIONS_PLACEHOLDER}
                invalid={Boolean(errors.exceptions)}
                onSave={(exceptions) => void save({ exceptions }, 'exceptions')}
              />
            </ProxyRow>
          </>
        )}
        <ProxyRow
          title={t('Check connection')}
          description={
            check === null || check === 'running' ? (
              t('Tries to connect to {{host}} with the current settings.', { host })
            ) : (
              <CheckOutcome check={check} />
            )
          }
        >
          <button type="button" className="network-proxy-button" disabled={checking || draftManual} onClick={runCheck}>
            {checking ? t('Checking…') : check && !check.ok ? t('Check again') : t('Check')}
          </button>
        </ProxyRow>
      </Group>
    </div>
  );
}

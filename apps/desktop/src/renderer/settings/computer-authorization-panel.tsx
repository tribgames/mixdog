import { useEffect, useState } from 'react';
import type { CapabilityApi } from './capability-data';
import { COMPUTER_POLICY_ACTIONS, type ComputerAuthorizationStatus, type ComputerAuthorizationWindow } from '../../shared/computer-settings';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { OpenSelect } from '../OpenSelect';
import { CompactSwitch } from './capability-controls';
import { ExtensionFacts, ExtensionSection } from './extension-detail';

// Expiry choices carry fixed labels instead of a "{{count}} hours" template so
// English stays grammatical ("1 hour") without plural-suffix catalog keys.
const DURATIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '24 hours' },
];

export function ComputerAuthorizationPanel({ api, enabled }: { api: CapabilityApi; enabled: boolean }) {
  const [status, setStatus] = useState<ComputerAuthorizationStatus | null>(null);
  const [windows, setWindows] = useState<ComputerAuthorizationWindow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>(['list', 'capture', 'diagnose', 'verify']);
  const [minutes, setMinutes] = useState(30);
  const [launches, setLaunches] = useState('');
  const [elevated, setElevated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const local = Boolean(api.computerReadAuthorization && api.computerUpdateAuthorization && api.computerAuthorizationWindows);
  useEffect(() => {
    let disposed = false;
    api.computerReadAuthorization?.().then((value) => {
      if (disposed) return;
      setStatus(value);
      if (value.policy) {
        setActions(value.policy.actions);
        setLaunches((value.policy.launchTargets ?? []).join('\n'));
        setElevated(value.policy.allowElevatedInput === true);
      }
    }).catch((reason: unknown) => { if (!disposed) setError(String((reason as Error).message || reason)); });
    return () => { disposed = true; };
  }, [api]);
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (reason) { setError(String((reason as Error).message || reason)); }
    finally { setBusy(false); }
  };
  const save = () => perform(async () => {
    if (!api.computerUpdateAuthorization) return;
    const value = await api.computerUpdateAuthorization({
      version: 1, actions,
      windows: windows.filter((window) => selected.includes(window.id)).map(({ id, pid }) => ({ id, pid })),
      launchTargets: launches.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      allowElevatedInput: elevated,
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
    setStatus(value);
    setMessage(t('Authorization saved. Active Computer Use tasks were stopped.'));
  });
  const exportDiagnostics = () => perform(async () => {
    const bundles = await api.computerFailureDiagnostics?.() ?? [];
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundles, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'computer-failure-diagnostics.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(t('Failure diagnostics exported without text or screenshots.'));
  });
  const toggle = (values: string[], value: string, checked: boolean) =>
    checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
  const refreshWindows = () => perform(async () => {
    setWindows(await api.computerAuthorizationWindows!());
    setSelected([]);
    setLoaded(true);
  });
  const locked = busy || !enabled || !status;
  const note = (text: string, tone?: 'danger') =>
    <p className="computer-authorization-note" data-tone={tone}>{text}</p>;
  const facts: Array<readonly [string, string]> = status?.policy ? [
    ['Allowed actions', status.policy.actions.join(', ') || t('None')],
    ['App windows', status.policy.windows.map((window) => `${window.id} (PID ${window.pid})`).join(', ') || t('None')],
  ] : [];
  // The dialog form grammar (schedules-field label/note blocks, settings-action
  // plates, OpenSelect, the compact switch) instead of bare browser controls;
  // the fieldset still carries the disabled state for every control at once.
  return <ExtensionSection title={t('Computer Use authorization')}>
    {!local ? note(t('Edit authorization on the local Windows desktop.')) : <>
      {status?.error
        ? note(t('Saved authorization is invalid. Computer Use is blocked until you save a new authorization.'), 'danger')
        : status?.policy
          ? note(t('Current authorization expires at {{time}}', { time: new Date(status.policy.expiresAt).toLocaleString() }))
          : note(status ? t('No additional authorization restrictions are configured.') : t('Loading…'))}
      {status?.externallyRestricted && note(t('Host launch restrictions also apply and cannot be relaxed here.'))}
      {facts.length > 0 && <ExtensionFacts facts={facts} />}
      {!enabled && note(t('Enable Computer Use to select windows and save authorization.'))}
      <fieldset className="computer-authorization" disabled={locked}>
        <legend>{t('New authorization')}</legend>
        <small>{t('Saving stops active Computer Use tasks. Unselected windows and actions are denied; expiry does not restore unrestricted access.')}</small>
        <div className="schedules-field">
          <span>{t('App windows')}</span>
          <small>{t('Select exact app windows. Reopened apps need new authorization.')}</small>
          <div className="computer-authorization-windows" data-i18n-skip>
            {windows.length === 0
              ? <p className="computer-authorization-empty">
                {loaded ? t('No windows found.') : t('Refresh to list open windows.')}
              </p>
              : windows.map((window) => <label key={window.id} className="computer-authorization-window">
                <input type="checkbox" checked={selected.includes(window.id)}
                  onChange={(event) => setSelected(toggle(selected, window.id, event.target.checked))} />
                <span className="computer-authorization-window-copy">
                  <b>{window.title || window.app}</b>
                  <small>{window.app} · PID {window.pid} · {window.id}</small>
                </span>
              </label>)}
          </div>
          <div className="computer-authorization-actions">
            <button type="button" className="settings-action" onClick={() => void refreshWindows()}>
              {t('Refresh windows')}
            </button>
            {windows.length > 0 && <span>{t('{{count}} selected', { count: selected.length })}</span>}
          </div>
        </div>
        <div className="schedules-field">
          <span>{t('Allowed actions')}</span>
          <div className="computer-authorization-chips" data-i18n-skip>
            {COMPUTER_POLICY_ACTIONS.map((action) => <label key={action} className="computer-authorization-chip">
              <input type="checkbox" checked={actions.includes(action)}
                onChange={(event) => setActions(toggle(actions, action, event.target.checked))} />
              <span>{action}</span>
            </label>)}
          </div>
        </div>
        <label className="schedules-field">
          <span>{t('Exact launch targets, one per line')}</span>
          <textarea className="computer-authorization-targets" value={launches} maxLength={32000} rows={3}
            spellCheck={false} onChange={(event) => setLaunches(event.target.value)} />
        </label>
        <div className="computer-authorization-inline">
          <span>{t('Authorization duration')}</span>
          <OpenSelect className="computer-authorization-select" ariaLabel={t('Authorization duration')}
            value={String(minutes)} disabled={locked} localizeLabels={false}
            options={DURATIONS.map((entry) => ({ value: String(entry.minutes), label: t(entry.label) }))}
            onChange={(value) => setMinutes(Number(value))} />
        </div>
        <div className="computer-authorization-inline">
          <span>{t('Allow elevated input')}</span>
          <CompactSwitch label={t('Allow elevated input')} checked={elevated} disabled={locked}
            optimistic={false} onChange={setElevated} />
        </div>
        <div className="computer-authorization-actions">
          <button type="button" className="settings-action" onClick={() => void save()}>
            {t('Save authorization and stop active tasks')}
          </button>
        </div>
      </fieldset>
      <div className="computer-authorization-inline">
        <small>{t('Failure bundles exclude input text, clipboard contents, window titles and screenshots.')}</small>
        <button type="button" className="settings-action" disabled={busy || !api.computerFailureDiagnostics}
          onClick={() => void exportDiagnostics()}>
          {t('Export failure diagnostics')}
        </button>
      </div>
    </>}
    {error && <ErrorNotice error={error} />}
    {message && <p className="computer-authorization-note" role="status">{message}</p>}
  </ExtensionSection>;
}

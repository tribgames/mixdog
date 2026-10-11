import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopRemoteHost } from '../../shared/contract';
import { t } from '../i18n';
import type { CapabilityApi } from './capability-data';
import { ConnDialog } from './connection-dialogs';

const HOSTS_REFRESH_MS = 3_000;

/** Accepts `482917`, `482 917`, `482·917`. */
function normalizeCodeInput(text: string): string {
  return text.replace(/\D/gu, '').slice(0, 6);
}

/** Presence when the relay reported it; otherwise an open window implies online. */
export function savedHostOnline(host: DesktopRemoteHost): boolean | undefined {
  return host.online === undefined ? (host.open ? true : undefined) : host.online;
}

/** The computers saved here ("PCs I opened"), refreshed on a short heartbeat. */
export function useRemoteHosts(api: CapabilityApi): { hosts: DesktopRemoteHost[]; refresh(): void } {
  const [hosts, setHosts] = useState<DesktopRemoteHost[]>([]);
  const refresh = useCallback(() => {
    void api
      .listRemoteHosts?.()
      .then((next) => setHosts(next ?? []))
      .catch(() => undefined);
  }, [api]);
  useEffect(() => {
    if (!api.listRemoteHosts) return undefined;
    refresh();
    const timer = window.setInterval(refresh, HOSTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [api, refresh]);
  return { hosts, refresh };
}

type Phase = 'input' | 'waiting' | 'error';

/** "Open another PC" (C1–C3): the 6-digit code shown on the other computer.
 *  Entering the sixth digit starts the connection; on success the dialog
 *  closes and that PC's window opens. */
export function OpenPcDialog({
  api,
  onConnected,
  onClose,
}: {
  api: CapabilityApi;
  onConnected(): void;
  onClose(): void;
}) {
  const [digits, setDigits] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const live = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      live.current = false;
    },
    []
  );
  useEffect(() => {
    if (phase === 'input') input.current?.focus();
  }, [phase]);

  const start = (code: string): void => {
    const connect = api.connectRemoteHostByCode;
    if (code.length !== 6 || !connect) return;
    setPhase('waiting');
    void Promise.resolve()
      .then(() => connect(code))
      .then(() => {
        onConnected();
        if (live.current) onClose();
      })
      .catch(() => {
        if (live.current) setPhase('error');
      });
  };
  const retry = (): void => {
    setDigits('');
    setPhase('input');
  };
  const focused = phase === 'input' ? Math.min(digits.length, 5) : -1;
  let primary = (
    <button
      type="button"
      className="conn-btn conn-btn--primary"
      disabled={digits.length !== 6}
      onClick={() => start(digits)}
    >
      {t('Connect')}
    </button>
  );
  if (phase === 'waiting') {
    primary = (
      <button type="button" className="conn-btn conn-btn--primary" disabled>
        {t('Connecting…')}
      </button>
    );
  } else if (phase === 'error') {
    primary = (
      <button type="button" className="conn-btn conn-btn--primary" onClick={retry}>
        {t('Enter again')}
      </button>
    );
  }
  const box = (index: number) => (
    <span key={index} className={phase === 'error' ? 'is-error' : index === focused ? 'is-focus' : undefined}>
      {digits[index] ?? ''}
    </span>
  );
  return (
    <ConnDialog
      title={t('Open another PC')}
      description={t('On that PC, open Connect a device → Other PC and enter the code shown there.')}
      viewKey={phase}
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          {primary}
        </>
      }
    >
      <div className="conn-field">
        <div className="conn-otp">
          {[0, 1, 2].map(box)}
          <i aria-hidden="true">·</i>
          {[3, 4, 5].map(box)}
          <input
            ref={input}
            type="text"
            name="code"
            data-autofocus
            value={digits}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('6-digit code')}
            disabled={phase !== 'input'}
            onChange={(event) => {
              const next = normalizeCodeInput(event.currentTarget.value);
              setDigits(next);
              if (next.length === 6) start(next);
            }}
          />
        </div>
        {phase === 'waiting' && (
          <div className="conn-field-msg conn-field-msg--busy" role="status">
            <span className="conn-spinner" aria-hidden="true" />
            {t('Press Allow on that PC to open it')}
          </div>
        )}
        {phase === 'error' && (
          <div className="conn-field-msg conn-field-msg--error" role="alert">
            {t('The code is wrong or has expired.')}
          </div>
        )}
        {phase === 'input' && <div className="conn-field-msg">{'\u00a0'}</div>}
      </div>
    </ConnDialog>
  );
}

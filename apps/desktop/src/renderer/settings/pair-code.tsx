import { Copy, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DesktopRemotePairCode, DesktopRemotePairCodeUnsupported } from '../../shared/contract';
import { t } from '../i18n';
import { useSection } from '../section-store';
import type { CapabilityApi } from './capability-data';
import { formatPairCode, remainingFraction, remainingLabel } from './pair-code-format';

export type PairCodeState = {
  code: DesktopRemotePairCode | null;
  unsupported: boolean;
  now: number;
  renew(): void;
};

/** The core's `remote` section value; `pairCode` is the live code, `null` while none exists (desktop-services.md
 *  §7, section `remote`). */
interface RemoteSectionValue {
  pairCode?: DesktopRemotePairCode | null;
}

/** The 6-digit code exists only while a view that shows it is on screen: it is
 *  requested once when shown and withdrawn when hidden. The core pushes the code
 *  and each replacement (on issue and on expiry) in the `remote` section, so
 *  nothing asks again on a clock. The browser and other-PC views share one code. */
export function usePairCode(api: CapabilityApi, enabled: boolean): PairCodeState {
  const [answered, setAnswered] = useState<DesktopRemotePairCode | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pushed = useSection<RemoteSectionValue>('remote')?.pairCode;
  const request = api.getRemotePairCode;
  // A relay without codes answers { unsupported: true }; a missing answer from
  // an older host means the same.
  // null is a request still pending (a loading state), not "unsupported".
  const accept = (next: DesktopRemotePairCode | DesktopRemotePairCodeUnsupported | null | undefined): void => {
    const none = next === undefined || (next !== null && 'unsupported' in next);
    setUnsupported(none);
    setAnswered(none || next === null ? null : next);
  };
  const renew = (): void => {
    void request?.('renew')
      .then(accept)
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!request || !enabled) return undefined;
    let live = true;
    void request('ensure')
      .then((next) => {
        if (live) accept(next);
      })
      .catch(() => undefined);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      window.clearInterval(tick);
      setAnswered(null);
      void request('release').catch(() => undefined);
    };
  }, [request, enabled]);
  return { code: pushed !== undefined ? pushed : answered, unsupported, now, renew };
}
/** The 6-digit code: a 64px tile plus a 28px timer row, so nothing moves when
 *  the code lands. A relay without codes puts a note in the same slot. */
export function PairCodeBlock({ pair }: { pair: PairCodeState }) {
  const { code, unsupported, now, renew } = pair;
  if (unsupported) {
    return (
      <div className="conn-code">
        <div className="conn-code-tile conn-code-tile--na" role="note">
          {t('Codes aren’t available right now')}
        </div>
        <p className="conn-code-note">{t('This connection server doesn’t support codes.')}</p>
      </div>
    );
  }
  return (
    <div className="conn-code">
      {code ? (
        <div className="conn-code-tile" role="group" aria-label={t('6-digit code')}>
          <b>{formatPairCode(code.code)}</b>
        </div>
      ) : (
        <div
          className="conn-code-tile conn-code-tile--loading"
          role="status"
          aria-busy="true"
          aria-label={t('Getting a code…')}
        >
          <span aria-hidden="true">000·000</span>
        </div>
      )}
      <div className="conn-code-meta">
        <div className="conn-code-bar" aria-hidden="true">
          <i style={{ width: code ? `${Math.round(remainingFraction(code.expiresAt, now) * 100)}%` : '0%' }} />
        </div>
        <span>{code ? t('{{time}} left', { time: remainingLabel(code.expiresAt, now) }) : ''}</span>
        <button
          type="button"
          className="conn-btn conn-btn--sm conn-btn--icon"
          aria-label={t('New code')}
          title={t('New code')}
          disabled={!code}
          onClick={renew}
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The browser address with a copy button, full width. */
export function AddressRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="conn-address" aria-label={address}>
      <code title={address}>{address}</code>
      <button
        type="button"
        className="conn-btn conn-btn--sm conn-btn--icon"
        aria-label={copied ? t('Copied') : t('Copy')}
        title={copied ? t('Copied') : t('Copy')}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(address)
            .then(() => setCopied(true))
            .catch(() => undefined);
        }}
      >
        <Copy size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

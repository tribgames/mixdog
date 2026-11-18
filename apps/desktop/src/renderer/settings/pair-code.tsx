import { Copy, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DesktopRemotePairCode, DesktopRemotePairCodeUnsupported } from '../../shared/contract';
import { t } from '../i18n';
import { useCoreLink } from '../core-link-store';
import { useSection } from '../section-store';
import type { CapabilityApi } from './capability-data';
import { formatPairCode, remainingFraction, remainingLabel } from './pair-code-format';
import { startSettingsReadRecovery } from './read-recovery';

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
  /** True while the relay issues no pairing codes. */
  pairCodeUnsupported?: boolean;
}

/** The 6-digit code exists only while a view that shows it is on screen: the view takes a hold on it once when shown
 *  (`ensure`) and gives it back when hidden (`release`); the core also drops the hold when this window's connection to it
 *  closes. While any hold exists the core always has a code or a request for one: it replaces a used or ending code itself
 * and pushes each code, and whether the relay issues none, in the `remote` section. The state read can recover a
 * missed push without renewing the code or taking a second hold.
 *  A reconnected core connection holds nothing, so the view takes its hold again when the link is back. The browser and
 *  other-PC views share one code. */
export function usePairCode(api: CapabilityApi, enabled: boolean): PairCodeState {
  const [answered, setAnswered] = useState<DesktopRemotePairCode | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const section = useSection<RemoteSectionValue>('remote');
  const latestSection = useRef(section);
  latestSection.current = section;
  const [readback, setReadback] = useState<{ section: typeof section; value: RemoteSectionValue } | null>(null);
  const current = readback?.section === section ? readback?.value ?? section : section;
  const linkUp = useCoreLink().view.status === 'ready';
  const request = api.getRemotePairCode;
  const readState = api.getRemoteConnectionState;
  // A relay without codes answers { unsupported: true }; a missing answer from
  // an older host means the same.
  // null is a request still pending (a loading state), not "unsupported".
  const accept = (next: DesktopRemotePairCode | DesktopRemotePairCodeUnsupported | null | undefined): void => {
    const none = next === undefined || (next !== null && 'unsupported' in next);
    setUnsupported(none);
    setAnswered(none || next === null ? null : next);
    setReadback({
      section: latestSection.current,
      value: { pairCode: none || next === null ? null : next, pairCodeUnsupported: none },
    });
  };
  const renew = (): void => {
    const before = latestSection.current;
    void request?.('renew')
      .then((next) => {
        if (latestSection.current === before) accept(next);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!request || !enabled || !linkUp) return undefined;
    let live = true;
    let held = false;
    const recovery = startSettingsReadRecovery(async (signal) => {
      const seen = latestSection.current;
      if (!held) {
        const next = await request('ensure');
        if (!live || signal.aborted) return;
        held = true;
        if (latestSection.current === seen) accept(next);
        // Ensure already answered the initial code. The fallback only needs
        // to read state on later ticks if a code update was missed.
        return;
      }
      if (!readState) return;
      const before = latestSection.current;
      const next = await readState();
      if (live && !signal.aborted && latestSection.current === before && next.pairCode !== undefined) {
        setReadback({ section: before, value: next });
      }
    }, 5_000, true, true);
    window.addEventListener('focus', recovery.replace);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      recovery.stop();
      window.removeEventListener('focus', recovery.replace);
      window.clearInterval(tick);
      setAnswered(null);
      setReadback(null);
      void request('release').catch(() => undefined);
    };
  }, [request, readState, enabled, linkUp]);
  return {
    code: current?.pairCode !== undefined ? current.pairCode : answered,
    unsupported: current?.pairCodeUnsupported ?? unsupported,
    now,
    renew,
  };
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

// The whole-PC screen view's full-screen host on a paired phone: one overlay,
// mounted once in the app shell, opened through remote-screen-request.ts. It
// lists the PC's displays, offers the monitor picker only when there are two
// or more (frame B), and then shows the pane (frame C).
import { ChevronRight, Monitor } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties } from 'react';

import type { RemoteScreenDisplaySummary } from '../shared/remote-webrtc';
import { ErrorNotice } from './ErrorNotice';
import { ProgressSpinner } from './ProgressSpinner';
import { ScreenHeaderRow, ScreenStateCard } from './RemoteScreenChrome';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { closeRemoteScreen, useRemoteScreenOpen } from './remote-screen-request';
import { chooseScreenEntry, readScreenDisplays } from './remote-screen-state';
import { remoteWebrtcHost } from './remote-webrtc-bridge';

const RemoteScreenPane = lazy(() => import('./RemoteScreenPane'));

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; reason: unknown }
  | { kind: 'none' }
  | { kind: 'pick'; displays: RemoteScreenDisplaySummary[] }
  | { kind: 'view'; display: RemoteScreenDisplaySummary };

/** The visible area above the soft keyboard (iOS keeps the layout viewport
 *  full height), so the keyboard bar docks right over the keyboard. */
function useVisibleViewportStyle(): CSSProperties | undefined {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () =>
      setBox((current) =>
        current?.top === viewport.offsetTop && current.height === viewport.height
          ? current
          : { top: viewport.offsetTop, height: viewport.height }
      );
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return box
    ? ({ '--remote-screen-top': `${box.top}px`, '--remote-screen-height': `${box.height}px` } as CSSProperties)
    : undefined;
}

function MonitorSheet({
  displays,
  onPick,
  onCancel,
}: {
  displays: readonly RemoteScreenDisplaySummary[];
  onPick(display: RemoteScreenDisplaySummary): void;
  onCancel(): void;
}) {
  return (
    <>
      <div className="remote-screen-scrim" aria-hidden="true" onClick={onCancel} />
      <div className="remote-screen-sheet" role="dialog" aria-label={t('Choose a display')}>
        <div className="remote-screen-grab" aria-hidden="true" />
        <h3>{t('Choose a display')}</h3>
        <p>{t('This PC has {{total}} displays connected.', { total: displays.length })}</p>
        <div className="remote-screen-list">
          {displays.map((display) => (
            <button type="button" key={display.screenId} className="remote-screen-row" onClick={() => onPick(display)}>
              <span className="remote-screen-tile">
                <Monitor size={16} aria-hidden="true" />
              </span>
              <span className="remote-screen-row-text">
                <span className="remote-screen-row-title">
                  <b>{display.label}</b>
                  {display.primary && <span className="remote-screen-row-status">{t('Primary display')}</span>}
                </span>
                <span className="remote-screen-row-meta">{`${display.pixelWidth}×${display.pixelHeight}`}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="remote-screen-cancel">
          <button type="button" onClick={onCancel}>
            {t('Cancel')}
          </button>
        </div>
      </div>
    </>
  );
}

function RemoteScreenOverlay() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [listing, setListing] = useState(0);
  const style = useVisibleViewportStyle();
  useMobileBack(true, closeRemoteScreen);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `listing` re-lists the displays (a removed display, a retry).
  useEffect(() => {
    let current = true;
    const api = window.mixdogDesktop;
    setPhase({ kind: 'loading' });
    if (!remoteWebrtcHost(api) || !api.remoteScreenDisplays) {
      setPhase({ kind: 'error', reason: t('This PC does not offer screen viewing.') });
      return undefined;
    }
    api.remoteScreenDisplays().then(
      (value) => {
        if (!current) return;
        const entry = chooseScreenEntry(readScreenDisplays(value));
        setPhase(entry);
      },
      (reason: unknown) => {
        if (current) setPhase({ kind: 'error', reason });
      }
    );
    return () => {
      current = false;
    };
  }, [listing]);
  const pickAgain = useCallback(() => setListing((count) => count + 1), []);

  let body = null;
  if (phase.kind === 'loading') {
    body = (
      <ScreenStateCard>
        <ProgressSpinner size={24} />
        <span>{t('Connecting to PC screen…')}</span>
      </ScreenStateCard>
    );
  } else if (phase.kind === 'error') {
    body = (
      <ScreenStateCard>
        <ErrorNotice error={phase.reason} title={t('Could not list the PC displays')} role="status" />
        <div className="remote-screen-actions">
          <button type="button" className="remote-screen-primary" onClick={pickAgain}>
            {t('Try again')}
          </button>
          <button type="button" onClick={closeRemoteScreen}>
            {t('Close')}
          </button>
        </div>
      </ScreenStateCard>
    );
  } else if (phase.kind === 'none') {
    body = (
      <ScreenStateCard>
        <span>{t('No display is available to view.')}</span>
        <div className="remote-screen-actions">
          <button type="button" onClick={closeRemoteScreen}>
            {t('Close')}
          </button>
        </div>
      </ScreenStateCard>
    );
  }
  return (
    <div className="remote-screen-overlay" style={style} role="dialog" aria-label={t('View entire PC screen')}>
      {phase.kind === 'view' ? (
        <Suspense
          fallback={
            <ScreenStateCard>
              <ProgressSpinner size={24} />
            </ScreenStateCard>
          }
        >
          <RemoteScreenPane
            key={phase.display.screenId}
            display={phase.display}
            onClose={closeRemoteScreen}
            onPickAgain={pickAgain}
          />
        </Suspense>
      ) : (
        <>
          <ScreenHeaderRow title={t('View entire PC screen')} onClose={closeRemoteScreen} />
          <div className="remote-screen-stage">{body}</div>
          {phase.kind === 'pick' && (
            <MonitorSheet
              displays={phase.displays}
              onPick={(display) => setPhase({ kind: 'view', display })}
              onCancel={closeRemoteScreen}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Mounted once in the app shell; renders nothing until the view is opened. */
export function RemoteScreenHost() {
  return useRemoteScreenOpen() ? <RemoteScreenOverlay /> : null;
}

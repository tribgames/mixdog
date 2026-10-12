// The first launch after an update announces that version's notes once. The
// version is marked seen, and main's pending update acknowledged, only once
// the notice is on screen (or the version has no notes to show) — never while
// the starter guide's welcome is open above it.
import { type ComponentType, useCallback, useEffect, useRef, useState } from 'react';

import { useStarterGuideBlocking } from '../starter-guide-gate';
import type { ChangelogRelease } from './changelog';
import { markWhatsNewSeen, peekWhatsNew, reportWhatsNew, type WhatsNewStatus } from './whats-new';

type NoticeDialog = ComponentType<{ release: ChangelogRelease; onClose(): void; onViewAll(): void }>;

export interface WhatsNewDialogModule {
  default: NoticeDialog;
  prepareWhatsNew(): Promise<ChangelogRelease | undefined>;
}

const loadWhatsNewDialog = (): Promise<WhatsNewDialogModule> => import('./whats-new-dialog');

// Main keeps an update pending (bootContext.afterUpdate) on every launch until
// told the notice was on screen, so a launch that failed to show it retries.
const updatePending = () => window.mixdogDesktop?.bootContext?.afterUpdate === true;

function readWhatsNewStatus(version: string): WhatsNewStatus {
  try {
    return peekWhatsNew(window.localStorage, version, updatePending());
  } catch {
    return 'storage-unavailable';
  }
}

function acknowledgeUpdate(version: string): void {
  if (updatePending()) window.mixdogDesktop?.acknowledgeWhatsNew?.(version);
}

function markSeen(version: string): void {
  try {
    markWhatsNewSeen(window.localStorage, version);
  } catch {
    markWhatsNewSeen(undefined, version);
  }
  acknowledgeUpdate(version);
}

export function useWhatsNewNotice(
  version: string,
  loadDialog: () => Promise<WhatsNewDialogModule> = loadWhatsNewDialog
) {
  const [status] = useState(() => readWhatsNewStatus(version));
  const [notice, setNotice] = useState<{ Dialog: NoticeDialog; release: ChangelogRelease } | null>(null);
  const closeNotice = useCallback(() => setNotice(null), []);
  // The starter welcome covers the window; the notice would sit hidden under
  // it and be consumed unseen, so it waits until the welcome is dismissed.
  const covered = useStarterGuideBlocking();
  const handled = useRef(false);
  useEffect(() => {
    if (status === 'pending') return;
    // Already announced (the stored mark matches): only main's record lags.
    if (status === 'current' || status === 'already-shown') acknowledgeUpdate(version);
    reportWhatsNew('skipped', version, { reason: status });
  }, [status, version]);
  useEffect(() => {
    if (status !== 'pending' || covered || handled.current) return;
    reportWhatsNew('taken', version);
    let cancelled = false;
    void loadDialog()
      .then(async (module) => {
        const release = await module.prepareWhatsNew();
        if (cancelled) return;
        handled.current = true;
        if (release) {
          setNotice({ Dialog: module.default, release });
        } else {
          // This version has no changelog section; retrying could never show one.
          markSeen(version);
          reportWhatsNew('skipped', version, { reason: 'no-section' });
        }
      })
      .catch((error: unknown) => reportWhatsNew('failed', version, { error }));
    return () => {
      cancelled = true;
    };
  }, [status, version, loadDialog, covered]);
  // Runs after the commit that put the dialog in the DOM.
  const noticeShown = notice !== null;
  useEffect(() => {
    if (!noticeShown) return;
    markSeen(version);
    reportWhatsNew('shown', version);
  }, [noticeShown, version]);
  return { notice, closeNotice };
}

// Pieces the whole-PC screen view's host and pane share: the dock's own header
// row markup (so it reads as the browser view's header) and the browser pane's
// centred state card.
import { Monitor, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { DockOverflowMenu, type DockAction } from './pane-dock-chrome';
import { t } from './i18n';
import './remote-screen.css';

/** Row 1 of the sheet: the monitor chip on the left, ⋯ and close on the right.
 *  It is the dock header's markup, without the phone dock's pane switch: this
 *  view is not a dock pane, so its ⋯ menu lists only its own items. */
export function ScreenHeaderRow({
  title,
  actions = [],
  onClose,
}: {
  title: string;
  actions?: readonly DockAction[];
  onClose(): void;
}) {
  return (
    <div className="dock-header-row" data-dock-header="">
      <div className="dock-header-left">
        <div className="browser-tab is-active dock-header-chip">
          <span className="browser-tab-select" title={title}>
            <Monitor size={14} aria-hidden="true" />
            <span>{title}</span>
          </span>
        </div>
      </div>
      <div className="dock-header-controls">
        {actions.length > 0 && <DockOverflowMenu items={actions} />}
        <button
          type="button"
          className="browser-pane-nav-button dock-header-close"
          aria-label={t('Close panel')}
          data-tooltip={t('Close panel')}
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The browser pane's state card (`.browser-remote-empty`), filling its
 *  nearest positioned box. */
export function ScreenStateCard({ children }: { children: ReactNode }) {
  return <div className="browser-remote-empty">{children}</div>;
}

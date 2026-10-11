// One pull request row of the dock list: open button, checkout control and
// overflow actions.
import { ArrowRight, Check, FileDiff } from 'lucide-react';
import type { DesktopPullRequestEntry } from '../shared/contract';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { RowOverflowMenu, rowOverflowHostProps } from './RowOverflowMenu';
import { StateIcon, checksState, relativeAge } from './pull-requests-model';
import type { PullRequestViewMode } from './pull-requests-model';

export function PullRequestRow({
  pr,
  checkedOut,
  busy,
  canCheckout,
  onOpen,
  onCheckout,
  onOpenExternal,
  onRefresh,
}: {
  pr: DesktopPullRequestEntry;
  checkedOut: boolean;
  /** Key of the running pane action ('' when idle). */
  busy: string;
  canCheckout: boolean;
  onOpen: (pr: DesktopPullRequestEntry, mode?: PullRequestViewMode, toSide?: boolean) => void;
  onCheckout: (pr: DesktopPullRequestEntry) => void;
  onOpenExternal: (url: string) => void;
  onRefresh: () => void;
}) {
  const checkoutKey = `checkout:${pr.number}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: tag must stay a div; <li> would bring list styling into the row.
    <div className="dock-pr-row" data-draft={pr.isDraft || undefined} role="listitem" {...rowOverflowHostProps()}>
      <button type="button" className="dock-pr-row-main" onClick={() => onOpen(pr)}>
        <span className="dock-pr-row-icon" aria-hidden="true">
          <StateIcon pr={pr} />
        </span>
        <span className="dock-pr-row-label">
          <b>{pr.title}</b>
          <small>
            #{pr.number}
            {relativeAge(pr.updatedAt) ? ` · ${relativeAge(pr.updatedAt)}` : ''}
            {pr.author ? ` · @${pr.author}` : ''}
          </small>
        </span>
        <span className="dock-pr-row-signals" aria-hidden="true">
          {checkedOut && <Check size={12} className="dock-pr-row-active" />}
          {pr.checks.total > 0 && <i className="dock-pr-row-checks" data-checks={checksState(pr.checks)} />}
        </span>
      </button>
      <span className="dock-pr-row-actions">
        <button
          type="button"
          aria-label={t('Open changes for pull request {{number}}', { number: pr.number })}
          data-tooltip={t('Open Changes')}
          onClick={() => onOpen(pr, 'changes')}
        >
          <FileDiff size={14} aria-hidden="true" />
        </button>
        {!checkedOut && (
          <button
            type="button"
            aria-label={t('Checkout pull request {{number}}', { number: pr.number })}
            data-tooltip={t('Checkout Pull Request')}
            disabled={Boolean(busy) || !canCheckout}
            onClick={() => onCheckout(pr)}
          >
            {busy === checkoutKey ? (
              <ProgressSpinner size={14} aria-hidden="true" />
            ) : (
              <ArrowRight size={14} aria-hidden="true" />
            )}
          </button>
        )}
        <RowOverflowMenu
          label={t('Actions for pull request {{number}}', { number: pr.number })}
          items={[
            {
              id: 'overview',
              label: t('View Pull Request Description'),
              onSelect: () => onOpen(pr),
            },
            {
              id: 'overview-side',
              label: t('Open Pull Request Description to the Side'),
              onSelect: () => onOpen(pr, 'overview', true),
            },
            {
              id: 'changes',
              label: t('Open Changes'),
              onSelect: () => onOpen(pr, 'changes'),
            },
            {
              id: 'checkout',
              label: checkedOut ? t('Pull Request Checked Out') : t('Checkout Pull Request'),
              disabled: checkedOut || Boolean(busy) || !canCheckout,
              onSelect: () => onCheckout(pr),
            },
            {
              id: 'open-github',
              label: t('Open on GitHub'),
              disabled: !pr.url,
              onSelect: () => {
                if (pr.url) onOpenExternal(pr.url);
              },
            },
            {
              id: 'refresh',
              label: t('Refresh Pull Request'),
              separatorBefore: true,
              onSelect: onRefresh,
            },
          ]}
        />
      </span>
    </div>
  );
}

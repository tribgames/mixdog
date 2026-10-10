import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Approval } from './desktop-types';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { isApprovalDismissKey } from './renderer-logic.mjs';
import { asRecord, textOf } from './text-format';
import { useRemoteHostImageUrl } from './local-image-preview';
import { isRemoteHostRenderer } from './remote-ui-projection';

function approvalText(value: unknown, preferredKey: string): string {
  const preferred = asRecord(value)?.[preferredKey];
  return (typeof preferred === 'string' ? preferred : textOf(value)).trim();
}

// The one argument that says what the call does, shown on its own the way a
// command approval shows the command; anything else falls back to the JSON.
const PRIMARY_ARG_KEYS = ['command', 'cmd', 'script', 'patch', 'file_path', 'path', 'url', 'query', 'pattern'];

function approvalDetail(args: unknown): string {
  const record = asRecord(args);
  const key = PRIMARY_ARG_KEYS.find((name) => typeof record?.[name] === 'string' && String(record[name]).trim());
  return key ? String(record?.[key]).trim() : textOf(args).trim();
}

function localPreviewUrl(path: unknown): string {
  const value = String(path || '').replace(/\\/g, '/');
  return value ? `file:///${encodeURI(value).replace(/^\/+/, '')}` : '';
}

// Desktop shows the host file directly; a paired browser has no access to the
// host disk, so it reads the image through the remote preview lane instead.
function ApprovalPreviewImage({ path, alt }: { path: unknown; alt: string }) {
  const remoteUrl = useRemoteHostImageUrl(String(path || ''));
  const src = isRemoteHostRenderer() ? remoteUrl : localPreviewUrl(path);
  return <img src={src || undefined} alt={alt} />;
}

export function ApprovalCard({
  approval,
  resolve,
  elsewhereDevice = '',
  outcome = null,
}: {
  approval: Approval;
  resolve: (approved: boolean) => Promise<unknown>;
  /** Device that answered, shown with "Resolved on another device" — passed
   *  only when the conversation involves more than one device. */
  elsewhereDevice?: string;
  /** The approval was answered on another device: a settled card that names
   *  it instead of the buttons. */
  outcome?: { approved: boolean; device: string } | null;
}) {
  const reason = approvalText(approval.reason, 'message') || t('Review this tool request before continuing.');
  const args = asRecord(approval.args);
  const action = String(args?.action || '').toLowerCase();
  const officeTransaction =
    String(approval.name || '').toLowerCase() === 'office' && ['commit', 'rollback', 'discard'].includes(action);
  const detail = officeTransaction ? '' : approvalDetail(approval.args);
  const transaction = asRecord(args?.transaction);
  const diff = asRecord(transaction?.diff);
  const summary = asRecord(diff?.summary);
  const preview = asRecord(args?.preview);
  const visualDiff = asRecord(preview?.visualDiff);
  const previewImages = [
    ...(Array.isArray(preview?.images) ? preview.images : []),
    ...(Array.isArray(visualDiff?.images) ? visualDiff.images : []),
  ]
    .map(asRecord)
    .filter((image): image is Record<string, unknown> => Boolean(image?.path))
    .slice(0, 4);
  let actionLabel = t('Discard recovery');
  if (action === 'commit') actionLabel = t('Commit changes');
  else if (action === 'rollback') actionLabel = t('Roll back');
  const [resolving, setResolving] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [resolvedElsewhere, setResolvedElsewhere] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const resolvingRef = useRef(false);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const decide = useCallback(async (approved: boolean) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setApprovalError('');
    setResolving(true);
    try {
      const accepted = await resolveRef.current(approved);
      if (accepted === true) return;
      if (accepted === false) {
        // The host answered "not pending": another device already decided.
        // Retire the card; the buttons stay disabled (resolvingRef stays set).
        setResolvedElsewhere(true);
        return;
      }
      setApprovalError(t('Mixdog could not record this decision. Please try again.'));
      resolvingRef.current = false;
      setResolving(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason || '');
      setApprovalError(
        detail
          ? t('Mixdog could not record this decision: {{detail}}', { detail })
          : t('Mixdog could not record this decision. Please try again.')
      );
      resolvingRef.current = false;
      setResolving(false);
    }
  }, []);
  useEffect(() => {
    if (resolvedElsewhere || outcome) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []
      );
    (focusable()[0] || dialog.current)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === 'a' || shortcut === 'y' || shortcut === 'd' || shortcut === 'n') {
        event.preventDefault();
        event.stopPropagation();
        void decide(shortcut === 'a' || shortcut === 'y');
        return;
      }
      if (isApprovalDismissKey(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        void decide(false);
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previousFocus?.focus();
    };
  }, [decide, resolvedElsewhere, outcome]);
  if (outcome || resolvedElsewhere) {
    return (
      <article className="approval-card approval-card--inline approval-card--resolved" role="status">
        <div className="approval-heading">
          <span>
            <ShieldAlert size={16} />
          </span>
          <div>
            {outcome ? (
              <b>
                {outcome.approved
                  ? t('Allowed from {{device}}', { device: outcome.device })
                  : t('Denied from {{device}}', { device: outcome.device })}
              </b>
            ) : (
              <>
                <b>{t('Resolved on another device')}</b>
                {elsewhereDevice && <small>{t('from {{device}}', { device: elsewhereDevice })}</small>}
              </>
            )}
          </div>
        </div>
      </article>
    );
  }
  // Inline approval: the request renders in the
  // transcript flow with a warning ring instead of a modal overlay, so the
  // user can keep reading and typing while deciding.
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <article> must keep its tag; role="group" names the approval region
    <article
      ref={dialog}
      className="approval-card approval-card--inline"
      role="group"
      aria-labelledby="approval-title"
      aria-describedby="approval-description"
    >
      {/* Icon column + title on one row; the reason and the call itself hang
          from the title's left edge, and the decision sits under them. */}
      <div className="approval-heading">
        <span>
          <ShieldAlert size={16} />
        </span>
        <div>
          <b id="approval-title">{officeTransaction ? t('Office transaction review') : t('Tool approval required')}</b>
          <small>
            {officeTransaction ? actionLabel : t('{{name}} wants to run', { name: String(approval.name || t('Tool')) })}
          </small>
        </div>
      </div>
      <div className="approval-body">
        <p id="approval-description">{reason}</p>
        {detail && <pre className="approval-detail">{detail}</pre>}
        {officeTransaction && (
          <dl>
            {Boolean(args?.document) && (
              <>
                <dt>{t('Document')}</dt>
                <dd>
                  <code>{String(args?.document)}</code>
                </dd>
              </>
            )}
            {Boolean(transaction?.id) && (
              <>
                <dt>{t('Transaction')}</dt>
                <dd>
                  <code>{String(transaction?.id)}</code>
                </dd>
              </>
            )}
            {summary && (
              <>
                <dt>{t('Changes')}</dt>
                <dd>
                  {t('{{total}} paths · +{{added}} −{{removed}} ~{{modified}}', {
                    total: Number(summary.total || 0),
                    added: Number(summary.added || 0),
                    removed: Number(summary.removed || 0),
                    modified: Number(summary.modified || 0),
                  })}
                </dd>
              </>
            )}
            {Boolean(preview?.output) && (
              <>
                <dt>{t('Preview')}</dt>
                <dd>
                  <code>{String(preview?.output)}</code>
                </dd>
              </>
            )}
            {visualDiff?.available === true && (
              <>
                <dt>{t('Visual diff')}</dt>
                <dd>{t('{{percent}}% changed pixels', { percent: Number(visualDiff.changedPercent || 0) })}</dd>
              </>
            )}
          </dl>
        )}
        {officeTransaction && previewImages.length > 0 && (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the preview strip is a plain container labelled for assistive tech
          <div className="office-approval-preview" aria-label={t('Document preview')}>
            {previewImages.map((image, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: preview pages are positional and never reorder
              <figure key={`${String(image.path)}:${index}`}>
                <ApprovalPreviewImage
                  path={image.path}
                  alt={
                    image.kind === 'visual-diff'
                      ? t('Visual diff page {{page}}', { page: Number(image.page || index + 1) })
                      : t('Preview page {{page}}', { page: Number(image.page || index + 1) })
                  }
                />
                <figcaption>{image.kind === 'visual-diff' ? t('Visual diff') : t('Preview')}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {approvalError && <ErrorNotice error={approvalError} />}
      </div>
      <div className="approval-actions">
        <button type="button" disabled={resolving} className="deny" onClick={() => void decide(false)}>
          {officeTransaction ? t('Keep editing') : t('Deny')}
        </button>
        <button type="button" disabled={resolving} className="allow" onClick={() => void decide(true)}>
          {officeTransaction ? actionLabel : t('Allow')}
        </button>
      </div>
    </article>
  );
}

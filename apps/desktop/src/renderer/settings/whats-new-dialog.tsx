import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { version as appVersion } from '../../../package.json';
import MarkdownBody from '../MarkdownBody';
import { parseStreamingMarkdownAst } from '../markdown-worker-client';
import { t } from '../i18n';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { CopyControl } from '../transcript-primitives';
import { type ChangelogRelease, selectWhatsNew } from './changelog';
import { loadReleases } from './changelog-source';
import './changelog-dialog.css';

/** The running version's section in the UI language, parsed and ready to paint. */
export async function prepareWhatsNew(): Promise<ChangelogRelease | undefined> {
  const release = selectWhatsNew(await loadReleases(), appVersion);
  if (release) await parseStreamingMarkdownAst(release.body).then(() => undefined, () => undefined);
  return release;
}

export default function WhatsNewDialog({
  release,
  onClose,
  onViewAll,
}: {
  release: ChangelogRelease;
  onClose(): void;
  onViewAll(): void;
}) {
  const uid = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; keyboard dismissal is the dialog's close button and Escape.
    <div
      className="settings-confirm-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-confirm-dialog settings-changelog-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={`${uid}-title`}>{t('What’s new in {{version}}', { version: release.version })}</h3>
          <button ref={closeRef} type="button" aria-label={t('Close')} data-settings-nested-close onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard-focusable to scroll. */}
        <div className="settings-changelog-list" data-scrollable tabIndex={0}>
          <article className="settings-changelog-release">
            {release.date && <span className="settings-changelog-date">{release.date}</span>}
            <div className="markdown">
              <MarkdownBody text={release.body} copyControl={CopyControl} />
            </div>
          </article>
        </div>
        <footer>
          <button type="button" onClick={onViewAll}>
            {t('View all changes')}
          </button>
          <button type="button" onClick={onClose}>
            {t('Close')}
          </button>
        </footer>
      </section>
    </div>
  );
}

import { ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import changelogSource from '../../../../../CHANGELOG.md?raw';
import { version as appVersion } from '../../../package.json';
import MarkdownBody from '../MarkdownBody';
import { parseStreamingMarkdownAst } from '../markdown-worker-client';
import { t } from '../i18n';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { CopyControl } from '../transcript-primitives';
import { parseChangelog, type ChangelogRelease } from './changelog';
import './changelog-dialog.css';

const RELEASES = parseChangelog(changelogSource);

// Markdown parses off-thread; parse a release before it is shown so it opens
// fully rendered instead of growing a tick later.
const prepareRelease = (body: string) => parseStreamingMarkdownAst(body).then(() => undefined, () => undefined);

/** Resolves once the initially expanded (newest) release is ready to paint. */
export const prepareChangelog = () => (RELEASES[0] ? prepareRelease(RELEASES[0].body) : Promise.resolve());

export default function ChangelogDialog({ onClose }: { onClose(): void }) {
  const uid = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Newest release starts expanded; the rest stay collapsed until opened.
  const [open, setOpen] = useState(() => new Set(RELEASES.slice(0, 1).map((release) => release.version)));
  const toggle = (release: ChangelogRelease) => {
    const { version } = release;
    if (open.has(version)) {
      setOpen((current) => new Set([...current].filter((item) => item !== version)));
      return;
    }
    void prepareRelease(release.body).then(() => setOpen((current) => new Set(current).add(version)));
  };
  useMobileBack(true, onClose);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
  // Focus the dialog on open and give focus back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <div className="settings-confirm-layer">
      <section
        className="settings-confirm-dialog settings-changelog-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={`${uid}-title`}>{t('Changelog')}</h3>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('Close changelog')}
            data-settings-nested-close
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="settings-changelog-list" data-scrollable tabIndex={0}>
          {RELEASES.map((release) => {
            const expanded = open.has(release.version);
            const bodyId = `${uid}-${release.version}`;
            return (
              <article key={release.version} className="settings-changelog-release">
                <h4>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={bodyId}
                    onClick={() => toggle(release)}
                  >
                    <ChevronRight aria-hidden="true" size={14} className="settings-changelog-chevron" />
                    <span>{release.version}</span>
                    {release.date && <span className="settings-changelog-date">{release.date}</span>}
                    {release.version === `v${appVersion}` && (
                      <span className="settings-changelog-current">{t('Current version')}</span>
                    )}
                  </button>
                </h4>
                {expanded && (
                  <div id={bodyId} className="markdown">
                    <MarkdownBody text={release.body} copyControl={CopyControl} />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

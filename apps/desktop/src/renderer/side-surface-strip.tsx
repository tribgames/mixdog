import { ExternalLink, File as FileIcon, FolderOpen, PanelTop, Save } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from './i18n';
import './tab-strip.css';

/** What the side-dock file editor reports upward so the dock can draw the
 *  actions in its own strip instead of the editor's breadcrumb row. */
export interface SideFileChrome {
  /** False for previews, binaries and read-only files: no Save / Problems. */
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  /** Markdown / SVG / table files: the Preview (or Table) ⇄ Source switch. */
  viewToggle?: { value: 'rendered' | 'source'; renderedLabel: string; onChange(next: 'rendered' | 'source'): void };
  save(): void;
  reveal(): void;
  /** Previews and binaries: hand the file to the OS default app. */
  openDefault?(): void;
}

/** The ONE strip every side-dock surface shows under the dock header: the
 *  shared browser/terminal tab toolbar with the surface's subject as its
 *  single active chip, optional leading control, and actions at the right. */
export function SideChipStrip({
  label,
  name,
  title,
  icon: Glyph = FileIcon,
  leading,
  children,
}: {
  label: string;
  name: string;
  title: string;
  icon?: typeof FileIcon;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="browser-tab-toolbar" data-side-dock-strip="">
      {leading}
      <div className="browser-tab-list" role="tablist" aria-label={label}>
        <div className="browser-tab is-active">
          <button type="button" role="tab" aria-selected="true" className="browser-tab-select" title={title}>
            <Glyph size={14} aria-hidden="true" />
            <span>{name}</span>
          </button>
        </div>
      </div>
      <span className="browser-tab-trailing side-file-strip-actions">{children}</span>
    </div>
  );
}

/** The side-dock file strip: the open file as the chip, file actions right. */
export function SideFileStrip({
  rel,
  chrome,
  onOpenInMain,
}: {
  rel: string;
  chrome: SideFileChrome | null;
  onOpenInMain(): void;
}) {
  return (
    <SideChipStrip label={t('File')} name={rel.split('/').at(-1) ?? rel} title={rel}>
        {chrome?.viewToggle &&
          (['rendered', 'source'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="browser-pane-nav-button side-strip-text-button"
              aria-pressed={chrome.viewToggle?.value === mode}
              onClick={() => chrome.viewToggle?.onChange(mode)}
            >
              {mode === 'rendered' ? chrome.viewToggle?.renderedLabel : t('Source')}
            </button>
          ))}
        {chrome?.openDefault && (
          <button
            type="button"
            className="browser-pane-nav-button"
            aria-label={t('Open in default app')}
            data-tooltip={t('Open in default app')}
            onClick={chrome.openDefault}
          >
            <ExternalLink size={16} aria-hidden="true" />
          </button>
        )}
        {chrome?.editable && chrome.dirty && (
          <button
            type="button"
            className="browser-pane-nav-button"
            disabled={chrome.saving}
            aria-label={t('Save')}
            data-tooltip={t('Save (Ctrl+S)')}
            onClick={chrome.save}
          >
            <Save size={16} aria-hidden="true" />
          </button>
        )}
        {chrome && (
          <button
            type="button"
            className="browser-pane-nav-button"
            aria-label={t('Reveal in Explorer')}
            data-tooltip={t('Reveal in Explorer')}
            onClick={chrome.reveal}
          >
            <FolderOpen size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="browser-pane-nav-button"
          aria-label={t('Open in main tab')}
          data-tooltip={t('Open in main tab')}
          onClick={onOpenInMain}
        >
          <PanelTop size={16} aria-hidden="true" />
        </button>
    </SideChipStrip>
  );
}

import { CircleX, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { sideStatusLayout } from './side-file-status-layout';
import type { SideFileChrome } from './side-surface-strip';

/** Only text editors (code/md/csv/tsv) get the footer. Image/pdf/office/binary
 *  previews have none: the chip's tooltip already carries the path. */
export function sideFileHasFooter(chrome: SideFileChrome | null): boolean {
  return Boolean(chrome && (chrome.cursor || chrome.viewToggle));
}

/** The side file's footer / status bar (last row of the card, inside the
 *  rounded sheet). Left: the Preview|Source / Table|Source segmented toggle
 *  (md/csv/tsv). Right: problems counts (toggle the Problems split), cursor (go
 *  to line) and language — Source mode only, so a rendered view has an empty
 *  right side. The path lives in the chip's tooltip, not here. */
export function SideFileStatusRow({ chrome }: { chrome: SideFileChrome | null }) {
  const row = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = row.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setWidth(Math.round(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const toggle = chrome?.viewToggle;
  const layout = sideStatusLayout(width, Boolean(toggle));
  const problems = chrome?.editable ? chrome.problems : undefined;
  // Rendered table/markdown preview: nothing editor-related to report.
  const showStatus = toggle?.value !== 'rendered';
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <footer> nested in the pane has no contentinfo role; the explicit role names the side file's status row.
    <div ref={row} className="side-file-status-row" data-side-file-status="" role="contentinfo">
      {toggle && (
        <span className="side-file-view-toggle" role="radiogroup" aria-label={t('View mode')}>
          {(['rendered', 'source'] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={toggle.value === mode} onClick={() => toggle.onChange(mode)}>
              {mode === 'rendered' ? toggle.renderedLabel : t('Source')}
            </button>
          ))}
        </span>
      )}
      <div className="side-file-status-items">
        {!showStatus && chrome?.tableSize && (
          <span className="side-file-status-size">
            {t('{{rows}} rows × {{columns}} columns', {
              rows: chrome.tableSize.rows,
              columns: chrome.tableSize.columns,
            })}
          </span>
        )}
        {showStatus && problems && (
          <button
            type="button"
            className="side-file-status-problems"
            aria-label={t('Problems')}
            data-tooltip={t('{{errors}} Errors, {{warnings}} Warnings', {
              errors: problems.errors,
              warnings: problems.warnings,
            })}
            onClick={problems.onToggle}
          >
            <span className="editor-problems-count is-error" aria-hidden="true">
              <CircleX size={12} />
              <b>{problems.errors}</b>
            </span>
            <span className="editor-problems-count is-warning" aria-hidden="true">
              <TriangleAlert size={12} />
              <b>{problems.warnings}</b>
            </span>
          </button>
        )}
        {showStatus && chrome?.cursor && layout.cursor && (
          <button
            type="button"
            className="side-file-status-cursor"
            aria-label={t('Go to Line/Column')}
            data-tooltip={chrome.cursor.label}
            onClick={chrome.cursor.onGoto}
          >
            {chrome.cursor.short}
          </button>
        )}
        {showStatus && chrome?.language && layout.language && (
          <span className="side-file-status-language">{chrome.language}</span>
        )}
      </div>
    </div>
  );
}

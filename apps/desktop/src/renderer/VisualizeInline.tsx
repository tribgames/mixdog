// An inline (direct-renderer) visualize pane: the agent's Mermaid / SVG /
// chart / HTML / Markdown source drawn in a dead sandboxed frame (see
// visualize-inline.ts). A render failure shows the error and the source here
// and is reported to main, which lists it with the tab's page problems.
import { useEffect, useState } from 'react';

import type { VisualizePaneView } from '../shared/visualize';
import { t } from './i18n';
import {
  buildInlineDocument,
  INLINE_FRAME_SANDBOX,
  inlineThemeFromDocument,
  renderInlineContent,
} from './visualize-inline';

type InlineState = { status: 'loading' } | { status: 'ready'; doc: string } | { status: 'error'; error: string };

export function InlinePaneContent({
  pane,
  onRendered,
}: {
  pane: VisualizePaneView;
  /** Called once per mount with the failure, or nothing on success. */
  onRendered?(error?: string): void;
}) {
  const content = pane.inline;
  const [state, setState] = useState<InlineState>({ status: 'loading' });
  // State pushes hand over a fresh (deep-equal) content object each time, e.g.
  // the one a problem report itself triggers: only a change of what is drawn
  // renders again, so one render files one report.
  const kind = content?.kind;
  const source = content?.source;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the drawn kind and source; the callback is read once
  useEffect(() => {
    if (!content) return;
    let alive = true;
    const theme = inlineThemeFromDocument();
    void renderInlineContent(content, theme).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setState({ status: 'ready', doc: buildInlineDocument(result.html, theme) });
        onRendered?.();
      } else {
        setState({ status: 'error', error: result.error });
        onRendered?.(result.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [kind, source]);
  if (!content) return <div className="visualize-empty">{t('Nothing to show.')}</div>;
  if (state.status === 'loading') return <div className="visualize-empty">{t('Loading…')}</div>;
  if (state.status === 'error') {
    return (
      <div className="visualize-inline-error" role="alert">
        <strong>{t('Could not render the {{kind}}', { kind: content.kind })}</strong>
        <pre className="visualize-inline-error-message">{state.error}</pre>
        <span className="visualize-inline-error-label">{t('Source')}</span>
        <pre className="visualize-inline-error-source">{content.source}</pre>
      </div>
    );
  }
  return (
    <iframe
      title={pane.label}
      sandbox={INLINE_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={state.doc}
      data-visualize-inline={content.kind}
    />
  );
}

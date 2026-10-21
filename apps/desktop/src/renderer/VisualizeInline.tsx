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
import { framePointInWindow, watchPinch } from './visualize-zoom';
import { dispatchZoomAt } from './zoom-target';

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
      // A new render is a new frame: changing a loaded frame's srcdoc pushes
      // an in-frame history entry that takes the phone's Back press.
      key={state.doc}
      title={pane.label}
      sandbox={INLINE_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      allow="fullscreen"
      srcDoc={state.doc}
      data-visualize-inline={content.kind}
      onLoad={(event) => watchInlinePinch(event.currentTarget)}
    />
  );
}

const inlinePinches = new WeakMap<HTMLIFrameElement, () => void>();

/** A pinch inside the frame zooms the panel it is in. The frame runs no
 *  script, so the listener is this document's, on the frame's document
 *  (reachable: same origin, see INLINE_FRAME_SANDBOX); each load replaces it. */
function watchInlinePinch(frame: HTMLIFrameElement): void {
  inlinePinches.get(frame)?.();
  const doc = frame.contentDocument;
  if (!doc) return;
  inlinePinches.set(
    frame,
    watchPinch(
      doc,
      (point) => framePointInWindow(frame, point),
      (ratio, at) => dispatchZoomAt(ratio > 1 ? 'in' : 'out', at, undefined, ratio)
    )
  );
}

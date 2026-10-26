// A visualize pane's read-only source: highlighted, line-numbered, with a copy
// button. Inline content carries its source in the tab; an HTML file's text is
// read from the host (a kept version shows that version's file).
import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import type { VisualizePaneText, VisualizePaneView } from '../shared/visualize';
import { t } from './i18n';
import { highlightSourceLines, type SourceToken, visualizeSourceLanguage } from './visualize-source';

function Token({ token }: { token: SourceToken }) {
  return token.classes.reduceRight<ReactNode>(
    (child, className) => <span className={className}>{child}</span>,
    token.text
  );
}

export function VisualizeSource({
  pane,
  sessionId,
  tabId,
  index,
}: {
  pane: VisualizePaneView;
  sessionId: string;
  tabId: string;
  index: number;
}) {
  const [loaded, setLoaded] = useState<VisualizePaneText | null>(() =>
    pane.inline ? { text: pane.inline.source, truncated: false } : null
  );
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (pane.inline) return;
    let alive = true;
    const read = window.mixdogDesktop?.visualizePaneText;
    (read ? read(sessionId, tabId, index) : Promise.reject(new Error(t('Source unavailable')))).then(
      (text) => alive && setLoaded(text),
      (reason: unknown) => alive && setError(reason instanceof Error ? reason.message : String(reason))
    );
    return () => {
      alive = false;
    };
  }, [pane.inline, sessionId, tabId, index]);
  const text = loaded?.text ?? '';
  const language = visualizeSourceLanguage(pane.inline?.kind);
  const lines = useMemo(() => highlightSourceLines(text, language), [text, language]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (error) return <div className="visualize-empty">{error}</div>;
  if (!loaded) return <div className="visualize-empty">{t('Loading…')}</div>;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => {}
    );
  };
  return (
    <div className="visualize-source" data-visualize-source="">
      <div className="visualize-source-bar">
        <span className="visualize-source-note">
          {loaded.truncated ? t('The source is long; showing only the start.') : ''}
        </span>
        <button
          type="button"
          className="visualize-source-copy"
          aria-label={copied ? t('Copied') : t('Copy')}
          data-tooltip={copied ? t('Copied') : t('Copy')}
          onClick={copy}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
      <div className="visualize-source-code" tabIndex={0} role="region" aria-label={t('Source')}>
        {lines.map((line, number) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reordered.
          <div className="visualize-source-line" key={number}>
            <span className="visualize-source-no" aria-hidden="true">
              {number + 1}
            </span>
            <code>
              {line.length
                ? line.map((token, at) => <Token key={`${at}:${token.text.length}`} token={token} />)
                : '\u200b'}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

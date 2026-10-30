// Settings → Display → Composer: the composer style row and its live preview,
// built like Settings → Theme's: hovering or focusing a style changes only the
// preview; pressing it applies the style.
import { useState, useSyncExternalStore } from 'react';
import {
  getComposerStyle,
  setComposerStyle,
  subscribeComposerStyle,
  type ComposerStyle,
} from '../composer-style-preference';
import { t } from '../i18n';
import { Group } from './capability-controls';
import type { PanelContext } from './capability-data';
import { Segmented } from './skin-panel';
import './composer-style-preview.css';

// Sample figures: the preview shows the layout, not this device's usage.
const SAMPLE_USAGE = '27.4M · 87 tok/s · 98.1%';

function RouteSample() {
  return (
    <span className="csp-route">
      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="3.5" r="1.8" />
          <circle cx="3.5" cy="12.5" r="1.8" />
          <circle cx="12.5" cy="12.5" r="1.8" />
          <path d="M8 5.3v2.7M8 8L4.6 10.9M8 8l3.4 2.9" />
        </g>
      </svg>
      {/* The built-in workflow's own name, which is not translated. */}
      <span className="csp-workflow">Default · </span>
      {t('Swarm')}
    </span>
  );
}

function ModelSample() {
  return (
    <span className="csp-model">
      {t('Model')} <span className="csp-effort">High</span>
    </span>
  );
}

/** The two-row card: the typing band, then +, the model and send. */
function CardSample({ mic = false }: { mic?: boolean }) {
  return (
    <div className="csp-card">
      <div className="csp-band">{t('Message')}</div>
      <div className="csp-row">
        <span className="csp-plus">＋</span>
        <ModelSample />
        <span className="csp-gauge" />
        <span className="csp-actions">
          {mic && (
            <svg className="csp-mic" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
                <path d="M3 7.5a5 5 0 0010 0M8 12.5v2" />
              </g>
            </svg>
          )}
          <span className="csp-send">↑</span>
        </span>
      </div>
    </div>
  );
}

export function ComposerStylePreview({ style }: { style: ComposerStyle }) {
  const route = style === 'detail';
  return (
    <div className="csp" role="img" aria-label={t('Composer style preview')} data-style={style}>
      <div className="csp-frame">
        <span className="csp-caption">PC</span>
        <div className="csp-pc">
          <div className="csp-bubble" data-me="true" />
          <div className="csp-bubble" />
          {style === 'simple' ? (
            <CardSample />
          ) : (
            <>
              <div className="csp-bar">
                <span className="csp-plus">＋</span>
                <span className="csp-input" />
                <span className="csp-send">↑</span>
              </div>
              <div className="csp-line">
                <span className="csp-usage">{SAMPLE_USAGE}</span>
                <span className="csp-controls">
                  {route && <RouteSample />}
                  {route && <span className="csp-divider" />}
                  <ModelSample />
                  <span className="csp-gauge" />
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="csp-frame">
        <span className="csp-caption">{t('Phone')}</span>
        <div className="csp-phone">
          <div className="csp-bubble" data-me="true" />
          <div className="csp-bubble" />
          <CardSample mic />
          {style !== 'simple' && (
            <div className="csp-under" data-centred={route ? undefined : ''}>
              <span className="csp-usage">{SAMPLE_USAGE}</span>
              {route && <RouteSample />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Composer group: the preview, then the style row. Saved on this device. */
export function ComposerStyleGroup({ pending }: Pick<PanelContext, 'pending'>) {
  const style = useSyncExternalStore<ComposerStyle>(subscribeComposerStyle, getComposerStyle, () => 'basic');
  const [hover, setHover] = useState<ComposerStyle | null>(null);
  return (
    <Group title={t('Composer')}>
      <ComposerStylePreview style={hover ?? style} />
      <div className="mixdog-settings__row">
        <div className="mixdog-settings__copy">
          <span className="mixdog-settings__row-title">{t('Composer style')}</span>
          <span className="mixdog-settings__row-desc">
            {t('Simple: the model inside the input card only. Standard: usage too. Detailed: usage, workflow and delegation.')}
          </span>
        </div>
        <div className="settings-row-control">
          <Segmented<ComposerStyle>
            label={t('Composer style')}
            value={style}
            disabled={Boolean(pending)}
            options={[
              { value: 'simple', label: t('Simple') },
              { value: 'basic', label: t('Standard') },
              { value: 'detail', label: t('Detailed') },
            ]}
            onChange={setComposerStyle}
            onPreview={setHover}
          />
        </div>
      </div>
    </Group>
  );
}

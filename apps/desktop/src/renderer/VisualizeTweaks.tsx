// The visualize panel's Tweaks drawer: one compact control per parameter the
// active tab's page declared in its `mx-tweaks` block. A change is applied to
// the page live (the bridge in VisualizeFeedback.tsx sends it) and kept per
// tab, pane and version; "Use these values" queues the changed ones as a
// composer chip so the agent bakes them into the file.
import { ChevronUp, RotateCcw } from 'lucide-react';

import type { VisualizeTabView } from '../shared/visualize';
import { tweakChanges, tweakColorInputValue, tweakValueOf, type VisualizeTweak } from '../shared/visualize-tweaks';
import { t } from './i18n';
import { setVisualizeTweakSet, visualizePaneFile } from './visualize-feedback-store';
import {
  resetVisualizeTweaks,
  setVisualizeTweakValue,
  useVisualizeTweaksRevision,
  visualizePaneTweaks,
  visualizeTweakValues,
  visualizeTweakVersion,
} from './visualize-tweaks-store';
import './visualize-tweaks.css';

function TweakControl({
  tweak,
  value,
  onChange,
  onReset,
}: {
  tweak: VisualizeTweak;
  value: string;
  onChange(raw: string | boolean): void;
  onReset(): void;
}) {
  const moved = value !== tweak.default;
  const shown = tweak.type === 'range' ? `${value}${tweak.unit ?? ''}` : value;
  return (
    <div className="visualize-tweak">
      <span className="visualize-tweak-label">{tweak.label}</span>
      <span className="visualize-tweak-input">
        {tweak.type === 'color' ? (
          <input
            type="color"
            aria-label={tweak.label}
            value={tweakColorInputValue(value)}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        ) : tweak.type === 'range' ? (
          <input
            type="range"
            aria-label={tweak.label}
            min={tweak.min}
            max={tweak.max}
            step={tweak.step}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        ) : tweak.type === 'select' ? (
          <select aria-label={tweak.label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
            {tweak.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="checkbox"
            role="switch"
            aria-label={tweak.label}
            checked={value === 'true'}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
        )}
        {tweak.type === 'color' || tweak.type === 'range' ? (
          <span className="visualize-tweak-value">{shown}</span>
        ) : null}
      </span>
      <button
        type="button"
        className="visualize-tweak-reset"
        aria-label={t('Reset {{label}}', { label: tweak.label })}
        data-tooltip={t('Reset {{label}}', { label: tweak.label })}
        disabled={!moved}
        onClick={onReset}
      >
        <RotateCcw size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function VisualizeTweaksDrawer({
  sessionId,
  tab,
  onHide,
}: {
  sessionId: string;
  tab: VisualizeTabView;
  onHide(): void;
}) {
  useVisualizeTweaksRevision();
  const sections = tab.panes
    .map((pane, index) => ({
      pane,
      index,
      tweaks: visualizePaneTweaks(sessionId, tab.id, index),
      version: visualizeTweakVersion(tab, pane),
    }))
    .filter((section) => section.tweaks.length > 0)
    .map((section) => ({
      ...section,
      values: visualizeTweakValues(sessionId, tab.id, section.index, section.version),
    }));
  if (!sections.length) return null;
  const moved = sections.some((section) => tweakChanges(section.tweaks, section.values).length > 0);
  const use = () => {
    for (const section of sections) {
      setVisualizeTweakSet(sessionId, {
        tabId: tab.id,
        tabLabel: tab.label,
        pane: section.index,
        file: visualizePaneFile(section.pane),
        changes: tweakChanges(section.tweaks, section.values),
      });
    }
  };
  return (
    <div className="visualize-tweaks" role="group" aria-label={t('Tweaks')}>
      <div className="visualize-tweaks-head">
        <span className="visualize-tweaks-title">{t('Tweaks')}</span>
        <button
          type="button"
          className="visualize-tweaks-hide"
          aria-label={t('Hide tweaks')}
          data-tooltip={t('Hide tweaks')}
          onClick={onHide}
        >
          <ChevronUp size={14} aria-hidden="true" />
        </button>
      </div>
      {sections.map((section) => (
        <div key={section.index} className="visualize-tweaks-section">
          {sections.length > 1 && <div className="visualize-tweaks-pane">{section.pane.label}</div>}
          {section.tweaks.map((tweak) => (
            <TweakControl
              key={tweak.id}
              tweak={tweak}
              value={tweakValueOf(tweak, section.values)}
              onChange={(raw) => setVisualizeTweakValue(sessionId, tab.id, section.index, section.version, tweak, raw)}
              onReset={() => resetVisualizeTweaks(sessionId, tab.id, section.index, section.version, tweak.id)}
            />
          ))}
        </div>
      ))}
      <div className="visualize-tweaks-actions">
        <button
          type="button"
          disabled={!moved}
          onClick={() => {
            for (const section of sections) resetVisualizeTweaks(sessionId, tab.id, section.index, section.version);
          }}
        >
          {t('Reset all')}
        </button>
        <button type="button" className="is-primary" disabled={!moved} onClick={use}>
          {t('Use these values')}
        </button>
      </div>
    </div>
  );
}

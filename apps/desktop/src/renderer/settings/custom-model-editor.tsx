import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';

import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { OpenSelect } from '../OpenSelect';
import type { RecordValue } from './capability-data';
import { record } from '../record-utils';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { errorMessage } from '../editor-pane-session-errors';

export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const isLevel = (value: unknown): value is ReasoningLevel => REASONING_LEVELS.includes(value as ReasoningLevel);

/** Toggle one level; the result is always in ranked order and may be []. */
function toggleLevel(levels: readonly ReasoningLevel[], level: ReasoningLevel): ReasoningLevel[] {
  const next = levels.includes(level) ? levels.filter((item) => item !== level) : [...levels, level];
  return REASONING_LEVELS.filter((item) => next.includes(item));
}

function wireFormatOptions(protocol: string) {
  return [
    { value: 'standard', label: t('Standard') },
    ...(protocol === 'openai-chat' ? [{ value: 'deepseek', label: t('DeepSeek format') }] : []),
  ];
}

function effectiveLevels(row: RecordValue): ReasoningLevel[] {
  const source = Array.isArray(row.reasoningLevels)
    ? row.reasoningLevels
    : Array.isArray(row.reasoningOptions)
      ? row.reasoningOptions
      : [];
  return toggleLevelsFrom(source.filter(isLevel));
}
const toggleLevelsFrom = (levels: ReasoningLevel[]) => REASONING_LEVELS.filter((item) => levels.includes(item));

type Patch = Record<string, unknown>;

/**
 * Per-model editor. Only touched fields are sent: a value replaces the
 * override, null resets it to the inherited value.
 */
export function CustomModelEditor({
  providerId,
  protocol,
  row,
  override,
  run,
  onClose,
  onSaved,
}: {
  providerId: string;
  protocol: string;
  row: RecordValue;
  override?: RecordValue;
  run: (capability: any, args?: unknown[], key?: string, refresh?: boolean, ...rest: any[]) => Promise<unknown>;
  onClose(): void;
  /** Receives the save's answer: the provider row as stored. */
  onSaved?(provider: RecordValue): void;
}) {
  const uid = useId();
  const modelId = String(row.id);
  const ov = override ?? {};
  const ovReasoning = record(ov.reasoning);
  // The stored override is what the model runs with, also when `row` predates
  // it: discovered rows reload only on the next discovery.
  const current: RecordValue = { ...row, ...ov };
  if (Array.isArray(ovReasoning.levels)) current.reasoningLevels = ovReasoning.levels;
  const custom = { ...record(row.customReasoning), ...ovReasoning };
  // Top-level patch and reasoning patch; a null value means "reset".
  const [patch, setPatch] = useState<Patch>({});
  const [reasoning, setReasoning] = useState<Patch>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const close = () => {
    if (!saving) onClose();
  };
  useMobileBack(true, close);
  useEffect(() => acquireTitleBarDim(), []);

  const has = (patchObj: Patch, key: string) => key in patchObj;
  const set = (key: string, value: unknown) => {
    setPatch((prev) => ({ ...prev, [key]: value }));
    setError('');
  };
  const setR = (key: string, value: unknown) => {
    setReasoning((prev) => ({ ...prev, [key]: value }));
    setError('');
  };
  const inherited = (key: string) => has(patch, key) && patch[key] === null;

  const hidden = has(patch, 'hidden') && patch.hidden !== null ? Boolean(patch.hidden) : current.hidden === true;
  const text = (key: 'name' | 'contextWindow' | 'maxOutputTokens', rowKey: string) => {
    if (has(patch, key) && patch[key] !== null) return String(patch[key]);
    if (inherited(key)) return '';
    return current[rowKey] === undefined || current[rowKey] === null ? '' : String(current[rowKey]);
  };
  const levels: ReasoningLevel[] =
    has(reasoning, 'levels') && reasoning.levels !== null
      ? (reasoning.levels as ReasoningLevel[])
      : effectiveLevels(current);
  const wireFormat =
    has(reasoning, 'wireFormat') && reasoning.wireFormat !== null
      ? String(reasoning.wireFormat)
      : String(custom.wireFormat || 'standard');
  const wireValues = (
    has(reasoning, 'wireValues') && reasoning.wireValues !== null ? reasoning.wireValues : (custom.wireValues ?? {})
  ) as Record<string, string>;
  const replay =
    has(reasoning, 'replay') && reasoning.replay !== null ? Boolean(reasoning.replay) : custom.replay === true;

  // Tri-state image input: no override = Auto (catalog / default), else on / off.
  const visionValue = has(patch, 'supportsVision') ? patch.supportsVision : ov.supportsVision;
  const visionChoice = visionValue === true ? 'on' : visionValue === false ? 'off' : 'auto';
  const visionOptions = [
    { value: 'auto', label: t('Auto') },
    { value: 'on', label: t('On') },
    { value: 'off', label: t('Off') },
  ];

  const overridden = (value: unknown) => value !== undefined;
  const reset = (apply: () => void, isOverridden: boolean, touched: boolean, label: string) => (
    <button
      type="button"
      className="secondary settings-model-reset"
      disabled={saving || (!isOverridden && !touched)}
      aria-label={t('Reset {{name}} to inherited', { name: label })}
      onClick={apply}
    >
      {t('Reset')}
    </button>
  );
  const badge = (isOverridden: boolean, touched: boolean) => (
    <small className="settings-model-source">{touched || isOverridden ? t('Override') : t('Inherited')}</small>
  );

  const save = async () => {
    const out: Patch = { ...patch };
    for (const key of ['contextWindow', 'maxOutputTokens']) {
      const value = out[key];
      if (value === undefined || value === null) continue;
      const parsed = Number(String(value).trim());
      if (String(value).trim() === '') out[key] = null;
      else if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        setError(t('{{name}} must be a positive whole number.', { name: key }));
        return;
      } else out[key] = parsed;
    }
    if (typeof out.name === 'string') out.name = out.name.trim() || null;
    if (Object.keys(reasoning).length) {
      const next: Patch = { ...reasoning };
      const pruned = (values: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(values).filter(
            ([level, value]) => levels.includes(level as ReasoningLevel) && String(value).trim() !== ''
          )
        );
      if (next.wireValues && typeof next.wireValues === 'object') {
        next.wireValues = pruned(next.wireValues as Record<string, string>);
      } else if (Array.isArray(next.levels) && !has(next, 'wireValues')) {
        // New levels drop the wire values of levels no longer listed.
        const kept = pruned(wireValues);
        if (Object.keys(kept).length !== Object.keys(wireValues).length)
          next.wireValues = Object.keys(kept).length ? kept : null;
      }
      out.reasoning = next;
    }
    if (!Object.keys(out).length) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const saved = await run(
        'updateCustomProviderModel',
        [providerId, modelId, out],
        `custom-model-${uid}`,
        true,
        true,
        'throw'
      );
      onSaved?.(record(saved));
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };

  const idp = `${uid}-`;
  const numberField = (key: 'contextWindow' | 'maxOutputTokens', rowKey: string, label: string) => (
    <>
      <label htmlFor={idp + key}>{label}</label>
      <div className="settings-model-field">
        <input
          id={idp + key}
          inputMode="numeric"
          value={text(key, rowKey)}
          disabled={saving}
          onChange={(event) => set(key, event.target.value)}
        />
        {badge(overridden(ov[key]), has(patch, key) && patch[key] !== null)}
        {reset(() => set(key, null), overridden(ov[key]), has(patch, key), label)}
      </div>
    </>
  );

  return (
    // Scrim click-to-dismiss; keyboard dismissal is the close button and Escape.
    <div className="settings-oauth-layer" {...scrimDismiss(close)}>
      <section
        className="settings-oauth-dialog settings-custom-provider-dialog settings-model-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${idp}title`}
        data-settings-nested-dialog
      >
        <header>
          <div>
            <h3 id={`${idp}title`}>{t('Edit model {{name}}', { name: modelId })}</h3>
          </div>
          <button type="button" aria-label={t('Close')} data-settings-nested-close disabled={saving} onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="settings-custom-provider-form settings-model-form">
          <label className="settings-model-check">
            <input
              type="checkbox"
              checked={hidden}
              disabled={saving}
              onChange={(event) => set('hidden', event.target.checked)}
            />
            {t('Hide this model')}
          </label>
          <label htmlFor={`${idp}name`}>{t('Display name')}</label>
          <div className="settings-model-field">
            <input
              id={`${idp}name`}
              value={text('name', 'name')}
              disabled={saving}
              onChange={(event) => set('name', event.target.value)}
            />
            {badge(overridden(ov.name), has(patch, 'name') && patch.name !== null)}
            {reset(() => set('name', null), overridden(ov.name), has(patch, 'name'), t('Display name'))}
          </div>
          {numberField('contextWindow', 'contextWindow', t('Context window'))}
          {numberField('maxOutputTokens', 'maxOutputTokens', t('Max output tokens'))}
          <span className="settings-model-label">{t('Image input')}</span>
          <div className="settings-model-field">
            <OpenSelect
              className="settings-select"
              ariaLabel={t('Image input')}
              value={visionChoice}
              disabled={saving}
              options={visionOptions}
              onChange={(value) => set('supportsVision', value === 'on' ? true : value === 'off' ? false : null)}
            />
            {badge(overridden(ov.supportsVision), has(patch, 'supportsVision') && patch.supportsVision !== null)}
            {reset(
              () => set('supportsVision', null),
              overridden(ov.supportsVision),
              has(patch, 'supportsVision'),
              t('Image input')
            )}
          </div>

          <fieldset className="settings-model-reasoning">
            <legend>{t('Reasoning levels')}</legend>
            <div className="settings-model-chips" role="group" aria-label={t('Reasoning levels')}>
              {REASONING_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className="settings-model-chip"
                  aria-pressed={levels.includes(level)}
                  disabled={saving}
                  onClick={() => setR('levels', toggleLevel(levels, level))}
                >
                  {level}
                </button>
              ))}
            </div>
            <div className="settings-model-field">
              {badge(overridden(ovReasoning.levels), has(reasoning, 'levels') && reasoning.levels !== null)}
              {reset(
                () => setR('levels', null),
                overridden(ovReasoning.levels),
                has(reasoning, 'levels'),
                t('Reasoning levels')
              )}
            </div>
            <label>{t('Wire format')}</label>
            <div className="settings-model-field">
              <OpenSelect
                className="settings-select"
                ariaLabel={t('Wire format')}
                value={wireFormat}
                disabled={saving}
                options={wireFormatOptions(protocol)}
                onChange={(value) => setR('wireFormat', value)}
              />
              {badge(overridden(ovReasoning.wireFormat), has(reasoning, 'wireFormat') && reasoning.wireFormat !== null)}
              {reset(
                () => setR('wireFormat', null),
                overridden(ovReasoning.wireFormat),
                has(reasoning, 'wireFormat'),
                t('Wire format')
              )}
            </div>
            {levels.map((level) => (
              <div className="settings-model-field" key={level}>
                <label htmlFor={`${idp}wire-${level}`}>{t('Wire value for {{level}}', { level })}</label>
                <input
                  id={`${idp}wire-${level}`}
                  value={wireValues[level] ?? ''}
                  disabled={saving}
                  autoComplete="off"
                  onChange={(event) => setR('wireValues', { ...wireValues, [level]: event.target.value })}
                />
              </div>
            ))}
            <div className="settings-model-field">
              {badge(overridden(ovReasoning.wireValues), has(reasoning, 'wireValues') && reasoning.wireValues !== null)}
              {reset(
                () => setR('wireValues', null),
                overridden(ovReasoning.wireValues),
                has(reasoning, 'wireValues'),
                t('Wire values')
              )}
            </div>
            <label className="settings-model-check">
              <input
                type="checkbox"
                checked={replay}
                disabled={saving}
                onChange={(event) => setR('replay', event.target.checked)}
              />
              {t('Replay reasoning content')}
            </label>
            <div className="settings-model-field">
              {badge(overridden(ovReasoning.replay), has(reasoning, 'replay') && reasoning.replay !== null)}
              {reset(
                () => setR('replay', null),
                overridden(ovReasoning.replay),
                has(reasoning, 'replay'),
                t('Replay reasoning content')
              )}
            </div>
          </fieldset>
          <div aria-live="polite">
            {error && (
              <p className="settings-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        <footer>
          <button type="button" className="secondary" disabled={saving} onClick={close}>
            {t('Cancel')}
          </button>
          <button type="button" disabled={saving} onClick={() => void save()}>
            {t('Save')}
          </button>
        </footer>
      </section>
    </div>
  );
}

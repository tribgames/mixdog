import { type ReactNode, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';

import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { OpenSelect } from '../OpenSelect';
import { CompactSwitch } from './capability-controls';
import type { RecordValue } from './capability-data';
import { record } from '../record-utils';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { errorMessage } from '../editor-pane-session-errors';
import { pairRecord, pairRows, type PairRow } from './pair-list-rows';
import {
  blockedModelHeader,
  ModelRequestHeaders,
  parseRequestBody,
  RequestBodyField,
  requestBodyText,
  RequestOptionsSection,
} from './custom-request-options';

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
  const storedBody = requestBodyText(ov.requestBody);
  const storedHeaders = pairRows(ov.requestHeaders);
  const [bodyText, setBodyText] = useState(storedBody);
  const [headerRows, setHeaderRows] = useState<PairRow[]>(storedHeaders);
  const bodyError = parseRequestBody(bodyText).error;
  const requestInvalid = bodyError !== '' || blockedModelHeader(headerRows) !== '';
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
  const overridden = (value: unknown) => value !== undefined;
  /** Whether the model overrides `key`: the pending patch decides, else the stored override. */
  const overrides = (patchObj: Patch, stored: RecordValue, key: string) =>
    has(patchObj, key) ? patchObj[key] !== null : overridden(stored[key]);

  const hidden = has(patch, 'hidden') && patch.hidden !== null ? Boolean(patch.hidden) : current.hidden === true;
  // An override shows as the field's text; an inherited value only as its placeholder.
  const text = (key: 'name' | 'contextWindow' | 'maxOutputTokens') => {
    if (has(patch, key)) return patch[key] === null ? '' : String(patch[key]);
    return overridden(ov[key]) ? String(ov[key]) : '';
  };
  const inheritedText = (key: 'name' | 'contextWindow' | 'maxOutputTokens') => {
    // `row` carries the applied override; `row.inherited` is the value without it.
    const value = record(row.inherited)[key];
    return overrides(patch, ov, key) || !value ? t('Inherited') : String(value);
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

  // The levels row shows a short summary; a model that never set any inherits.
  const levelsSummary = levels.length
    ? levels.join(' · ')
    : overrides(reasoning, ovReasoning, 'levels')
      ? t('None')
      : t('Inherited');

  // Tri-state image input: no override = Auto (catalog / default), else on / off.
  const visionValue = has(patch, 'supportsVision') ? patch.supportsVision : ov.supportsVision;
  const visionChoice = visionValue === true ? 'on' : visionValue === false ? 'off' : 'auto';
  const visionOptions = [
    { value: 'auto', label: t('Auto') },
    { value: 'on', label: t('On') },
    { value: 'off', label: t('Off') },
  ];

  // A field's reset action exists only while the model overrides that field.
  const reset = (apply: () => void, isOverride: boolean, label: string) =>
    isOverride && (
      <button
        type="button"
        className="settings-action settings-model-reset"
        disabled={saving}
        aria-label={t('Reset {{name}} to inherited', { name: label })}
        onClick={apply}
      >
        {t('Reset')}
      </button>
    );
  // A field's title row: label (or plain title) at the left, its control and reset at the right.
  const head = (label: string, htmlFor: string | null, resetButton: ReactNode, control?: ReactNode) => (
    <div className="settings-custom-provider-key-row">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="settings-model-label">{label}</span>}
      <div className="settings-model-actions">
        {control}
        {resetButton}
      </div>
    </div>
  );
  // A few options, one chosen: the shared segmented control (pressed = chosen).
  const segmented = (
    label: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    chosen: string,
    onChoose: (value: string) => void
  ) => (
    // biome-ignore lint/a11y/useSemanticElements: a div button group, same as the API key source picker.
    <div className="mx-segmented mx-segmented-compact" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={chosen === option.value}
          disabled={saving}
          onClick={() => onChoose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  // On / off: the settings switch with its title, reset at the far end.
  const switchRow = (label: string, checked: boolean, onChange: (value: boolean) => void, resetButton?: ReactNode) => (
    <div className="settings-model-check">
      <CompactSwitch label={label} checked={checked} disabled={saving} optimistic={false} onChange={onChange} />
      <span>{label}</span>
      {resetButton}
    </div>
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
    // A null patch value resets the stored override to inherited.
    if (bodyText !== storedBody) {
      const { value } = parseRequestBody(bodyText);
      out.requestBody = Object.keys(value).length ? value : null;
    }
    if (JSON.stringify(headerRows) !== JSON.stringify(storedHeaders)) {
      let values: Record<string, string>;
      try {
        values = pairRecord(headerRows, t('Headers for this model only'));
      } catch (reason) {
        setError(errorMessage(reason));
        return;
      }
      out.requestHeaders = Object.keys(values).length ? values : null;
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
  const numberField = (key: 'contextWindow' | 'maxOutputTokens', label: string) => (
    <>
      {head(
        label,
        idp + key,
        reset(() => set(key, null), overrides(patch, ov, key), label)
      )}
      <input
        id={idp + key}
        inputMode="numeric"
        value={text(key)}
        placeholder={inheritedText(key)}
        disabled={saving}
        autoComplete="off"
        onChange={(event) => set(key, event.target.value)}
      />
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
          {switchRow(t('Hide this model'), hidden, (next) => set('hidden', next))}
          {head(
            t('Display name'),
            `${idp}name`,
            reset(() => set('name', null), overrides(patch, ov, 'name'), t('Display name'))
          )}
          <input
            id={`${idp}name`}
            value={text('name')}
            placeholder={inheritedText('name')}
            disabled={saving}
            autoComplete="off"
            onChange={(event) => set('name', event.target.value)}
          />
          {numberField('contextWindow', t('Context window'))}
          {numberField('maxOutputTokens', t('Max output tokens'))}
          {head(
            t('Image input'),
            null,
            reset(() => set('supportsVision', null), overrides(patch, ov, 'supportsVision'), t('Image input')),
            segmented(t('Image input'), visionOptions, visionChoice, (value) =>
              set('supportsVision', value === 'on' ? true : value === 'off' ? false : null)
            )
          )}
          {head(
            t('Reasoning levels'),
            null,
            reset(() => setR('levels', null), overrides(reasoning, ovReasoning, 'levels'), t('Reasoning levels')),
            // A checklist menu: the app's select menu in multi-select mode.
            <OpenSelect
              className="settings-select"
              ariaLabel={t('Reasoning levels')}
              multiple
              values={levels}
              displayValue={levelsSummary}
              disabled={saving}
              menuMinWidth={180}
              options={REASONING_LEVELS.map((level) => ({ value: level, label: level }))}
              onChange={(level) => setR('levels', toggleLevel(levels, level as ReasoningLevel))}
            />
          )}
          <RequestOptionsSection
            hasValue={
              storedBody !== '' ||
              storedHeaders.length > 0 ||
              ['wireFormat', 'wireValues', 'replay'].some((key) => overridden(ovReasoning[key]))
            }
            hasError={requestInvalid}
          >
            <span className="settings-model-label">{t('Reasoning format')}</span>
            {head(
              t('Wire format'),
              null,
              reset(() => setR('wireFormat', null), overrides(reasoning, ovReasoning, 'wireFormat'), t('Wire format')),
              segmented(t('Wire format'), wireFormatOptions(protocol), wireFormat, (value) => setR('wireFormat', value))
            )}
            {levels.length > 0 &&
              head(
                t('Wire values'),
                null,
                reset(() => setR('wireValues', null), overrides(reasoning, ovReasoning, 'wireValues'), t('Wire values'))
              )}
            {levels.map((level) => (
              <div className="settings-custom-provider-key-row" key={level}>
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
            {switchRow(
              t('Replay reasoning content'),
              replay,
              (next) => setR('replay', next),
              reset(
                () => setR('replay', null),
                overrides(reasoning, ovReasoning, 'replay'),
                t('Replay reasoning content')
              )
            )}
            <span className="settings-model-label">{t('Extra request')}</span>
            <RequestBodyField
              id={`${idp}request`}
              text={bodyText}
              disabled={saving}
              error={bodyError}
              hint={t('A JSON object merged into this model request. It wins over the provider setting.')}
              onChange={(next) => {
                setBodyText(next);
                setError('');
              }}
            />
            <ModelRequestHeaders
              rows={headerRows}
              disabled={saving}
              onChange={(next) => {
                setHeaderRows(next);
                setError('');
              }}
            />
          </RequestOptionsSection>
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
          <button type="button" disabled={saving || requestInvalid} onClick={() => void save()}>
            {t('Save')}
          </button>
        </footer>
      </section>
    </div>
  );
}

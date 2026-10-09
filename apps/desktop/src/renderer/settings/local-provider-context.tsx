import { t } from '../i18n';
import { OpenSelect } from '../OpenSelect';
import type { RecordValue } from './capability-data';
import type { LocalProviderActions } from './local-provider-actions';

const CONTEXT_PRESETS = [16384, 32768, 65536, 131072, 262144];
const RECOMMENDED_CONTEXT = 32768;

export function contextSize(tokens: unknown): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1024 ? `${Math.round(value / 1024)}K` : String(value);
}

/** Context size as a preset picker: the model default (empty value) plus the
 *  standard sizes the model supports. Choosing one applies it at once; an
 *  active model reloads after its current requests finish. */
export function LocalProviderContext({ model, actions }: { model: RecordValue; actions: LocalProviderActions }) {
  const id = String(model.id);
  const minimum = Number(model.minContextWindow) || 16384;
  const maximum = Number(model.maxContextWindow || model.contextWindow);
  const current = Number(model.contextWindow);
  if (!Number.isSafeInteger(maximum) || maximum < minimum) return <>{contextSize(current)}</>;
  const configured = model.configuredContextWindow == null ? '' : String(model.configuredContextWindow);
  const sizes = new Set(CONTEXT_PRESETS.filter((size) => size >= minimum && size <= maximum));
  if (configured) sizes.add(Number(configured));
  const label = (size: number) =>
    size === RECOMMENDED_CONTEXT ? t('{{size}} · recommended', { size: contextSize(size) }) : contextSize(size);
  const options = [
    { value: '', label: t('Default ({{label}})', { label: contextSize(model.defaultContextWindow || current) }) },
    ...[...sizes].sort((a, b) => a - b).map((size) => ({ value: String(size), label: label(size) })),
  ];
  return (
    <OpenSelect
      className="extensions-select local-provider-context"
      ariaLabel={`${String(model.name || id)} · ${t('Context size')}`}
      tooltip={t('32K or more is recommended for agent work.')}
      value={configured}
      displayValue={contextSize(current)}
      options={options}
      disabled={actions.busy}
      onChange={(value) => void actions.setContext(id, value === '' ? null : Number(value))}
    />
  );
}

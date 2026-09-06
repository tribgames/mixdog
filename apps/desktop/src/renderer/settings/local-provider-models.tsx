import { t } from '../i18n';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import { OpenSelect } from '../OpenSelect';
import { ExtensionItemRow, ExtensionSection } from './extension-detail';
import { LocalProviderOperations, localIdleLabel, type LocalProviderActions } from './local-provider-operations';
import { LocalProviderModelRow } from './local-provider-model-row';

export function localProviderFileSize(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}

function contextSize(tokens: unknown): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1024 ? `${Math.round(value / 1024)}K context` : `${value} context`;
}

export function LocalProviderModels({ status, actions }: {
  status: RecordValue;
  actions: LocalProviderActions;
}) {
  const models = Array.isArray(status.models) ? status.models.map(record) : [];
  const installed = models.filter((model) => model.installed === true || model.present === true);
  const ttl = typeof status.idleTtlSeconds === 'number' ? status.idleTtlSeconds : 3600;
  const presets = [...new Set([0, 300, 900, 3600, ttl])].sort((a, b) => a - b);
  return <>
  <ExtensionSection title={t('Installed models')} count={installed.length}>
    {!installed.length && <p className="extensions-mcp-note">
      {t('No models installed.')} {t('To add a model, ask in chat. The local-provider skill checks your PC and guides installation.')}
    </p>}
    {installed.length > 0 && <div className="extensions-item-list">
      {installed.map((model) => {
        const modelId = String(model.id);
        const details = [
          localProviderFileSize(model.sizeBytes),
          `~${localProviderFileSize(model.estimatedVramBytes)} VRAM`,
          contextSize(model.contextWindow),
        ].filter(Boolean).join(' · ');
        return <LocalProviderModelRow key={modelId} model={model} status={status} actions={actions} details={details} />;
      })}
    </div>}
    <ExtensionItemRow title={t('Auto-unload when idle')}
      description={t('Active requests and queued work keep the model loaded.')}
      control={<OpenSelect className="settings-select" ariaLabel={t('Auto-unload when idle')}
        value={String(ttl)} disabled={actions.busy}
        options={presets.map((seconds) => ({ value: String(seconds), label: localIdleLabel(seconds) }))}
        onChange={(value) => actions.setIdleTtl(Number(value))} />} />
  </ExtensionSection>
  <LocalProviderOperations status={status} actions={actions} />
  </>;
}

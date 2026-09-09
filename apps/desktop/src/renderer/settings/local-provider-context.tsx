import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { RecordValue } from './capability-data';
import type { LocalProviderActions } from './local-provider-operations';
import { ExtensionAction } from './extension-detail';

export function LocalProviderContext({ model, status, actions }: {
  model: RecordValue; status: RecordValue; actions: LocalProviderActions;
}) {
  const saved = model.configuredContextWindow == null ? '' : String(model.configuredContextWindow);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const maximum = Number(model.maxContextWindow || model.contextWindow);
  if (!Number.isSafeInteger(maximum) || maximum < 512) return null;
  const tokens = draft.trim() === '' ? null : Number(draft);
  const valid = tokens === null || (/^\d+$/.test(draft) && Number.isSafeInteger(tokens) && tokens >= 512 && tokens <= maximum);
  const active = status.activeModel === model.id && (status.running === true || status.starting === true);
  const waiting = Number(status.activeRequests) > 0 || Number(status.queuedRequests) > 0;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="text" inputMode="numeric" aria-label={`${String(model.name || model.id)} · ${t('Context size')}`}
          aria-invalid={!valid} value={draft} disabled={actions.busy}
          title={`${t('Context size')} · ${t('Up to {{maximum}} tokens.', { maximum })} ${t('Automatic (recommended)')}: ${String(model.defaultContextWindow || model.contextWindow)}`}
          placeholder={String(model.defaultContextWindow || model.contextWindow)}
          style={{ width: 120 }} onChange={(event) => setDraft(event.target.value)} />
        <ExtensionAction disabled={actions.busy || !valid || draft === saved}
          onClick={() => void actions.setContext(String(model.id), tokens)}>
          <span title={waiting ? t('Apply after current requests finish') : active ? t('Apply and reload') : undefined}>
            {actions.busy ? t('Saving…') : t('Apply')}
          </span>
        </ExtensionAction>
      </div>
      {!valid && <small role="alert">{t('Enter an integer from 512 to {{maximum}}.', { maximum })}</small>}
    </div>;
}

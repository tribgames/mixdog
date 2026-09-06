import { useState } from 'react';
import { Cpu } from 'lucide-react';
import { t } from '../i18n';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import { ExtensionAction, ExtensionItemRow } from './extension-detail';
import { SettingsConfirmDialog } from './capability-controls';
import type { LocalProviderActions } from './local-provider-operations';

/** One installed model as a plain list item: name, size facts, state and a
 *  delete control. Repair and verification stay chat-driven via the
 *  local-provider skill so the card carries no maintenance clutter. */
export function LocalProviderModelRow({ model, status, actions, details }: {
  model: RecordValue; status: RecordValue; actions: LocalProviderActions; details: string;
}) {
  const [confirmation, setConfirmation] = useState<Parameters<typeof SettingsConfirmDialog>[0]['options'] | null>(null);
  const id = String(model.id), name = String(model.name || id);
  const inUse = status.activeModel === id && (status.running === true || status.starting === true);
  const jobActive = Array.isArray(status.installations) && status.installations.map(record)
    .some((job) => job.modelId === id && ['running', 'cancelling'].includes(String(job.state)));
  const broken = model.installed !== true || record(model.verification).valid === false;
  const label = model.installed !== true ? t('Needs repair')
    : record(model.verification).valid === false ? t('Integrity check failed')
    : inUse && status.starting ? t('Loading model…') : inUse ? t('Running') : t('Installed');
  const requestDelete = async () => {
    const receipt = record(await actions.details(id));
    if (!receipt.confirmationToken || !Array.isArray(receipt.files)) return;
    const paths = receipt.files.map(record).map((file) => String(file.path)).join('\n');
    setConfirmation({
      title: 'Delete model?', danger: true, confirmLabel: 'Delete',
      description: `${name}\n${paths}\n${t('Permanently deletes these files. Recovery requires downloading the model again.')}`,
      onConfirm: () => actions.deleteModel(String(receipt.confirmationToken)),
    });
  };
  return <>
    <ExtensionItemRow icon={<Cpu size={15} aria-hidden="true" />} title={name} description={details}
      tone={broken ? 'warn' : inUse ? 'ok' : 'muted'} status={label}
      control={<ExtensionAction danger disabled={actions.busy || jobActive || inUse}
        onClick={() => void requestDelete()}>{t('Delete')}</ExtensionAction>} />
    {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
  </>;
}

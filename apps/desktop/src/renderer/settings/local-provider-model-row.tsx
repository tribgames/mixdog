import { useState } from 'react';
import { Cpu } from 'lucide-react';
import { t } from '../i18n';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import { ExtensionAction, ExtensionItemRow } from './extension-detail';
import { SettingsConfirmDialog } from './capability-controls';
import type { LocalProviderActions } from './local-provider-operations';
import { LocalProviderContext } from './local-provider-context';
import { installationActive } from './local-provider-status';

/** One installed model as a plain list item: name, size facts, state,
 *  context controls and deletion. Repair and verification stay chat-driven via the
 *  local-provider skill so the card carries no maintenance clutter. */
export function LocalProviderModelRow({
  model,
  status,
  actions,
  details,
}: {
  model: RecordValue;
  status: RecordValue;
  actions: LocalProviderActions;
  details: string;
}) {
  const [confirmation, setConfirmation] = useState<Parameters<typeof SettingsConfirmDialog>[0]['options'] | null>(null);
  const id = String(model.id),
    name = String(model.name || id);
  const inUse = status.activeModel === id && (status.running === true || status.starting === true);
  const jobActive =
    Array.isArray(status.installations) &&
    status.installations.map(record).some((job) => job.modelId === id && installationActive(job));
  const broken = model.installed !== true || record(model.verification).valid === false;
  let label = t('Installed');
  if (model.installed !== true) label = t('Needs repair');
  else if (record(model.verification).valid === false) label = t('Integrity check failed');
  else if (inUse && status.starting) label = t('Loading model…');
  else if (inUse) label = t('Running');
  let tone: 'warn' | 'ok' | 'muted' = 'muted';
  if (broken) tone = 'warn';
  else if (inUse) tone = 'ok';
  const requestDelete = async () => {
    const receipt = record(await actions.details(id));
    if (!receipt.confirmationToken || !Array.isArray(receipt.files)) return;
    const paths = receipt.files
      .map(record)
      .map((file) => String(file.path))
      .join('\n');
    setConfirmation({
      title: 'Delete model?',
      danger: true,
      confirmLabel: 'Delete',
      description: `${name}\n${paths}\n${t('Permanently deletes these files. Recovery requires downloading the model again.')}`,
      onConfirm: () => actions.deleteModel(String(receipt.confirmationToken)),
    });
  };
  return (
    <>
      <ExtensionItemRow
        icon={<Cpu size={15} aria-hidden="true" />}
        title={name}
        description={details}
        tone={tone}
        status={label}
        control={
          // Apply and Delete sit on ONE line: the context column's control row
          // is as tall as the dialog's 32px input skin (30-dialogs.css) while
          // .extensions-action is a 28px plate, so `flex-start` pinned Delete
          // 2px above the Apply button centred in that row. Baseline alignment
          // puts both buttons on the input row's text line and still lets the
          // validation message grow the column underneath them.
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            {!broken && <LocalProviderContext model={model} status={status} actions={actions} />}
            <ExtensionAction danger disabled={actions.busy || jobActive || inUse} onClick={() => void requestDelete()}>
              {t('Delete')}
            </ExtensionAction>
          </div>
        }
      />
      {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
    </>
  );
}

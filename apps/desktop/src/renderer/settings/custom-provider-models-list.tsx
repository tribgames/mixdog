import { ChevronDown, Plus, X } from 'lucide-react';

import { t } from '../i18n';

export interface CustomModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  hidden?: boolean;
  manual?: boolean;
}

/** "Add models manually": the model id field, the provider's models (the
 *  discovered rows, then the manual ids they lack), per-model Edit for a
 *  discovered row and Remove for a manual id, and Refresh models. */
export function CustomProviderModelsList({
  open,
  editable,
  rows,
  models,
  modelDraft,
  disabled,
  onToggle,
  onDraftChange,
  onAdd,
  onEdit,
  onRemove,
  onRefresh,
}: {
  open: boolean;
  /** An existing provider: its discovered rows are listed, editable and refreshable. */
  editable: boolean;
  rows: CustomModel[];
  models: CustomModel[];
  modelDraft: string;
  disabled: boolean;
  onToggle(open: boolean): void;
  onDraftChange(draft: string): void;
  onAdd(): void;
  onEdit(id: string): void;
  onRemove(model: CustomModel): void;
  onRefresh(): void;
}) {
  return (
    <details className="settings-custom-models" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>
        <span>{t('Add models manually')}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <p>{t('Optional. Leave empty to discover models automatically.')}</p>
      <div className="settings-custom-models-add">
        <input
          value={modelDraft}
          disabled={disabled}
          autoComplete="off"
          aria-label={t('Model ID')}
          placeholder={t('Model ID')}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onAdd();
            }
          }}
        />
        <button
          type="button"
          className="provider-account-add-button"
          aria-label={t('Add model')}
          title={t('Add model')}
          disabled={disabled || !modelDraft.trim()}
          onClick={onAdd}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <ul>
        {(editable ? [...rows, ...models.filter((model) => !rows.some((row) => row.id === model.id))] : models).map(
          (model) => {
            const explicit = models.find((item) => item.id === model.id);
            const backed = rows.some((row) => row.id === model.id);
            return (
              <li className={`extensions-mcp-list-row${model.hidden ? ' settings-model-hidden' : ''}`} key={model.id}>
                <span title={model.id}>
                  {model.id}
                  {model.hidden ? ` (${t('Hidden')})` : ''}
                </span>
                {editable && backed && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    aria-label={t('Edit model {{name}}', { name: model.id })}
                    onClick={() => onEdit(model.id)}
                  >
                    {t('Edit')}
                  </button>
                )}
                {explicit && (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={t('Remove {{name}}', { name: model.id })}
                    onClick={() => onRemove(explicit)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          }
        )}
      </ul>
      {editable && (
        <button type="button" className="secondary" disabled={disabled} onClick={onRefresh}>
          {t('Refresh models')}
        </button>
      )}
    </details>
  );
}

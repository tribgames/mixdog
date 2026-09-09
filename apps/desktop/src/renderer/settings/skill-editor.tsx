import { X } from 'lucide-react';
import { CapabilityIcon } from '../CapabilityIcon';
import { skillDisplayDescription } from '../skill-presentation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { record } from '../record-utils';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import { CompactSwitch } from './capability-controls';
import { rows, type PanelContext, type RecordValue } from './capability-data';
import { ExtensionDetailDialog, ExtensionField, ExtensionNote } from './extension-detail';
import { ToolNameInput } from './tool-name-input';

type Dependency = { type: string; value: string; [key: string]: unknown };
const dependenciesOf = (value: unknown): Dependency[] => Array.isArray(value)
  ? value.map(record).map((entry) => ({ ...entry, type: String(entry.type || ''), value: String(entry.value || '') }))
  : [];

export function SkillEditorDialog({
  skill, instructions, disabled, busy, readOnly = false, scopeField, tools = [],
  onClose, onSave, onToggle,
}: {
  skill: RecordValue | null;
  instructions: string;
  disabled: boolean;
  busy: boolean;
  readOnly?: boolean;
  scopeField?: ReactNode;
  tools?: RecordValue[];
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
}) {
  const editing = Boolean(skill);
  const name = String(skill?.name || '');
  const [formError, setFormError] = useState('');
  const [dependencies, setDependencies] = useState(() => dependenciesOf(skill?.toolDependencies));
  const [dependencyChange, setDependencyChange] = useState<'none' | 'override' | 'restore'>('none');
  const changeDependencies = (next: Dependency[]) => {
    setDependencies(next);
    setDependencyChange('override');
  };
  const toolOptions = tools.map(tool => ({
    value: String(tool.name), description: String(tool.description || ''),
  }));
  return <ExtensionDetailDialog width="editor" className="extensions-skill-dialog"
    titleId="extensions-skill-dialog-title" icon={<CapabilityIcon name={name} />}
    title={editing ? name : t('Add skill')} onClose={onClose}
    headerControl={editing && onToggle
      ? <CompactSwitch label={`${name} · ${t('Enabled')}`} checked={!disabled}
          disabled={busy} onChange={() => onToggle()} /> : null}
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const dependencyPayload = dependencyChange === 'none' ? {} : {
        toolDependencies: dependencyChange === 'restore' ? null
          : dependencies.filter((entry) => entry.value.trim()).map((entry) => ({ ...entry, value: entry.value.trim() })),
      };
      if (readOnly) {
        if (dependencyChange !== 'none') onSave({ originalName: name, dependenciesOnly: true, ...dependencyPayload });
        return;
      }
      const data = new FormData(event.currentTarget);
      const body = String(data.get('skill-instructions') || '').trim();
      if (!body) { setFormError('SKILL.md instructions must not be empty.'); return; }
      setFormError('');
      onSave({
        ...(editing ? { originalName: name } : {}),
        name: String(data.get('skill-name') || '').trim(),
        description: String(data.get('skill-description') || '').trim(),
        whenToUse: String(data.get('skill-trigger') || '').trim(),
        instructions: body,
        ...dependencyPayload,
      });
    }}
    footer={<>
      {formError && <ErrorNotice error={formError} />}
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>
        {t(readOnly ? 'Close' : 'Cancel')}
      </button>
      <button type="submit" disabled={busy || (readOnly && dependencyChange === 'none')}>{t('Save')}</button>
    </>}>
    {editing ? scopeField : null}
    <ExtensionField label={t('Name')} note={t('Shown in skill lists and menus.')}>
      <input name="skill-name" defaultValue={name} required autoFocus={!editing}
        disabled={busy || readOnly} maxLength={64} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
    </ExtensionField>
    <ExtensionField label={t('Description')}
      note={t('One sentence on what this skill does. Shown in the skill list.')}>
      <input name="skill-description" defaultValue={readOnly ? skillDisplayDescription(skill || {}) : String(skill?.description || '')}
        required disabled={busy || readOnly} maxLength={1024} />
    </ExtensionField>
    <ExtensionField className="workflows-md-field extensions-trigger-field" label={t('Trigger')}
      note={t('Phrases and situations that should call this skill, and what it should leave to others.')}>
      <textarea name="skill-trigger" defaultValue={String(skill?.whenToUse || '')}
        disabled={busy || readOnly} maxLength={1024} />
    </ExtensionField>
    <ExtensionField label={t('Required tools')}
      note={t('Load these tool schemas with this skill. Permissions and enabled settings stay unchanged.')}>
      <div className="extensions-mcp-list-rows">
        {dependencies.map((entry, index) => <div className="extensions-mcp-list-row extensions-mcp-pair-row" key={index}>
          <select aria-label={t('Dependency type')} value={entry.type} disabled={busy}
            onChange={(event) => changeDependencies(dependencies.map((row, i) => i === index ? { ...row, type: event.target.value } : row))}>
            <option value="tool">{t('Tool')}</option>
            <option value="mcp">{t('MCP server')}</option>
            {!['tool', 'mcp'].includes(entry.type) && <option value={entry.type}>{entry.type}</option>}
          </select>
          {entry.type === 'tool'
            ? <ToolNameInput ariaLabel={t('Required tool')} value={entry.value} disabled={busy}
              options={toolOptions} placeholder="office"
              onChange={value => changeDependencies(dependencies.map((row, i) => i === index ? { ...row, value } : row))} />
            : <input aria-label={t('Required tool')} value={entry.value} disabled={busy} spellCheck={false}
              placeholder={entry.type === 'mcp' ? 'figma' : 'office'}
              onChange={(event) => changeDependencies(dependencies.map((row, i) => i === index ? { ...row, value: event.target.value } : row))} />}
          <button type="button" aria-label={t('Remove')} disabled={busy}
            onClick={() => changeDependencies(dependencies.filter((_, i) => i !== index))}><X size={14} aria-hidden="true" /></button>
        </div>)}
      </div>
      <button type="button" className="extensions-mcp-list-add" disabled={busy || dependencies.length >= 128}
        onClick={() => changeDependencies([...dependencies, { type: 'tool', value: '' }])}>+ {t('Add')}</button>
      {editing && <button type="button" className="extensions-mcp-list-add" disabled={busy}
        onClick={() => {
          setDependencies(dependenciesOf(skill?.declaredToolDependencies));
          setDependencyChange('restore');
        }}>{t('Restore declared tools')}</button>}
      <ExtensionNote>{t('Tool links are saved locally without changing the imported skill.')}</ExtensionNote>
      <ErrorNotice errors={Array.isArray(skill?.dependencyIssues) ? skill.dependencyIssues.map(String) : []} />
    </ExtensionField>
    <ExtensionField className="workflows-md-field extensions-instructions-field" label={t('Instructions')}
      note={t('Instructions that define how this skill works.')}>
      <textarea name="skill-instructions"
        defaultValue={instructions || (editing ? '' : '# Instructions\n\nDescribe how to use this skill.')}
        required spellCheck={false} disabled={busy || readOnly} />
    </ExtensionField>
  </ExtensionDetailDialog>;
}

/** Built-in and plugin cards share the same editor; their source stays read-only. */
export function useSkillToolLinks({ data, pending, run }: Pick<PanelContext, 'data' | 'pending' | 'run'>) {
  const [detail, setDetail] = useState<{ name: string; resource: RecordValue | null } | null>(null);
  const skill = rows(record(data.skills), 'skills').find((entry) => entry.name === detail?.name);
  const openSkillTools = (name: string) => {
    setDetail({ name, resource: null });
    void run<RecordValue>('skillContent', [name], `skill-content-${name}`, false).then((resource) => {
      setDetail((current) => current?.name !== name ? current : resource ? { name, resource } : null);
    });
  };
  const skillToolsDialog = detail && skill ? detail.resource === null
    ? <SidebarLoadingDialog title={detail.name} onClose={() => setDetail(null)} />
    : <SkillEditorDialog key={detail.name} skill={{ ...skill, ...detail.resource }}
        instructions={String(detail.resource.content || '')} disabled={false} busy={Boolean(pending)}
        readOnly tools={rows(record(data.skills), 'tools')} onClose={() => setDetail(null)}
        onSave={(payload) => { void run('saveSkill', [payload]).then((saved) => { if (saved !== undefined) setDetail(null); }); }} />
    : null;
  return { openSkillTools, skillToolsDialog };
}

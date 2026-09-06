import { useRef, useState } from 'react';
import type { GithubRequest } from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';

type Field = { key: keyof GithubRequest; label: string; type?: 'area' | 'check'; options?: string[]; required?: boolean };
const title: Field = { key: 'title', label: 'Title', required: true };
const body: Field = { key: 'body', label: 'Description', type: 'area' };
const draft: Field = { key: 'draft', label: 'Draft', type: 'check' };
const prerelease: Field = { key: 'prerelease', label: 'Pre-release', type: 'check' };
const issueFields: Field[] = [title, body, { key: 'labels', label: 'Labels (comma-separated)' }, { key: 'assignees', label: 'Assignees (comma-separated)' }];
const FIELDS: Partial<Record<GithubRequest['action'], Field[]>> = {
  'repo.create': [{ key: 'repo', label: 'Repository (owner/name)', required: true },
    { key: 'visibility', label: 'Visibility', options: ['private', 'public'] }, { key: 'description', label: 'Description' }],
  'repo.clone': [{ key: 'repo', label: 'Repository (owner/name)', required: true },
    { key: 'destination', label: 'New absolute directory', required: true }],
  'repo.fork': [{ key: 'organization', label: 'Organization (optional)' }],
  'issue.create': issueFields,
  'issue.edit': issueFields,
  'issue.comment': [{ key: 'body', label: 'Comment', type: 'area', required: true }],
  'workflow.run': [{ key: 'workflow', label: 'Workflow file or ID', required: true },
    { key: 'ref', label: 'Branch or tag', required: true },
    { key: 'inputs', label: 'Workflow inputs (JSON)', type: 'area' }],
  'release.create': [{ key: 'tag', label: 'Tag', required: true }, title, body,
    { key: 'target', label: 'Target branch or commit (optional)' }, draft, prerelease],
  'release.edit': [title, body, draft, prerelease],
};
const LABELS: Partial<Record<GithubRequest['action'], string>> = {
  'repo.create': 'Create repository', 'repo.clone': 'Clone repository', 'repo.fork': 'Fork repository',
  'issue.create': 'Create issue', 'issue.edit': 'Edit issue', 'issue.comment': 'Add comment',
  'workflow.run': 'Run workflow', 'release.create': 'Create release', 'release.edit': 'Edit release',
};

export function GithubActionForm({ request, onSubmit, onClose }: {
  request: GithubRequest;
  onSubmit(request: GithubRequest): Promise<void>;
  onClose(): void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({
    visibility: 'private', draft: request.action === 'release.create', ...request,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const fields = FIELDS[request.action] || [];
  const label = LABELS[request.action] || request.action;
  return <form className="github-action-form" onSubmit={(event) => {
    event.preventDefault();
    if (sending.current) return;
    let next: GithubRequest;
    try {
      next = { ...request };
      for (const field of fields) {
        const value = values[field.key];
        if (field.type === 'check') Object.assign(next, { [field.key]: value === true });
        else if (field.key === 'labels' || field.key === 'assignees') {
          const entries = Array.isArray(value) ? value : String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
          Object.assign(next, { [field.key]: entries });
        } else if (field.key === 'inputs') {
          const inputs = value && typeof value === 'object' ? value : JSON.parse(String(value || '{}'));
          Object.assign(next, { inputs });
        } else if (value !== undefined && (String(value).trim() || field.key === 'body' || field.key === 'description')) {
          Object.assign(next, { [field.key]: String(value) });
        }
      }
    } catch { setError(t('Workflow inputs must be a JSON object with string values.')); return; }
    const target = next.repo || request.repo || '';
    const warning = next.action === 'workflow.run' || (next.action.startsWith('release.') && next.draft !== true)
      ? `\n${t('This action may trigger a deployment.')}` : '';
    if (!window.confirm(`${t(label)}\n${target}${next.number ? ` #${next.number}` : ''}${next.id ? ` #${next.id}` : ''}${warning}`)) return;
    sending.current = true;
    setBusy(true);
    setError('');
    void onSubmit(next).then(onClose).catch((reason) => {
      setError(String(reason instanceof Error ? reason.message : reason));
    }).finally(() => { sending.current = false; setBusy(false); });
  }}>
    <h3>{t(label)}</h3>
    {request.repo && <p className="github-target">{request.repo}{request.number ? ` #${request.number}` : ''}</p>}
    {fields.map((field) => {
      const value = values[field.key];
      const textValue = Array.isArray(value) ? value.join(', ')
        : value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '');
      const change = (next: unknown) => setValues((current) => ({ ...current, [field.key]: next }));
      return <label key={field.key}>
        <span>{t(field.label)}</span>
        {field.type === 'check'
          ? <input type="checkbox" checked={value === true} disabled={busy} onChange={(event) => change(event.currentTarget.checked)} />
          : field.options ? <select value={textValue} disabled={busy} onChange={(event) => change(event.currentTarget.value)}>
            {field.options.map((option) => <option key={option} value={option}>{t(option)}</option>)}
          </select>
          : field.type === 'area' ? <textarea value={textValue} rows={5} maxLength={60000} disabled={busy}
            required={field.required} onChange={(event) => change(event.currentTarget.value)} />
            : <input value={textValue} disabled={busy} required={field.required} maxLength={1000}
              onChange={(event) => change(event.currentTarget.value)} />}
      </label>;
    })}
    {error && <ErrorNotice error={error} />}
    <div className="github-actions">
      <button type="submit" disabled={busy}>{t(busy ? 'Working…' : label)}</button>
      <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
    </div>
  </form>;
}

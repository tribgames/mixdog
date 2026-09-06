import type { GithubRequest } from '../../shared/contract';
import { t } from '../i18n';
import { githubItemState, githubItemTitle, githubItemUrl, githubRecord, type GithubRecord, type GithubSection } from './github-model';

export function GithubDetail({ section, item, comments, busy, onAction, onForm, onLogs, onClose }: {
  section: GithubSection;
  item: GithubRecord;
  comments: GithubRecord[];
  busy: boolean;
  onAction(input: Partial<GithubRequest> & Pick<GithubRequest, 'action'>): void;
  onForm(input: Partial<GithubRequest> & Pick<GithubRequest, 'action'>): void;
  onLogs(): void;
  onClose(): void;
}) {
  const number = Number(item.number);
  const id = Number(item.id);
  const url = githubItemUrl(item);
  const action = (label: string, input: Parameters<typeof onAction>[0]) =>
    <button type="button" disabled={busy} onClick={() => onAction(input)}>{t(label)}</button>;
  return <article className="github-detail">
    <div className="github-actions">
      <button type="button" onClick={onClose}>{t('Back')}</button>
      {url && <button type="button" onClick={() => void window.mixdogDesktop.openExternal?.(url)}>{t('Open on GitHub')}</button>}
    </div>
    <h3>{githubItemTitle(item)}</h3>
    <p className="github-meta">{githubItemState(item)}{item.number ? ` · #${item.number}` : ''}</p>
    <div className="github-actions">
      {section === 'repositories' && <>
        <button type="button" disabled={busy} onClick={() => onForm({ action: 'repo.clone', repo: String(item.full_name) })}>{t('Clone repository')}</button>
        <button type="button" disabled={busy} onClick={() => onForm({ action: 'repo.fork', repo: String(item.full_name) })}>{t('Fork repository')}</button>
      </>}
      {section === 'issues' && <>
        <button type="button" disabled={busy} onClick={() => onForm({
          action: 'issue.edit', number, title: String(item.title || ''), body: String(item.body || ''),
          labels: Array.isArray(item.labels) ? item.labels.map((entry) => String(githubRecord(entry).name || '')) : [],
          assignees: Array.isArray(item.assignees) ? item.assignees.map((entry) => String(githubRecord(entry).login || '')) : [],
        })}>{t('Edit issue')}</button>
        <button type="button" disabled={busy} onClick={() => onForm({ action: 'issue.comment', number })}>{t('Add comment')}</button>
        {item.state === 'closed' ? action('Reopen issue', { action: 'issue.reopen', number })
          : action('Close issue', { action: 'issue.close', number })}
      </>}
      {section === 'actions' && <>
        <button type="button" disabled={busy} onClick={onLogs}>{t('View logs')}</button>
        {action('Re-run all jobs', { action: 'run.rerun', id })}
        {action('Re-run failed jobs', { action: 'run.rerun', id, failed: true })}
        {item.status !== 'completed' && action('Cancel run', { action: 'run.cancel', id })}
      </>}
      {section === 'workflows' && <button type="button" disabled={busy}
        onClick={() => onForm({ action: 'workflow.run', workflow: String(id) })}>{t('Run workflow')}</button>}
      {section === 'releases' && <button type="button" disabled={busy} onClick={() => onForm({
        action: 'release.edit', id, title: String(item.name || item.tag_name || ''), body: String(item.body || ''),
        draft: item.draft === true, prerelease: item.prerelease === true,
      })}>{t('Edit release')}</button>}
      {section === 'notifications' && action('Mark as read', { action: 'notification.read', id })}
    </div>
    <dl className="github-facts">
      {[
        ['Author', githubRecord(item.user).login || githubRecord(item.actor).login],
        ['Branch', item.head_branch || item.default_branch],
        ['Tag', item.tag_name],
        ['Updated', item.updated_at || item.published_at],
        ['Repository', githubRecord(item.repository).full_name],
        ['Reason', item.reason],
      ].filter(([, value]) => value).map(([label, value]) =>
        <div key={String(label)}><dt>{t(String(label))}</dt><dd>{String(value)}</dd></div>)}
    </dl>
    {Boolean(item.body || item.description) && <div className="github-body">{String(item.body || item.description)}</div>}
    {comments.length > 0 && <section aria-label={t('Comments')}>
      <h4>{t('Comments')}</h4>
      {comments.map((comment) => <article className="github-comment" key={String(comment.id)}>
        <b>{String(githubRecord(comment.user).login || '')}</b>
        <div className="github-body">{String(comment.body || '')}</div>
      </article>)}
    </section>}
  </article>;
}

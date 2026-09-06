import { useEffect, useRef, useState } from 'react';
import type { GithubRequest } from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { githubRecord, repositoryFromUrl } from './github-model';
import './github.css';

export function GithubReviewForm({ projectPath, number, url = '', active, onSubmitted }: {
  projectPath: string; number: number; url?: string; active: boolean; onSubmitted(): void;
}) {
  const [body, setBody] = useState('');
  const [event, setEvent] = useState<NonNullable<GithubRequest['event']>>('COMMENT');
  const [target, setTarget] = useState<{ repo: string; hostname?: string; sha: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setTarget(null);
    const repository = repositoryFromUrl(url.replace(/\/pull\/\d+.*$/, ''));
    void window.mixdogDesktop.githubRequest?.(projectPath, { ...repository, action: 'pr.view', number }).then((result) => {
      if (live) setTarget({ repo: result.repo, hostname: result.hostname, sha: String(githubRecord(githubRecord(result.data).head).sha || '') });
    }).catch((reason) => { if (live) setError(String(reason.message || reason)); });
    return () => { live = false; };
  }, [projectPath, number, url, active]);
  return <form className="github-action-form" onSubmit={(submit) => {
    submit.preventDefault();
    if (sending.current || !target?.sha || !window.mixdogDesktop.githubRequest) return;
    if (!window.confirm(`${t('Submit review')}\n${target.repo} #${number}\n${event}`)) return;
    sending.current = true; setBusy(true); setError('');
    void window.mixdogDesktop.githubRequest(projectPath, {
      action: 'pr.review', repo: target.repo, hostname: target.hostname, number, sha: target.sha, event, body,
    }).then(() => { setBody(''); onSubmitted(); }).catch((reason) => {
      setError(String(reason.message || reason));
    }).finally(() => { sending.current = false; setBusy(false); });
  }}>
    <h3>{t('Submit review')}</h3>
    <label><span>{t('Review')}</span><select value={event} disabled={busy}
      onChange={(change) => setEvent(change.currentTarget.value as typeof event)}>
      <option value="COMMENT">{t('Comment')}</option>
      <option value="APPROVE">{t('Approve')}</option>
      <option value="REQUEST_CHANGES">{t('Request changes')}</option>
    </select></label>
    <label><span>{t('Comment')}</span><textarea rows={4} value={body} maxLength={60000}
      required={event !== 'APPROVE'} disabled={busy} onChange={(change) => setBody(change.currentTarget.value)} /></label>
    {error && <ErrorNotice error={error} />}
    <button type="submit" disabled={busy || !active || !target?.sha}>{t(busy ? 'Working…' : 'Submit review')}</button>
  </form>;
}

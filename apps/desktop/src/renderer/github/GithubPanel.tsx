import { useCallback, useEffect, useRef, useState } from 'react';
import type { GithubRequest, GithubResult } from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { useSurfaceActive } from '../surface-activity';
import { GithubActionForm } from './GithubActionForm';
import { GithubDetail } from './GithubDetail';
import {
  LIST_ACTIONS, githubItemState, githubItemTitle, githubRecord, githubRows, repositoryFromUrl,
  type GithubRecord, type GithubSection,
} from './github-model';
import './github.css';

export function GithubPanel({ projectPath, repositoryUrl, section }: {
  projectPath: string; repositoryUrl: string; section: GithubSection;
}) {
  const api = window.mixdogDesktop;
  const active = useSurfaceActive();
  const target = repositoryFromUrl(repositoryUrl);
  const [repo, setRepo] = useState(target?.repo || '');
  const [repoDraft, setRepoDraft] = useState(target?.repo || '');
  const [hostname, setHostname] = useState(target?.hostname || 'github.com');
  const [hostDraft, setHostDraft] = useState(target?.hostname || 'github.com');
  const [items, setItems] = useState<GithubRecord[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<GithubRecord | null>(null);
  const [comments, setComments] = useState<GithubRecord[]>([]);
  const [commentPage, setCommentPage] = useState(1);
  const [moreComments, setMoreComments] = useState(false);
  const [form, setForm] = useState<GithubRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const epoch = useRef(0);
  const sending = useRef(false);
  const repoRef = useRef(repo);

  const request = useCallback((input: GithubRequest): Promise<GithubResult> => {
    if (!api.githubRequest) return Promise.reject(new Error(t('GitHub needs an app restart to finish updating.')));
    return api.githubRequest(projectPath, {
      ...(!input.action.startsWith('notification.') && input.action !== 'repo.list' && repoRef.current
        ? { repo: repoRef.current } : {}),
      hostname, ...input,
    });
  }, [api, projectPath, hostname]);

  useEffect(() => {
    setDetail(null); setForm(null); setLogs(null); setError(''); setNotice('');
  }, [section, repo, hostname]);
  useEffect(() => {
    if (!active) { ++epoch.current; return; }
    const generation = ++epoch.current;
    setLoading(true);
    setError('');
    const input: GithubRequest = {
      action: LIST_ACTIONS[section], page, limit: 30,
      ...(section === 'issues' ? { state } : {}),
    };
    void request(input).then((result) => {
      if (generation !== epoch.current) return;
      setItems(githubRows(result.data));
      setHasMore(result.hasMore === true);
      if (!repoRef.current && result.repo) {
        repoRef.current = result.repo;
        setRepoDraft(result.repo);
        // No additional list request just to confirm an inferred repository.
      }
    }).catch((reason) => {
      if (generation === epoch.current) { setError(String(reason.message || reason)); setItems([]); }
    }).finally(() => { if (generation === epoch.current) setLoading(false); });
    return () => { ++epoch.current; };
  }, [active, page, repo, hostname, request, section, state, refresh]);

  const open = async (item: GithubRecord) => {
    const generation = ++epoch.current;
    setLoading(true); setError(''); setLogs(null); setForm(null);
    try {
      let next = item;
      let nextComments: GithubResult | null = null;
      if (section === 'issues') {
        const results = await Promise.all([
          request({ action: 'issue.view', number: Number(item.number) }),
          request({ action: 'issue.comments', number: Number(item.number), limit: 30, page: 1 }),
        ]);
        next = githubRecord(results[0].data); nextComments = results[1];
      } else if (section === 'repositories' || section === 'actions' || section === 'releases') {
        const result = await request(section === 'repositories'
          ? { action: 'repo.view', repo: String(item.full_name) }
          : { action: section === 'actions' ? 'run.view' : 'release.view', id: Number(item.id) });
        next = githubRecord(result.data);
      }
      if (generation !== epoch.current) return;
      setDetail(next);
      setComments(githubRows(nextComments?.data)); setCommentPage(1);
      setMoreComments(nextComments?.hasMore === true);
    } catch (reason) {
      if (generation === epoch.current) setError(String(reason instanceof Error ? reason.message : reason));
    } finally { if (generation === epoch.current) setLoading(false); }
  };
  const mutate = async (input: GithubRequest) => {
    if (sending.current) throw new Error(t('Another GitHub action is still running.'));
    sending.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(input);
      setNotice(t('GitHub action completed.'));
      setDetail(null); setLogs(null); setRefresh((value) => value + 1);
    } finally { sending.current = false; setBusy(false); }
  };
  const action = (input: GithubRequest) => {
    const warning = input.action === 'run.rerun' ? `\n${t('This action may trigger a deployment.')}` : '';
    if (!window.confirm(`${input.action}\n${repoRef.current}${input.number ? ` #${input.number}` : ''}${input.id ? ` #${input.id}` : ''}${warning}`)) return;
    void mutate(input).catch((reason) => setError(String(reason.message || reason)));
  };
  const beginForm = (input: GithubRequest) => {
    if (!repoRef.current && !['repo.create', 'repo.clone'].includes(input.action)) {
      setError(t('Choose a repository before making changes.'));
      return;
    }
    setForm({ repo: repoRef.current || undefined, hostname, ...input });
    setLogs(null);
  };
  const loadLogs = async () => {
    if (!detail) return;
    setBusy(true); setError('');
    const generation = epoch.current;
    try {
      const result = await request({ action: 'run.logs', id: Number(detail.id) });
      if (generation === epoch.current) setLogs(String(result.data || '').slice(0, 100000));
    } catch (reason) {
      if (generation === epoch.current) setError(String(reason instanceof Error ? reason.message : reason));
    } finally { setBusy(false); }
  };
  return <div className="github-panel">
    <form className="github-target-form" onSubmit={(event) => {
      event.preventDefault();
      repoRef.current = repoDraft.trim();
      setPage(1);
      setRepo(repoDraft.trim()); setHostname(hostDraft.trim() || 'github.com');
    }}>
      <label><span>{t('Repository (owner/name)')}</span><input value={repoDraft}
        placeholder={t('Current Project')} disabled={busy} onChange={(event) => setRepoDraft(event.currentTarget.value)} /></label>
      <label><span>{t('GitHub host')}</span><input value={hostDraft} disabled={busy}
        onChange={(event) => setHostDraft(event.currentTarget.value)} /></label>
      <button type="submit" disabled={busy}>{t('Apply')}</button>
    </form>
    <div className="github-actions">
      <button type="button" disabled={busy || loading} onClick={() => { setDetail(null); setRefresh((value) => value + 1); }}>{t('Refresh')}</button>
      {section === 'repositories' && <>
        <button type="button" disabled={busy} onClick={() => beginForm({ action: 'repo.create', repo: '' })}>{t('Create repository')}</button>
        <button type="button" disabled={busy} onClick={() => beginForm({ action: 'repo.clone' })}>{t('Clone repository')}</button>
      </>}
      {section === 'issues' && <>
        <select aria-label={t('Issue state')} value={state} disabled={busy} onChange={(event) => {
          setPage(1); setState(event.currentTarget.value as typeof state); setDetail(null);
        }}>
          <option value="open">{t('Open')}</option><option value="closed">{t('Closed')}</option><option value="all">{t('All')}</option>
        </select>
        <button type="button" disabled={busy} onClick={() => beginForm({ action: 'issue.create' })}>{t('Create issue')}</button>
      </>}
      {section === 'releases' && <button type="button" disabled={busy}
        onClick={() => beginForm({ action: 'release.create' })}>{t('Create release')}</button>}
      {section === 'workflows' && <button type="button" disabled={busy}
        onClick={() => beginForm({ action: 'workflow.run' })}>{t('Run workflow')}</button>}
    </div>
    {error && <ErrorNotice error={error} />}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">{t('Loading…')}</p>}
    {form ? <GithubActionForm key={`${form.action}:${form.id || form.number || ''}`} request={form}
      onSubmit={mutate} onClose={() => setForm(null)} />
      : detail ? <>
        <GithubDetail section={section} item={detail} comments={comments} busy={busy}
          onAction={action} onForm={beginForm} onLogs={() => void loadLogs()}
          onClose={() => { ++epoch.current; setDetail(null); setLogs(null); }} />
        {moreComments && <button type="button" disabled={busy} onClick={() => {
          setBusy(true);
          const generation = epoch.current;
          void request({ action: 'issue.comments', number: Number(detail.number), page: commentPage + 1, limit: 30 })
            .then((result) => {
              if (generation !== epoch.current) return;
              setComments((current) => [...current, ...githubRows(result.data)]);
              setCommentPage((value) => value + 1); setMoreComments(result.hasMore === true);
            }).catch((reason) => { if (generation === epoch.current) setError(String(reason.message || reason)); })
            .finally(() => setBusy(false));
        }}>{t('Load more comments')}</button>}
        {logs !== null && <section><h4>{t('Logs (up to 100,000 characters)')}</h4><pre className="github-logs">{logs || t('No logs available.')}</pre></section>}
      </> : <>
        {!loading && !error && items.length === 0 && <p>{t('No items on this page.')}</p>}
        <div className="github-list" role="list">
          {items.map((item) => <button type="button" className="github-item" role="listitem"
            key={String(item.id)} disabled={busy || loading} onClick={() => void open(item)}>
            <b>{githubItemTitle(item)}</b>
            <small>{item.number ? `#${item.number} · ` : ''}{githubItemState(item)}
              {item.head_branch ? ` · ${item.head_branch}` : ''}</small>
          </button>)}
        </div>
        <div className="github-actions">
          <button type="button" disabled={busy || loading || page <= 1} onClick={() => setPage((value) => value - 1)}>{t('Previous')}</button>
          <span>{t('Page {{page}}', { page })}</span>
          <button type="button" disabled={busy || loading || !hasMore} onClick={() => setPage((value) => value + 1)}>{t('Next')}</button>
        </div>
      </>}
  </div>;
}

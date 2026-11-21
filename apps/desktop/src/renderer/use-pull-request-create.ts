// The pull request create form: its draft fields and the publish-then-create action.
import { useState } from 'react';
import type { DesktopPullRequestEntry } from '../shared/contract';
import { errorMessage } from './editor-pane-session-errors';
import { t } from './i18n';
import { titleFromBranch } from './pull-requests-model';

type PullRequestCreateHost = NonNullable<Window['mixdogDesktop']>;

export function usePullRequestCreate({
  api,
  projectPath,
  currentBranch,
  prUrl,
  createHint,
  defaultBaseBranch,
  busy,
  setBusy,
  loadList,
  onCreated,
}: {
  api: PullRequestCreateHost | undefined;
  projectPath: string;
  currentBranch: string;
  prUrl: string;
  createHint: string;
  defaultBaseBranch: string;
  busy: string;
  setBusy(key: string): void;
  loadList(): Promise<unknown>;
  onCreated(created: DesktopPullRequestEntry): void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('main');
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState('');

  const begin = () => {
    setTitle(titleFromBranch(currentBranch));
    setBody('');
    setBase(defaultBaseBranch);
    setDraft(false);
    setError('');
    setOpen(true);
  };
  const cancel = () => {
    if (busy === 'create') return;
    setOpen(false);
    setError('');
  };
  const close = () => {
    setOpen(false);
    setError('');
  };
  const submit = async () => {
    const trimmedTitle = title.trim();
    const trimmedBase = base.trim();
    if (
      !trimmedTitle ||
      !trimmedBase ||
      !currentBranch ||
      trimmedBase.toLocaleLowerCase() === currentBranch.toLocaleLowerCase()
    )
      return;
    if (!api?.ghPrCreate) {
      setError(t('Pull request creation is unavailable in this host.'));
      return;
    }
    setBusy('create');
    setError('');
    try {
      if (!prUrl) {
        if (!api.gitPush) throw new Error(createHint || 'Publish or push this branch before creating a pull request.');
        await api.gitPush(projectPath);
      }
      const created = await api.ghPrCreate(projectPath, {
        base: trimmedBase,
        head: currentBranch,
        title: trimmedTitle,
        body,
        draft,
      });
      setOpen(false);
      await loadList();
      onCreated(created);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };
  const submitDisabled =
    !title.trim() ||
    !base.trim() ||
    !currentBranch ||
    base.trim().toLocaleLowerCase() === currentBranch.toLocaleLowerCase() ||
    busy === 'create';

  return {
    open,
    title,
    body,
    base,
    draft,
    error,
    submitDisabled,
    setTitle,
    setBody,
    setBase,
    setDraft,
    begin,
    cancel,
    close,
    submit,
  };
}

// New pull request form. Fully controlled: the pane owns the field state and
// the create/push flow.
import { GitPullRequestArrow } from 'lucide-react';
import { t } from './i18n';
import { OpenSelect } from './OpenSelect';
import { ProgressSpinner } from './ProgressSpinner';
import { SourceControlErrorNotice } from './SourceControlErrorNotice';
import { createSubmitLabel } from './pull-requests-model';

export function PullRequestCreateForm({
  currentBranch,
  title,
  body,
  base,
  draft,
  baseBranchNames,
  prUrl,
  createHint,
  error,
  creating,
  submitDisabled,
  onTitleChange,
  onBodyChange,
  onBaseChange,
  onDraftChange,
  onSubmit,
  onCancel,
  onAuthenticationHelp,
}: {
  currentBranch: string;
  title: string;
  body: string;
  base: string;
  draft: boolean;
  baseBranchNames: string[];
  prUrl: string;
  createHint: string;
  error: string;
  /** True while the create action is running. */
  creating: boolean;
  submitDisabled: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onBaseChange: (value: string) => void;
  onDraftChange: (value: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onAuthenticationHelp: () => void;
}) {
  return (
    <form
      className="dock-pr-create"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header>
        <GitPullRequestArrow size={16} aria-hidden="true" />
        <span>
          <b>{t('New pull request')}</b>
          <small>
            {currentBranch} → {base || 'base'}
          </small>
        </span>
      </header>
      <label>
        <span>{t('Title')}</span>
        <input
          type="text"
          aria-label={t('Pull request title')}
          value={title}
          maxLength={1024}
          // biome-ignore lint/a11y/noAutofocus: the create form opens to type the title immediately.
          autoFocus
          onInput={(event) => onTitleChange(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t('Description')}</span>
        <textarea
          aria-label={t('Pull request description')}
          rows={6}
          value={body}
          placeholder={t('Description (optional)')}
          onInput={(event) => onBodyChange(event.currentTarget.value)}
        />
      </label>
      <div className="dock-pr-create-base">
        <span>{t('Base')}</span>
        <OpenSelect
          className="dock-pr-base-select"
          ariaLabel={t('Pull request base branch')}
          value={base}
          options={baseBranchNames.map((branch) => ({ value: branch, label: branch }))}
          onChange={onBaseChange}
        />
      </div>
      <label className="dock-pr-create-draft">
        <input type="checkbox" checked={draft} onChange={(event) => onDraftChange(event.currentTarget.checked)} />
        <span>{t('Create as draft')}</span>
      </label>
      {!prUrl && <p className="dock-pr-create-note">{createHint || t('The branch will be pushed before creation.')}</p>}
      {error && (
        <SourceControlErrorNotice
          error={error}
          className="dock-pr-create-error"
          onAuthenticationHelp={onAuthenticationHelp}
          authenticationHelpLabel={t('GitHub CLI help')}
        />
      )}
      <footer>
        <button type="button" onClick={onCancel} disabled={creating}>
          {t('Cancel')}
        </button>
        <button type="submit" disabled={submitDisabled}>
          {creating && <ProgressSpinner size={14} aria-hidden="true" />}
          {createSubmitLabel(creating, prUrl, draft)}
        </button>
      </footer>
    </form>
  );
}

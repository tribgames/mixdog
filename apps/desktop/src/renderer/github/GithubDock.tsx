import { useState, type ComponentProps } from 'react';
import { PullRequestsPane } from '../PullRequestsPane';
import { t } from '../i18n';
import { GithubPanel } from './GithubPanel';
import { GITHUB_SECTIONS, type GithubSection } from './github-model';
import './github.css';

export function GithubDock(props: ComponentProps<typeof PullRequestsPane>) {
  const [section, setSection] = useState<'pulls' | GithubSection>(
    props.repositoryUrl ? 'pulls' : 'repositories',
  );
  return <div className="github-dock">
    <label className="github-navigation">
      <span>GitHub</span>
      <select aria-label={t('GitHub view')} value={section}
        onChange={(event) => setSection(event.currentTarget.value as typeof section)}>
        <option value="pulls">{t('Pull requests')}</option>
        {GITHUB_SECTIONS.map(([id, title]) => <option key={id} value={id}>{t(title)}</option>)}
      </select>
    </label>
    {section === 'pulls' ? <PullRequestsPane {...props} />
      : <GithubPanel key={`${props.projectPath}:${section}`} projectPath={props.projectPath}
        repositoryUrl={props.repositoryUrl} section={section} />}
  </div>;
}

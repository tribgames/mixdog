import { useEffect, useState, type ComponentType } from 'react';
import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { ActionButton, Group, ResourceRow } from './capability-controls';
import { FeedbackDialog } from './feedback-dialog';
import { readGithubStarred, rememberGithubStarred } from './github-star-storage';

const MIXDOG_REPO_URL = 'https://github.com/tribgames/mixdog';
const MIXDOG_ISSUES_URL = 'https://github.com/tribgames/mixdog/issues';
type ChangelogDialogComponent = ComponentType<{ onClose(): void }>;

export function AboutPanel() {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const [ghReady, setGhReady] = useState(false);
  const [starred, setStarred] = useState(readGithubStarred);
  const [busy, setBusy] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The dialog bundles CHANGELOG.md and the Markdown renderer: load it on
  // demand and mount it only once its first release is rendered-ready.
  const [ChangelogDialog, setChangelogDialog] = useState<ChangelogDialogComponent | null>(null);
  const openChangelog = () =>
    void import('./changelog-dialog')
      .then(async (module) => {
        await module.prepareChangelog();
        setChangelogDialog(() => module.default);
      })
      .catch(() => undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: host is the window bridge read per render; it is kept as the re-query trigger.
  useEffect(() => {
    if (readGithubStarred()) return;
    let live = true;
    void host
      ?.githubStarStatus?.()
      ?.then((status) => {
        if (!status) return;
        const confirmedStarred = rememberGithubStarred(status.starred === true);
        if (!live) return;
        setGhReady(status.available === true);
        setStarred(confirmedStarred);
      })
      .catch(() => {
        /* retain the plain repository link */
      });
    return () => {
      live = false;
    };
  }, [host]);
  const open = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const star = () => {
    if (starred || !ghReady || !host?.starGithub) {
      open(MIXDOG_REPO_URL);
      return;
    }
    setBusy(true);
    void host
      .starGithub()
      .then((result) => setStarred(rememberGithubStarred(result?.starred === true)))
      .catch(() => open(MIXDOG_REPO_URL))
      .finally(() => setBusy(false));
  };
  let starLabel = t('Star on GitHub ↗');
  if (starred) starLabel = t('Starred ★');
  else if (busy) starLabel = t('Starring…');
  else if (ghReady) starLabel = t('Star ☆');
  return (
    <Group title={t('Community')}>
      <ResourceRow
        title={t('GitHub')}
        className="settings-about-row"
        description={t('Source, releases, and discussions — a star helps mixdog grow.')}
        actions={
          <>
            <ActionButton disabled={busy || starred} onClick={star}>
              {starLabel}
            </ActionButton>
            <ActionButton disabled={busy} onClick={() => open(MIXDOG_REPO_URL)}>
              {t('Open ↗')}
            </ActionButton>
          </>
        }
      />
      <ResourceRow
        title={t('Report an issue')}
        className="settings-about-row"
        description={t('Bug reports and feature requests.')}
        actions={
          <ActionButton disabled={busy} onClick={() => open(MIXDOG_ISSUES_URL)}>
            {t('Issues ↗')}
          </ActionButton>
        }
      />
      <ResourceRow
        title={t('Feedback')}
        className="settings-about-row"
        description={t('Send a bug report or suggestion to the Mixdog team.')}
        actions={
          <ActionButton disabled={busy} onClick={() => setFeedbackOpen(true)}>
            {t('Give feedback')}
          </ActionButton>
        }
      />
      <ResourceRow
        title={t('Changelog')}
        className="settings-about-row"
        description={t('See what changed in each version.')}
        actions={
          <ActionButton disabled={busy} onClick={openChangelog}>
            {t('View changelog')}
          </ActionButton>
        }
      />
      {ChangelogDialog && <ChangelogDialog onClose={() => setChangelogDialog(null)} />}
      {feedbackOpen && (
        <FeedbackDialog
          submit={host?.submitFeedback ? (input) => host.submitFeedback!(input) : undefined}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </Group>
  );
}

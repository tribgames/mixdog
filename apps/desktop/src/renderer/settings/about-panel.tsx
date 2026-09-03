import { useEffect, useState } from 'react';
import type { DesktopApi } from '../../shared/contract';
import { ActionButton, Group, ResourceRow } from './capability-controls';

const MIXDOG_REPO_URL = 'https://github.com/tribgames/mixdog';
const MIXDOG_ISSUES_URL = 'https://github.com/tribgames/mixdog/issues';
const MIXDOG_SPONSOR_URL = 'https://ko-fi.com/tribgamesdev';

export function AboutPanel() {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const [ghReady, setGhReady] = useState(false);
  const [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void host?.githubStarStatus?.()
      ?.then((status) => {
        if (!live || !status) return;
        setGhReady(status.available === true);
        setStarred(status.starred === true);
      })
      .catch(() => { /* retain the plain repository link */ });
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
    void host.starGithub()
      .then((result) => setStarred(result?.starred === true))
      .catch(() => open(MIXDOG_REPO_URL))
      .finally(() => setBusy(false));
  };
  return <Group title="Community">
    <ResourceRow title="GitHub" className="settings-about-row"
      description="Source, releases, and discussions — a star helps mixdog grow."
      actions={<>
        <ActionButton disabled={busy || starred} onClick={star}>
          {starred ? 'Starred ★' : busy ? 'Starring…' : ghReady ? 'Star ☆' : 'Star on GitHub ↗'}
        </ActionButton>
        <ActionButton disabled={busy} onClick={() => open(MIXDOG_REPO_URL)}>Open ↗</ActionButton>
      </>} />
    <ResourceRow title="Report an issue" className="settings-about-row"
      description="Bug reports and feature requests."
      actions={<ActionButton disabled={busy}
        onClick={() => open(MIXDOG_ISSUES_URL)}>Issues ↗</ActionButton>} />
    <ResourceRow title="Sponsor" className="settings-about-row"
      description="Support mixdog development."
      actions={<ActionButton disabled={busy}
        onClick={() => open(MIXDOG_SPONSOR_URL)}>Ko-fi ↗</ActionButton>} />
  </Group>;
}

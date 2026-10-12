// The New Task context bar's chip order: project → workflow (the pack and
// delegation pills) → branch. The branch chip is always the last chip.
import type { ReactNode } from 'react';

export function ComposerContextChips({
  project,
  workflow,
  delegation,
  branch,
}: {
  project: ReactNode;
  workflow: ReactNode;
  delegation: ReactNode;
  branch: ReactNode;
}) {
  return (
    <>
      {project}
      {workflow}
      {delegation}
      {branch}
    </>
  );
}

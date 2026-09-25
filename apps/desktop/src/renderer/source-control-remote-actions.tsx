import { ArrowUp, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DesktopGitStatus } from '../shared/contract';
import { repositoryBusyReason } from './source-control-actions';

interface SourceControlRemoteAction {
  key: string;
  runKey: string;
  verb: string;
  target: string;
  label: string;
  reason: string;
  blocked: boolean;
  icon: ReactNode;
  perform(): void;
}

export function sourceControlRemoteActions({
  status,
  busy,
  canFetch,
  canPush,
  missingChannel,
  onFetch,
  onPush,
}: {
  status: DesktopGitStatus | null | undefined;
  busy: string;
  canFetch: boolean;
  canPush: boolean;
  missingChannel(label: string): string;
  onFetch(): void;
  onPush(): void;
}) {
  const remoteName = (status?.upstreamName || '').split('/')[0] || 'origin';
  const aheadCount = status?.ahead ?? 0;
  const behindCount = status?.behind ?? 0;
  // Shared gate for every remote action: a running action, an unfinished
  // Git operation, a missing channel, then a missing remote — in that order.
  const remoteGate = (capable: boolean, action: string, verb: string): string => {
    const busyReason = repositoryBusyReason(busy, status);
    if (busyReason) return busyReason;
    if (!capable) return missingChannel(action);
    return status?.remote ? '' : `Add a remote before ${verb}`;
  };
  const fetchReason = remoteGate(canFetch, 'Fetching', 'fetching');
  const fetchEntry: SourceControlRemoteAction = {
    key: 'fetch',
    runKey: 'fetch',
    verb: 'Fetch',
    target: remoteName,
    label: `Fetch ${remoteName}`,
    reason: fetchReason,
    blocked: Boolean(fetchReason),
    icon: <RefreshCw size={14} aria-hidden="true" />,
    perform: onFetch,
  };
  let pushReason = remoteGate(canPush, 'Pushing', 'pushing');
  if (!pushReason && status?.detached) pushReason = 'Cannot push a detached HEAD';
  const pushEntry: SourceControlRemoteAction = {
    key: 'push',
    runKey: 'push',
    verb: 'Push',
    target: remoteName,
    label: `Push ${remoteName}`,
    reason: pushReason,
    blocked: Boolean(pushReason),
    icon: <ArrowUp size={14} aria-hidden="true" />,
    perform: onPush,
  };
  let rowPushReason = pushReason;
  if (!rowPushReason && !status?.upstream) rowPushReason = 'Publish the branch before pushing';

  return {
    remoteName,
    aheadCount,
    behindCount,
    fetchEntry,
    pushEntry,
    rowPushReason,
    rowPushBlocked: Boolean(rowPushReason),
  };
}

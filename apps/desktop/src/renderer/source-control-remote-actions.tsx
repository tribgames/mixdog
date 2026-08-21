import { ArrowUp, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import type { DesktopGitStatus } from "../shared/contract";

export interface SourceControlRemoteAction {
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
  const remoteName = (status?.upstreamName || "").split("/")[0] || "origin";
  const aheadCount = status?.ahead ?? 0;
  const behindCount = status?.behind ?? 0;
  const fetchReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !canFetch
        ? missingChannel("Fetching")
        : !status?.remote
          ? "Add a remote before fetching"
          : "";
  const fetchEntry: SourceControlRemoteAction = {
    key: "fetch",
    runKey: "fetch",
    verb: "Fetch",
    target: remoteName,
    label: `Fetch ${remoteName}`,
    reason: fetchReason,
    blocked: Boolean(fetchReason),
    icon: <RefreshCw size={14} aria-hidden="true" />,
    perform: onFetch,
  };
  const pushReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !canPush
        ? missingChannel("Pushing")
        : !status?.remote
          ? "Add a remote before pushing"
          : status.detached
            ? "Cannot push a detached HEAD"
            : "";
  const pushEntry: SourceControlRemoteAction = {
    key: "push",
    runKey: "push",
    verb: "Push",
    target: remoteName,
    label: `Push ${remoteName}`,
    reason: pushReason,
    blocked: Boolean(pushReason),
    icon: <ArrowUp size={14} aria-hidden="true" />,
    perform: onPush,
  };
  const rowPushReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !canPush
        ? missingChannel("Pushing")
        : !status?.remote
          ? "Add a remote before pushing"
          : status.detached
            ? "Cannot push a detached HEAD"
            : !status.upstream
              ? "Publish the branch before pushing"
              : "";

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

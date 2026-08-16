import { ArrowDown, ArrowUp, CloudUpload, RefreshCw } from "lucide-react";
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
  missingChannel,
  onFetch,
  onPush,
  onPull,
}: {
  status: DesktopGitStatus | null | undefined;
  busy: string;
  canFetch: boolean;
  missingChannel(label: string): string;
  onFetch(): void;
  onPush(): void;
  onPull(): void;
}) {
  const remoteName = (status?.upstreamName || "").split("/")[0] || "origin";
  const aheadCount = status?.ahead ?? 0;
  const behindCount = status?.behind ?? 0;
  const bothDirections = aheadCount > 0 && behindCount > 0;
  const fetchEntry: SourceControlRemoteAction = {
    key: "fetch",
    runKey: "fetch",
    verb: "Fetch",
    target: remoteName,
    label: `Fetch ${remoteName}`,
    reason: "",
    blocked: false,
    icon: <RefreshCw size={14} aria-hidden="true" />,
    perform: onFetch,
  };
  const publishEntry = (key: string, label: string): SourceControlRemoteAction => ({
    key,
    runKey: "push",
    verb: label,
    target: "",
    label,
    reason: "",
    blocked: false,
    icon: <CloudUpload size={14} aria-hidden="true" />,
    perform: onPush,
  });
  const blockedEntry = (
    key: string,
    label: string,
    reason: string,
  ): SourceControlRemoteAction => ({
    ...publishEntry(key, label),
    reason,
    blocked: true,
    perform: () => {},
  });
  const pushEntry: SourceControlRemoteAction = {
    key: "push",
    runKey: "push",
    verb: "Push",
    target: remoteName,
    label: `Push ${remoteName}`,
    reason: "",
    blocked: false,
    icon: <ArrowUp size={14} aria-hidden="true" />,
    perform: onPush,
  };
  const remoteEntry = !status ? null
    : !status.remote
      ? blockedEntry(
        "publish-repository",
        "Publish repository",
        "Add a remote before publishing this repository",
      )
      : status.unborn
        ? fetchEntry
        : status.detached
          ? blockedEntry(
            "detached-head",
            "Publish branch",
            status.operation === "rebase"
              ? "Rebase in progress"
              : "Cannot publish detached HEAD",
          )
          : !status.upstream
            ? publishEntry("publish-branch", "Publish branch")
            : aheadCount === 0 && behindCount === 0
              ? fetchEntry
              : behindCount > 0
                ? {
                  key: "pull",
                  runKey: "pull",
                  verb: "Pull",
                  target: remoteName,
                  label: `Pull ${remoteName}`,
                  reason: "",
                  blocked: false,
                  icon: <ArrowDown size={14} aria-hidden="true" />,
                  perform: onPull,
                }
                : pushEntry;
  const rowPushReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !status?.remote
        ? "Add a remote before pushing"
        : status.detached
          ? "Cannot push a detached HEAD"
          : !status.upstream
            ? "Publish the branch from the toolbar before pushing"
            : "";
  const headerFetchReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !canFetch
        ? missingChannel("Fetching")
        : !status?.remote
          ? "Add a remote before fetching"
          : "";

  return {
    remoteName,
    aheadCount,
    behindCount,
    bothDirections,
    fetchEntry,
    remoteEntry,
    rowPushReason,
    rowPushBlocked: Boolean(rowPushReason),
    headerFetchReason,
  };
}

import type { HTMLAttributes } from "react";
import { Check, FileText, Undo2 } from "lucide-react";

import type { DesktopGitFile } from "../shared/contract";
import type { ScmContextMenuItem } from "./ScmContextMenu";
import { ScmPathText } from "./ScmPathText";
import { ScmStatusIcon } from "./ScmStatusIcon";
import { statusKind } from "./source-control-support";

export function changedFileMenuItems({
  file,
  busy,
  canRevert,
  canIgnore,
  canReveal,
  canOpenDefault,
  missingChannel,
  guarded,
  onDiscard,
  onIgnore,
  onCopyFilePath,
  onCopyRelativePath,
  onReveal,
  onOpenDefault,
}: {
  file: DesktopGitFile;
  busy: boolean;
  canRevert: boolean;
  canIgnore: boolean;
  canReveal: boolean;
  canOpenDefault: boolean;
  missingChannel(label: string): string;
  guarded(action: () => void): void;
  onDiscard(): void;
  onIgnore(path: string, scope?: "extension"): void;
  onCopyFilePath(): void;
  onCopyRelativePath(): void;
  onReveal(): void;
  onOpenDefault(): void;
}): ScmContextMenuItem[] {
  const slash = file.path.lastIndexOf("/");
  const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const folder = slash >= 0 ? file.path.slice(0, slash) : "";
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot) : "";
  return [
    {
      id: "discard",
      label: "Discard changes…",
      danger: true,
      disabled: busy || file.conflicted || !canRevert,
      title: file.conflicted
        ? "Resolve the conflict before discarding this file"
        : !canRevert ? missingChannel("Discarding changes") : undefined,
      onSelect: () => guarded(onDiscard),
    },
    {
      id: "ignore-file",
      label: "Ignore file (add to .gitignore)",
      separatorBefore: true,
      disabled: busy || !canIgnore,
      title: canIgnore ? undefined : missingChannel("Ignoring a file"),
      onSelect: () => guarded(() => onIgnore(file.path)),
    },
    {
      id: "ignore-folder",
      label: "Ignore folder (add to .gitignore)",
      disabled: busy || !canIgnore || !folder,
      title: folder
        ? canIgnore ? undefined : missingChannel("Ignoring a folder")
        : "This file sits at the repository root, so it has no folder to ignore",
      onSelect: () => guarded(() => onIgnore(folder)),
    },
    {
      id: "ignore-extension",
      label: `Ignore all ${extension || "extensionless"} files (add to .gitignore)`,
      disabled: busy || !canIgnore || !extension,
      title: extension
        ? canIgnore ? undefined : missingChannel("Ignoring a file type")
        : "This file has no extension, so there is no file type to ignore",
      onSelect: () => guarded(() => onIgnore(file.path, "extension")),
    },
    {
      id: "copy-file-path",
      label: "Copy file path",
      separatorBefore: true,
      onSelect: onCopyFilePath,
    },
    {
      id: "copy-relative-path",
      label: "Copy relative file path",
      onSelect: onCopyRelativePath,
    },
    {
      id: "reveal",
      label: "Show in Explorer",
      separatorBefore: true,
      disabled: !canReveal,
      title: canReveal ? undefined : missingChannel("Showing a file in Explorer"),
      onSelect: onReveal,
    },
    {
      id: "open-default",
      label: "Open with default program",
      disabled: !canOpenDefault,
      title: canOpenDefault ? undefined : missingChannel("Opening a file"),
      onSelect: onOpenDefault,
    },
  ];
}

export function SourceControlFileRow({
  file,
  included,
  selected,
  busy,
  contextMenuProps,
  onSetIncluded,
  onToggleSelected,
  onOpenChange,
  onOpenFile,
  onResolve,
  onDiscard,
}: {
  file: DesktopGitFile;
  included: boolean;
  selected: boolean;
  busy: boolean;
  contextMenuProps: HTMLAttributes<HTMLDivElement>;
  onSetIncluded(included: boolean): void;
  onToggleSelected(additive: boolean): void;
  onOpenChange(): void;
  onOpenFile(): void;
  onResolve(): void;
  onDiscard(): void;
}) {
  const slash = file.path.lastIndexOf("/");
  const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const oldSlash = file.oldPath?.lastIndexOf("/") ?? -1;
  const oldFileName = file.oldPath
    ? oldSlash >= 0 ? file.oldPath.slice(oldSlash + 1) : file.oldPath
    : "";
  const displayName = file.oldPath ? `${oldFileName} → ${fileName}` : fileName;
  const kind = statusKind(file);
  return <div className="dock-scm-file" data-selected={selected || undefined}
    data-conflicted={file.conflicted || undefined}
    role="treeitem" aria-selected={selected} {...contextMenuProps}>
    <input type="checkbox" className="dock-scm-file-check" checked={included}
      disabled={file.conflicted || busy}
      aria-label={`Include ${file.path} in the commit`}
      onChange={(event) => onSetIncluded(event.currentTarget.checked)} />
    <button type="button" className="dock-scm-file-main" title={file.path}
      data-status={kind}
      aria-label={`Open changes ${file.path}`}
      onClick={(event) => {
        const additive = event.ctrlKey || event.metaKey;
        onToggleSelected(additive);
        if (!additive && !event.shiftKey) onOpenChange();
      }}>
      <ScmPathText path={file.path} name={displayName} />
    </button>
    <ScmStatusIcon kind={kind} className="dock-scm-file-state" />
    <div className="dock-scm-file-actions">
      <button type="button" aria-label={`Open file ${file.path}`} onClick={onOpenFile}>
        <FileText size={14} aria-hidden="true" />
      </button>
      {file.conflicted
        ? <button type="button" aria-label={`Mark resolved ${file.path}`}
            disabled={busy} onClick={onResolve}>
            <Check size={14} aria-hidden="true" />
          </button>
        : <button type="button" aria-label={`Discard changes ${file.path}`}
            disabled={busy} onClick={onDiscard}>
            <Undo2 size={14} aria-hidden="true" />
          </button>}
    </div>
  </div>;
}

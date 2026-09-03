import React, {
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { DesktopGitFile } from "../shared/contract";
import {
  anchoredPanelGeometry,
  intersectRects,
  rectFrom,
  viewportRect,
} from "./anchored-panel";
import { scmStatusKind, type ScmStatusKind } from "./ScmStatusIcon";

export interface SourceControlDiffRequest {
  source: "staged" | "unstaged" | "commit" | "session";
  hash?: string;
  untracked?: boolean;
}

export const indexOnly = (file: DesktopGitFile): boolean =>
  !file.conflicted && file.index !== " " && file.index !== "?" && file.worktree === " ";

export const stagedInIndex = (file: DesktopGitFile): boolean =>
  !file.conflicted && file.index !== " " && file.index !== "?";

export const partiallyStaged = (file: DesktopGitFile): boolean =>
  stagedInIndex(file) && !file.untracked && file.worktree !== " ";

export const HISTORY_PAGE_SIZE = 40;
export const SCM_FILE_ROW_HEIGHT = 29;
export const SCM_COMMIT_ROW_HEIGHT = 46;
const SCM_ROW_OVERSCAN = 6;
export const HISTORY_PREFETCH_ROWS = 8;
export const DEFAULT_BRANCH_NAMES = ["main", "master", "trunk"];

const GIT_RESET_DIRTY_CODE = "git-reset-dirty-worktree";

export function isDirtyResetRefusal(reason: unknown): boolean {
  if (typeof reason === "object" && reason !== null
    && (reason as { code?: unknown }).code === GIT_RESET_DIRTY_CODE) return true;
  const message = reason instanceof Error ? reason.message : String(reason);
  return /--mixed reset rewrites the index/.test(message);
}

export function leavesStateBehind(key: string): boolean {
  return /^(revert-commit|cherry-pick|reset|revert:|discard-all|resolve:|continue|abort-operation|branch-merge|pull|sync|stash)/
    .test(key);
}

export function gitRemoteWebUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  if (!trimmed) return "";
  const ssh = /^(?:ssh:\/\/)?(?:git@)?([^:/]+)[:/](.+)$/i.exec(trimmed);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (ssh && !trimmed.includes("://")) return `https://${ssh[1]}/${ssh[2]}`;
  return "";
}

export function pullRequestUrl(remoteUrl: string, branch: string): string {
  const base = gitRemoteWebUrl(remoteUrl);
  if (!base || !branch) return "";
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  if (/gitlab/i.test(base)) {
    return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  }
  return `${base}/compare/${encoded}?expand=1`;
}

export function statusKind(file: DesktopGitFile): ScmStatusKind {
  if (file.conflicted) return "conflicted";
  if (file.untracked) return "new";
  const value = file.index !== " " && file.index !== "?" ? file.index : file.worktree;
  return scmStatusKind(value);
}

export function pathsFor(file: DesktopGitFile): string[] {
  return file.oldPath ? [file.oldPath, file.path] : [file.path];
}

export const SCM_SORT_KEY = "mixdog.desktop.scm-sort-key.v1";
export type ScmSortKey = "path" | "name" | "status";

export function changedFilesLabel(total: number, visible: number): string {
  const prefix = visible !== total ? `${visible} of ` : "";
  return `${prefix}${total} changed file${total === 1 ? "" : "s"}`;
}

export const EMPTY_SUMMARY = "Empty commit message";
export const UNKNOWN_AUTHOR = "Unknown author";

export function useAnchoredPanel(
  open: boolean,
  trigger: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  options: {
    preferredWidth: number;
    minWidth?: number;
    align?: "start" | "end";
    placement?: "below" | "above";
    boundary?: React.RefObject<HTMLElement | null>;
  },
): React.CSSProperties {
  const { preferredWidth, minWidth, align, placement, boundary } = options;
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed" });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const anchor = trigger.current;
      const surface = panel.current;
      if (!anchor || !surface) return;
      const viewport = viewportRect();
      const boundaryElement = boundary?.current;
      const bounds = boundaryElement
        ? intersectRects(rectFrom(boundaryElement), viewport)
        : viewport;
      const geometry = anchoredPanelGeometry({
        trigger: rectFrom(anchor),
        bounds,
        preferredWidth,
        minWidth,
        naturalHeight: surface.scrollHeight || surface.offsetHeight,
        align,
        placement,
      });
      setStyle({
        position: "fixed",
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        maxHeight: geometry.maxHeight,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [align, boundary, minWidth, open, panel, placement, preferredWidth, trigger]);
  return style;
}

export interface ScmRowWindow {
  start: number;
  end: number;
  leading: number;
  trailing: number;
  measured: boolean;
}

export function useRowWindow(
  viewport: React.RefObject<HTMLElement | null>,
  rowHeight: number,
  count: number,
  active: boolean,
  resetKey: string,
): ScmRowWindow {
  const [metrics, setMetrics] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !active) return undefined;
    const measure = () => {
      const top = node.scrollTop;
      const height = node.clientHeight;
      setMetrics((current) =>
        current.top === top && current.height === height ? current : { top, height });
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const Observer = typeof window.ResizeObserver === "function" ? window.ResizeObserver : null;
    const observer = Observer ? new Observer(measure) : null;
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [active, count, rowHeight, viewport]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !active) return;
    node.scrollTop = 0;
    setMetrics((current) => (current.top === 0 ? current : { ...current, top: 0 }));
  }, [active, resetKey, viewport]);
  return useMemo(() => {
    const { top, height } = metrics;
    if (height <= 0) {
      // First commit, viewport not measured yet: mount only what the tallest
      // plausible viewport could show. Mounting EVERY row here and windowing
      // on the next commit made a dock with a few hundred changes pay a full
      // list build — rows, path measurement, layout — for one frame that the
      // real window immediately threw away (user: 소스 제어 누르면 히칭).
      const viewportGuess = typeof window === "undefined" ? 800 : window.innerHeight;
      const end = Math.min(count, Math.ceil(viewportGuess / rowHeight) + SCM_ROW_OVERSCAN);
      return { start: 0, end, leading: 0, trailing: (count - end) * rowHeight, measured: false };
    }
    if (count * rowHeight <= height) {
      return { start: 0, end: count, leading: 0, trailing: 0, measured: true };
    }
    const start = Math.max(0, Math.floor(top / rowHeight) - SCM_ROW_OVERSCAN);
    const end = Math.min(count, Math.max(start,
      Math.ceil((top + height) / rowHeight) + SCM_ROW_OVERSCAN));
    return {
      start,
      end,
      leading: start * rowHeight,
      trailing: (count - end) * rowHeight,
      measured: true,
    };
  }, [count, metrics, rowHeight]);
}

export function RowSpacer({ height, edge }: { height: number; edge: "leading" | "trailing" }) {
  return <div className="dock-scm-row-spacer" data-scm-spacer={edge}
    aria-hidden="true" style={{ height }} />;
}

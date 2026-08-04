import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronRight,
  CircleX,
  FileText,
  Filter,
  Info,
  Lightbulb,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  getEditorLanguageSnapshot,
  subscribeEditorLanguageStore,
  type EditorProblem,
} from "./editor-language-store";
import { t } from "./i18n";
import { RowOverflowMenu } from "./RowOverflowMenu";

export interface ProblemsPanelFilter {
  query: string;
  showErrors: boolean;
  showWarnings: boolean;
  showInfos: boolean;
  activeFileOnly: boolean;
  sort: "severity" | "position";
  view: "tree" | "table";
}

export const DEFAULT_PROBLEMS_PANEL_FILTER: ProblemsPanelFilter = Object.freeze({
  query: "",
  showErrors: true,
  showWarnings: true,
  showInfos: true,
  activeFileOnly: false,
  sort: "severity",
  view: "tree",
});

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").toLocaleLowerCase();
}

function projectProblems(projectPath: string, problems: readonly EditorProblem[]): EditorProblem[] {
  const project = normalizedPath(projectPath);
  return problems.filter((problem) => normalizedPath(problem.projectPath) === project);
}

function useProblems(active: boolean) {
  const subscribe = useCallback(
    (listener: () => void) => active ? subscribeEditorLanguageStore(listener) : () => {},
    [active],
  );
  return React.useSyncExternalStore(
    subscribe,
    getEditorLanguageSnapshot,
    getEditorLanguageSnapshot,
  );
}

export const ProjectProblemCount = memo(function ProjectProblemCount({
  projectPath,
}: {
  projectPath: string;
}) {
  const language = React.useSyncExternalStore(
    subscribeEditorLanguageStore,
    getEditorLanguageSnapshot,
    getEditorLanguageSnapshot,
  );
  const count = projectProblems(projectPath, language.problems).length;
  return count ? <i className="bottom-panel-tab-count">{count}</i> : null;
});

export const WorkbenchProblemsToolbar = memo(function WorkbenchProblemsToolbar({
  projectPath,
  filter,
  onFilter,
  onCollapseAll,
}: {
  projectPath: string;
  filter: ProblemsPanelFilter;
  onFilter(next: ProblemsPanelFilter): void;
  onCollapseAll(): void;
}) {
  const language = React.useSyncExternalStore(
    subscribeEditorLanguageStore,
    getEditorLanguageSnapshot,
    getEditorLanguageSnapshot,
  );
  const rows = projectProblems(projectPath, language.problems);
  const count = (severity: number) => rows.filter((problem) => problem.severity === severity).length;
  const update = (patch: Partial<ProblemsPanelFilter>) => onFilter({ ...filter, ...patch });
  return <div className="problems-panel-actions" aria-label={t("Problems actions")}>
    <label className="problems-panel-filter">
      <Filter size={14} aria-hidden="true" />
      <input value={filter.query}
        onChange={(event) => update({ query: event.target.value })}
        placeholder={t("Filter problems")}
        aria-label={t("Filter Problems")} />
      {filter.query && <button type="button" aria-label={t("Clear Problems filter")}
        onClick={() => update({ query: "" })}><X size={13} aria-hidden="true" /></button>}
    </label>
    <button type="button" className="problems-filter-toggle" data-severity="error"
      aria-label={t("Show Errors ({{count}})", { count: count(1) })} aria-pressed={filter.showErrors}
      onClick={() => update({ showErrors: !filter.showErrors })}>
      <CircleX size={14} aria-hidden="true" /><span>{count(1)}</span>
    </button>
    <button type="button" className="problems-filter-toggle" data-severity="warning"
      aria-label={t("Show Warnings ({{count}})", { count: count(2) })} aria-pressed={filter.showWarnings}
      onClick={() => update({ showWarnings: !filter.showWarnings })}>
      <TriangleAlert size={14} aria-hidden="true" /><span>{count(2)}</span>
    </button>
    <button type="button" className="problems-filter-toggle" data-severity="info"
      aria-label={t("Show Infos ({{count}})", { count: count(3) + count(4) })} aria-pressed={filter.showInfos}
      onClick={() => update({ showInfos: !filter.showInfos })}>
      <Info size={14} aria-hidden="true" /><span>{count(3) + count(4)}</span>
    </button>
    {/* Cleanup (user: 구조 클린하게 — 좁은 창에서 다 가려짐): the always-on
        strip keeps ONLY the filter and the severity counters. The four
        low-frequency toggles live in one "…" menu, VS Code-style. */}
    <RowOverflowMenu label="More Problems actions" width={188} items={[
      {
        id: "active-file",
        label: "Active file only",
        checked: filter.activeFileOnly,
        onSelect: () => update({ activeFileOnly: !filter.activeFileOnly }),
      },
      {
        id: "sort-severity",
        label: "Sort by severity",
        checked: filter.sort === "severity",
        separatorBefore: true,
        onSelect: () => update({ sort: "severity" }),
      },
      {
        id: "sort-position",
        label: "Sort by position",
        checked: filter.sort === "position",
        onSelect: () => update({ sort: "position" }),
      },
      {
        id: "view",
        label: filter.view === "tree" ? "View as table" : "View as tree",
        separatorBefore: true,
        onSelect: () => update({ view: filter.view === "tree" ? "table" : "tree" }),
      },
      { id: "collapse-all", label: "Collapse all", onSelect: onCollapseAll },
    ]} />
  </div>;
});

function ProblemSeverityIcon({ severity }: { severity: number }) {
  return severity === 1
    ? <CircleX size={15} aria-hidden="true" />
    : severity === 2
      ? <TriangleAlert size={15} aria-hidden="true" />
      : <Info size={15} aria-hidden="true" />;
}

export const WorkbenchProblemsPane = memo(function WorkbenchProblemsPane({
  projectPath,
  active,
  activeFileRel = "",
  filter = DEFAULT_PROBLEMS_PANEL_FILTER,
  collapseNonce = 0,
  onOpenFile,
  onQuickFix,
}: {
  projectPath: string;
  active: boolean;
  activeFileRel?: string;
  filter?: ProblemsPanelFilter;
  collapseNonce?: number;
  onOpenFile?(project: string, rel: string, line?: number): void;
  onQuickFix?(problem: EditorProblem): void;
}) {
  const language = useProblems(active);
  const rows = useMemo(() => projectProblems(projectPath, language.problems)
    .filter((problem) => {
      if (problem.severity === 1 && !filter.showErrors) return false;
      if (problem.severity === 2 && !filter.showWarnings) return false;
      if (problem.severity >= 3 && !filter.showInfos) return false;
      if (filter.activeFileOnly && normalizedPath(problem.relPath) !== normalizedPath(activeFileRel)) {
        return false;
      }
      const needle = filter.query.trim().toLocaleLowerCase();
      return !needle || `${problem.message} ${problem.relPath} ${problem.source} ${problem.code}`
        .toLocaleLowerCase().includes(needle);
    })
    .sort((left, right) => left.relPath.localeCompare(right.relPath)
      || (filter.sort === "severity"
        ? left.severity - right.severity || left.startLineNumber - right.startLineNumber
        : left.startLineNumber - right.startLineNumber || left.severity - right.severity)),
  [activeFileRel, filter, language.problems, projectPath]);
  const groups = useMemo(() => {
    const grouped = new Map<string, EditorProblem[]>();
    for (const problem of rows) {
      const group = grouped.get(problem.relPath);
      if (group) group.push(problem);
      else grouped.set(problem.relPath, [problem]);
    }
    return [...grouped.entries()];
  }, [rows]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const appliedCollapseNonce = useRef(0);
  useEffect(() => {
    if (!collapseNonce || appliedCollapseNonce.current === collapseNonce) return;
    appliedCollapseNonce.current = collapseNonce;
    setCollapsed(new Set(groups.map(([relPath]) => relPath)));
  }, [collapseNonce, groups]);
  const toggleGroup = (relPath: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    return next;
  });
  const focusTreeSibling = (event: KeyboardEvent<HTMLElement>, offset: -1 | 1) => {
    const tree = event.currentTarget.closest('[role="tree"]');
    const items = tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')] : [];
    const next = items[items.indexOf(event.currentTarget) + offset];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  const openProblem = (problem: EditorProblem) =>
    onOpenFile?.(problem.projectPath, problem.relPath, problem.startLineNumber);

  if (!projectPath) return <p className="utility-dock-empty">{t("Open a project to view problems.")}</p>;
  if (!rows.length) {
    return <p className="utility-dock-empty">
      {filter.query || filter.activeFileOnly ? t("No problems match the current filters.") : t("No problems detected.")}
    </p>;
  }
  if (filter.view === "table") {
    return <div className="problems-table" role="tree" aria-label={t("Problems")}>
      <div className="problems-table-header" aria-hidden="true">
        <span>{t("Problem")}</span><span>{t("File")}</span><span>{t("Line")}</span>
      </div>
      {rows.map((problem) => <div key={problem.key} role="treeitem" tabIndex={0}
        className="problem-table-row" data-severity={problem.severity}
        onClick={() => openProblem(problem)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") focusTreeSibling(event, 1);
          else if (event.key === "ArrowUp") focusTreeSibling(event, -1);
          else if (event.key === "Enter") openProblem(problem);
        }}>
        <span><ProblemSeverityIcon severity={problem.severity} />{problem.message}</span>
        <span>{problem.relPath}</span>
        <span>{problem.startLineNumber}:{problem.startColumn}</span>
      </div>)}
    </div>;
  }
  return <div className="problems-tree" role="tree" aria-label={t("Problems")}>
    {groups.map(([relPath, problems]) => {
      const isCollapsed = collapsed.has(relPath);
      const segments = relPath.replace(/\\/g, "/").split("/");
      const name = segments.at(-1) || relPath;
      const parent = segments.slice(0, -1).join("/");
      return <div className="problems-file-group" key={relPath}>
        <div role="treeitem" tabIndex={0} className="problems-file-row"
          aria-expanded={!isCollapsed} data-rel={relPath}
          onClick={() => toggleGroup(relPath)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") focusTreeSibling(event, 1);
            else if (event.key === "ArrowUp") focusTreeSibling(event, -1);
            else if (event.key === "ArrowLeft" && !isCollapsed) {
              event.preventDefault();
              toggleGroup(relPath);
            } else if (event.key === "ArrowRight" && isCollapsed) {
              event.preventDefault();
              toggleGroup(relPath);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleGroup(relPath);
            }
          }}>
          <ChevronRight size={15} aria-hidden="true" />
          <FileText size={14} aria-hidden="true" />
          <b>{name}</b>{parent && <small>{parent}</small>}
          <i>{problems.length}</i>
        </div>
        {!isCollapsed && <div role="group">
          {problems.map((problem) => <div key={problem.key} role="treeitem" tabIndex={0}
            className="problem-tree-row" data-severity={problem.severity}
            onClick={() => openProblem(problem)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") focusTreeSibling(event, 1);
              else if (event.key === "ArrowUp") focusTreeSibling(event, -1);
              else if (event.key === "Enter") openProblem(problem);
            }}>
            <ProblemSeverityIcon severity={problem.severity} />
            <span><b>{problem.message}</b>
              <small>{[problem.source, problem.code].filter(Boolean).join(" ")}</small></span>
            <em>[Ln {problem.startLineNumber}, Col {problem.startColumn}]</em>
            {onQuickFix && <button type="button" className="problem-quick-fix"
              aria-label={t("Show Quick Fixes for {{message}}", { message: problem.message })}
              onClick={(event) => {
                event.stopPropagation();
                onQuickFix(problem);
              }}><Lightbulb size={14} aria-hidden="true" /></button>}
          </div>)}
        </div>}
      </div>;
    })}
  </div>;
});

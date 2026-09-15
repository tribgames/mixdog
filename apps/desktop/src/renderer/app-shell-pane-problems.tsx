import React from "react";
import { BottomPanel, type useBottomPanelState } from "./BottomPanel";
import { bottomPanelOpenForPane } from "./bottom-panel-pane-state";
import { WORKBENCH_PANEL_REGISTRY } from "./workbench-panel-registry";
import {
  ProjectProblemCount,
  WorkbenchProblemsFilter,
  WorkbenchProblemsPane,
  WorkbenchProblemsSeverityActions,
  type ProblemsPanelFilter,
} from "./WorkbenchProblems";
import { paneActiveSelection, type PaneLeaf } from "./pane-layout";
import type { EditorNavigationState } from "./use-editor-navigation";

export interface PaneProblemsRendererProps {
  bottomPanel: ReturnType<typeof useBottomPanelState>;
  problemsFilter: ProblemsPanelFilter;
  setProblemsFilter: (filter: ProblemsPanelFilter) => void;
  problemsCollapseNonce: number;
  setProblemsCollapseNonce: React.Dispatch<React.SetStateAction<number>>;
  openFileTab: (project: string, rel: string, line?: number, accessToken?: string) => void;
  openProblemQuickFix: EditorNavigationState["openProblemQuickFix"];
}

export function renderPaneProblemsView(
  leaf: PaneLeaf,
  {
    bottomPanel,
    problemsFilter,
    setProblemsFilter,
    problemsCollapseNonce,
    setProblemsCollapseNonce,
    openFileTab,
    openProblemQuickFix,
  }: PaneProblemsRendererProps,
): React.ReactNode {
  const active = paneActiveSelection(leaf);
  if (active?.kind !== "file") return null;
  const open = bottomPanelOpenForPane(bottomPanel.openPaneIds, leaf.id);
  return <BottomPanel
    open={open}
    height={bottomPanel.height}
    motion={bottomPanel.motion}
    onHeightChange={bottomPanel.setHeight}
    tabs={WORKBENCH_PANEL_REGISTRY.map((panel) => ({
      id: panel.id,
      label: panel.label,
      ...(panel.id === "problems"
        ? { badge: <ProjectProblemCount projectPath={active.project} /> }
        : {}),
    }))}
    activeTab="problems"
    onSelectTab={() => {}}
    onClose={() => bottomPanel.setOpenFor(leaf.id, false)}
    headerActions={<WorkbenchProblemsFilter
      filter={problemsFilter}
      onFilter={setProblemsFilter} />}
    actions={<WorkbenchProblemsSeverityActions
      projectPath={active.project}
      filter={problemsFilter}
      onFilter={setProblemsFilter}
      onCollapseAll={() => setProblemsCollapseNonce((value) => value + 1)} />}>
    {open &&
      <div className="workbench-panel-surface utility-dock-pane stable-surface-layer"
        data-tab="problems"
        data-surface-active="true">
          <WorkbenchProblemsPane projectPath={active.project}
            active={open}
            activeFileRel={active.rel}
            filter={problemsFilter}
            collapseNonce={problemsCollapseNonce}
            onOpenFile={openFileTab}
            onQuickFix={openProblemQuickFix} />
        </div>}
  </BottomPanel>;
}


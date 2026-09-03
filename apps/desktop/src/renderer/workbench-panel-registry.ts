export type WorkbenchPanelId = "problems";

export const WORKBENCH_PANEL_REGISTRY: ReadonlyArray<{
  id: WorkbenchPanelId;
  label: string;
  requiresProject?: boolean;
}> = Object.freeze([
  { id: "problems", label: "Problems", requiresProject: true },
]);

export type WorkbenchPanelId = "problems";

export const WORKBENCH_PANEL_REGISTRY: ReadonlyArray<{
  id: WorkbenchPanelId;
  label: string;
  requiresProject?: boolean;
}> = Object.freeze([
  { id: "problems", label: "Problems", requiresProject: true },
]);

export function isWorkbenchPanelId(value: string): value is WorkbenchPanelId {
  return WORKBENCH_PANEL_REGISTRY.some((entry) => entry.id === value);
}

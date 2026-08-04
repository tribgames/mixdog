export type WorkbenchPanelId =
  | "problems"
  | "terminal";

export const WORKBENCH_PANEL_REGISTRY: ReadonlyArray<{
  id: WorkbenchPanelId;
  label: string;
  requiresProject?: boolean;
}> = Object.freeze([
  // Tab order is user-specified: Terminal leads, Problems follows.
  { id: "terminal", label: "Terminal" },
  { id: "problems", label: "Problems", requiresProject: true },
]);

export function isWorkbenchPanelId(value: string): value is WorkbenchPanelId {
  return WORKBENCH_PANEL_REGISTRY.some((entry) => entry.id === value);
}

import { lazy, Suspense, type ComponentProps } from "react";
export type { WorkbenchQuickAccessMode } from "./WorkbenchOverlays";

let pending: Promise<typeof import("./WorkbenchOverlays")> | null = null;
function loadOverlays() {
  pending ??= import("./WorkbenchOverlays").catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}
const QuickAccess = lazy(() => loadOverlays().then((module) => ({
  default: module.WorkbenchQuickAccess,
})));
const UnsavedChanges = lazy(() => loadOverlays().then((module) => ({
  default: module.UnsavedChangesDialog,
})));

// These secondary dialogs never belong to the first chat paint. A local
// Suspense boundary keeps the current screen in place while they arrive.
export function WorkbenchQuickAccess(props: ComponentProps<typeof QuickAccess>) {
  return <Suspense fallback={null}><QuickAccess {...props} /></Suspense>;
}
export function UnsavedChangesDialog(props: ComponentProps<typeof UnsavedChanges>) {
  return <Suspense fallback={null}><UnsavedChanges {...props} /></Suspense>;
}

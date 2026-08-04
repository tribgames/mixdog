type StudioViewModule = typeof import("./StudioView");

let studioViewModulePromise: Promise<StudioViewModule> | null = null;

export function loadStudioViewModule(): Promise<StudioViewModule> {
  studioViewModulePromise ||= import("./StudioView").catch((error) => {
    studioViewModulePromise = null;
    throw error;
  });
  return studioViewModulePromise;
}

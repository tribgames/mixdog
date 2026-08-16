import type { DesktopModelSelection } from "../shared/contract";

export function mergeRoutePreference(
  current: DesktopModelSelection | null | undefined,
  next: DesktopModelSelection,
): DesktopModelSelection {
  const sameModel = current?.provider === next.provider && current.model === next.model;
  return {
    ...(sameModel ? current : {}),
    ...next,
  };
}

export function createRoutePreferenceStore() {
  const selections = new Map<string, DesktopModelSelection>();
  const keyFor = (provider: string, model: string) => `${provider}/${model}`;
  return {
    get(provider: string, model: string) {
      return selections.get(keyFor(provider, model));
    },
    remember(selection: DesktopModelSelection) {
      const key = keyFor(selection.provider, selection.model);
      const remembered = mergeRoutePreference(selections.get(key), selection);
      selections.set(key, remembered);
      return remembered;
    },
  };
}

export const routePreferenceStore = createRoutePreferenceStore();

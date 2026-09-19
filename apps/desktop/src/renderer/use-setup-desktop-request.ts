import { useEffect, useRef } from 'react';
import type { DesktopApi } from '../shared/contract';
import { getDesktopThemePreference, setDesktopThemePreference, desktopThemeOptions } from './desktop-theme';
import {
  getUiLanguagePreference,
  setUiLanguagePreference,
  SUPPORTED_UI_LANGUAGES,
  type UiLanguagePreference,
} from './i18n';
import { getSidePanelMode, setSidePanelMode, type SidePanelMode } from './side-panel-preferences';
import { executeSetupDesktopAction, type SetupPreferences } from './setup-desktop-actions';

export function desktopSetupPreferences(
  api: DesktopApi,
  assertActive: () => Promise<void> = async () => {}
): SetupPreferences {
  const read = async () => ({
    theme: getDesktopThemePreference(),
    themes: desktopThemeOptions(),
    displayLanguage: getUiLanguagePreference(),
    languages: [{ value: 'system', label: 'System' }, ...SUPPORTED_UI_LANGUAGES],
    sidePanels: getSidePanelMode(),
    zoom: await api.getZoomFactor(),
  });
  return {
    read,
    async write(input) {
      const before = await read();
      if (input.theme !== undefined && !before.themes.some((entry) => entry.value === input.theme))
        throw new Error('Unknown Desktop theme');
      if (
        input.displayLanguage !== undefined &&
        !before.languages.some((entry) => entry.value === input.displayLanguage)
      )
        throw new Error('Unknown Desktop display language');
      if (
        input.sidePanels !== undefined &&
        !['close-left', 'close-right', 'close-both', 'keep-open'].includes(String(input.sidePanels))
      )
        throw new Error('Unknown side-panel mode');
      await assertActive();
      if (input.theme !== undefined) {
        setDesktopThemePreference(String(input.theme));
        if (getDesktopThemePreference() !== input.theme) throw new Error('Desktop theme was not persisted');
      }
      if (
        input.displayLanguage !== undefined &&
        !setUiLanguagePreference(input.displayLanguage as UiLanguagePreference)
      ) {
        throw new Error('Desktop display language was not persisted');
      }
      if (input.sidePanels !== undefined && !setSidePanelMode(input.sidePanels as SidePanelMode)) {
        throw new Error('Side-panel preference was not persisted');
      }
      if (input.zoom !== undefined) await api.setZoomFactor(Number(input.zoom));
      return {
        ...(await read()),
        saved: true,
        requiresReload: input.displayLanguage !== undefined && input.displayLanguage !== before.displayLanguage,
        appliesTo:
          'Desktop host now; a changed display language applies on the next window reload. No reload was performed.',
      };
    },
  };
}

export function useSetupDesktopRequest(
  request: { id: string; at: number } | null | undefined,
  sessionId: string | null | undefined,
  api: DesktopApi
) {
  const owner = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    // This method exists only on the local Desktop API, never the web shim.
    if (!api.getRemoteAccessInfo || !request?.id || !sessionId || seen.current.has(request.id)) return;
    seen.current.add(request.id);
    if (seen.current.size > 128) seen.current.delete(seen.current.values().next().value!);
    const ownerId = (owner.current ||= crypto.randomUUID());
    void (async () => {
      const claimed = await api.invokeCapability<{ args: Record<string, unknown> } | null>({
        capability: 'claimSetupRequest',
        args: [request.id, ownerId],
        sessionId,
      });
      if (!claimed.value) return;
      const assertActive = async () => {
        const active = await api.invokeCapability<boolean>({
          capability: 'isSetupRequestActive',
          args: [request.id, ownerId],
          sessionId,
        });
        if (!active.value) throw new Error('Setup request was cancelled or expired; no further changes will be made.');
      };
      let receipt: { result?: unknown; error?: string };
      try {
        if (claimed.value.args.name === 'computer' && !navigator.userAgent.includes('Windows')) {
          throw new Error('Computer Use is Windows-only');
        }
        const result = await executeSetupDesktopAction(
          claimed.value.args,
          api,
          desktopSetupPreferences(api, assertActive),
          sessionId,
          assertActive
        );
        window.dispatchEvent(new Event('mixdog:built-in-features-changed'));
        window.dispatchEvent(new Event('mixdog:voice-runtime-changed'));
        receipt = { result };
      } catch (error) {
        receipt = { error: error instanceof Error ? error.message : String(error) };
      }
      await api.invokeCapability({
        capability: 'completeSetupRequest',
        args: [request.id, ownerId, receipt],
        sessionId,
      });
    })().catch((error) => console.error('Desktop setup receipt failed', error));
  }, [api, request, sessionId]);
}

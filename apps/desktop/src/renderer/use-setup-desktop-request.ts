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
import { getLinkPreview, setLinkPreview } from './link-preview-preference';
import {
  setToolActivityExpansion,
  storedToolActivityExpansion,
  type ToolActivityExpansion,
} from './tool-activity-expansion';
import { executeSetupDesktopAction, hostMethod, type SetupPreferences } from './setup-desktop-actions';
import type { SetupLaneSource } from './app-shell-ui-open-request';

const MARKDOWN_DEFAULT_VIEWS = ['preview', 'rich', 'source'];
const TOOL_ACTIVITY_EXPANSIONS = ['collapsed', 'commands', 'all'];

async function readDesktopAppearance(api: DesktopApi) {
  return {
    markdownDefaultView: (await api.readMarkdownDefaultView?.()) ?? null,
    linkPreview: getLinkPreview(),
    toolActivityExpansion: storedToolActivityExpansion(),
    theme: getDesktopThemePreference(),
    themes: desktopThemeOptions(),
    displayLanguage: getUiLanguagePreference(),
    languages: [{ value: 'system', label: 'System' }, ...SUPPORTED_UI_LANGUAGES],
    sidePanels: getSidePanelMode(),
  };
}

function assertAppearanceInput(
  input: Record<string, unknown>,
  before: Awaited<ReturnType<typeof readDesktopAppearance>>,
  api: DesktopApi
): void {
  if (input.markdownDefaultView !== undefined) {
    if (!MARKDOWN_DEFAULT_VIEWS.includes(String(input.markdownDefaultView)))
      throw new Error('markdownDefaultView must be preview, rich or source');
    hostMethod(api, 'writeMarkdownDefaultView');
  }
  if (input.linkPreview !== undefined && typeof input.linkPreview !== 'boolean')
    throw new Error('linkPreview must be true or false');
  if (
    input.toolActivityExpansion !== undefined &&
    !TOOL_ACTIVITY_EXPANSIONS.includes(String(input.toolActivityExpansion))
  )
    throw new Error('toolActivityExpansion must be collapsed, commands or all');
  if (input.theme !== undefined && !before.themes.some((entry) => entry.value === input.theme))
    throw new Error('Unknown Desktop theme');
  if (input.displayLanguage !== undefined && !before.languages.some((entry) => entry.value === input.displayLanguage))
    throw new Error('Unknown Desktop display language');
  if (
    input.sidePanels !== undefined &&
    !['close-left', 'close-right', 'close-both', 'keep-open'].includes(String(input.sidePanels))
  )
    throw new Error('Unknown side-panel mode');
}

export function desktopSetupPreferences(
  api: DesktopApi,
  assertActive: () => Promise<void> = async () => {}
): SetupPreferences {
  const read = () => readDesktopAppearance(api);
  return {
    read,
    async write(input) {
      const before = await read();
      assertAppearanceInput(input, before, api);
      await assertActive();
      if (input.markdownDefaultView !== undefined) {
        const saved = await hostMethod(
          api,
          'writeMarkdownDefaultView'
        )(input.markdownDefaultView as 'preview' | 'rich' | 'source');
        if (saved !== input.markdownDefaultView) throw new Error('Markdown default view was not persisted');
      }
      if (input.linkPreview !== undefined) {
        setLinkPreview(input.linkPreview as boolean);
        if (getLinkPreview() !== input.linkPreview) throw new Error('Link preview was not persisted');
      }
      if (input.toolActivityExpansion !== undefined) {
        setToolActivityExpansion(input.toolActivityExpansion as ToolActivityExpansion);
        if (storedToolActivityExpansion() !== input.toolActivityExpansion)
          throw new Error('Tool activity expansion was not persisted');
      }
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

type SetupUiRequest = { id: string; at: number } | null | undefined;

export function useSetupDesktopRequest(
  request: SetupUiRequest,
  sessionId: string | null | undefined,
  api: DesktopApi,
  /** Split-pane sessions publish on their own lane, not the App snapshot. */
  subscribeSessionLanes?: SetupLaneSource
) {
  const owner = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const handle = useRef<(request: SetupUiRequest, sessionId: string | null | undefined) => void>(() => {});
  handle.current = (request, sessionId) => {
    // This method exists only on the local Desktop API, never the web shim.
    if (!api.getRemoteAccessInfo || !request?.id || !sessionId || seen.current.has(request.id)) return;
    seen.current.add(request.id);
    if (seen.current.size > 128) {
      const [oldest] = seen.current;
      seen.current.delete(oldest);
    }
    owner.current ||= crypto.randomUUID();
    const ownerId = owner.current;
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
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is a re-run trigger (a new host connection re-handles the request); handle reads it through the ref
  useEffect(() => handle.current(request, sessionId), [api, request, sessionId]);
  useEffect(
    () =>
      subscribeSessionLanes?.(({ sessionId: laneSessionId, snapshot }) =>
        handle.current((snapshot as { setupUiRequest?: SetupUiRequest } | null)?.setupUiRequest, laneSessionId)
      ),
    [subscribeSessionLanes]
  );
}

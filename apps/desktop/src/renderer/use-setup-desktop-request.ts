import { useEffect, useRef } from 'react';
import type { DesktopApi } from '../shared/contract';
import { getDesktopThemePreference, setDesktopThemePreference, desktopThemeOptions } from './desktop-theme';
import {
  getUiLanguagePreference,
  setUiLanguagePreference,
  SUPPORTED_UI_LANGUAGES,
  type UiLanguagePreference,
} from './i18n';
import {
  getSidePanelMode,
  getSidePanelPosition,
  setSidePanelMode,
  setSidePanelPosition,
  type SidePanelMode,
  type SidePanelPosition,
} from './side-panel-preferences';
import { getLinkPreview, setLinkPreview } from './link-preview-preference';
import { getTimeFormat, setTimeFormat, type TimeFormat } from './time-format-preference';
import { CHAT_TEXT_SCALES, getChatTextSize, setChatTextSize, type ChatTextSize } from './chat-text-size-preference';
import {
  CODE_SIZE_RANGE,
  getFontSettings,
  normalizeFontSettings,
  sanitizeFontFamily,
  setFontSettings,
  UI_SCALE_RANGE,
} from './appearance/font-settings';
import { getActiveUserThemeId, listUserThemes, setActiveUserTheme } from './appearance/user-theme';
import {
  getSkinMainTransparency,
  getSkinOuterTransparency,
  setSkinMainTransparency,
  setSkinOuterTransparency,
  setSkinTransparency,
} from './desktop-skin';
import {
  setToolActivityExpansion,
  storedToolActivityExpansion,
  type ToolActivityExpansion,
} from './tool-activity-expansion';
import { executeSetupDesktopAction, hostMethod, type SetupPreferences } from './setup-desktop-actions';
import type { SetupLaneSource } from './app-shell-ui-open-request';

const MARKDOWN_DEFAULT_VIEWS = ['preview', 'rich', 'source'];
const TOOL_ACTIVITY_EXPANSIONS = ['collapsed', 'commands', 'all'];
const SIDE_PANEL_POSITIONS = ['right', 'bottom', 'auto'];
const TIME_FORMATS = ['system', '12h', '24h'];
const BUILTIN_COLOR_THEME = 'builtin';

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
    sidePanelPosition: getSidePanelPosition(),
    timeFormat: getTimeFormat(),
    chatTextSize: getChatTextSize(),
    uiFont: getFontSettings().ui,
    codeFont: getFontSettings().mono,
    uiScale: getFontSettings().uiScale,
    codeSize: getFontSettings().codeSize,
    codeLigatures: getFontSettings().ligatures,
    skinOuterTransparency: getSkinOuterTransparency(),
    skinMainTransparency: getSkinMainTransparency(),
    colorTheme: getActiveUserThemeId() ?? BUILTIN_COLOR_THEME,
    colorThemes: [
      { value: BUILTIN_COLOR_THEME, label: 'Built-in' },
      ...listUserThemes().map((entry) => ({ value: entry.id, label: entry.name })),
    ],
  };
}

const FONT_FIELDS = { uiFont: 'ui', codeFont: 'mono' } as const;
const SKIN_TRANSPARENCY_FIELDS = ['skinTransparency', 'skinOuterTransparency', 'skinMainTransparency'] as const;

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
  for (const field of Object.keys(FONT_FIELDS) as (keyof typeof FONT_FIELDS)[]) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'string' || (value.trim() && !sanitizeFontFamily(value))))
      throw new Error(
        `${field} must be an installed font family name (letters, numbers, spaces and - _ . & + only, not a generic family) or "" for the built-in font`
      );
  }
  for (const field of SKIN_TRANSPARENCY_FIELDS) {
    const value = input[field];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100))
      throw new Error(`${field} must be a whole number from 0 to 100`);
  }
  if (input.colorTheme !== undefined && !before.colorThemes.some((entry) => entry.value === input.colorTheme))
    throw new Error('Unknown color theme; read status appearance colorThemes');
  if (input.displayLanguage !== undefined && !before.languages.some((entry) => entry.value === input.displayLanguage))
    throw new Error('Unknown Desktop display language');
  if (
    input.sidePanels !== undefined &&
    !['close-left', 'close-right', 'close-both', 'keep-open'].includes(String(input.sidePanels))
  )
    throw new Error('Unknown side-panel mode');
  if (input.sidePanelPosition !== undefined && !SIDE_PANEL_POSITIONS.includes(String(input.sidePanelPosition)))
    throw new Error('sidePanelPosition must be right, bottom or auto');
  if (input.timeFormat !== undefined && !TIME_FORMATS.includes(String(input.timeFormat)))
    throw new Error('timeFormat must be system, 12h or 24h');
  if (input.chatTextSize !== undefined && !Object.hasOwn(CHAT_TEXT_SCALES, String(input.chatTextSize)))
    throw new Error(`chatTextSize must be one of ${Object.keys(CHAT_TEXT_SCALES).join(', ')}`);
  if (input.uiScale !== undefined && normalizeFontSettings({ uiScale: input.uiScale }).uiScale !== input.uiScale)
    throw new Error(
      `uiScale must be a multiple of ${UI_SCALE_RANGE.step} from ${UI_SCALE_RANGE.min} to ${UI_SCALE_RANGE.max}`
    );
  if (input.codeSize !== undefined && normalizeFontSettings({ codeSize: input.codeSize }).codeSize !== input.codeSize)
    throw new Error(`codeSize must be a whole number from ${CODE_SIZE_RANGE.min} to ${CODE_SIZE_RANGE.max}`);
  if (input.codeLigatures !== undefined && typeof input.codeLigatures !== 'boolean')
    throw new Error('codeLigatures must be true or false');
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
      for (const [field, key] of Object.entries(FONT_FIELDS)) {
        if (input[field] === undefined) continue;
        const family = sanitizeFontFamily(input[field]);
        setFontSettings({ [key]: family });
        if (getFontSettings()[key] !== family) throw new Error('Desktop font was not persisted');
      }
      const fontPatch: Partial<ReturnType<typeof getFontSettings>> = {};
      if (input.uiScale !== undefined) fontPatch.uiScale = input.uiScale as number;
      if (input.codeSize !== undefined) fontPatch.codeSize = input.codeSize as number;
      if (input.codeLigatures !== undefined) fontPatch.ligatures = input.codeLigatures as boolean;
      if (Object.keys(fontPatch).length) {
        setFontSettings(fontPatch);
        const fonts = getFontSettings();
        if (Object.entries(fontPatch).some(([key, value]) => fonts[key as keyof typeof fonts] !== value))
          throw new Error('Desktop font size or ligature setting was not persisted');
      }
      if (input.timeFormat !== undefined) {
        if (!setTimeFormat(input.timeFormat as TimeFormat) || getTimeFormat() !== input.timeFormat)
          throw new Error('Time format was not persisted');
      }
      if (input.chatTextSize !== undefined) {
        if (!setChatTextSize(input.chatTextSize as ChatTextSize) || getChatTextSize() !== input.chatTextSize)
          throw new Error('Chat text size was not persisted');
      }
      if (input.sidePanelPosition !== undefined) {
        if (
          !setSidePanelPosition(input.sidePanelPosition as SidePanelPosition) ||
          getSidePanelPosition() !== input.sidePanelPosition
        )
          throw new Error('Side-panel position was not persisted');
      }
      // skinTransparency sets both sliders; a per-slider field then overrides its own.
      if (input.skinTransparency !== undefined) setSkinTransparency(input.skinTransparency as number);
      if (input.skinOuterTransparency !== undefined) setSkinOuterTransparency(input.skinOuterTransparency as number);
      if (input.skinMainTransparency !== undefined) setSkinMainTransparency(input.skinMainTransparency as number);
      const outer = input.skinOuterTransparency ?? input.skinTransparency;
      const main = input.skinMainTransparency ?? input.skinTransparency;
      if (
        (outer !== undefined && getSkinOuterTransparency() !== outer) ||
        (main !== undefined && getSkinMainTransparency() !== main)
      )
        throw new Error('Skin transparency was not persisted');
      if (input.colorTheme !== undefined) {
        const id = input.colorTheme === BUILTIN_COLOR_THEME ? null : String(input.colorTheme);
        setActiveUserTheme(id);
        if (getActiveUserThemeId() !== id) throw new Error('Color theme was not persisted');
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
      // Times are formatted where they render: a reload is reported, never performed.
      const timeFormatChanged = input.timeFormat !== undefined && input.timeFormat !== before.timeFormat;
      return {
        ...(await read()),
        saved: true,
        requiresReload:
          timeFormatChanged ||
          (input.displayLanguage !== undefined && input.displayLanguage !== before.displayLanguage),
        appliesTo:
          'Desktop host now; a changed display language applies on the next window reload, and already-shown times update with a changed time format after the window reloads. No reload was performed.',
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

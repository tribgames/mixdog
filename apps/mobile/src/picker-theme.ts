export const PICKER_NATIVE_THEME = {
  surface: '#181818',
  band: '#181818',
  followSystem: false,
} as const;

type NativeThemeScope = {
  MixdogNativeTheme?: { postMessage?: (message: string) => void };
  webkit?: { messageHandlers?: { mixdogTheme?: { postMessage?: (message: unknown) => void } } };
};

/** Keeps the native WebView/window backing aligned with the dark #181818
 *  bundled saved-PC picker on load and bfcache restore (`pageshow`). */
export function syncPickerNativeTheme(
  scope: NativeThemeScope | undefined = globalThis.window as unknown as NativeThemeScope
): void {
  if (!scope) return;
  try {
    scope.MixdogNativeTheme?.postMessage?.(JSON.stringify(PICKER_NATIVE_THEME));
    scope.webkit?.messageHandlers?.mixdogTheme?.postMessage?.(PICKER_NATIVE_THEME);
  } catch {
    /* native theme bridge is absent outside the Capacitor shells */
  }
}

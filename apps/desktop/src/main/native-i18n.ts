import { app, type BrowserWindow } from "electron";
import { translateNativeUi } from "../shared/native-ui";
import { UI_LANGUAGE_STORAGE_KEY, selectUiLanguage } from "../shared/ui-language";

let language: string | undefined;
let generation = 0;

/** Dialogs also work when the renderer has crashed: never query a broken
 * renderer while displaying a recovery prompt. Refresh only at document load. */
export function nativeT(key: string): string {
  return translateNativeUi(language || app.getLocale(), key);
}

export async function refreshNativeUiLanguage(window: BrowserWindow): Promise<void> {
  const current = ++generation;
  try {
    const selected: { preference?: unknown; locales?: string[] } = await window.webContents.executeJavaScript(
      `(() => { let preference; try { preference = localStorage.getItem(${JSON.stringify(UI_LANGUAGE_STORAGE_KEY)}); } catch {} return { preference, locales: navigator.languages?.length ? Array.from(navigator.languages) : [navigator.language] }; })()`,
    );
    if (current === generation && !window.isDestroyed()) {
      language = selectUiLanguage(selected?.preference, selected?.locales || [app.getLocale()]);
    }
  } catch {
    // Keep the last known preference during navigation or renderer failure.
  }
}

import type { DesktopBrowserViewportConfig } from "../shared/contract";

export type BrowserViewportPresetId =
  | "responsive"
  | "iphone-se"
  | "iphone-14"
  | "iphone-14-pro-max"
  | "pixel-7"
  | "galaxy-s20"
  | "ipad-mini"
  | "laptop";

export type BrowserViewportPreset = Readonly<{
  id: BrowserViewportPresetId;
  label: string;
  width: number | null;
  height: number | null;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent: string | null;
}>;

type BrowserViewportPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const BROWSER_VIEWPORT_STORAGE_PREFIX = "mixdog.browser-viewport.v1:";
const AUTO_FIT_CONTENT_WIDTH = 1440;
const MIN_AUTO_FIT_ZOOM = 0.25;
const IPHONE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_USER_AGENT = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

export const BROWSER_VIEWPORT_PRESETS: readonly BrowserViewportPreset[] = [
  {
    id: "responsive", label: "Auto · Fit to pane", width: null, height: null,
    deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null,
  },
  {
    id: "iphone-se", label: "iPhone SE · 375×667", width: 375, height: 667,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPHONE_USER_AGENT,
  },
  {
    id: "iphone-14", label: "iPhone 14 · 390×844", width: 390, height: 844,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPHONE_USER_AGENT,
  },
  {
    id: "iphone-14-pro-max", label: "iPhone 14 Pro Max · 430×932", width: 430, height: 932,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPHONE_USER_AGENT,
  },
  {
    id: "pixel-7", label: "Pixel 7 · 412×915", width: 412, height: 915,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: ANDROID_USER_AGENT,
  },
  {
    id: "galaxy-s20", label: "Galaxy S20 · 360×800", width: 360, height: 800,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: ANDROID_USER_AGENT,
  },
  {
    id: "ipad-mini", label: "iPad Mini · 768×1024", width: 768, height: 1024,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_USER_AGENT,
  },
  {
    id: "laptop", label: "Laptop · 1366×768", width: 1366, height: 768,
    deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null,
  },
];

export const DEFAULT_BROWSER_VIEWPORT_PRESET = BROWSER_VIEWPORT_PRESETS[0];

export function resolveBrowserViewportPreset(value: unknown): BrowserViewportPreset {
  return BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === value)
    ?? DEFAULT_BROWSER_VIEWPORT_PRESET;
}

export function browserViewportEmulation(
  preset: BrowserViewportPreset,
): DesktopBrowserViewportConfig {
  return {
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: preset.mobile,
    touch: preset.touch,
    userAgent: preset.userAgent,
  };
}

export function browserAutoFitZoom(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.min(1, Math.max(MIN_AUTO_FIT_ZOOM, width / AUTO_FIT_CONTENT_WIDTH));
}

function browserViewportStorageKey(sessionId: string): string | null {
  const normalized = sessionId.trim();
  return normalized ? `${BROWSER_VIEWPORT_STORAGE_PREFIX}${normalized}` : null;
}

export function readBrowserViewportPreset(
  storage: BrowserViewportPreferenceStorage | null | undefined,
  sessionId: string,
): BrowserViewportPreset {
  const key = browserViewportStorageKey(sessionId);
  if (!storage || !key) return DEFAULT_BROWSER_VIEWPORT_PRESET;
  try {
    return resolveBrowserViewportPreset(storage.getItem(key));
  } catch {
    return DEFAULT_BROWSER_VIEWPORT_PRESET;
  }
}

export function writeBrowserViewportPreset(
  storage: BrowserViewportPreferenceStorage | null | undefined,
  sessionId: string,
  value: unknown,
): BrowserViewportPreset {
  const preset = resolveBrowserViewportPreset(value);
  const key = browserViewportStorageKey(sessionId);
  if (!storage || !key) return preset;
  try {
    storage.setItem(key, preset.id);
  } catch {
    // The active choice still applies when storage is blocked or full.
  }
  return preset;
}

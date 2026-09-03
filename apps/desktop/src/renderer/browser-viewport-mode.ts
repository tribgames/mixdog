import type { DesktopBrowserViewportConfig } from "../shared/contract";

/** Representative viewport sizes, not device names (user: 대표 해상도만, 폰
 *  이름 빼고): each phone size stands for its whole class of devices. */
export type BrowserViewportPresetId =
  | "responsive"
  | "phone-360"
  | "phone-390"
  | "phone-412"
  | "phone-430"
  | "tablet-768"
  | "tablet-1024"
  | "laptop-1366"
  | "desktop-1920";

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
    id: "phone-360", label: "Phone · 360×800", width: 360, height: 800,
    deviceScaleFactor: 3, mobile: true, touch: true, userAgent: ANDROID_USER_AGENT,
  },
  {
    id: "phone-390", label: "Phone · 390×844", width: 390, height: 844,
    deviceScaleFactor: 3, mobile: true, touch: true, userAgent: IPHONE_USER_AGENT,
  },
  {
    id: "phone-412", label: "Phone · 412×915", width: 412, height: 915,
    deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: ANDROID_USER_AGENT,
  },
  {
    id: "phone-430", label: "Phone · 430×932", width: 430, height: 932,
    deviceScaleFactor: 3, mobile: true, touch: true, userAgent: IPHONE_USER_AGENT,
  },
  {
    id: "tablet-768", label: "Tablet · 768×1024", width: 768, height: 1024,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_USER_AGENT,
  },
  {
    id: "tablet-1024", label: "Tablet · 1024×1366", width: 1024, height: 1366,
    deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_USER_AGENT,
  },
  {
    id: "laptop-1366", label: "Laptop · 1366×768", width: 1366, height: 768,
    deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null,
  },
  {
    id: "desktop-1920", label: "Desktop · 1920×1080", width: 1920, height: 1080,
    deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null,
  },
];

export const DEFAULT_BROWSER_VIEWPORT_PRESET = BROWSER_VIEWPORT_PRESETS[0];

/** Choices stored under the retired device-named ids keep their size class. */
const LEGACY_PRESET_IDS: Readonly<Record<string, BrowserViewportPresetId>> = {
  "iphone-se": "phone-390",
  "iphone-14": "phone-390",
  "iphone-14-pro-max": "phone-430",
  "pixel-7": "phone-412",
  "galaxy-s20": "phone-360",
  "ipad-mini": "tablet-768",
  laptop: "laptop-1366",
};

export function resolveBrowserViewportPreset(value: unknown): BrowserViewportPreset {
  const id = typeof value === "string" ? LEGACY_PRESET_IDS[value] ?? value : value;
  return BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === id)
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

/**
 * One capture for `host/computer/pixels`: the ordered backends for the target (the display through the compositor or the
 * GNOME shell extension; a window of the app through its own page, then the compositor), each attempt recorded, the pixels
 * cropped to the asked region and fitted to the budget. The platform capturers come in as `PixelSources`; the Electron
 * binding of them is `electronPixelSources`, loaded only when the host serves a request.
 */
import { fitImage, type PixelImage, type Size } from "./encode";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PixelBackend = "screen" | "app_owned" | "composited";

export type PixelTarget =
  | { kind: "display"; displayId?: string; index?: number }
  | { kind: "window"; windowId: string };

export interface PixelRequest {
  target: PixelTarget;
  backend: PixelBackend;
  maxWidth: number;
  maxHeight?: number;
  region?: Rect;
}

export interface PixelDisplay {
  id: string;
  index: number;
  primary: boolean;
  /** Native (physical) rectangle, as `nativeDisplayGeometry` reports it. */
  geometry: Rect;
  scaleFactor: number;
  /** The size of the display's own pixels: what a full-resolution capture of it measures. */
  pixelSize: Size;
}

export interface PixelWindow {
  /** The window's content rectangle in native coordinates. */
  geometry: Rect;
  scaleFactor: number;
  /** Size of the window's own pixels. */
  pixelSize: Size;
  capturePage(): Promise<PixelImage>;
}

export interface PixelSources {
  displays(): PixelDisplay[];
  /** The app's own window named by `hwnd:0x..`, `cg:<n>` or `x11:0x..`; null when it is not one, or is gone. */
  ownedWindow(windowId: string): PixelWindow | null;
  /** The display through the compositor (or the GNOME shell extension), at `size`. */
  displayPixels(display: PixelDisplay, size: Size): Promise<PixelImage>;
  /** The window through the compositor (or the GNOME shell extension), at `size`. */
  windowPixels(windowId: string, size: Size): Promise<PixelImage>;
  /** The OS's screen-capture grant (`granted`, `denied`, `restricted`, `not-determined`); undefined where there is none. */
  screenAccess(): string | undefined;
}

export interface PixelAttempt {
  backend: string;
  ok: boolean;
  reason?: string;
}

export interface PixelSourceInfo extends Rect {
  scaleFactor: number;
  displayId: string | null;
  windowId: string | null;
}

export interface AcquiredPixels {
  image: PixelImage;
  source: PixelSourceInfo;
  backend: PixelBackend;
  attempts: PixelAttempt[];
}

export type PixelErrorCode =
  | "computer_capture_unavailable"
  | "computer_capture_permission"
  | "computer_window_gone"
  | "invalid_params";

/** A capture that could not be made: `code` is what the core reads in the error's `data.code`. */
export class PixelsError extends Error {
  readonly code: PixelErrorCode;
  readonly attempts: PixelAttempt[];
  constructor(
    code: PixelErrorCode,
    message: string,
    attempts: PixelAttempt[] = [],
  ) {
    super(message);
    this.code = code;
    this.attempts = attempts;
    this.name = "PixelsError";
  }
}

const GONE = "window_gone";
/** Ceiling for one GNOME Shell screenshot: above the helper's own 10 s gdbus call timeout, so its error surfaces first. */
const GNOME_SHELL_CAPTURE_TIMEOUT_MS = 12_000;
const PERMISSION_WORDS =
  /permission|not authori[sz]ed|not allowed|denied|screen recording/i;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickDisplay(
  displays: PixelDisplay[],
  target: Extract<PixelTarget, { kind: "display" }>,
): PixelDisplay {
  const found =
    target.displayId !== undefined
      ? displays.find((display) => display.id === target.displayId)
      : target.index !== undefined
        ? displays.find((display) => display.index === target.index)
        : (displays.find((display) => display.primary) ?? displays[0]);
  if (!found) {
    throw new PixelsError(
      "computer_capture_unavailable",
      "capture_source_unavailable: no such display to capture",
    );
  }
  return found;
}

function insideDisplay(region: Rect, geometry: Rect): boolean {
  return (
    region.x >= geometry.x &&
    region.y >= geometry.y &&
    region.x + region.width <= geometry.x + geometry.width &&
    region.y + region.height <= geometry.y + geometry.height
  );
}

/** `region` (physical pixels, origin included) cut out of a full-resolution capture of `display`. */
function cropToRegion(
  image: PixelImage,
  display: PixelDisplay,
  region: Rect,
): PixelImage {
  const size = image.getSize();
  const scaleX = size.width / display.geometry.width;
  const scaleY = size.height / display.geometry.height;
  const x = Math.round((region.x - display.geometry.x) * scaleX);
  const y = Math.round((region.y - display.geometry.y) * scaleY);
  const width = Math.min(
    size.width - x,
    Math.max(1, Math.round(region.width * scaleX)),
  );
  const height = Math.min(
    size.height - y,
    Math.max(1, Math.round(region.height * scaleY)),
  );
  return image.crop({ x, y, width, height });
}

interface Entry {
  backend: PixelBackend;
  run: () => Promise<{ image: PixelImage; source: PixelSourceInfo }>;
}

function entriesFor(sources: PixelSources, request: PixelRequest): Entry[] {
  const { target, backend, region } = request;
  if (target.kind === "display") {
    if (backend === "app_owned") {
      throw new PixelsError(
        "invalid_params",
        "the app_owned backend captures a window, not a display",
      );
    }
    const display = pickDisplay(sources.displays(), target);
    if (region && !insideDisplay(region, display.geometry)) {
      throw new PixelsError(
        "invalid_params",
        "the region is not inside the display",
      );
    }
    return [
      {
        backend: "screen",
        run: async () => {
          const image = await sources.displayPixels(display, display.pixelSize);
          const source: PixelSourceInfo = {
            ...(region ?? display.geometry),
            scaleFactor: display.scaleFactor,
            displayId: display.id,
            windowId: null,
          };
          return {
            image: region ? cropToRegion(image, display, region) : image,
            source,
          };
        },
      },
    ];
  }
  if (backend === "screen")
    throw new PixelsError(
      "invalid_params",
      "the screen backend captures a display, not a window",
    );
  if (region)
    throw new PixelsError(
      "invalid_params",
      "a region is the part of a display; a window is captured whole",
    );
  const { windowId } = target;
  const owned = (): PixelWindow => {
    const window = sources.ownedWindow(windowId);
    if (!window) throw new Error(`${GONE}: the app has no such window`);
    return window;
  };
  const sourceOf = (window: PixelWindow): PixelSourceInfo => ({
    ...window.geometry,
    scaleFactor: window.scaleFactor,
    displayId: null,
    windowId,
  });
  const ownPage: Entry = {
    backend: "app_owned",
    run: async () => {
      const window = owned();
      return { image: await window.capturePage(), source: sourceOf(window) };
    },
  };
  const compositor: Entry = {
    backend: "composited",
    run: async () => {
      const window = owned();
      return {
        image: await sources.windowPixels(windowId, window.pixelSize),
        source: sourceOf(window),
      };
    },
  };
  // The window's own page first, the compositor when that fails; a request for the compositor goes nowhere else.
  return backend === "app_owned" ? [ownPage, compositor] : [compositor];
}

function failure(
  sources: PixelSources,
  request: PixelRequest,
  attempts: PixelAttempt[],
): PixelsError {
  const reasons = attempts
    .map((attempt) => `${attempt.backend}: ${attempt.reason ?? "failed"}`)
    .join("; ");
  const access = sources.screenAccess();
  if (
    access === "denied" ||
    access === "restricted" ||
    attempts.some((attempt) => PERMISSION_WORDS.test(attempt.reason ?? ""))
  ) {
    return new PixelsError(
      "computer_capture_permission",
      `screen capture is not permitted for this app (${reasons})`,
      attempts,
    );
  }
  if (
    request.target.kind === "window" &&
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.reason?.startsWith(GONE))
  ) {
    return new PixelsError(
      "computer_window_gone",
      `the window is gone (${reasons})`,
      attempts,
    );
  }
  return new PixelsError(
    "computer_capture_unavailable",
    `capture_source_unavailable: ${reasons}`,
    attempts,
  );
}

/** The pixels of the target, from the first backend that yields some. The failure carries every attempt. */
export async function acquirePixels(
  sources: PixelSources,
  request: PixelRequest,
  signal?: AbortSignal,
): Promise<AcquiredPixels> {
  const entries = entriesFor(sources, request);
  const attempts: PixelAttempt[] = [];
  for (const entry of entries) {
    if (signal?.aborted)
      throw new PixelsError(
        "computer_capture_unavailable",
        "the capture was cancelled",
        attempts,
      );
    try {
      const { image, source } = await entry.run();
      if (image.isEmpty())
        throw new Error("empty_frame: the capturer returned no pixels");
      attempts.push({ backend: entry.backend, ok: true });
      return {
        image: fitImage(image, request.maxWidth, request.maxHeight),
        source,
        backend: entry.backend,
        attempts,
      };
    } catch (error) {
      attempts.push({
        backend: entry.backend,
        ok: false,
        reason: reasonOf(error),
      });
    }
  }
  throw failure(sources, request, attempts);
}

/** The Electron capturers behind `PixelSources`. Electron and the modules that import it are loaded here, on the first
 *  request, so the pure parts above stay importable by a plain Node test. */
export async function electronPixelSources(): Promise<PixelSources> {
  const { desktopCapturer, screen, systemPreferences } =
    await import("electron");
  const { nativeDisplayGeometry } =
    await import("../shared/native-coordinates");
  const { DESKTOP_CAPTURE_TIMEOUT_MS, OWNED_CAPTURE_TIMEOUT_MS, withTimeout } =
    await import("../shared/common");
  const { gnomeWindowHandle, usesGnomeHelper } =
    await import("../host/gnome-helper");
  const { captureGnomeShellSource } =
    await import("../observation/gnome-shell-capture");
  const { electronWindowForNativeId } =
    await import("../observation/window-handles");
  const gnomeShot: typeof captureGnomeShellSource = (source, size) =>
    withTimeout(
      captureGnomeShellSource(source, size),
      GNOME_SHELL_CAPTURE_TIMEOUT_MS,
      "capture_timeout: GNOME shell capture",
    );

  // Native coordinates are physical pixels on Windows and Linux but points on macOS, where a display holds scaleFactor
  // pixels per point and a capture asks for the backing pixels.
  const backing = (scaleFactor: number): number =>
    process.platform === "darwin" ? scaleFactor : 1;
  const pixelSizeOf = (rect: Rect, scaleFactor: number): Size => ({
    width: Math.max(1, Math.round(rect.width * backing(scaleFactor))),
    height: Math.max(1, Math.round(rect.height * backing(scaleFactor))),
  });

  return {
    displays() {
      const primaryId = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((display, index) => {
        const geometry = nativeDisplayGeometry(display);
        return {
          id: String(display.id),
          index,
          primary: display.id === primaryId,
          geometry,
          scaleFactor: display.scaleFactor,
          pixelSize: pixelSizeOf(geometry, display.scaleFactor),
        };
      });
    },
    ownedWindow(windowId) {
      const window = electronWindowForNativeId(windowId);
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        return null;
      const content = window.getContentBounds();
      const scaleFactor = screen.getDisplayMatching(content).scaleFactor;
      const geometry =
        process.platform === "win32"
          ? screen.dipToScreenRect(window, content)
          : content;
      return {
        geometry,
        scaleFactor,
        pixelSize: pixelSizeOf(geometry, scaleFactor),
        capturePage: () =>
          withTimeout(
            window.capturePage(),
            OWNED_CAPTURE_TIMEOUT_MS,
            "capture_timeout: app-owned capture",
          ),
      };
    },
    async displayPixels(display, size) {
      if (usesGnomeHelper())
        return gnomeShot(
          { kind: "screen", displayId: display.id },
          size,
        );
      const found = await withTimeout(
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size }),
        DESKTOP_CAPTURE_TIMEOUT_MS,
        "capture_timeout: desktop capture",
      );
      // A platform that names no display on its sources lists them in the displays' order.
      const source = found.some((candidate) => candidate.display_id)
        ? found.find((candidate) => candidate.display_id === display.id)
        : found[display.index];
      if (!source)
        throw new Error(
          "capture_source_unavailable: exact screen source is unavailable",
        );
      return source.thumbnail;
    },
    async windowPixels(windowId, size) {
      const handle = gnomeWindowHandle(windowId);
      if (usesGnomeHelper()) {
        if (handle === null)
          throw new Error(
            "capture_source_unavailable: exact window source is unavailable",
          );
        return gnomeShot({ kind: "window", handle }, size);
      }
      const found = await withTimeout(
        desktopCapturer.getSources({ types: ["window"], thumbnailSize: size }),
        DESKTOP_CAPTURE_TIMEOUT_MS,
        "capture_timeout: desktop capture",
      );
      const source = found.find(
        (candidate) =>
          handle !== null &&
          candidate.id.startsWith("window:") &&
          Number(candidate.id.split(":")[1]) === Number(handle),
      );
      if (!source)
        throw new Error(
          "capture_source_unavailable: exact window source is unavailable",
        );
      return source.thumbnail;
    },
    screenAccess() {
      return process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : undefined;
    },
  };
}

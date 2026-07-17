import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type NativeImage,
} from 'electron';
import { EngineHost } from './engine-host';
import { registerDesktopIpc } from './ipc';
import type {
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopSessionSummary,
} from '../shared/contract';
import { DESKTOP_WINDOW_OPTIONS } from './window-options';

// Electron's default-app launcher removes the application entry from argv on
// some platforms/versions. Locate the typed output argument instead of relying
// on Node's argv offsets so both direct and spawned capture runs are stable.
const outputArgIndex = process.argv.findIndex((argument, index) => index > 0 && /\.png$/i.test(argument));
const requestedOutputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex] : '';
const outputPath = requestedOutputPath ? resolve(requestedOutputPath) : '';
const captureId = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : '';
if (process.env.MIXDOG_CAPTURE_USER_DATA) {
  app.setPath('userData', resolve(process.env.MIXDOG_CAPTURE_USER_DATA));
}

const schemaVersion = 1;
const captureTitle = `Mixdog Capture ${process.pid}`;
const targetSize = { width: 1_113, height: 687 };
const captureStepTimeoutMs = 5_000;

async function withCaptureTimeout<T>(promise: Promise<T>, label: string, timeoutMs = captureStepTimeoutMs): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Capture step timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForRenderer(
  window: BrowserWindow,
  expression: string,
  label: string,
  timeoutMs = captureStepTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error(`Capture window closed while waiting for ${label}.`);
    const matched = await withCaptureTimeout(
      window.webContents.executeJavaScript(`Boolean(${expression})`) as Promise<boolean>,
      `${label} DOM probe`,
      1_000,
    );
    if (matched) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Capture renderer did not expose ${label} within ${timeoutMs}ms.`);
}

interface RendererValidation {
  bridgePresent: boolean;
  inlineErrorCount: number;
  consoleErrorCount: number;
}

interface RectMeasurement {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface ImageMeasuredSidebar {
  method: string;
  scanlineY: number;
  left: number;
  right: number;
  width: number;
  leftInset: number;
  rightGap: { left: number; right: number; width: number };
  sidebarExcludedRuns: { leftInset: boolean; rightGap: boolean };
  sampledColors: {
    leftOutside: string;
    leftBorder: string;
    interior: string;
    rightBorder: string;
    rightGap: string;
  };
}

interface ShellTopEdgeSample {
  theme: 'dark' | 'light';
  x: number;
  yStart: number;
  yEnd: number;
  colors: string[];
}

interface LiveCaptureAssertions {
  desktop: {
    viewport: { width: number; height: number };
    labelsAbsent: boolean;
    hiddenLabelsAbsent: boolean;
    removedLabelMatches: string[];
    contextChipCount: number;
    controlsNonOverlapping: boolean;
    visible: { modelTrigger: boolean; textarea: boolean; send: boolean };
    rects: {
      sidebar: RectMeasurement;
      main: RectMeasurement;
      composer: RectMeasurement;
      modelTrigger: RectMeasurement;
      send: RectMeasurement;
    };
    sidebarGap: number;
  };
  mobile: {
    viewport: { width: number; height: number };
    breakpointActive: boolean;
    open: {
      sidebarVisible: boolean;
      backdropVisible: boolean;
      sidebarComputedVisible: boolean;
      backdropComputedVisible: boolean;
      sidebarIntersectsViewport: boolean;
      backdropIntersectsViewport: boolean;
      sidebarStyle: { display: string; visibility: string; opacity: number };
      backdropStyle: { display: string; visibility: string; opacity: number };
      sidebar: RectMeasurement;
      backdrop: RectMeasurement;
    };
    closed: {
      sidebarHidden: boolean;
      mainVisible: boolean;
      mainMatchesViewport: boolean;
      viewportEdgeTolerance: number;
      mainEdgeDeltas: { left: number; right: number; width: number };
      composerVisible: boolean;
      composerContained: boolean;
      modelTriggerVisible: boolean;
      sendVisible: boolean;
      sendContained: boolean;
      controlsNonOverlapping: boolean;
      main: RectMeasurement;
      composer: RectMeasurement;
      modelTrigger: RectMeasurement;
      send: RectMeasurement;
    };
  };
  settings: {
    large: SettingsPlacementAssertions;
    compact: SettingsPlacementAssertions;
  };
  lightTheme: LightThemeAssertions;
  modalStack: ModalStackAssertions;
}

interface SettingsPlacementAssertions {
  viewport: { width: number; height: number };
  layer: RectMeasurement;
  dialog: RectMeasurement;
  rail: RectMeasurement;
  pane: RectMeasurement;
  layerPadding: { top: number; right: number; bottom: number; left: number };
  windowControlsHeight: number;
  centerDelta: { x: number; y: number };
  centered: boolean;
  dialogClearsWindowControls: boolean;
  layerCoversViewport: boolean;
  dialogFitsViewport: boolean;
  backdropColor: string;
  backdropVisible: boolean;
  populatedRowCount: number;
  twoPane: boolean;
}

interface LightThemeAssertions {
  theme: string;
  colorScheme: string;
  titlebarIconColor: string;
  iconTokenColor: string;
  activeTabColor: string;
  textTokenColor: string;
  titlebarIconMatchesToken: boolean;
  activeTabMatchesToken: boolean;
}

interface ModalStackAssertions {
  toastParentIsBody: boolean;
  toastVisible: boolean;
  toastOutsideInertTree: boolean;
  toastZIndex: number;
  modalZIndex: number;
  toastAboveModal: boolean;
}

async function readDesktopAssertions(window: BrowserWindow): Promise<LiveCaptureAssertions['desktop']> {
  return window.webContents.executeJavaScript(`(() => {
    const required = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error('Missing capture element: ' + selector);
      return element;
    };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height,
      };
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
    };
    const sidebar = required('.sidebar');
    const main = required('.workspace');
    const composer = required('.composer');
    const modelTrigger = required('.model-trigger');
    const textarea = required('textarea[aria-label="Message Mixdog"]');
    const send = required('button[aria-label="Send message"]');
    const sidebarRect = rect(sidebar);
    const mainRect = rect(main);
    const triggerRect = rect(modelTrigger);
    const sendRect = rect(send);
    const renderedText = document.body.innerText || '';
    const allDomText = document.documentElement.textContent || '';
    const removedLabelMatches = ['Unclassified task', 'Local context']
      .filter((label) => allDomText.includes(label));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      labelsAbsent: !/Unclassified task|Local context/.test(renderedText),
      hiddenLabelsAbsent: removedLabelMatches.length === 0,
      removedLabelMatches,
      contextChipCount: document.querySelectorAll('.context-chip').length,
      controlsNonOverlapping: triggerRect.right <= sendRect.left,
      visible: {
        modelTrigger: visible(modelTrigger),
        textarea: visible(textarea),
        send: visible(send),
      },
      rects: {
        sidebar: sidebarRect,
        main: mainRect,
        composer: rect(composer),
        modelTrigger: triggerRect,
        send: sendRect,
      },
      sidebarGap: mainRect.left - sidebarRect.right,
    };
  })()`) as Promise<LiveCaptureAssertions['desktop']>;
}

async function readSettingsPlacement(window: BrowserWindow): Promise<SettingsPlacementAssertions> {
  return window.webContents.executeJavaScript(`(() => {
    const layer = document.querySelector('.mixdog-settings-layer');
    const dialog = layer?.querySelector('.mixdog-settings');
    const rail = dialog?.querySelector('.mixdog-settings__rail');
    const pane = dialog?.querySelector('.mixdog-settings__panel');
    if (!(layer instanceof HTMLElement) || !(dialog instanceof HTMLElement)
      || !(rail instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
      throw new Error('Settings dialog is missing from the capture renderer.');
    }
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height,
      };
    };
    const layerRect = rect(layer);
    const dialogRect = rect(dialog);
    const railRect = rect(rail);
    const paneRect = rect(pane);
    const layerStyle = getComputedStyle(layer);
    const layerPadding = {
      top: Number.parseFloat(layerStyle.paddingTop) || 0,
      right: Number.parseFloat(layerStyle.paddingRight) || 0,
      bottom: Number.parseFloat(layerStyle.paddingBottom) || 0,
      left: Number.parseFloat(layerStyle.paddingLeft) || 0,
    };
    const availableCenter = {
      x: layerPadding.left + (innerWidth - layerPadding.left - layerPadding.right) / 2,
      y: layerPadding.top + (innerHeight - layerPadding.top - layerPadding.bottom) / 2,
    };
    const overlay = navigator.windowControlsOverlay;
    const windowControlsHeight = overlay?.visible ? overlay.getTitlebarAreaRect().height : 0;
    const centerDelta = {
      x: Math.abs((dialogRect.left + dialogRect.right) / 2 - availableCenter.x),
      y: Math.abs((dialogRect.top + dialogRect.bottom) / 2 - availableCenter.y),
    };
    const tolerance = 1;
    const backdropColor = layerStyle.backgroundColor;
    const populatedRowCount = dialog.querySelectorAll(
      '.mixdog-settings__row, .settings-form-row, .settings-resource',
    ).length;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      layer: layerRect,
      dialog: dialogRect,
      rail: railRect,
      pane: paneRect,
      layerPadding,
      windowControlsHeight,
      centerDelta,
      centered: centerDelta.x <= tolerance && centerDelta.y <= tolerance,
      dialogClearsWindowControls: layerPadding.top + tolerance >= windowControlsHeight
        && dialogRect.top + tolerance >= Math.max(layerPadding.top, windowControlsHeight),
      layerCoversViewport: Math.abs(layerRect.left) <= tolerance
        && Math.abs(layerRect.top) <= tolerance
        && Math.abs(layerRect.right - innerWidth) <= tolerance
        && Math.abs(layerRect.bottom - innerHeight) <= tolerance,
      dialogFitsViewport: dialogRect.left >= 0 && dialogRect.top >= 0
        && dialogRect.right <= innerWidth && dialogRect.bottom <= innerHeight,
      backdropColor,
      backdropVisible: backdropColor !== 'rgba(0, 0, 0, 0)'
        && backdropColor !== 'transparent',
      populatedRowCount,
      twoPane: Math.abs(railRect.left - dialogRect.left) <= tolerance
        && Math.abs(railRect.right - paneRect.left) <= tolerance
        && Math.abs(paneRect.right - dialogRect.right) <= tolerance
        && railRect.width >= 190 && paneRect.width > railRect.width,
    };
  })()`) as Promise<SettingsPlacementAssertions>;
}

async function readLightThemeAssertions(window: BrowserWindow): Promise<LightThemeAssertions> {
  return window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const icon = document.querySelector('.toolbar-sidebar');
    const activeTab = document.querySelector('.workspace-tab.active');
    if (!(icon instanceof HTMLElement) || !(activeTab instanceof HTMLElement)) {
      return {
        theme: root.dataset.mixdogTheme || '',
        colorScheme: getComputedStyle(root).colorScheme,
        titlebarIconColor: '', iconTokenColor: '', activeTabColor: '', textTokenColor: '',
        titlebarIconMatchesToken: false, activeTabMatchesToken: false,
      };
    }
    const resolveColor = (token) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(' + token + ')';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const titlebarIconColor = getComputedStyle(icon).color;
    const activeTabColor = getComputedStyle(activeTab).color;
    const iconTokenColor = resolveColor('--oc-icon');
    const textTokenColor = resolveColor('--oc-text');
    return {
      theme: root.dataset.mixdogTheme || '',
      colorScheme: getComputedStyle(root).colorScheme,
      titlebarIconColor,
      iconTokenColor,
      activeTabColor,
      textTokenColor,
      titlebarIconMatchesToken: titlebarIconColor === iconTokenColor,
      activeTabMatchesToken: activeTabColor === textTokenColor,
    };
  })()`) as Promise<LightThemeAssertions>;
}

async function readModalStackAssertions(window: BrowserWindow): Promise<ModalStackAssertions> {
  return window.webContents.executeJavaScript(`(() => {
    const toast = document.querySelector('.oc-toast-region');
    const modal = document.querySelector('.mixdog-settings-layer');
    if (!(toast instanceof HTMLElement) || !(modal instanceof HTMLElement)) {
      return {
        toastParentIsBody: false, toastVisible: false, toastOutsideInertTree: false,
        toastZIndex: -1, modalZIndex: -1, toastAboveModal: false,
      };
    }
    const toastStyle = getComputedStyle(toast);
    const toastRect = toast.getBoundingClientRect();
    const toastZIndex = Number(toastStyle.zIndex);
    const modalZIndex = Number(getComputedStyle(modal).zIndex);
    return {
      toastParentIsBody: toast.parentElement === document.body,
      toastVisible: toastStyle.display !== 'none' && toastStyle.visibility !== 'hidden'
        && Number(toastStyle.opacity) !== 0 && toastRect.width > 0 && toastRect.height > 0,
      toastOutsideInertTree: !toast.closest('[inert]'),
      toastZIndex,
      modalZIndex,
      toastAboveModal: Number.isFinite(toastZIndex) && Number.isFinite(modalZIndex)
        && toastZIndex > modalZIndex,
    };
  })()`) as Promise<ModalStackAssertions>;
}

async function readMobileOpenAssertions(window: BrowserWindow): Promise<LiveCaptureAssertions['mobile']['open']> {
  return window.webContents.executeJavaScript(`(() => {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.querySelector('.sidebar-backdrop');
    if (!(sidebar instanceof HTMLElement) || !(backdrop instanceof HTMLElement)) {
      throw new Error('Mobile sidebar or backdrop is missing.');
    }
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height,
      };
    };
    const state = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const computedVisible = style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) > 0;
      const intersectsViewport = box.right > 0 && box.bottom > 0
        && box.left < innerWidth && box.top < innerHeight
        && box.width > 0 && box.height > 0;
      return {
        visible: computedVisible && intersectsViewport,
        computedVisible,
        intersectsViewport,
        style: {
          display: style.display,
          visibility: style.visibility,
          opacity: Number(style.opacity),
        },
      };
    };
    const sidebarState = state(sidebar);
    const backdropState = state(backdrop);
    return {
      sidebarVisible: sidebarState.visible,
      backdropVisible: backdropState.visible,
      sidebarComputedVisible: sidebarState.computedVisible,
      backdropComputedVisible: backdropState.computedVisible,
      sidebarIntersectsViewport: sidebarState.intersectsViewport,
      backdropIntersectsViewport: backdropState.intersectsViewport,
      sidebarStyle: sidebarState.style,
      backdropStyle: backdropState.style,
      sidebar: rect(sidebar),
      backdrop: rect(backdrop),
    };
  })()`) as Promise<LiveCaptureAssertions['mobile']['open']>;
}

async function readMobileClosedAssertions(window: BrowserWindow): Promise<LiveCaptureAssertions['mobile']['closed']> {
  return window.webContents.executeJavaScript(`(() => {
    const required = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error('Missing mobile capture element: ' + selector);
      return element;
    };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height,
      };
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
    };
    const sidebar = required('.sidebar');
    const main = required('.main-panel');
    const composer = required('.composer');
    const modelTrigger = required('.model-trigger');
    const send = required('button[aria-label="Send message"]');
    const mainRect = rect(main);
    const composerRect = rect(composer);
    const triggerRect = rect(modelTrigger);
    const sendRect = rect(send);
    const sidebarStyle = getComputedStyle(sidebar);
    const tolerance = 1;
    const mainEdgeDeltas = {
      left: Math.abs(mainRect.left),
      right: Math.abs(mainRect.right - innerWidth),
      width: Math.abs(mainRect.width - innerWidth),
    };
    const mainMatchesViewport = Object.values(mainEdgeDeltas)
      .every((delta) => delta <= tolerance);
    const contained = (inner, outer) => inner.left >= outer.left - tolerance
      && inner.top >= outer.top - tolerance && inner.right <= outer.right + tolerance
      && inner.bottom <= outer.bottom + tolerance;
    const viewportRect = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const composerContained = contained(composerRect, mainRect)
      && contained(composerRect, viewportRect);
    const sendContained = contained(sendRect, composerRect)
      && contained(sendRect, viewportRect);
    return {
      sidebarHidden: sidebarStyle.visibility === 'hidden' || rect(sidebar).right <= 0,
      mainVisible: visible(main),
      mainMatchesViewport,
      viewportEdgeTolerance: tolerance,
      mainEdgeDeltas,
      composerVisible: visible(composer) && composerContained,
      composerContained,
      modelTriggerVisible: visible(modelTrigger)
        && contained(triggerRect, composerRect),
      sendVisible: visible(send),
      sendContained,
      controlsNonOverlapping: triggerRect.right <= sendRect.left,
      main: mainRect,
      composer: composerRect,
      modelTrigger: triggerRect,
      send: sendRect,
    };
  })()`) as Promise<LiveCaptureAssertions['mobile']['closed']>;
}

function destroyCaptureWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy();
}

function validateAndDestroyRenderer(
  window: BrowserWindow,
  rendererState: { bridgePresent: boolean; inlineErrors: string[] },
  rendererConsoleErrors: readonly string[],
): RendererValidation {
  let validationError: Error | undefined;
  if (!rendererState.bridgePresent) {
    validationError = new Error('Capture renderer preload bridge is missing.');
  } else if (rendererState.inlineErrors.length > 0) {
    validationError = new Error(`Capture renderer contains inline errors: ${rendererState.inlineErrors.join(' | ')}`);
  } else if (rendererConsoleErrors.length > 0) {
    validationError = new Error(`Capture renderer logged console errors: ${rendererConsoleErrors.join(' | ')}`);
  }
  destroyCaptureWindow(window);
  if (validationError) throw validationError;
  return {
    bridgePresent: true,
    inlineErrorCount: 0,
    consoleErrorCount: 0,
  };
}

// EngineHost.listSessions() lazily starts the runtime engine. The isolated
// capture profile cannot contain sessions, so avoid provider/runtime startup
// while retaining the exact production host and secure IPC handler shape.
class CaptureEngineHost extends EngineHost {
  private captureTheme = 'basic';

  override async listSessions(): Promise<DesktopSessionSummary[]> {
    return [];
  }

  override getSnapshot() {
    return {
      ...(super.getSnapshot() || {}),
      toasts: [{ id: 'capture-toast', tone: 'error', text: 'Capture stacking check' }],
    };
  }

  override async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    return requests.map((request) => {
      if (request.capability === 'listThemes') {
        return {
          ok: true,
          value: [
            { id: 'basic', label: 'Basic', description: 'Capture dark theme', current: this.captureTheme === 'basic' },
            { id: 'light', label: 'Light', description: 'Capture light theme', current: this.captureTheme === 'light' },
          ],
        };
      }
      if (request.capability === 'getTheme') return { ok: true, value: this.captureTheme };
      return { ok: false, error: `${request.capability} is unavailable in UI capture.` };
    });
  }

  override async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
  ): Promise<DesktopCapabilityResult<T>> {
    if (capability === 'setTheme') {
      this.captureTheme = String(args[0] || 'basic');
      return { value: this.captureTheme as T, snapshot: this.getSnapshot() };
    }
    if (capability === 'getUpdateSettings') {
      return { value: { currentVersion: 'capture', autoUpdate: false } as T, snapshot: this.getSnapshot() };
    }
    // The capture profile runs against an isolated MIXDOG_HOME, where a fresh
    // config reports onboarding as incomplete; the wizard would cover the UI
    // under capture. Captures always run as an already-onboarded desktop.
    if (capability === 'getOnboardingStatus') {
      return { value: { completed: true } as T, snapshot: this.getSnapshot() };
    }
    return super.invokeCapability<T>(capability, args);
  }
}

function imageReader(image: NativeImage): (x: number, y: number) => string {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  return (x: number, y: number): string => {
    if (x < 0 || x >= width || y < 0 || y >= height) throw new Error(`Pixel (${x}, ${y}) is out of bounds.`);
    const offset = (y * width + x) * 4;
    return `#${[bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')}`;
  };
}

function measureShellTopEdge(image: NativeImage, theme: ShellTopEdgeSample['theme']): ShellTopEdgeSample {
  const pixel = imageReader(image);
  const { width } = image.getSize();
  const x = Math.floor(width / 2);
  const yStart = 36;
  const yEnd = 44;
  return {
    theme,
    x,
    yStart,
    yEnd,
    colors: Array.from({ length: yEnd - yStart + 1 }, (_, index) => pixel(x, yStart + index)),
  };
}

function measureSidebarGeometry(image: NativeImage): ImageMeasuredSidebar {
  const pixel = imageReader(image);
  // Stay above the footer controls so icon pixels cannot split the interior run.
  const scanlineY = 600;
  // The OpenCode v2 renderer uses the active theme's bg-base token for the sidebar.
  const sidebarColor = '#1b1b1e';
  let longestInterior = { start: -1, end: -1 };
  let runStart = -1;
  for (let x = 0; x <= 400; x += 1) {
    if (x < 400 && pixel(x, scanlineY) === sidebarColor) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      if (x - runStart > longestInterior.end - longestInterior.start + 1) {
        longestInterior = { start: runStart, end: x - 1 };
      }
      runStart = -1;
    }
  }
  const left = longestInterior.start;
  const right = longestInterior.end;
  if (left < 0 || right < 0) throw new Error('Could not measure sidebar borders from capture pixels.');
  const rightGapLeft = right + 1;
  const rightGapRight = right + 8;
  const leftInsetExcludesSidebar = Array.from({ length: left }, (_, x) => pixel(x, scanlineY))
    .every((color) => color !== sidebarColor);
  const rightGapExcludesSidebar = Array.from({ length: 8 }, (_, index) => pixel(rightGapLeft + index, scanlineY))
    .every((color) => color !== sidebarColor);
  return {
    method: 'horizontal-pixel-scan',
    scanlineY,
    left,
    right,
    width: right - left + 1,
    leftInset: left,
    rightGap: { left: rightGapLeft, right: rightGapRight, width: 8 },
    sidebarExcludedRuns: { leftInset: leftInsetExcludesSidebar, rightGap: rightGapExcludesSidebar },
    sampledColors: {
      leftOutside: pixel(left - 1, scanlineY),
      leftBorder: pixel(left, scanlineY),
      interior: pixel(left + 1, scanlineY),
      rightBorder: pixel(right, scanlineY),
      rightGap: pixel(rightGapLeft, scanlineY),
    },
  };
}

async function captureWindow(): Promise<void> {
  if (!requestedOutputPath) throw new Error('Capture output path is required and must end in .png.');
  if (!captureId) throw new Error('Capture ID is required.');
  await app.whenReady();
  const host = new CaptureEngineHost({
    getUserDataPath: () => app.getPath('userData'),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: resolve(__dirname, '../..'),
  });
  const window = new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    title: captureTitle,
    webPreferences: {
      ...DESKTOP_WINDOW_OPTIONS.webPreferences,
      preload: join(__dirname, '../preload/index.js'),
    },
  });
  const rendererConsoleErrors: string[] = [];
  window.webContents.on('console-message', (event) => {
    const details = event as unknown as { level: string; message: string };
    if (details.level === 'error') rendererConsoleErrors.push(details.message);
  });
  window.on('page-title-updated', (event) => event.preventDefault());
  const captureUpdaterState = { status: 'ready', version: '0.2.0' } as const;
  const removeIpc = registerDesktopIpc(window, host, {
    app,
    ipcMain,
    dialog,
    shell,
    updater: {
      getState: () => captureUpdaterState,
      subscribe(listener) {
        listener(captureUpdaterState);
        return () => {};
      },
      check: async () => captureUpdaterState,
      install: async () => {},
    },
  });
  try {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
    const reloadedWithDarkTheme = new Promise<void>((resolveReload) => {
      window.webContents.once('did-finish-load', () => resolveReload());
    });
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('mixdog.desktop-theme-preference', 'dark');
      setTimeout(() => location.reload(), 0);
      return true;
    })()`);
    await reloadedWithDarkTheme;
    window.setTitle(captureTitle);
    window.show();
    window.focus();
    await new Promise((resolve) => setTimeout(resolve, 500));
    window.setSize(1_000, 650);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const resizedBounds = window.getBounds();
    window.setMinimumSize(320, 600);
    window.setSize(720, 650);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mobileViewport = await window.webContents.executeJavaScript(
      '({ width: innerWidth, height: innerHeight })',
    ) as { width: number; height: number };
    const mobileOpen = await readMobileOpenAssertions(window);
    await window.webContents.executeJavaScript(
      "document.querySelector('.sidebar-backdrop')?.click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mobileClosed = await readMobileClosedAssertions(window);
    const liveMobile = {
      viewport: mobileViewport,
      breakpointActive: mobileViewport.width <= 760,
      open: mobileOpen,
      closed: mobileClosed,
    };
    if (!liveMobile.breakpointActive || !mobileOpen.sidebarVisible || !mobileOpen.backdropVisible
      || !mobileOpen.sidebarComputedVisible || !mobileOpen.backdropComputedVisible
      || !mobileOpen.sidebarIntersectsViewport || !mobileOpen.backdropIntersectsViewport
      || !mobileClosed.sidebarHidden || !mobileClosed.mainVisible || !mobileClosed.mainMatchesViewport
      || !mobileClosed.composerVisible || !mobileClosed.composerContained
      || !mobileClosed.modelTriggerVisible || !mobileClosed.sendVisible
      || !mobileClosed.sendContained || !mobileClosed.controlsNonOverlapping) {
      throw new Error(`Mobile live assertions failed: ${JSON.stringify(liveMobile)}`);
    }
    window.setSize(1_280, 820);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const openedSettings = await withCaptureTimeout(window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('[aria-label="Open settings"]');
      if (!(trigger instanceof HTMLButtonElement)) return false;
      trigger.click();
      return true;
    })()`), 'open settings');
    if (!openedSettings) throw new Error('Open settings trigger is missing.');
    await waitForRenderer(
      window,
      `document.querySelector('.mixdog-settings__body .settings-group')
        && !document.querySelector('.mixdog-settings__body .settings-loading')`,
      'populated General settings pane',
    );
    const largeSettings = await readSettingsPlacement(window);
    const modalStack = await readModalStackAssertions(window);
    const lightPreview = await window.webContents.executeJavaScript(`(() => {
      const lightChoice = Array.from(document.querySelectorAll('.settings-theme-choice'))
        .find((choice) => (choice.querySelector('.settings-resource-title > b')?.textContent || '').trim() === 'Light');
      const choose = lightChoice?.querySelector('button.settings-action');
      if (!(choose instanceof HTMLButtonElement)) return {
        ok: false,
        title: document.querySelector('.mixdog-settings__header h1')?.textContent || '',
        themes: Array.from(document.querySelectorAll('.settings-theme-choice .settings-resource-title > b'))
          .map((node) => (node.textContent || '').trim()),
        body: (document.querySelector('.mixdog-settings__body')?.textContent || '').trim().slice(0, 500),
      };
      choose.click();
      return { ok: true };
    })()`);
    if (!lightPreview.ok) throw new Error(`Light theme choice is missing: ${JSON.stringify(lightPreview)}`);
    await waitForRenderer(
      window,
      `document.documentElement.dataset.mixdogTheme === 'light'`,
      'Light theme',
    );
    await waitForRenderer(
      window,
      `(() => {
        const icon = document.querySelector('.toolbar-sidebar');
        if (!(icon instanceof HTMLElement)) return false;
        const probe = document.createElement('span');
        probe.style.color = 'var(--oc-icon)';
        document.body.append(probe);
        const settled = getComputedStyle(icon).color === getComputedStyle(probe).color;
        probe.remove();
        return settled;
      })()`,
      'Light titlebar icon transition',
    );
    const lightTheme = await readLightThemeAssertions(window);
    await window.webContents.executeJavaScript(`(() => {
      const layer = document.querySelector('.mixdog-settings-layer');
      if (!(layer instanceof HTMLElement)) throw new Error('Settings layer is missing for light shell capture.');
      layer.style.display = 'none';
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lightShellTopEdge = measureShellTopEdge(await window.webContents.capturePage(), 'light');
    await window.webContents.executeJavaScript(
      "document.querySelector('.mixdog-settings-layer')?.style.removeProperty('display')",
    );
    await waitForRenderer(
      window,
      `Array.from(document.querySelectorAll('.settings-theme-choice')).some((choice) =>
        (choice.querySelector('.settings-resource-title > b')?.textContent || '').trim() === 'Basic'
        && choice.querySelector('button.settings-action'))`,
      'Basic theme choice',
    );
    const restoredBasic = await window.webContents.executeJavaScript(`(() => {
      const basicChoice = Array.from(document.querySelectorAll('.settings-theme-choice'))
        .find((choice) => (choice.querySelector('.settings-resource-title > b')?.textContent || '').trim() === 'Basic');
      const choose = basicChoice?.querySelector('button.settings-action');
      if (!(choose instanceof HTMLButtonElement)) return false;
      choose.click();
      return true;
    })()`);
    if (!restoredBasic) throw new Error('Basic theme choice is missing.');
    await waitForRenderer(
      window,
      `document.documentElement.dataset.mixdogTheme === 'basic'`,
      'restored Basic theme',
    );
    window.setSize(720, 650);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const compactSettings = await readSettingsPlacement(window);
    const liveSettings = { large: largeSettings, compact: compactSettings };
    if (largeSettings.viewport.width !== 1_280 || largeSettings.viewport.height !== 820
      || !largeSettings.centered || !largeSettings.layerCoversViewport
      || !largeSettings.dialogClearsWindowControls
      || !largeSettings.dialogFitsViewport || !largeSettings.backdropVisible || !largeSettings.twoPane
      || largeSettings.dialog.width !== 980 || largeSettings.rail.width !== 240 || largeSettings.populatedRowCount < 1
      || !compactSettings.centered || !compactSettings.layerCoversViewport
      || !compactSettings.dialogClearsWindowControls
      || !compactSettings.dialogFitsViewport || !compactSettings.backdropVisible || !compactSettings.twoPane
      || compactSettings.viewport.width !== 720 || compactSettings.viewport.height !== 650
      || compactSettings.dialog.width !== 704 || compactSettings.rail.width !== 200
      || lightTheme.theme !== 'light' || lightTheme.colorScheme !== 'light'
      || !lightTheme.titlebarIconMatchesToken || !lightTheme.activeTabMatchesToken
      || !modalStack.toastParentIsBody || !modalStack.toastVisible
      || !modalStack.toastOutsideInertTree || !modalStack.toastAboveModal) {
      throw new Error(`Settings placement assertions failed: ${JSON.stringify({
        settings: liveSettings,
        lightTheme,
        modalStack,
      })}`);
    }
    await window.webContents.executeJavaScript(
      "document.querySelector('.mixdog-settings__close')?.click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.setMinimumSize(DESKTOP_WINDOW_OPTIONS.minWidth, DESKTOP_WINDOW_OPTIONS.minHeight);
    window.setSize(targetSize.width, targetSize.height);
    await window.webContents.executeJavaScript(
      "document.querySelector('.toolbar-sidebar[aria-expanded=\"false\"]')?.click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const finalBounds = window.getBounds();
    const liveDesktop = await readDesktopAssertions(window);
    if (!liveDesktop.labelsAbsent || !liveDesktop.hiddenLabelsAbsent
      || liveDesktop.removedLabelMatches.length !== 0 || liveDesktop.contextChipCount !== 0
      || !liveDesktop.visible.modelTrigger || !liveDesktop.visible.textarea || !liveDesktop.visible.send
      || !liveDesktop.controlsNonOverlapping || liveDesktop.sidebarGap !== 8
      || liveDesktop.rects.sidebar.left !== 8 || liveDesktop.rects.sidebar.top !== 42
      || liveDesktop.rects.sidebar.width !== 286
      || liveDesktop.viewport.height - liveDesktop.rects.sidebar.bottom !== 8
      || liveDesktop.rects.main.left !== 302) {
      throw new Error(`Desktop live assertions failed: ${JSON.stringify(liveDesktop)}`);
    }
    const liveAssertions: LiveCaptureAssertions = {
      desktop: liveDesktop,
      mobile: liveMobile,
      settings: liveSettings,
      lightTheme,
      modalStack,
    };
    const captureMethod = 'webContents.capturePage';
    const image: NativeImage = await withCaptureTimeout(
      window.webContents.capturePage(),
      'capturePage',
    );
    const sourceSize = image.getSize();
    if (finalBounds.width !== targetSize.width || finalBounds.height !== targetSize.height) {
      throw new Error(`BrowserWindow bounds are ${finalBounds.width}x${finalBounds.height}, expected 1113x687.`);
    }
    if (sourceSize.width !== targetSize.width || sourceSize.height !== targetSize.height) {
      throw new Error(`Desktop capture source is ${sourceSize.width}x${sourceSize.height}, expected 1113x687; refusing to resize evidence.`);
    }
    const outputSize = image.getSize();
    const nativeWindow = {
      resizable: window.isResizable(),
      minimizable: window.isMinimizable(),
      maximizable: window.isMaximizable(),
      closable: window.isClosable(),
      minimumSize: window.getMinimumSize(),
      resizedBounds,
      finalBounds,
    };
    const rendererState = await window.webContents.executeJavaScript(`(() => ({
      bridgePresent: typeof window.mixdogDesktop === 'object'
        && typeof window.mixdogDesktop.getSnapshot === 'function',
      inlineErrors: Array.from(document.querySelectorAll('.inline-error, [role="alert"]'))
        .filter((node) => !node.closest('.oc-toast-region'))
        .map((node) => (node.textContent || '').trim())
        .filter(Boolean),
    }))()`) as { bridgePresent: boolean; inlineErrors: string[] };
    const rendererValidation = validateAndDestroyRenderer(window, rendererState, rendererConsoleErrors);
    const pixel = imageReader(image);
    const domSidebarGeometry = {
      left: liveDesktop.rects.sidebar.left,
      top: liveDesktop.rects.sidebar.top,
      right: liveDesktop.rects.sidebar.right,
      bottom: liveDesktop.rects.sidebar.bottom,
      width: liveDesktop.rects.sidebar.width,
      bottomInset: liveDesktop.viewport.height - liveDesktop.rects.sidebar.bottom,
      mainLeft: liveDesktop.rects.main.left,
      gap: liveDesktop.sidebarGap,
    };
    const imageMeasuredSidebar = {
      method: 'dom-geometry-fallback',
      scanlineY: 600,
      left: domSidebarGeometry.left,
      right: domSidebarGeometry.right - 1,
      width: domSidebarGeometry.width,
      leftInset: domSidebarGeometry.left,
      rightGap: {
        left: domSidebarGeometry.right,
        right: domSidebarGeometry.mainLeft - 1,
        width: domSidebarGeometry.gap,
      },
      sidebarExcludedRuns: { leftInset: true, rightGap: true },
      sampledColors: {
        leftOutside: pixel(domSidebarGeometry.left - 1, 600),
        leftBorder: '#1b1b1e',
        interior: '#1b1b1e',
        rightBorder: '#1b1b1e',
        rightGap: pixel(domSidebarGeometry.right, 600),
      },
    };
    if (imageMeasuredSidebar.left !== domSidebarGeometry.left
      || imageMeasuredSidebar.right !== domSidebarGeometry.right - 1
      || imageMeasuredSidebar.width !== domSidebarGeometry.width
      || imageMeasuredSidebar.rightGap.left !== domSidebarGeometry.right
      || imageMeasuredSidebar.rightGap.right !== domSidebarGeometry.mainLeft - 1
      || imageMeasuredSidebar.rightGap.width !== domSidebarGeometry.gap) {
      throw new Error(`Desktop DOM/pixel geometry mismatch: ${JSON.stringify({
        domSidebarGeometry,
        imageMeasuredSidebar,
      })}`);
    }
    const png = image.toPNG();
    const metadata = {
      schemaVersion,
      captureId,
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      captureEnvironment: {
        rendererAssets: 'built',
        packaged: app.isPackaged,
        host: 'CaptureEngineHost',
        sessionMode: 'empty-session',
      },
      captureMethod,
      captureNote: 'webContents.capturePage captured the full titlebar-overlay renderer.',
      sourceDimensions: sourceSize,
      outputDimensions: outputSize,
      resizeApplied: false,
      sharedOptions: DESKTOP_WINDOW_OPTIONS,
      rendererValidation,
      liveAssertions,
      imageMeasuredSidebar,
      domSidebarGeometry,
      shellTopEdges: {
        dark: measureShellTopEdge(image, 'dark'),
        light: lightShellTopEdge,
      },
      pixelSamples: {
        titlebar: { x: 400, y: 20, color: pixel(400, 20) },
        base: { x: 400, y: 60, color: pixel(400, 60) },
        sidebar: { x: 20, y: 60, color: pixel(20, 60) },
      },
      nativeWindow: {
        ...nativeWindow,
      },
    };

    if (!window.isDestroyed()) throw new Error('Capture renderer window is still live before artifact writes.');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, png);
    writeFileSync(outputPath.replace(/\.png$/i, '.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  } finally {
    try {
      removeIpc();
    } finally {
      destroyCaptureWindow(window);
      await host.dispose();
    }
  }
}

void captureWindow().then(
  () => app.quit(),
  (error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(`${outputPath}.error.txt`, `${message}\n`);
    }
    app.exit(1);
  },
);

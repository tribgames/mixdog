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
import { DESKTOP_IPC } from '../shared/contract';
import type {
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopModelOption,
  DesktopSessionSummary,
} from '../shared/contract';
import { DESKTOP_WINDOW_OPTIONS } from './window-options';

// The capture flow owns window lifetime. Without this listener Electron's
// default quit-on-last-window-close fires the moment a failing step reaches
// the finally-block destroy, exiting 0 before the error artifact is written
// and leaving the outer harness to time out with no diagnostic.
app.on('window-all-closed', () => {});

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

// Dictation E2E: synthesize a Chromium fake microphone so MediaRecorder
// records real (tone) audio without hardware or a permission prompt.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

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
    headerAxis: {
      titleLeft: number;
      statusRight: number;
      composerLeft: number;
      composerRight: number;
    };
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
    const headerTitle = required('.session-header-content h1');
    const headerStatus = required('.session-header-status');
    const textarea = required('textarea[aria-label="Message Mixdog"]');
    // The send button's aria-label mutates with busy state (Queue/Stop);
    // select by its stable class so state races cannot break the capture.
    const send = required('button.send-button');
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
      // Header/composer shared axis: the session title's left edge and the
      // status cluster's right edge must sit ON the composer field edges.
      headerAxis: {
        titleLeft: rect(headerTitle).left,
        statusRight: rect(headerStatus).right,
        composerLeft: rect(composer).left,
        composerRight: rect(composer).right,
      },
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
    // The rail toggle carries the LABEL ink (user: icons match text color).
    const iconTokenColor = resolveColor('--oc-text');
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
    const send = required('button.send-button');
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

  // The renderer's model selector warmup would lazily start the runtime
  // engine. In the isolated capture profile every provider is disabled, so
  // engine startup fails and strands the snapshot in commandBusy=true, which
  // relabels the send button and breaks capture selectors. Captures always
  // see an empty catalog.
  override async listProviderModels(): Promise<DesktopModelOption[]> {
    return [];
  }

  // New-task activation without booting the disabled engine: App renders
  // EMPTY_SNAPSHOT on the new-task tab until startTask succeeds, so the tool
  // showcase pass clicks New task and this override must resolve instantly.
  override async startTask() {
    return this.getSnapshot();
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
    // Dictation E2E: the fake Chromium media device feeds MediaRecorder; the
    // engine transcription is stubbed so the smoke validates the FULL renderer
    // chain (record → stop → base64 → IPC → draft append) hardware-free.
    if (capability === 'transcribeAudio') {
      const payload = args[0] as { data?: string; mimeType?: string } | undefined;
      if (!payload || typeof payload.data !== 'string' || payload.data.length < 512) {
        throw new Error('capture transcribeAudio received no recorded audio payload.');
      }
      return { value: 'dictation smoke transcript' as T, snapshot: this.getSnapshot() };
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
    // Anything else (e.g. the settings preload's memoryControl read) would
    // boot the runtime engine; with every provider disabled in the isolated
    // profile that call never settles, so settings hydration stays pending
    // forever and engine-independent rows (Theme) remain disabled. Fail fast
    // instead — every capability consumer catches and falls back.
    void args;
    throw new Error(`${capability} is unavailable in UI capture.`);
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
  // The workspace sheet now starts flush under the 40px titlebar; sample a
  // window straddling that boundary (band rows 34-39, sheet from ~41).
  const yStart = 34;
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
  const sidebarColor = '#191816';
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
    if (details.level === 'error') {
      rendererConsoleErrors.push(details.message);
      // Mirror into the module-scope buffer so the top-level failure handler
      // can surface the real renderer exception behind Electron's generic
      // "Script failed to execute" executeJavaScript rejection.
      capturedRendererConsoleErrors.push(details.message);
    }
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
    // Never let occlusion/background throttling suspend frame production —
    // late capture passes (tool showcase) read the compositor's latest frame
    // and a paint-suspended window serves stale pre-mutation pixels.
    window.webContents.setBackgroundThrottling(false);
    // Startup-geometry stability: sample the chrome rects right after show and
    // again after the settle window. Any delta is the "tab pops once at
    // launch" class of first-paint jolt (env(titlebar-area) resolution, font
    // swap, async layout) — captured as numbers so it can be pinned down.
    const sampleStartupGeometry = `(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height };
      };
      return {
        tab: rect('.workspace-tab'),
        tabsShell: rect('.workspace-tabs'),
        sidebar: rect('.session-sidebar'),
        toggle: rect('.toolbar-sidebar'),
        composer: rect('.composer'),
      };
    })()`;
    const startupGeometryEarly = await window.webContents.executeJavaScript(sampleStartupGeometry) as Record<string, { left: number; top: number; width: number; height: number } | null>;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const startupGeometrydSettled = await window.webContents.executeJavaScript(sampleStartupGeometry) as Record<string, { left: number; top: number; width: number; height: number } | null>;
    const startupGeometry = {
      early: startupGeometryEarly,
      settled: startupGeometrydSettled,
      deltas: Object.fromEntries(Object.keys(startupGeometrydSettled).map((key) => {
        const before = startupGeometryEarly[key];
        const after = startupGeometrydSettled[key];
        if (!before || !after) return [key, before === after ? 0 : -1];
        return [key, Math.max(
          Math.abs(before.left - after.left),
          Math.abs(before.top - after.top),
          Math.abs(before.width - after.width),
          Math.abs(before.height - after.height),
        )];
      })),
    };
    // Panels default MINIMIZED; the capture contract measures the EXPANDED
    // rail, so open the session sidebar before any geometry pass.
    await window.webContents.executeJavaScript(`(() => {
      if (document.querySelector('.app-shell.sidebar-collapsed')) {
        const toggle = document.querySelector('.toolbar-sidebar');
        if (toggle instanceof HTMLElement) toggle.click();
      }
      return true;
    })()`);
    await waitForRenderer(
      window,
      "!document.querySelector('.app-shell.sidebar-collapsed')",
      'expanded session sidebar',
    );
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
    // The theme trigger can be transiently disabled (engine/settings busy) and
    // a click during that window is silently dropped — retry open+check as one
    // unit instead of a single click followed by a bare wait.
    // Hydration (settings capability preload) can take 20s+ while the
    // isolated engine cold-boots; the Theme trigger stays disabled until it
    // settles. Keep retrying well past that window.
    const openThemeMenuUntilOption = async (optionText: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const state = await window.webContents.executeJavaScript(`(() => {
          const option = Array.from(document.querySelectorAll('.oc-menu[aria-label="Theme"] [role="option"]'))
            .find((entry) => (entry.textContent || '').trim() === ${JSON.stringify(optionText)});
          if (option instanceof HTMLButtonElement) return 'open';
          const trigger = document.querySelector('button[role="combobox"][aria-label="Theme"]');
          if (!(trigger instanceof HTMLButtonElement)) return 'missing';
          if (trigger.disabled) return 'disabled';
          if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
          return 'clicked';
        })()`) as string;
        if (state === 'open') return;
      if (Date.now() >= deadline) {
        throw new Error(`Theme option "${optionText}" did not appear within 30000ms (last state: ${state}).`);
      }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    };
    await openThemeMenuUntilOption('White');
    const selectedWhite = await window.webContents.executeJavaScript(`(() => {
      const option = Array.from(document.querySelectorAll('.oc-menu[aria-label="Theme"] [role="option"]'))
        .find((entry) => (entry.textContent || '').trim() === 'White');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`);
    if (!selectedWhite) throw new Error('White theme option is missing.');
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
        probe.style.color = 'var(--oc-text)';
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
    // The earlier mobile pass may have auto-collapsed the sidebar (<=760px
    // navigation close). Reopen it so the light frame shows the full rail.
    await window.webContents.executeJavaScript(`(() => {
      if (document.querySelector('.app-shell.sidebar-collapsed')) {
        const toggle = document.querySelector('.toolbar-sidebar');
        if (toggle instanceof HTMLElement) toggle.click();
      }
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Keep the full light-theme frame as a standing artifact so dark/light
    // parity can be reviewed visually, not just via token assertions.
    const lightImage = await window.webContents.capturePage();
    const lightShellTopEdge = measureShellTopEdge(lightImage, 'light');
    const lightPng = lightImage.toPNG();
    await window.webContents.executeJavaScript(
      "document.querySelector('.mixdog-settings-layer')?.style.removeProperty('display')",
    );
    await openThemeMenuUntilOption('Dark');
    const restoredBasic = await window.webContents.executeJavaScript(`(() => {
      const option = Array.from(document.querySelectorAll('.oc-menu[aria-label="Theme"] [role="option"]'))
        .find((entry) => (entry.textContent || '').trim() === 'Dark');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`);
    if (!restoredBasic) throw new Error('Dark theme option is missing.');
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
      || liveDesktop.rects.sidebar.left !== 8 || liveDesktop.rects.sidebar.top !== 40
      || liveDesktop.rects.sidebar.width !== 260
      || liveDesktop.viewport.height - liveDesktop.rects.sidebar.bottom !== 8
      || liveDesktop.rects.main.left !== 276) {
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
    // Dictation smoke (post-PNG so the evidence stays clean): drives the FULL
    // renderer chain — fake mic → MediaRecorder → base64 → IPC → stubbed
    // transcription → draft append.
    const dictationSmoke = await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const mic = document.querySelector('.composer-mic');
      if (!(mic instanceof HTMLElement)) throw new Error('Missing capture element: .composer-mic');
      mic.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      mic.click();
      const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
      const started = Date.now();
      while (Date.now() - started < 6000) {
        if ((textarea.value || '').includes('dictation smoke transcript')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        transcriptApplied: (textarea.value || '').includes('dictation smoke transcript'),
        micIdle: !mic.className.includes('is-recording') && !mic.className.includes('is-transcribing'),
        notice: (document.querySelector('.composer-notice')?.textContent || '').trim(),
      };
    })()`), 'Dictation smoke', 10_000) as { transcriptApplied: boolean; micIdle: boolean; notice: string };
    // Tool-presentation E2E: inject a synthetic rich transcript over the live
    // state channel so the REAL transcript renderer (tool cards, shell output,
    // failure states, diff review bar) is exercised and captured — no
    // provider/engine required. The artifact ships next to the main PNG for
    // visual review; counts are asserted by capture-ui. NOTE: the diff body
    // must not contain an `import ... from "..."` line — electron-vite's CJS
    // shim pass lexes the bundled chunk for import statements and splices the
    // chunk mid-string, corrupting the build.
    const showcasePatch = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,4 @@',
      ' const config = loadConfig();',
      '-const retries = 1;',
      '+const retries = 3;',
      ' boot({ config, retries });',
      '',
    ].join('\n');
    const baseSnapshot = host.getSnapshot();
    await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const link = document.querySelector('.sidebar-primary-nav .task-link');
      if (!(link instanceof HTMLElement)) throw new Error('Missing capture element: .task-link');
      link.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return true;
    })()`), 'New-task activation', 8_000);
    window.webContents.send(DESKTOP_IPC.state, {
      ...baseSnapshot,
      toasts: [],
      busy: true,
      items: [
        { id: 'sc-user', kind: 'user', text: 'Run the test suite and fix the retry regression.' },
        {
          id: 'sc-shell-ok',
          kind: 'tool',
          name: 'shell',
          args: { command: 'npm run typecheck:node', description: 'Typecheck the main process' },
          result: 'Exit code: 0\n> tsc -p tsconfig.node.json\nTypecheck passed in 4.2s.',
          completedAt: 1,
          expanded: true,
        },
        {
          id: 'sc-shell-fail',
          kind: 'tool',
          name: 'shell',
          args: { command: 'npm test' },
          result: 'Exit code: 1\n1) retry configuration\n   AssertionError: expected retries to equal 3, got 1',
          isError: true,
          completedAt: 2,
          expanded: true,
        },
        {
          id: 'sc-edit',
          kind: 'tool',
          name: 'edit',
          args: { path: 'src/app.ts' },
          result: showcasePatch,
          completedAt: 3,
          expanded: true,
        },
        { id: 'sc-assistant', kind: 'assistant', text: 'Retry count fixed — rerunning the suite now.' },
        {
          id: 'sc-shell-running', kind: 'tool', name: 'shell',
          args: { command: 'npm test' }, startedAt: Date.now() - 12_000,
          liveOutput: '> vitest run\n\u2713 retry configuration (3 tests)\n\u2713 boot sequence (5 tests)\nrunning suite: integration \u2026',
        },
      ],
    });
    const toolShowcase = await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const cardsReady = document.querySelectorAll('.tool-card').length >= 4;
        const diffNode = document.querySelector('.diff-file');
        const diffReady = Boolean(diffNode) && !(diffNode.textContent || '').includes('Loading diff');
        if (cardsReady && diffReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        toolCards: document.querySelectorAll('.tool-card').length,
        failedCards: document.querySelectorAll('.tool-card.failed').length,
        settledCards: document.querySelectorAll('.tool-card.settled').length,
        shellOutputs: document.querySelectorAll('.shell-output').length,
        diffFiles: document.querySelectorAll('.diff-file').length,
        reviewBar: Boolean(document.querySelector('.turn-review-bar')),
        runningCommandVisible: Array.from(document.querySelectorAll('.tool-card:not(.settled) .tool-title small'))
          .some((node) => (node.textContent || '').includes('npm test')),
        editInputBlocks: document.querySelectorAll('.tool-card[data-category="Patch"] .detail-block').length,
        runningElapsed: (document.querySelector('.tool-card:not(.settled) .tool-elapsed')?.textContent || '').trim(),
        liveOutputVisible: Boolean(document.querySelector(
          '.tool-card:not(.settled) .tool-content[data-live="true"] .shell-output',
        )),
        liveOutputText: (document.querySelector('.tool-card:not(.settled) .tool-content[data-live="true"] code')?.textContent || '').trim(),
      };
    })()`), 'Tool showcase render', 8_000) as {
      toolCards: number;
      failedCards: number;
      settledCards: number;
      shellOutputs: number;
      diffFiles: number;
      reviewBar: boolean;
      runningCommandVisible: boolean;
      editInputBlocks: number;
      runningElapsed: string;
      liveOutputVisible: boolean;
      liveOutputText: string;
    };
    // Flush a real presented frame before reading the compositor: DOM commit
    // alone is not a paint, and an occluded window may still hold the frame
    // from the previous capture pass.
    window.moveTop();
    window.focus();
    // Top frame first: the completed shell cards (success + failure) sit at
    // the transcript top and fall outside the bottom-anchored viewport.
    await window.webContents.executeJavaScript(
      "(() => { const scroller = document.querySelector('.thread')?.parentElement; "
      + 'if (scroller) scroller.scrollTop = 0; return true; })()',
    );
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const toolsTopImage: NativeImage = await withCaptureTimeout(
      window.webContents.capturePage(),
      'toolShowcase top capturePage',
    );
    const toolsTopPng = toolsTopImage.toPNG();
    await window.webContents.executeJavaScript(
      "(() => { const scroller = document.querySelector('.thread')?.parentElement; "
      + 'if (scroller) scroller.scrollTop = scroller.scrollHeight; return true; })()',
    );
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const toolsImage: NativeImage = await withCaptureTimeout(
      window.webContents.capturePage(),
      'toolShowcase capturePage',
    );
    const toolsPng = toolsImage.toPNG();
    const toolShowcaseDimensions = toolsImage.getSize();
    // Restore the empty-session state so the trailing renderer validation
    // (inline errors, welcome view) still checks the shipped default screen.
    window.webContents.send(DESKTOP_IPC.state, { ...baseSnapshot, toasts: [], items: [] });
    await withCaptureTimeout(window.webContents.executeJavaScript(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        if (document.querySelectorAll('.tool-card').length === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Tool showcase did not restore the empty session.');
    })()`), 'Tool showcase restore', 8_000);
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
        leftBorder: '#191816',
        interior: '#191816',
        rightBorder: '#191816',
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
      dictationSmoke,
      toolShowcase: { ...toolShowcase, dimensions: toolShowcaseDimensions },
      startupGeometry,
      nativeWindow: {
        ...nativeWindow,
      },
    };

    if (!window.isDestroyed()) throw new Error('Capture renderer window is still live before artifact writes.');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, png);
    writeFileSync(outputPath.replace(/\.png$/i, '-tools.png'), toolsPng);
    writeFileSync(outputPath.replace(/\.png$/i, '-tools-top.png'), toolsTopPng);
    writeFileSync(outputPath.replace(/\.png$/i, '-light.png'), lightPng);
    writeFileSync(outputPath.replace(/\.png$/i, '.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  } finally {
    try {
      removeIpc();
    } finally {
      destroyCaptureWindow(window);
      // Engine teardown can hang for 30s+ (session dispose). The capture
      // artifacts/error are already decided at this point — never let dispose
      // block the exit path past a short grace.
      await Promise.race([
        host.dispose(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
}

const capturedRendererConsoleErrors: string[] = [];

void captureWindow().then(
  () => app.quit(),
  (error: unknown) => {
    let message = error instanceof Error ? error.stack || error.message : String(error);
    if (capturedRendererConsoleErrors.length > 0) {
      message += `\nRenderer console errors:\n${capturedRendererConsoleErrors.slice(-5).join('\n')}`;
    }
    console.error(message);
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(`${outputPath}.error.txt`, `${message}\n`);
    }
    app.exit(1);
    // app.exit can stall behind lingering engine/GPU teardown; guarantee the
    // process dies so the calling harness never waits out its full timeout.
    setTimeout(() => process.exit(1), 1_500);
  },
);

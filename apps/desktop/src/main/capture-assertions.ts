import type { BrowserWindow, NativeImage } from 'electron';

export const schemaVersion = 1;
export const captureTitle = `Mixdog Capture ${process.pid}`;
export const targetSize = { width: 1_113, height: 687 };
export const captureStepTimeoutMs = 5_000;

export async function withCaptureTimeout<T>(promise: Promise<T>, label: string, timeoutMs = captureStepTimeoutMs): Promise<T> {
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

export async function waitForRenderer(
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

export interface RendererValidation {
  bridgePresent: boolean;
  inlineErrorCount: number;
  consoleErrorCount: number;
}

export interface RectMeasurement {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ImageMeasuredSidebar {
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

export interface ShellTopEdgeSample {
  theme: 'dark' | 'light';
  x: number;
  yStart: number;
  yEnd: number;
  colors: string[];
}

export interface LiveCaptureAssertions {
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
    phone: SettingsPhoneAssertions;
  };
  lightTheme: LightThemeAssertions;
  modalStack: ModalStackAssertions;
}

export interface SettingsPlacementAssertions {
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

export interface SettingsPhoneCategoryAssertions {
  label: string;
  rowCount: number;
  overflowFree: boolean;
  controlsContained: boolean;
  controlsRightAligned: boolean;
  labelsSeparated: boolean;
}

export interface SettingsPhoneAssertions {
  viewport: { width: number; height: number };
  layer: RectMeasurement;
  dialog: RectMeasurement;
  rail: RectMeasurement;
  pane: RectMeasurement;
  fullScreen: boolean;
  railConnected: boolean;
  railButtonCount: number;
  railButtonsAccessible: boolean;
  closeTouchTarget: boolean;
  rowCount: number;
  filledValueControlCount: number;
  sharedValueAxis: boolean;
  controlsContained: boolean;
  controlsRightAligned: boolean;
  labelsSeparated: boolean;
  valuesFillColumn: boolean;
  overflowFree: boolean;
  categories: SettingsPhoneCategoryAssertions[];
}

export interface LightThemeAssertions {
  theme: string;
  colorScheme: string;
  titlebarIconColor: string;
  iconTokenColor: string;
  activeTabColor: string;
  textTokenColor: string;
  titlebarIconMatchesToken: boolean;
  activeTabMatchesToken: boolean;
}

export interface ModalStackAssertions {
  toastParentIsBody: boolean;
  toastVisible: boolean;
  toastOutsideInertTree: boolean;
  toastZIndex: number;
  modalZIndex: number;
  toastAboveModal: boolean;
}

export async function readDesktopAssertions(window: BrowserWindow): Promise<LiveCaptureAssertions['desktop']> {
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

export async function readSettingsPlacement(window: BrowserWindow): Promise<SettingsPlacementAssertions> {
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

export async function readPhoneSettingsAssertions(window: BrowserWindow): Promise<SettingsPhoneAssertions> {
  return window.webContents.executeJavaScript(`(async () => {
    const layer = document.querySelector('.mixdog-settings-layer');
    const dialog = layer?.querySelector('.mixdog-settings');
    const rail = dialog?.querySelector('.mixdog-settings__rail');
    const pane = dialog?.querySelector('.mixdog-settings__panel');
    const body = dialog?.querySelector('.mixdog-settings__body');
    const close = dialog?.querySelector('.mixdog-settings__close');
    if (!(layer instanceof HTMLElement) || !(dialog instanceof HTMLElement)
      || !(rail instanceof HTMLElement) || !(pane instanceof HTMLElement)
      || !(body instanceof HTMLElement) || !(close instanceof HTMLElement)) {
      throw new Error('Phone settings surface is missing from the capture renderer.');
    }
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height,
      };
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const value = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && value.width > 0 && value.height > 0;
    };
    const overflowFree = (element) => element.scrollWidth <= element.clientWidth + 1;
    const buttons = Array.from(rail.querySelectorAll('button'));
    const controlLefts = [];
    let rowCount = 0;
    let filledValueControlCount = 0;
    let controlsContained = true;
    let controlsRightAligned = true;
    let labelsSeparated = true;
    let valuesFillColumn = true;
    let allOverflowFree = overflowFree(dialog) && overflowFree(pane) && overflowFree(body);
    const categories = [];
    for (const button of buttons) {
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rows = Array.from(body.querySelectorAll(
        '.mixdog-settings__row, .settings-form-row, .settings-resource',
      )).filter((element) => element instanceof HTMLElement && visible(element));
      let categoryControlsContained = true;
      let categoryControlsRightAligned = true;
      let categoryLabelsSeparated = true;
      let categoryOverflowFree = [
        body,
        ...body.querySelectorAll(
          '.settings-group, .settings-group-body, .core-memory-manager, .core-memory-add-card, '
          + '.core-memory-list, .settings-shortcut-list, .settings-connection-grid',
        ),
      ].every((element) => element instanceof HTMLElement && overflowFree(element));
      for (const row of rows) {
        rowCount += 1;
        categoryOverflowFree = categoryOverflowFree && overflowFree(row);
        const control = Array.from(row.children).find((element) =>
          element instanceof HTMLElement && element.matches(
            '.settings-row-control, .settings-form-controls, .settings-resource-control',
          ));
        if (!(control instanceof HTMLElement)) continue;
        const rowRect = rect(row);
        const controlRect = rect(control);
        const first = row.firstElementChild;
        controlLefts.push(controlRect.left);
        categoryControlsContained = categoryControlsContained
          && controlRect.left >= rowRect.left - 1 && controlRect.right <= rowRect.right + 1;
        categoryControlsRightAligned = categoryControlsRightAligned
          && Math.abs(controlRect.right - rowRect.right) <= 1;
        categoryLabelsSeparated = categoryLabelsSeparated
          && (!(first instanceof HTMLElement) || rect(first).right <= controlRect.left + 1);
        const fillTargets = Array.from(control.querySelectorAll(
          '.settings-select.oc-select-root, .settings-model-trigger, .effort-control, '
          + '.fast-control, input:not([type="checkbox"])',
        )).filter((element) => element instanceof HTMLElement && visible(element));
        for (const target of fillTargets) {
          const targetRect = rect(target);
          filledValueControlCount += 1;
          valuesFillColumn = valuesFillColumn
            && Math.abs(targetRect.left - controlRect.left) <= 1
            && Math.abs(targetRect.right - controlRect.right) <= 1;
        }
      }
      controlsContained = controlsContained && categoryControlsContained;
      controlsRightAligned = controlsRightAligned && categoryControlsRightAligned;
      labelsSeparated = labelsSeparated && categoryLabelsSeparated;
      allOverflowFree = allOverflowFree && categoryOverflowFree;
      categories.push({
        label: button.getAttribute('aria-label') || (button.textContent || '').trim(),
        rowCount: rows.length,
        overflowFree: categoryOverflowFree,
        controlsContained: categoryControlsContained,
        controlsRightAligned: categoryControlsRightAligned,
        labelsSeparated: categoryLabelsSeparated,
      });
    }
    const layerRect = rect(layer);
    const dialogRect = rect(dialog);
    const railRect = rect(rail);
    const paneRect = rect(pane);
    const tolerance = 1;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      layer: layerRect,
      dialog: dialogRect,
      rail: railRect,
      pane: paneRect,
      fullScreen: Math.abs(layerRect.left) <= tolerance && Math.abs(layerRect.top) <= tolerance
        && Math.abs(layerRect.right - innerWidth) <= tolerance
        && Math.abs(layerRect.bottom - innerHeight) <= tolerance
        && Math.abs(dialogRect.left) <= tolerance && Math.abs(dialogRect.top) <= tolerance
        && Math.abs(dialogRect.right - innerWidth) <= tolerance
        && Math.abs(dialogRect.bottom - innerHeight) <= tolerance,
      railConnected: Math.abs(railRect.left - dialogRect.left) <= tolerance
        && Math.abs(railRect.right - paneRect.left) <= tolerance
        && Math.abs(paneRect.right - dialogRect.right) <= tolerance,
      railButtonCount: buttons.length,
      railButtonsAccessible: buttons.every((button) =>
        Boolean((button.getAttribute('aria-label') || '').trim())),
      closeTouchTarget: rect(close).width >= 40 && rect(close).height >= 40,
      rowCount,
      filledValueControlCount,
      sharedValueAxis: controlLefts.length > 0
        && Math.max(...controlLefts) - Math.min(...controlLefts) <= tolerance,
      controlsContained,
      controlsRightAligned,
      labelsSeparated,
      valuesFillColumn,
      overflowFree: allOverflowFree,
      categories,
    };
  })()`) as Promise<SettingsPhoneAssertions>;
}

export async function readLightThemeAssertions(window: BrowserWindow): Promise<LightThemeAssertions> {
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

export async function readModalStackAssertions(window: BrowserWindow): Promise<ModalStackAssertions> {
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

export async function readMobileOpenAssertions(window: BrowserWindow): Promise<LiveCaptureAssertions['mobile']['open']> {
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

export async function readMobileClosedAssertions(window: BrowserWindow): Promise<LiveCaptureAssertions['mobile']['closed']> {
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

export function destroyCaptureWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy();
}

export function validateAndDestroyRenderer(
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

export function imageReader(image: NativeImage): (x: number, y: number) => string {
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

export function measureShellTopEdge(image: NativeImage, theme: ShellTopEdgeSample['theme']): ShellTopEdgeSample {
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

export function measureSidebarGeometry(image: NativeImage): ImageMeasuredSidebar {
  const pixel = imageReader(image);
  // Stay above the footer controls so icon pixels cannot split the interior run.
  const scanlineY = 600;
  // The renderer uses the active theme's bg-base token for the sidebar.
  const sidebarColor = '#201e1c';
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

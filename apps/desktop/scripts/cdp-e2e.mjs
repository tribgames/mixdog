import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DESKTOP_READ_CAPABILITIES,
} from '../src/shared/contract.ts';
import {
  SLASH_COMMANDS as desktopSlashCommands,
} from '../src/renderer/slash-commands.ts';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_ITEMS,
  categoryForSettingsItem,
} from '../src/renderer/settings/settings-items.ts';
import {
  SLASH_COMMANDS as tuiSlashCommands,
} from '../../../src/tui/app/slash-commands.mjs';

const [webSocketUrl, projectPath] = process.argv.slice(2);
if (!webSocketUrl || !projectPath) {
  throw new Error('Usage: node --import tsx scripts/cdp-e2e.mjs <webSocketUrl> <projectPath>');
}

const publicFields = (command) => Object.fromEntries(
  ['name', 'usage', 'aliases', 'aliasUsage', 'showAliasUsage', 'params', 'description']
    .filter((field) => Object.hasOwn(command, field))
    .map((field) => [field, command[field]]),
);
assert.deepEqual(
  desktopSlashCommands.map(publicFields),
  tuiSlashCommands.map(publicFields),
  'Desktop command inventory drifted from the TUI registry.',
);

async function largestStoredSessionId(sessionIds) {
  const known = new Set(sessionIds.map(String));
  if (known.size === 0) return '';
  const mixdogHome = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
  const metadataDirectory = join(mixdogHome, 'sessions');
  let largest = { id: '', bytes: -1 };
  let files = [];
  try {
    files = await readdir(metadataDirectory);
  } catch {
    return '';
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const metadata = JSON.parse(await readFile(join(metadataDirectory, file), 'utf8'));
      const id = String(metadata?.sessionId || '');
      const transcriptPath = String(metadata?.transcriptPath || '');
      if (!known.has(id) || !transcriptPath) continue;
      const info = await stat(transcriptPath);
      if (info.size > largest.bytes) largest = { id, bytes: info.size };
    } catch {
      // Stale process metadata is expected; only live transcript files are candidates.
    }
  }
  return largest.id;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || 'Unknown renderer exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push((message.params.args || [])
          .map((argument) => argument.value ?? argument.description ?? '')
          .join(' '));
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 15_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP websocket failed.'));
      }, { once: true });
    });
    await this.request('Runtime.enable');
  }

  request(method, params = {}, timeoutMs = 45_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 45_000) {
    const result = await this.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

const client = new CdpClient(webSocketUrl);
await client.connect();

const harnessInstalled = await client.evaluate('Boolean(window.__mixdogE2e?.bootstrap)');
const bootstrap = harnessInstalled
  ? await client.evaluate('window.__mixdogE2e.bootstrap')
  : await client.evaluate(`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, label, timeoutMs = 30000) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const value = await read();
      if (value) return value;
      await sleep(25);
    }
    throw new Error('Timed out waiting for ' + label + '.');
  };
  const text = (element) => String(element?.textContent || '').replace(/\\s+/g, ' ').trim();
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const queryVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(visible) || null;
  const currentError = () => text(queryVisible('.inline-error[role="alert"], .mixdog-settings__error[role="alert"], .composer-error'));
  const textarea = () => {
    const element = document.querySelector('textarea[aria-label="Message Mixdog"]');
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('Composer textarea is unavailable.');
    return element;
  };
  const setDraft = async (value) => {
    const element = textarea();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native textarea setter is unavailable.');
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: value ? 'insertText' : 'deleteContentBackward',
      data: value || null,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);
  };
  const clearDraft = async () => {
    await setDraft('');
    await sleep(25);
  };
  const submitSlash = async (command) => {
    await waitFor(async () => {
      const snapshot = await window.mixdogDesktop.getSnapshot();
      return snapshot?.commandBusy !== true ? snapshot : null;
    }, 'command idle before ' + command, 45000);
    let button = null;
    for (let attempt = 0; attempt < 2 && !button; attempt += 1) {
      await setDraft(command);
      try {
        button = await waitFor(() => {
          const candidate = queryVisible('button.send-button:not(.stop)');
          return candidate && !candidate.disabled ? candidate : null;
        }, 'enabled command submit button for ' + command, attempt === 0 ? 5_000 : 30_000);
      } catch (error) {
        if (attempt === 1) throw error;
        await clearDraft();
      }
    }
    const form = button.closest('form');
    if (!(form instanceof HTMLFormElement)) throw new Error('Composer form is unavailable.');
    form.requestSubmit(button);
    await waitFor(() => textarea().value === '' || currentError(),
      'command acceptance for ' + command, 5000);
    const error = currentError();
    if (error) throw new Error(command + ' was rejected: ' + error);
    await sleep(50);
    return textarea();
  };
  const inputRetries = [];
  const submitAndWait = async (command, read, label, timeoutMs = 30000) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await submitSlash(command);
      try {
        return await waitFor(read, label, attempt === 0 ? Math.min(timeoutMs, 5000) : timeoutMs);
      } catch (reason) {
        const error = currentError();
        if (error) throw new Error(command + ' failed before opening ' + label + ': ' + error);
        if (attempt === 1) throw reason;
        inputRetries.push({ command, label });
        await clearDraft();
      }
    }
    throw new Error('Unreachable submit retry state for ' + command + '.');
  };
  const closeSettings = async () => {
    const button = queryVisible('button[aria-label="Close settings"]');
    if (button) button.click();
    await waitFor(() => !queryVisible('[role="dialog"][aria-labelledby="mixdog-settings-title"]'),
      'settings close');
  };
  const closeCommandSurface = async () => {
    const dialog = queryVisible('[role="dialog"][aria-labelledby="command-surface-title"]');
    if (!dialog) return;
    const button = Array.from(dialog.querySelectorAll('button')).find((entry) =>
      String(entry.getAttribute('aria-label') || '').startsWith('Close '));
    if (!button) throw new Error('Command surface close button is unavailable.');
    button.click();
    await waitFor(() => !queryVisible('[role="dialog"][aria-labelledby="command-surface-title"]'),
      'command surface close');
  };
  const assertNativeControlsSafe = (dialog) => {
    const overlay = navigator.windowControlsOverlay;
    if (!overlay?.visible) return { overlayVisible: false, safe: true };
    const safeRect = overlay.getTitlebarAreaRect();
    const dialogRect = dialog.getBoundingClientRect();
    const safe = dialogRect.top >= safeRect.height || dialogRect.right <= safeRect.x + safeRect.width;
    if (!safe) throw new Error('Dialog overlaps the native minimize/maximize/close controls.');
    return {
      overlayVisible: true,
      safe,
      safeRect: { x: safeRect.x, y: safeRect.y, width: safeRect.width, height: safeRect.height },
      dialogRect: { x: dialogRect.x, y: dialogRect.y, width: dialogRect.width, height: dialogRect.height },
    };
  };
  const palette = async (name, usage, description) => {
    let listbox = null;
    for (let attempt = 0; attempt < 2 && !listbox; attempt += 1) {
      await setDraft('/' + name);
      try {
        listbox = await waitFor(() => queryVisible('[role="listbox"][aria-label="Slash commands"]'),
          'slash palette for /' + name, 3000);
      } catch {
        await clearDraft();
      }
    }
    if (!listbox) {
      const snapshot = await window.mixdogDesktop.getSnapshot();
      throw new Error('Slash palette did not open for /' + name +
        ' (draft=' + JSON.stringify(textarea().value) + ', busy=' + Boolean(snapshot?.busy) +
        ', commandBusy=' + Boolean(snapshot?.commandBusy) + ').');
    }
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    const match = options.find((option) => text(option).toLowerCase().includes(String(usage).toLowerCase()));
    if (!match) throw new Error('Slash palette did not expose ' + usage + '.');
    if (!text(match).toLowerCase().includes(String(description).toLowerCase())) {
      throw new Error('Slash palette description drifted for ' + usage + '.');
    }
    const result = { name, usage, optionCount: options.length, label: text(match) };
    await clearDraft();
    return result;
  };
  const settingsRoute = async (name, expectedCategory) => {
    const dialog = await submitAndWait('/' + name, () => queryVisible(
      '[role="dialog"][aria-labelledby="mixdog-settings-title"]'
    ), 'settings route /' + name);
    await waitFor(() => !queryVisible('.settings-loading'), 'settings route load /' + name);
    const active = text(dialog.querySelector('.mixdog-settings__rail button[aria-current="page"]'));
    if (active.toLowerCase() !== String(expectedCategory).toLowerCase()) {
      throw new Error('/' + name + ' opened ' + active + ' instead of ' + expectedCategory + '.');
    }
    const error = currentError();
    if (error) throw new Error('/' + name + ' settings failed: ' + error);
    const nativeControls = assertNativeControlsSafe(dialog);
    const result = { name, category: active, nativeControls };
    await closeSettings();
    return result;
  };
  const commandSurface = async (name, expectedTitle) => {
    if (name === 'schedules') {
      const pane = await submitAndWait('/schedules', () => queryVisible('.schedules-pane'),
        'schedules main pane');
      await waitFor(() => pane.querySelector('.schedules-empty, .schedules-list'),
        'schedules main pane load', 45000);
      const title = text(pane.querySelector('.schedules-page-header h1'));
      if (title !== expectedTitle) {
        throw new Error('/schedules opened ' + title + ' instead of ' + expectedTitle + '.');
      }
      const taskLink = queryVisible('.task-link');
      if (!taskLink) throw new Error('New task navigation is unavailable after /schedules.');
      taskLink.click();
      await waitFor(() => !queryVisible('.schedules-pane'), 'schedules main pane close');
      return { name, title, bodyLength: text(pane).length };
    }
    const dialog = await submitAndWait('/' + name, () => queryVisible(
      '[role="dialog"][aria-labelledby="command-surface-title"]'
    ), 'command surface /' + name);
    await waitFor(() => dialog.getAttribute('aria-busy') !== 'true', 'command surface load /' + name, 45000);
    const title = text(dialog.querySelector('#command-surface-title'));
    if (title !== expectedTitle) throw new Error('/' + name + ' opened ' + title + ' instead of ' + expectedTitle + '.');
    const error = currentError();
    if (error) throw new Error('/' + name + ' surface failed: ' + error);
    const result = { name, title, bodyLength: text(dialog.querySelector('.mixdog-settings__body')).length };
    await closeCommandSurface();
    return result;
  };
  const auditSettings = async (categories) => {
    const dialog = await submitAndWait('/setting', () => queryVisible(
      '[role="dialog"][aria-labelledby="mixdog-settings-title"]'
    ), 'settings audit');
    const results = [];
    for (const category of categories) {
      const button = Array.from(dialog.querySelectorAll('.mixdog-settings__rail button'))
        .find((entry) => text(entry) === category.label);
      if (!button) throw new Error('Settings category is missing: ' + category.label + '.');
      button.click();
      await waitFor(() => text(dialog.querySelector('#mixdog-settings-title')) === category.label,
        'settings category ' + category.label);
      await waitFor(() => !queryVisible('.settings-loading'), 'settings category load ' + category.label, 45000);
      const error = currentError();
      if (error) throw new Error(category.label + ' settings failed: ' + error);
      const body = dialog.querySelector('.mixdog-settings__body');
      const bodyText = text(body);
      if (!bodyText) throw new Error(category.label + ' settings rendered an empty body.');
      // System shell override is TUI-only now (user decision); the desktop
      // System page intentionally omits the command editor.
      results.push({
        value: category.value,
        label: category.label,
        bodyLength: bodyText.length,
        controlCount: body.querySelectorAll('button, input, select, textarea').length,
      });
    }
    const nativeControls = assertNativeControlsSafe(dialog);
    await closeSettings();
    return { categories: results, nativeControls };
  };
  const projectRoute = async () => {
    const dialog = await submitAndWait('/project',
      () => queryVisible('[role="dialog"][aria-labelledby="project-switcher-title"]'),
      'project switcher');
    const rows = dialog.querySelectorAll('.project-row').length;
    const pinnedStates = Array.from(dialog.querySelectorAll('.project-card'))
      .map((card) => card.classList.contains('pinned'));
    const firstUnpinned = pinnedStates.indexOf(false);
    if (firstUnpinned >= 0 && pinnedStates.slice(firstUnpinned).includes(true)) {
      throw new Error('Pinned projects are not ordered before unpinned projects.');
    }
    const more = queryVisible('.project-card .project-more');
    let actions = [];
    if (more) {
      more.click();
      const menu = await waitFor(() => queryVisible('.project-card-menu[role="menu"]'),
        'project action menu');
      actions = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(text);
      if (!actions.some((action) => action === 'Pin project' || action === 'Unpin project')) {
        throw new Error('Project action menu is missing Pin/Unpin project.');
      }
      more.click();
      await waitFor(() => !queryVisible('.project-card-menu[role="menu"]'),
        'project action menu close');
    }
    const close = dialog.querySelector('button[aria-label="Close projects"]');
    if (!close) throw new Error('Project switcher close button is unavailable.');
    close.click();
    await waitFor(() => !queryVisible('[role="dialog"][aria-labelledby="project-switcher-title"]'),
      'project switcher close');
    return { rows, actions };
  };
  // Runtime status chip was retired with the header cleanup (aggregate
  // spinner + hover popover); no dedicated dialog remains to audit.
  const resumeRoute = async () => {
    await submitSlash('/resume');
    const sidebar = await waitFor(() => document.querySelector('#session-sidebar:not([aria-hidden="true"])'),
      'session sidebar');
    const sessions = sidebar.querySelectorAll('.session-row').length;
    const trigger = queryVisible('.session-row-more');
    if (!trigger) return { visible: visible(sidebar), sessions, actions: [] };
    trigger.click();
    const menu = await waitFor(() => queryVisible('.session-row-menu[role="menu"]'), 'session action menu');
    const actions = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(text);
    for (const expected of ['Rename', 'Delete']) {
      if (!actions.includes(expected)) throw new Error('Session action menu is missing ' + expected + '.');
    }
    trigger.click();
    await waitFor(() => !queryVisible('.session-row-menu[role="menu"]'), 'session action menu close');
    return { visible: visible(sidebar), sessions, actions };
  };
  const statusCommand = async (command, pattern) => {
    const notice = await submitAndWait(command, () => {
      const candidate = queryVisible('.composer-notice');
      return candidate && new RegExp(pattern, 'i').test(text(candidate)) ? candidate : null;
    }, 'status notice for ' + command);
    const result = text(notice);
    const error = currentError();
    if (error) throw new Error(command + ' failed: ' + error);
    return result;
  };
  const idempotentFast = async () => {
    const before = await window.mixdogDesktop.getSnapshot();
    const value = before?.fast === true;
    await submitSlash('/fast ' + (value ? 'on' : 'off'));
    await waitFor(async () => {
      const snapshot = await window.mixdogDesktop.getSnapshot();
      return snapshot && snapshot.fast === value ? snapshot : null;
    }, 'idempotent Fast mode');
    const error = currentError();
    if (error) throw new Error('/fast failed: ' + error);
    return { before: value, after: value };
  };
  const waitCommandIdle = async (label, timeoutMs = 45000, completed = () => false) => {
    let sawBusy = false;
    let sawCompletion = false;
    const snapshot = await waitFor(async () => {
      const snapshot = await window.mixdogDesktop.getSnapshot();
      if (snapshot?.commandBusy === true) sawBusy = true;
      if (snapshot && completed(snapshot)) sawCompletion = true;
      const settled = snapshot && (sawBusy || sawCompletion) && snapshot.commandBusy !== true;
      return settled ? snapshot : null;
    }, label, timeoutMs);
    await waitFor(() => {
      const button = queryVisible('button.send-button:not(.stop)');
      return button?.getAttribute('aria-label') === 'Send message' ? button : null;
    }, label + ' renderer settlement', timeoutMs);
    return { snapshot, sawBusy, sawCompletion };
  };
  const destructiveLocalRoutes = async () => {
    const beforeCompact = await window.mixdogDesktop.getSnapshot();
    const compactCompletionCount = (beforeCompact?.items || []).filter((item) =>
      item?.kind === 'statusdone' && String(item?.label || '').startsWith('Compact')).length;
    await submitSlash('/compact');
    const compactSettlement = await waitCommandIdle('/compact completion', 45000, (snapshot) =>
      (snapshot?.items || []).filter((item) =>
        item?.kind === 'statusdone' && String(item?.label || '').startsWith('Compact')).length > compactCompletionCount);
    let error = currentError();
    if (error) throw new Error('/compact failed: ' + error);
    await submitSlash('/clear');
    await sleep(250);
    await waitFor(async () => {
      const snapshot = await window.mixdogDesktop.getSnapshot();
      const button = queryVisible('button.send-button:not(.stop)');
      return snapshot && snapshot.commandBusy !== true &&
        button?.getAttribute('aria-label') === 'Send message' ? snapshot : null;
    }, '/clear completion', 45000);
    error = currentError();
    if (error) throw new Error('/clear failed: ' + error);
    await setDraft('/context');
    try {
      await waitFor(() => {
        const button = queryVisible('button.send-button:not(.stop)');
        return button && !button.disabled ? button : null;
      }, 'composer recovery after /clear', 15000);
    } catch (reason) {
      const snapshot = await window.mixdogDesktop.getSnapshot();
      const button = queryVisible('button.send-button:not(.stop)');
      throw new Error('Composer did not recover after /clear (busy=' + Boolean(snapshot?.busy) +
        ', commandBusy=' + Boolean(snapshot?.commandBusy) + ', buttonLabel=' +
        JSON.stringify(button?.getAttribute('aria-label') || '') + ', buttonDisabled=' +
        Boolean(button?.disabled) + '): ' + reason.message);
    }
    await clearDraft();
    return {
      clear: true,
      compact: true,
      compactObservedBusy: compactSettlement.sawBusy,
      compactObservedCompletion: compactSettlement.sawCompletion,
      composerRecovered: true,
    };
  };
  const auditSessionTimeline = async (sessionId) => {
    if (!sessionId) return { available: false, itemCount: 0, renderedRows: 0, virtualized: false };
    const row = Array.from(document.querySelectorAll('[data-session-id]'))
      .find((entry) => entry.getAttribute('data-session-id') === sessionId);
    if (!(row instanceof HTMLElement)) {
      return { available: false, itemCount: 0, renderedRows: 0, virtualized: false };
    }
    const current = await api.getSnapshot();
    if (row.getAttribute('aria-current') === 'page' && String(current?.sessionId || '') !== sessionId) {
      await api.resumeSession(sessionId);
    } else if (row.getAttribute('aria-current') !== 'page' || String(current?.sessionId || '') !== sessionId) {
      row.click();
    }
    const state = await waitFor(async () => {
      const next = await api.getSnapshot();
      return String(next?.sessionId || '') === sessionId ? next : null;
    }, 'stored session resume', 60000);
    const itemCount = Array.isArray(state.items) ? state.items.length : 0;
    if (document.querySelector('button[aria-label="Previous message"], button[aria-label="Next message"]')) {
      throw new Error('Transcript message navigation buttons should be absent.');
    }
    if (itemCount > 80) {
      await waitFor(() => queryVisible('.transcript-virtual-space[data-virtualized="true"]'),
        'recent session virtual timeline');
      await waitFor(() => document.querySelectorAll('.transcript-virtual-row').length,
        'recent session virtual rows');
      await waitFor(() => Array.from(document.querySelectorAll('.transcript-virtual-row'))
        .some((entry) => Number(entry.getAttribute('data-index')) === itemCount - 1),
      'recent session virtual tail');
    }
    const virtualized = Boolean(queryVisible('.transcript-virtual-space[data-virtualized="true"]'));
    const renderedIndexes = Array.from(document.querySelectorAll('.transcript-virtual-row'))
      .map((entry) => Number(entry.getAttribute('data-index')))
      .filter(Number.isFinite);
    const renderedRows = renderedIndexes.length;
    const firstRenderedIndex = renderedRows ? Math.min(...renderedIndexes) : null;
    const lastRenderedIndex = renderedRows ? Math.max(...renderedIndexes) : null;
    if (itemCount > 80 && (!virtualized || renderedRows <= 0 || renderedRows >= itemCount)) {
      throw new Error('Stored session timeline did not keep a bounded virtual DOM window.');
    }
    return {
      available: true, itemCount, renderedRows, firstRenderedIndex, lastRenderedIndex,
      virtualized,
    };
  };
  window.__mixdogE2e = {
    sleep, waitFor, text, palette, settingsRoute, commandSurface, auditSettings, inputRetries,
    projectRoute, resumeRoute, statusCommand, idempotentFast, destructiveLocalRoutes,
    auditSessionTimeline,
  };
  const api = window.mixdogDesktop;
  if (!api) throw new Error('Desktop preload bridge is missing.');
  const requiredMethods = [
    'startTask', 'startProject', 'listProjects', 'listSessions', 'getSnapshot', 'submit',
    'abort', 'readSettings', 'readCapabilities', 'invokeCapability', 'dispose', 'quit',
  ];
  const missingMethods = requiredMethods.filter((name) => typeof api[name] !== 'function');
  if (missingMethods.length) throw new Error('Desktop bridge is missing: ' + missingMethods.join(', '));
  const titlebarReady = await waitFor(() => {
    const titlebar = document.querySelector('header.topbar[aria-label="Workspace tabs"]');
    const rect = titlebar?.getBoundingClientRect();
    return rect && Math.round(rect.top) === 0 && Math.round(rect.height) === 40
      ? { titlebar, rect }
      : null;
  }, 'OpenCode titlebar geometry', 30000);
  const titlebarRect = titlebarReady.rect;
  await waitFor(() => document.querySelector('#session-sidebar'), 'session sidebar');
  await waitFor(() => document.querySelector('nav[aria-label="Open workspaces"]'), 'workspace tabs');
  await waitFor(() => document.querySelector('textarea[aria-label="Message Mixdog"]'), 'composer');
  const openCodeShell = {
    // Tabs reorder via pointer capture (aria-grabbed), not HTML draggable.
    workspaceTab: Boolean(document.querySelector('.workspace-tab')),
    // OpenCode parity: while a draft tab is active it IS the new-task
    // surface and the + affordance hides, so accept either signal.
    newTask: Boolean(document.querySelector('button[aria-label="New task"]') ||
      document.querySelector('.workspace-tab')),
    sidebarToggle: Boolean(document.querySelector('button.toolbar-sidebar')),
    projectSwitcher: Boolean(document.querySelector('button.projects-link')),
    settings: Boolean(document.querySelector('button[aria-label="Open settings"]')),
    sidebarResize: Boolean(document.querySelector('[role="separator"][aria-label="Resize session sidebar"]')),
    attachmentPicker: Boolean(document.querySelector('button[aria-label="Attach files"]') &&
      document.querySelector('input[type="file"][multiple]')),
  };
  const requiredShellFeatures = [
    'workspaceTab', 'newTask', 'sidebarToggle', 'projectSwitcher', 'settings',
    'sidebarResize', 'attachmentPicker',
  ];
  const missingShellFeatures = requiredShellFeatures.filter((name) => !openCodeShell[name]);
  if (missingShellFeatures.length) {
    throw new Error('OpenCode shell controls are missing: ' + missingShellFeatures.join(', ') + '.');
  }
  const bootstrapState = {
    bridgeMethods: requiredMethods.length,
    titlebar: { top: titlebarRect.top, height: titlebarRect.height, width: titlebarRect.width },
    openCodeShell,
    windowTitle: document.title,
  };
  window.__mixdogE2e.bootstrap = bootstrapState;
  return bootstrapState;
})()`);

try {
  const startedAt = Date.now();
  const baselineSessionIds = await client.evaluate(`window.mixdogDesktop.listSessions().then((rows) =>
    rows.slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).map((row) => row.id))`);
  const sessionAuditId = await largestStoredSessionId(baselineSessionIds) || baselineSessionIds[0] || '';
  await client.evaluate(`window.mixdogDesktop.startProject(${JSON.stringify(projectPath)})`, 60_000);

  const palette = [];
  for (const command of desktopSlashCommands) {
    palette.push(await client.evaluate(
      `window.__mixdogE2e.palette(${JSON.stringify(command.name)}, ${JSON.stringify(command.usage)}, ${JSON.stringify(command.description)})`,
    ));
  }

  const settingRoutes = [];
  for (const command of desktopSlashCommands.filter((entry) => entry.settingsRow)) {
    const category = categoryForSettingsItem(command.settingsRow);
    const label = SETTINGS_CATEGORIES.find((entry) => entry.value === category)?.label;
    settingRoutes.push(await client.evaluate(
      `window.__mixdogE2e.settingsRoute(${JSON.stringify(command.name)}, ${JSON.stringify(label)})`,
      60_000,
    ));
  }

  const surfaceTitles = {
    agents: 'Agents',
    memory: 'Memory',
    schedules: 'Scheduled tasks',
    webhooks: 'Webhooks',
    channels: 'Channels',
    context: 'Context',
    usage: 'Provider usage',
    doctor: 'Doctor',
    effort: 'Reasoning effort',
  };
  const commandSurfaces = [];
  for (const command of desktopSlashCommands.filter((entry) => entry.surface)) {
    try {
      commandSurfaces.push(await client.evaluate(
        `window.__mixdogE2e.commandSurface(${JSON.stringify(command.name)}, ${JSON.stringify(surfaceTitles[command.surface])})`,
        90_000,
      ));
    } catch (reason) {
      throw new Error(`/${command.name} command surface acceptance failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  const settingsAudit = await client.evaluate(
    `window.__mixdogE2e.auditSettings(${JSON.stringify(SETTINGS_CATEGORIES)})`,
    180_000,
  );
  const project = await client.evaluate('window.__mixdogE2e.projectRoute()', 60_000);
  const resume = await client.evaluate('window.__mixdogE2e.resumeRoute()', 60_000);
  const statusCommands = {
    autoclear: await client.evaluate("window.__mixdogE2e.statusCommand('/autoclear status', 'Auto-clear')"),
    theme: await client.evaluate("window.__mixdogE2e.statusCommand('/theme status', 'Theme:')"),
    outputStyle: await client.evaluate("window.__mixdogE2e.statusCommand('/OutputStyle status', 'Output style:')"),
  };
  const fast = await client.evaluate('window.__mixdogE2e.idempotentFast()', 60_000);
  const localMutations = await client.evaluate('window.__mixdogE2e.destructiveLocalRoutes()', 120_000);

  const readCapabilities = DESKTOP_READ_CAPABILITIES.filter((capability) => capability !== 'skillContent');
  const capabilityResults = await client.evaluate(
    `window.mixdogDesktop.readCapabilities(${JSON.stringify(readCapabilities.map((capability) => ({ capability })))})`,
    180_000,
  );
  assert.equal(capabilityResults.length, readCapabilities.length);
  const capabilityFailures = capabilityResults.flatMap((result, index) => result.ok
    ? []
    : [{ capability: readCapabilities[index], error: result.error }]);
  assert.deepEqual(capabilityFailures, [], 'One or more real desktop capability reads failed.');
  const inputRetries = await client.evaluate('window.__mixdogE2e.inputRetries');
  const sessionTimeline = await client.evaluate(
    `window.__mixdogE2e.auditSessionTimeline(${JSON.stringify(sessionAuditId)})`,
    90_000,
  );
  const heapUsage = await client.request('Runtime.getHeapUsage');
  const domCounters = await client.request('Memory.getDOMCounters');
  const heapMegabytes = Object.fromEntries(Object.entries(heapUsage)
    .filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => [key, Math.round((value / 1024 / 1024) * 100) / 100]));
  let afterGarbageCollection = null;
  if (process.env.MIXDOG_E2E_COLLECT_GC === '1') {
    await client.request('HeapProfiler.collectGarbage');
    const [collectedHeap, collectedDom] = await Promise.all([
      client.request('Runtime.getHeapUsage'),
      client.request('Memory.getDOMCounters'),
    ]);
    afterGarbageCollection = {
      heapUsageMb: Object.fromEntries(Object.entries(collectedHeap)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => [key, Math.round((value / 1024 / 1024) * 100) / 100])),
      domCounters: collectedDom,
    };
  }

  const report = {
    schemaVersion: 1,
    mode: 'direct-user-environment',
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    projectVerified: true,
    inventory: {
      tuiCommands: tuiSlashCommands.length,
      desktopCommands: desktopSlashCommands.length,
      settingsItems: SETTINGS_ITEMS.length,
      settingsCategories: SETTINGS_CATEGORIES.length,
      readCapabilities: readCapabilities.length,
    },
    bootstrap,
    palette,
    settingRoutes,
    commandSurfaces,
    settingsAudit,
    actions: {
      project,
      runtimeStatus: 'retired: header aggregate replaces the dedicated popover',
      resume,
      fast,
      localMutations,
      statusCommands,
      remote: 'guarded: would claim remote from another live session',
      quit: 'covered by the direct runner lifecycle',
    },
    capabilityFailures,
    inputRetries,
    sessionTimeline,
    renderer: {
      consoleErrors: client.consoleErrors,
      exceptions: client.exceptions,
      heapUsageMb: heapMegabytes,
      domCounters,
      afterGarbageCollection,
    },
  };
  assert.deepEqual(client.exceptions, [], 'Renderer raised an uncaught exception during E2E.');
  console.log(JSON.stringify(report));
} finally {
  client.close();
}

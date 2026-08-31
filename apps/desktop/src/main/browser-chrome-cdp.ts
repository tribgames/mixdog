import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { type RawData } from 'ws';

import { assertBrowserKeyDoesNotAccessClipboard } from './browser-input';
import {
  normalizePageUrl,
  redactBrowserText,
  redactBrowserUrl,
  type BrowserUrlPolicy,
} from './browser-host-policy';
import {
  assertFullPageOutputBounds,
  boundedFullPageRect,
} from './browser-screenshot-policy';
import { createBrowserUrlAdmission } from './browser-url-admission';

const CHROME_REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';
const CONNECT_TIMEOUT_MS = 30_000;
const CDP_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_SNAPSHOT_ELEMENTS = 220;
const MAX_SNAPSHOT_ELEMENTS = 500;
const DEFAULT_SNAPSHOT_CHARS = 24_000;
const MAX_SNAPSHOT_CHARS = 80_000;
const PAGE_STATE_TEXT_CHARS = 160_000;
const MAX_PENDING_CDP_REQUESTS = 256;

export interface ChromeBrowserTarget {
  id: string;
  title: string;
  url: string;
  type: 'page';
}

export interface ChromeBrowserStatus {
  connected: boolean;
  endpoint: string;
  target?: ChromeBrowserTarget;
}

export interface ChromeBrowserCommand {
  action: string;
  url?: string;
  ref?: string;
  targetRef?: string;
  snapshotId?: string;
  x?: number;
  y?: number;
  targetX?: number;
  targetY?: number;
  mode?: string;
  button?: string;
  modifiers?: string[];
  script?: string;
  operation?: string;
  text?: string;
  textGone?: string;
  value?: string;
  values?: string[];
  checked?: boolean;
  reload?: boolean;
  submit?: boolean;
  key?: string;
  dy?: number;
  dx?: number;
  maxChars?: number;
  offset?: number;
  viewportOnly?: boolean;
  maxElements?: number;
  doubleClick?: boolean;
  fullPage?: boolean;
  format?: string;
  quality?: number;
  accept?: boolean;
  promptText?: string;
  fields?: Array<{
    ref?: string;
    text?: string;
    value?: string;
    values?: string[];
    checked?: boolean;
  }>;
  timeoutMs?: number;
  expect?: {
    text?: string;
    textGone?: string;
    url?: string;
    timeoutMs?: number;
  };
  settleMs?: number;
  includeScreenshot?: boolean;
  tab?: string;
  background?: boolean;
}

export interface ChromeBrowserCommandResult {
  text: string;
  image?: { mimeType: string; data: string };
}

interface ConnectedTarget {
  target: ChromeBrowserTarget;
  admissionUrl: string;
}

interface AxValue {
  value?: unknown;
}

interface AxProperty {
  name?: string;
  value?: AxValue;
}

interface AxNode {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
}

interface RefEntry {
  snapshotId: string;
  backendNodeId: number;
  role: string;
  name: string;
}

interface PageState {
  title: string;
  url: string;
  text: string;
  textCapped: boolean;
}

type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
) => void;

export interface ChromeCdpBrowserOptions {
  /** Test/embedding override. Production discovers Chrome's protected endpoint
   *  from DevToolsActivePort and never accepts a renderer-supplied address. */
  browserWSEndpoint?: string;
  browserWSEndpointProvider?: () => Promise<string>;
  userDataDirectories?: string[];
  connectionLabel?: string;
  protectedExistingProfile?: boolean;
  onPurchaseApproval?: (request: BrowserPurchaseApprovalRequest) => Promise<boolean>;
  urlPolicy?: BrowserUrlPolicy;
  lookupAddresses?: (hostname: string) => Promise<Array<{ address: string }>>;
}

export interface BrowserPurchaseApprovalRequest {
  merchant: string;
  url: string;
  actionLabel: string;
  pageSummary: string;
}

interface PurchaseTargetDescriptor {
  tag: string;
  role: string;
  type: string;
  label: string;
  href: string;
  formAction: string;
  pageTitle: string;
  pageUrl: string;
  summary: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('browser command cancelled'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason || new Error('browser command cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    timer.unref?.();
  });
}

function cleanText(value: unknown, max = 500): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function isFinalPurchaseTarget(
  descriptor: Pick<PurchaseTargetDescriptor, 'tag' | 'role' | 'type' | 'label' | 'href' | 'formAction'>,
): boolean {
  const label = cleanText(descriptor.label, 500).toLowerCase();
  const destination = cleanText(`${descriptor.href} ${descriptor.formAction}`, 2_000).toLowerCase();
  if (/(add\s+to\s+(cart|bag)|장바구니|카트에\s*담|proceed\s+to\s+checkout|review\s+order|checkout\s*$)/i.test(label)) {
    return false;
  }
  const finalLabel = /(?:place|submit|confirm|complete)\s+(?:your\s+)?(?:order|purchase)|(?:pay|buy|purchase)\s+now|confirm\s+and\s+pay|order\s+with\s+obligation\s+to\s+pay|주문(?:을)?\s*(?:확정|완료|하기)|결제(?:를)?\s*(?:확정|완료|하기)|구매(?:를)?\s*(?:확정|완료|하기)|注文を確定|購入する|支払う|确认订单|提交订单|立即支付|立即购买/i.test(label);
  const paymentBrand = /^(?:apple\s*pay|google\s*pay|shop\s*pay|paypal)$/i.test(label);
  if (!finalLabel && !paymentBrand) return false;
  const actionable = /^(?:button|input|a)$/i.test(descriptor.tag)
    || descriptor.role.toLowerCase() === 'button'
    || descriptor.type.toLowerCase() === 'submit';
  const checkoutContext = /(?:checkout|order|purchase|payment|pay|결제|주문|구매)/i.test(destination);
  return actionable && (finalLabel || paymentBrand || checkoutContext);
}

function jsonValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

class CdpSocket {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
    abort?: () => void;
    signal?: AbortSignal;
  }>();
  private nextId = 0;
  private closed = false;
  private sessionId = '';

  private constructor(
    socket: WebSocket,
    private readonly onEvent: CdpEventListener,
    private readonly onClosed: () => void,
  ) {
    this.socket = socket;
    socket.on('message', (data) => this.receive(data));
    socket.once('close', () => this.finish(new Error('Chrome closed the DevTools connection')));
    socket.once('error', (error) => this.finish(error));
  }

  static open(
    url: string,
    onEvent: CdpEventListener,
    onClosed: () => void,
    signal?: AbortSignal,
  ): Promise<CdpSocket> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('Chrome connection cancelled'));
        return;
      }
      const socket = new WebSocket(url, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: 16 * 1024 * 1024,
      });
      const abort = (): void => {
        socket.terminate();
        reject(signal?.reason || new Error('Chrome connection cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('open', () => {
        signal?.removeEventListener('abort', abort);
        resolve(new CdpSocket(socket, onEvent, onClosed));
      });
      socket.once('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
    });
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chrome DevTools connection is closed'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason || new Error('browser command cancelled'));
    }
    if (this.pending.size >= MAX_PENDING_CDP_REQUESTS) {
      return Promise.reject(new Error(
        `Chrome DevTools request limit reached (${MAX_PENDING_CDP_REQUESTS})`,
      ));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        reject(new Error(`${method} timed out after ${CDP_TIMEOUT_MS}ms`));
      }, CDP_TIMEOUT_MS);
      timer.unref?.();
      const abort = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(signal?.reason || new Error('browser command cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, timer, abort, signal });
      this.socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      }), (error) => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.abort!);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
    this.finish(new Error('Chrome DevTools connection disconnected'));
  }

  private receive(data: RawData): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = Number(value.id);
    if (Number.isInteger(id) && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener('abort', entry.abort!);
      if (value.error) {
        const error = asRecord(value.error);
        entry.reject(new Error(
          `CDP ${cleanText(error.message || 'request failed')}`
          + (error.code === undefined ? '' : ` (${String(error.code)})`),
        ));
      } else {
        entry.resolve(value.result);
      }
      return;
    }
    const method = cleanText(value.method, 120);
    if (method) this.onEvent(method, asRecord(value.params), cleanText(value.sessionId, 300));
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener('abort', entry.abort!);
      entry.reject(error);
    }
    this.pending.clear();
    this.onClosed();
  }
}

const ACTIONABLE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider',
  'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);

const READABLE_ROLES = new Set([
  ...ACTIONABLE_ROLES,
  'alert', 'article', 'cell', 'columnheader', 'dialog', 'document', 'figure',
  'form', 'heading', 'img', 'list', 'listitem', 'main', 'navigation', 'region',
  'row', 'rowheader', 'statictext', 'status', 'table',
]);

function axValue(value: AxValue | undefined): unknown {
  return value?.value;
}

function axProperty(node: AxNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value?.value;
}

function modifierMask(modifiers: string[] | undefined): number {
  let mask = 0;
  for (const modifier of modifiers || []) {
    const value = modifier.toLowerCase();
    if (value === 'alt') mask |= 1;
    else if (value === 'control' || value === 'ctrl') mask |= 2;
    else if (value === 'meta' || value === 'command' || value === 'cmd') mask |= 4;
    else if (value === 'shift') mask |= 8;
  }
  return mask;
}

function mouseButton(value: unknown): 'left' | 'right' | 'middle' {
  const normalized = String(value || 'left').toLowerCase();
  if (normalized === 'right' || normalized === 'middle') return normalized;
  return 'left';
}

const KEY_INFO: Record<string, { key: string; code: string; vk: number }> = {
  ENTER: { key: 'Enter', code: 'Enter', vk: 13 },
  RETURN: { key: 'Enter', code: 'Enter', vk: 13 },
  TAB: { key: 'Tab', code: 'Tab', vk: 9 },
  ESCAPE: { key: 'Escape', code: 'Escape', vk: 27 },
  ESC: { key: 'Escape', code: 'Escape', vk: 27 },
  BACKSPACE: { key: 'Backspace', code: 'Backspace', vk: 8 },
  DELETE: { key: 'Delete', code: 'Delete', vk: 46 },
  ARROWUP: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ARROWDOWN: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ARROWLEFT: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ARROWRIGHT: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  HOME: { key: 'Home', code: 'Home', vk: 36 },
  END: { key: 'End', code: 'End', vk: 35 },
  PAGEUP: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PAGEDOWN: { key: 'PageDown', code: 'PageDown', vk: 34 },
  SPACE: { key: ' ', code: 'Space', vk: 32 },
};

export class ChromeCdpBrowser {
  private client: CdpSocket | null = null;
  private connected: ConnectedTarget | null = null;
  private targetSessionId = '';
  private availableTargets = new Map<string, ConnectedTarget>();
  private snapshotGeneration = 0;
  private refs = new Map<string, RefEntry>();
  private pendingDialog: { type: string; message: string } | null = null;
  private readonly urlAdmission: ReturnType<typeof createBrowserUrlAdmission>;

  constructor(private readonly options: ChromeCdpBrowserOptions = {}) {
    this.urlAdmission = createBrowserUrlAdmission({
      policy: options.urlPolicy || {},
      ...(options.lookupAddresses ? { lookupAddresses: options.lookupAddresses } : {}),
    });
    if (options.browserWSEndpoint) {
      const parsed = new URL(options.browserWSEndpoint);
      if (parsed.protocol !== 'ws:' || !loopbackHostname(parsed.hostname)) {
        throw new Error('Chrome WebSocket endpoint must be a loopback ws:// address');
      }
    }
  }

  status(): ChromeBrowserStatus {
    return {
      connected: Boolean(this.client && this.connected),
      endpoint: this.options.connectionLabel ?? CHROME_REMOTE_DEBUGGING_URL,
      ...(this.connected ? { target: this.connected.target } : {}),
    };
  }

  isConnected(): boolean {
    return Boolean(this.client && this.connected);
  }

  async listTargets(signal?: AbortSignal): Promise<ChromeBrowserTarget[]> {
    if (this.connected) return [{ ...this.connected.target }];
    const client = await this.ensureBrowserClient(signal);
    const targets = await this.readTargets(client, signal);
    this.availableTargets = new Map(targets.map((target) => [target.target.id, target]));
    return targets.map(({ target }) => ({ ...target }));
  }

  async connect(targetId: string, signal?: AbortSignal): Promise<ChromeBrowserStatus> {
    const requested = String(targetId || '').trim();
    if (!requested) throw new Error('Chrome target id is required');
    const client = await this.ensureBrowserClient(signal);
    if (!this.availableTargets.size) {
      const targets = await this.readTargets(client, signal);
      this.availableTargets = new Map(targets.map((target) => [target.target.id, target]));
    }
    const selected = this.availableTargets.get(requested);
    if (!selected) {
      throw new Error('The selected Chrome tab is no longer available; refresh the tab list');
    }
    normalizePageUrl(selected.admissionUrl, this.options.urlPolicy || {});
    await this.urlAdmission.assertResolvedUrlAllowed(selected.admissionUrl, true);
    const attached = asRecord(await client.call('Target.attachToTarget', {
      targetId: selected.target.id,
      flatten: true,
    }, signal));
    const sessionId = cleanText(attached.sessionId, 300);
    if (!sessionId) throw new Error('Chrome did not create a tab-scoped DevTools session');
    client.setSessionId(sessionId);
    this.targetSessionId = sessionId;
    this.connected = selected;
    try {
      await Promise.all([
        client.call('Page.enable', {}, signal),
        client.call('Runtime.enable', {}, signal),
        client.call('DOM.enable', {}, signal),
        client.call('Accessibility.enable', {}, signal),
        client.call('Fetch.enable', {
          patterns: [
            { urlPattern: 'http://*/*', requestStage: 'Request' },
            { urlPattern: 'https://*/*', requestStage: 'Request' },
          ],
        }, signal),
      ]);
    } catch (error) {
      this.disconnect();
      throw new Error(`Could not initialize the selected Chrome tab: ${messageFor(error)}`);
    }
    return this.status();
  }

  disconnect(): ChromeBrowserStatus {
    const client = this.client;
    this.client = null;
    this.connected = null;
    this.targetSessionId = '';
    this.availableTargets.clear();
    this.refs.clear();
    this.pendingDialog = null;
    client?.close();
    return this.status();
  }

  async run(
    command: ChromeBrowserCommand,
    signal?: AbortSignal,
  ): Promise<ChromeBrowserCommandResult> {
    const action = String(command.action || '').trim().toLowerCase();
    if (!action) throw new Error('browser command requires action');
    this.assertExactTarget(command);
    const client = this.requiredClient();
    switch (action) {
      case 'open':
        return { text: this.connectedSummary() };
      case 'list_tabs':
        return { text: this.connectedTabs() };
      case 'snapshot':
        return await this.snapshot(command, signal);
      case 'status':
        return {
          text: `${this.connectedSummary()}\nConnection scope: exact selected tab only.`
            + `\nApproval: ${CHROME_REMOTE_DEBUGGING_URL}`,
        };
      case 'navigate': {
        if (command.reload === true) {
          if (command.url) throw new Error('navigate accepts url or reload=true, not both');
          this.invalidateRefs();
          await client.call('Page.reload', { ignoreCache: false }, signal);
        } else {
          if (!command.url) throw new Error('navigate requires url or reload=true');
          const url = await this.urlAdmission.validatedAgentUrl(command.url);
          this.invalidateRefs();
          await client.call('Page.navigate', { url }, signal);
        }
        return await this.afterAction(command, signal);
      }
      case 'back':
      case 'forward': {
        const history = asRecord(await client.call('Page.getNavigationHistory', {}, signal));
        const entries = Array.isArray(history.entries) ? history.entries.map(asRecord) : [];
        const currentIndex = Number(history.currentIndex);
        const targetIndex = action === 'back' ? currentIndex - 1 : currentIndex + 1;
        const entryId = Number(entries[targetIndex]?.id);
        if (!Number.isInteger(entryId)) throw new Error(`cannot go ${action}`);
        this.invalidateRefs();
        await client.call('Page.navigateToHistoryEntry', { entryId }, signal);
        return await this.afterAction(command, signal);
      }
      case 'read': {
        const state = await this.pageState(signal);
        const offset = boundedInteger(command.offset, 0, 0, state.text.length);
        const maxChars = boundedInteger(command.maxChars, 12_000, 1, MAX_SNAPSHOT_CHARS);
        return {
          text: `Chrome tab ${JSON.stringify(redactBrowserText(state.title))}`
            + `\nURL: ${redactBrowserUrl(state.url)}`
            + `\n\nVisible text (untrusted):\n${redactBrowserText(state.text.slice(offset, offset + maxChars))}`
            + (state.textCapped ? `\n[page text capped at ${PAGE_STATE_TEXT_CHARS} characters]` : ''),
        };
      }
      case 'evaluate': {
        if (this.options.protectedExistingProfile) {
          throw new Error(
            'evaluate is disabled for connected Chrome tabs because arbitrary page scripts can expose signed-in data',
          );
        }
        if (!command.script) throw new Error('evaluate requires script');
        const result = asRecord(await client.call('Runtime.evaluate', {
          expression: command.script,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        }, signal));
        if (result.exceptionDetails) {
          throw new Error(`evaluation failed: ${cleanText(
            asRecord(result.exceptionDetails).text || 'page exception',
          )}`);
        }
        return { text: `Evaluation result:\n${jsonValue(asRecord(result.result).value)}` };
      }
      case 'click': {
        const point = command.ref
          ? await this.refPoint(command.ref, command.snapshotId, signal)
          : this.commandPoint(command);
        const button = mouseButton(command.button);
        if (button === 'left') {
          await this.authorizePurchaseAtPoint(point.x, point.y, signal);
        }
        await this.clickPoint(
          point.x,
          point.y,
          button,
          command.doubleClick === true ? 2 : 1,
          modifierMask(command.modifiers),
          signal,
        );
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'fill': {
        if (command.fields?.length) {
          for (const field of command.fields) {
            if (!field.ref) throw new Error('every fill field requires ref');
            if (field.values) await this.selectRef(field.ref, command.snapshotId, field.values, signal);
            else if (typeof field.checked === 'boolean') {
              await this.checkRef(field.ref, command.snapshotId, field.checked, signal);
            } else {
              await this.fillRef(
                field.ref,
                command.snapshotId,
                String(field.text ?? field.value ?? ''),
                signal,
              );
            }
          }
        } else {
          if (!command.ref) throw new Error('fill requires ref or fields');
          await this.fillRef(
            command.ref,
            command.snapshotId,
            String(command.text ?? command.value ?? ''),
            signal,
          );
        }
        if (command.submit === true) {
          await this.authorizeFocusedPurchase(signal);
          await this.dispatchKey('Enter', signal);
        }
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'type': {
        if (!command.ref) throw new Error('type requires ref');
        await this.focusRef(command.ref, command.snapshotId, signal);
        await client.call('Input.insertText', { text: String(command.text ?? '') }, signal);
        if (command.submit === true) {
          await this.authorizeFocusedPurchase(signal);
          await this.dispatchKey('Enter', signal);
        }
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'select': {
        if (!command.ref) throw new Error('select requires ref');
        const values = command.values || (command.value === undefined ? [] : [command.value]);
        if (!values.length) throw new Error('select requires value or values');
        await this.selectRef(command.ref, command.snapshotId, values, signal);
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'check': {
        if (!command.ref) throw new Error('check requires ref');
        await this.checkRef(command.ref, command.snapshotId, command.checked !== false, signal);
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'hover': {
        const point = command.ref
          ? await this.refPoint(command.ref, command.snapshotId, signal)
          : this.commandPoint(command);
        await client.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          modifiers: modifierMask(command.modifiers),
        }, signal);
        return await this.afterAction(command, signal);
      }
      case 'drag': {
        const start = command.ref
          ? await this.refPoint(command.ref, command.snapshotId, signal)
          : this.commandPoint(command);
        const end = command.targetRef
          ? await this.refPoint(command.targetRef, command.snapshotId, signal)
          : {
              x: Number(command.targetX),
              y: Number(command.targetY),
            };
        if (!Number.isFinite(end.x) || !Number.isFinite(end.y)) {
          throw new Error('drag requires targetRef or targetX/targetY');
        }
        await client.call('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1,
        }, signal);
        await client.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: end.x, y: end.y, button: 'left',
        }, signal);
        await client.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1,
        }, signal);
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'press': {
        if (!command.key) throw new Error('press requires key');
        assertBrowserKeyDoesNotAccessClipboard(command.key);
        if (/^(?:enter|return|space| )$/i.test(command.key.trim())) {
          await this.authorizeFocusedPurchase(signal);
        }
        await this.dispatchKey(command.key, signal);
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'scroll': {
        if (command.ref) {
          await this.callOnRef(
            command.ref,
            command.snapshotId,
            `function () { this.scrollIntoView({ block: 'center', inline: 'center' }); return true; }`,
            signal,
          );
        } else {
          await client.call('Runtime.evaluate', {
            expression: `window.scrollBy(${Number(command.dx) || 0}, ${Number(command.dy) || 0})`,
            returnByValue: true,
          }, signal);
        }
        this.invalidateRefs();
        return await this.afterAction(command, signal);
      }
      case 'wait': {
        await this.waitForState({
          text: cleanText(command.text, 2_000),
          textGone: cleanText(command.textGone, 2_000),
          url: '',
          timeoutMs: boundedInteger(command.timeoutMs, DEFAULT_WAIT_MS, 500, MAX_WAIT_MS),
        }, signal);
        return await this.snapshot(command, signal);
      }
      case 'handle_dialog': {
        if (!this.pendingDialog) throw new Error('there is no pending JavaScript dialog');
        await client.call('Page.handleJavaScriptDialog', {
          accept: command.accept !== false,
          ...(command.promptText === undefined ? {} : { promptText: command.promptText }),
        }, signal);
        this.pendingDialog = null;
        return await this.afterAction(command, signal);
      }
      case 'performance': {
        if (String(command.operation || 'metrics').toLowerCase() !== 'metrics') {
          throw new Error('external Chrome supports performance operation=metrics only');
        }
        await client.call('Performance.enable', {}, signal);
        const metrics = asRecord(await client.call('Performance.getMetrics', {}, signal));
        const rows = (Array.isArray(metrics.metrics) ? metrics.metrics : [])
          .map(asRecord)
          .map((metric) => `${cleanText(metric.name, 100)}=${String(metric.value)}`);
        return { text: `Chrome performance metrics:\n${rows.join('\n')}` };
      }
      case 'cookies':
      case 'storage':
        throw new Error(
          `${action} is unavailable for a connected Chrome profile; Browser Use never exports profile secrets`,
        );
      case 'upload':
        throw new Error('upload is unavailable for a connected Chrome profile; use the in-app browser');
      case 'close_tab':
      case 'downloads':
        throw new Error(`${action} is unavailable because the connection is limited to one selected Chrome tab`);
      case 'locate':
      case 'emulate':
      case 'console':
      case 'network':
        throw new Error(`${action} is not available for a connected Chrome tab`);
      default:
        throw new Error(`unknown browser action "${action}"`);
    }
  }

  private async ensureBrowserClient(signal?: AbortSignal): Promise<CdpSocket> {
    if (this.client) return this.client;
    const endpoints = await this.browserEndpointCandidates();
    if (!endpoints.length) {
      throw new Error(
        `Could not find Chrome's protected DevTools endpoint. Open ${CHROME_REMOTE_DEBUGGING_URL}`
        + ' in Chrome 144 or newer, enable remote debugging, then retry.',
      );
    }
    let lastError: unknown;
    for (const endpoint of endpoints) {
      let client: CdpSocket | null = null;
      try {
        const parsedEndpoint = new URL(endpoint);
        if (parsedEndpoint.protocol !== 'ws:' || !loopbackHostname(parsedEndpoint.hostname)) {
          throw new Error('Chrome WebSocket endpoint must be a loopback ws:// address');
        }
        client = await CdpSocket.open(
          parsedEndpoint.href,
          (method, params, sessionId) => this.receiveEvent(method, params, sessionId),
          () => {
            if (this.client !== client) return;
            this.client = null;
            this.connected = null;
            this.targetSessionId = '';
            this.availableTargets.clear();
            this.refs.clear();
            this.pendingDialog = null;
          },
          signal,
        );
        this.client = client;
        return client;
      } catch (error) {
        lastError = error;
        client?.close();
      }
    }
    throw new Error(
      'Chrome did not approve the protected remote-debugging connection. '
      + `Enable it at ${CHROME_REMOTE_DEBUGGING_URL}, accept Chrome's connection dialog, then retry.`
      + (lastError ? ` (${messageFor(lastError)})` : ''),
    );
  }

  private async browserEndpointCandidates(): Promise<string[]> {
    if (this.options.browserWSEndpoint) return [this.options.browserWSEndpoint];
    const endpoints: string[] = [];
    for (const directory of this.chromeUserDataDirectories()) {
      let content: string;
      try {
        content = await readFile(join(directory, 'DevToolsActivePort'), 'utf8');
      } catch {
        continue;
      }
      const [rawPort, rawPath] = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
      if (!rawPath?.startsWith('/devtools/browser/')) continue;
      endpoints.push(`ws://127.0.0.1:${port}${rawPath}`);
    }
    if (this.options.browserWSEndpointProvider) {
      const endpoint = await this.options.browserWSEndpointProvider();
      endpoints.push(endpoint);
    }
    return [...new Set(endpoints)];
  }

  private chromeUserDataDirectories(): string[] {
    if (this.options.userDataDirectories?.length) {
      return [...this.options.userDataDirectories];
    }
    const home = homedir();
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
      return [
        join(local, 'Google', 'Chrome', 'User Data'),
        join(local, 'Google', 'Chrome Beta', 'User Data'),
        join(local, 'Google', 'Chrome Dev', 'User Data'),
        join(local, 'Google', 'Chrome SxS', 'User Data'),
      ];
    }
    if (process.platform === 'darwin') {
      const applicationSupport = join(home, 'Library', 'Application Support', 'Google');
      return [
        join(applicationSupport, 'Chrome'),
        join(applicationSupport, 'Chrome Beta'),
        join(applicationSupport, 'Chrome Dev'),
        join(applicationSupport, 'Chrome Canary'),
      ];
    }
    const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
    return [
      join(config, 'google-chrome'),
      join(config, 'google-chrome-beta'),
      join(config, 'google-chrome-unstable'),
    ];
  }

  private async readTargets(
    client: CdpSocket,
    signal?: AbortSignal,
  ): Promise<ConnectedTarget[]> {
    const result = asRecord(await client.call('Target.getTargets', {}, signal));
    const targets: ConnectedTarget[] = [];
    for (const value of Array.isArray(result.targetInfos) ? result.targetInfos : []) {
      const record = asRecord(value);
      if (record.type !== 'page') continue;
      const id = cleanText(record.targetId, 300);
      const title = cleanText(record.title, 500) || 'Untitled tab';
      const url = cleanText(record.url, 4_000);
      if (!id || !url || /^(?:about|chrome|chrome-extension|devtools|edge):/i.test(url)) continue;
      try {
        normalizePageUrl(url, this.options.urlPolicy || {});
      } catch {
        continue;
      }
      targets.push({
        admissionUrl: url,
        target: {
          id,
          title: redactBrowserText(title),
          url: redactBrowserUrl(url),
          type: 'page',
        },
      });
    }
    return targets;
  }

  private requiredClient(): CdpSocket {
    if (!this.client || !this.connected) {
      throw new Error('No Chrome tab is connected. Select one in the Browser Use pane first.');
    }
    return this.client;
  }

  private assertExactTarget(command: ChromeBrowserCommand): void {
    if (!this.isConnected()) return;
    if (command.background === true) {
      throw new Error('background pages are disabled for an exact Chrome tab connection');
    }
    const tab = String(command.tab || '').trim();
    if (tab && tab !== 'v1' && tab !== this.connected?.target.id) {
      throw new Error('the connected Chrome capability cannot switch to another tab');
    }
  }

  private connectedSummary(): string {
    if (!this.connected) return 'No Chrome tab is connected.';
    return `Connected Chrome tab: ${JSON.stringify(redactBrowserText(this.connected.target.title))}`
      + `\nURL: ${redactBrowserUrl(this.connected.target.url)}`;
  }

  private connectedTabs(): string {
    if (!this.connected) return 'No Chrome tab is connected.';
    return 'Chrome tabs (exact user-selected capability):'
      + `\n- v1 ${JSON.stringify(redactBrowserText(this.connected.target.title))} `
      + `${redactBrowserUrl(this.connected.target.url)} [selected]`;
  }

  private receiveEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): void {
    if (this.connected && sessionId && sessionId !== this.targetSessionId) return;
    if (method === 'Fetch.requestPaused') {
      void this.handlePausedRequest(params);
    } else if (method === 'Page.javascriptDialogOpening') {
      this.pendingDialog = {
        type: cleanText(params.type, 80) || 'alert',
        message: cleanText(params.message, 2_000),
      };
    } else if (method === 'Page.javascriptDialogClosed') {
      this.pendingDialog = null;
    } else if (method === 'Page.frameNavigated' || method === 'Runtime.executionContextsCleared') {
      this.invalidateRefs();
    }
  }

  private async handlePausedRequest(params: Record<string, unknown>): Promise<void> {
    const requestId = cleanText(params.requestId, 300);
    const request = asRecord(params.request);
    const url = cleanText(request.url, 8_000);
    if (!requestId || !url) return;
    const client = this.client;
    if (!client) return;
    try {
      await this.urlAdmission.assertResolvedUrlAllowed(url, true);
      await client.call('Fetch.continueRequest', { requestId });
    } catch {
      await client.call('Fetch.failRequest', {
        requestId,
        errorReason: 'BlockedByClient',
      }).catch(() => undefined);
    }
  }

  private invalidateRefs(): void {
    this.refs.clear();
  }

  private async pageState(signal?: AbortSignal): Promise<PageState> {
    const result = asRecord(await this.requiredClient().call('Runtime.evaluate', {
      expression: `(() => {
        const text = document.body?.innerText || document.documentElement?.innerText || '';
        return {
          title: document.title || '',
          url: location.href,
          text: text.slice(0, ${PAGE_STATE_TEXT_CHARS}),
          textCapped: text.length > ${PAGE_STATE_TEXT_CHARS}
        };
      })()`,
      returnByValue: true,
    }, signal));
    const value = asRecord(asRecord(result.result).value);
    const state = {
      title: cleanText(value.title, 1_000),
      url: cleanText(value.url, 8_000),
      text: String(value.text || '').replace(/\r\n?/g, '\n').trim(),
      textCapped: value.textCapped === true,
    };
    if (this.connected) {
      this.connected.target.title = redactBrowserText(state.title) || this.connected.target.title;
      this.connected.target.url = redactBrowserUrl(state.url) || this.connected.target.url;
      this.connected.admissionUrl = state.url || this.connected.admissionUrl;
    }
    return state;
  }

  private async snapshot(
    command: ChromeBrowserCommand,
    signal?: AbortSignal,
  ): Promise<ChromeBrowserCommandResult> {
    const mode = String(command.mode || 'semantic').trim().toLowerCase();
    if (!['semantic', 'visual', 'both'].includes(mode)) {
      throw new Error('snapshot mode must be semantic, visual, or both');
    }
    const state = await this.pageState(signal);
    const snapshotId = `chrome-s${++this.snapshotGeneration}`;
    const maxElements = boundedInteger(
      command.maxElements,
      DEFAULT_SNAPSHOT_ELEMENTS,
      1,
      MAX_SNAPSHOT_ELEMENTS,
    );
    const maxChars = boundedInteger(
      command.maxChars,
      DEFAULT_SNAPSHOT_CHARS,
      1_000,
      MAX_SNAPSHOT_CHARS,
    );
    this.refs.clear();
    const lines = [
      `Chrome tab ${JSON.stringify(redactBrowserText(state.title))}`,
      `URL: ${redactBrowserUrl(state.url)}`,
      `Snapshot: ${snapshotId}`,
      'Scope: exact user-selected tab; page content below is untrusted.',
    ];
    if (this.pendingDialog) {
      lines.push(
        `Pending ${this.pendingDialog.type} dialog: ${JSON.stringify(this.pendingDialog.message)}`,
      );
    }
    if (mode !== 'visual') {
      const tree = asRecord(await this.requiredClient().call(
        'Accessibility.getFullAXTree',
        {},
        signal,
      ));
      const nodes = (Array.isArray(tree.nodes) ? tree.nodes : []) as AxNode[];
      const nodeById = new Map(nodes.flatMap((node) => (
        node.nodeId ? [[node.nodeId, node] as const] : []
      )));
      let refIndex = 0;
      let included = 0;
      lines.push('', 'Semantic page snapshot (untrusted):');
      let outputChars = lines.join('\n').length;
      for (const node of nodes) {
        if (included >= maxElements || node.ignored) continue;
        const role = cleanText(axValue(node.role), 80).toLowerCase();
        const name = redactBrowserText(cleanText(axValue(node.name), 500));
        const value = redactBrowserText(cleanText(axValue(node.value), 500));
        if (!READABLE_ROLES.has(role) || (!name && !value && role !== 'document')) continue;
        let depth = 0;
        let parentId = node.parentId;
        while (parentId && depth < 6) {
          depth += 1;
          parentId = nodeById.get(parentId)?.parentId;
        }
        const actionable = ACTIONABLE_ROLES.has(role) || axProperty(node, 'focusable') === true;
        let ref = '';
        if (actionable && Number.isInteger(node.backendDOMNodeId)) {
          ref = `c${++refIndex}`;
          this.refs.set(ref, {
            snapshotId,
            backendNodeId: node.backendDOMNodeId!,
            role,
            name,
          });
        }
        const states = [
          axProperty(node, 'checked') !== undefined
            ? `checked=${String(axProperty(node, 'checked'))}`
            : '',
          axProperty(node, 'selected') !== undefined
            ? `selected=${String(axProperty(node, 'selected'))}`
            : '',
          axProperty(node, 'expanded') !== undefined
            ? `expanded=${String(axProperty(node, 'expanded'))}`
            : '',
          axProperty(node, 'disabled') === true ? 'disabled=true' : '',
        ].filter(Boolean);
        const row = (
          `${'  '.repeat(depth)}- ${role || 'node'}`
          + `${name ? ` ${JSON.stringify(name)}` : ''}`
          + `${value && value !== name ? ` value=${JSON.stringify(value)}` : ''}`
          + `${states.length ? ` ${states.join(' ')}` : ''}`
          + `${ref ? ` [ref=${ref}]` : ''}`
        );
        if (outputChars + row.length + 1 >= maxChars) {
          lines.push('… snapshot text limit reached');
          break;
        }
        lines.push(row);
        outputChars += row.length + 1;
        included += 1;
      }
      if (included === 0 && state.text) {
        lines.push(redactBrowserText(state.text.slice(0, maxChars)));
      }
      if (state.textCapped) {
        lines.push(`[page text capped at ${PAGE_STATE_TEXT_CHARS} characters]`);
      }
    }
    const result: ChromeBrowserCommandResult = { text: lines.join('\n').slice(0, maxChars) };
    if (mode === 'visual' || mode === 'both' || command.includeScreenshot === true) {
      result.image = await this.screenshot(command, signal);
    }
    return result;
  }

  private async screenshot(
    command: ChromeBrowserCommand,
    signal?: AbortSignal,
  ): Promise<{ mimeType: string; data: string }> {
    const requested = String(command.format || 'png').toLowerCase();
    const format = requested === 'jpeg' || requested === 'webp' ? requested : 'png';
    if (command.fullPage === true) {
      const metrics = asRecord(await this.requiredClient().call(
        'Page.getLayoutMetrics',
        {},
        signal,
      ));
      const rect = boundedFullPageRect(
        asRecord(metrics.cssContentSize || metrics.contentSize),
      );
      const scaleResult = asRecord(await this.requiredClient().call('Runtime.evaluate', {
        expression: 'window.devicePixelRatio || 1',
        returnByValue: true,
      }, signal));
      const scale = Number(asRecord(scaleResult.result).value);
      assertFullPageOutputBounds(rect, Number.isFinite(scale) && scale > 0 ? scale : 1);
    }
    const response = asRecord(await this.requiredClient().call('Page.captureScreenshot', {
      format,
      fromSurface: true,
      captureBeyondViewport: command.fullPage === true,
      ...(format === 'png'
        ? {}
        : { quality: boundedInteger(command.quality, 80, 0, 100) }),
    }, signal));
    const data = String(response.data || '');
    if (!data) throw new Error('Chrome returned an empty screenshot');
    return { mimeType: `image/${format}`, data };
  }

  private commandPoint(command: ChromeBrowserCommand): { x: number; y: number } {
    const x = Number(command.x);
    const y = Number(command.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('browser action requires ref or x/y coordinates');
    }
    return { x, y };
  }

  private requiredRef(ref: string, snapshotId?: string): RefEntry {
    const entry = this.refs.get(String(ref || '').trim());
    if (!entry) throw new Error(`stale or unknown Chrome ref "${String(ref || '')}"; take a fresh snapshot`);
    if (snapshotId && snapshotId !== entry.snapshotId) {
      throw new Error(`Chrome ref belongs to ${entry.snapshotId}, not ${snapshotId}; take a fresh snapshot`);
    }
    return entry;
  }

  private async callOnRef(
    ref: string,
    snapshotId: string | undefined,
    functionDeclaration: string,
    signal?: AbortSignal,
    args: unknown[] = [],
  ): Promise<unknown> {
    const entry = this.requiredRef(ref, snapshotId);
    const resolved = asRecord(await this.requiredClient().call('DOM.resolveNode', {
      backendNodeId: entry.backendNodeId,
      objectGroup: 'mixdog-chrome-ref',
    }, signal));
    const objectId = String(asRecord(resolved.object).objectId || '');
    if (!objectId) throw new Error(`Chrome ref "${ref}" no longer resolves; take a fresh snapshot`);
    try {
      const result = asRecord(await this.requiredClient().call('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, signal));
      if (result.exceptionDetails) {
        throw new Error(cleanText(asRecord(result.exceptionDetails).text || 'page exception'));
      }
      return asRecord(result.result).value;
    } finally {
      await this.requiredClient().call('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  private async refPoint(
    ref: string,
    snapshotId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const value = asRecord(await this.callOnRef(
      ref,
      snapshotId,
      `function () {
        const rect = this.getBoundingClientRect();
        if (!this.isConnected || rect.width <= 0 || rect.height <= 0) return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      }`,
      signal,
    ));
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Chrome ref "${ref}" is not visible; take a fresh snapshot`);
    }
    return { x, y };
  }

  private async authorizePurchaseAtPoint(
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.authorizePurchaseTarget(
      `document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)})`,
      signal,
      { kind: 'pointer', x, y },
    );
  }

  private async authorizeFocusedPurchase(signal?: AbortSignal): Promise<void> {
    await this.authorizePurchaseTarget(`(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.form) {
        return active.form.querySelector(
          'button[type="submit"],input[type="submit"],button:not([type])',
        ) || active;
      }
      return active;
    })()`, signal, { kind: 'keyboard' });
  }

  private async authorizePurchaseTarget(
    targetExpression: string,
    signal?: AbortSignal,
    permit?: { kind: 'pointer'; x: number; y: number } | { kind: 'keyboard' },
  ): Promise<void> {
    if (!this.options.protectedExistingProfile) return;
    const result = asRecord(await this.requiredClient().call('Runtime.evaluate', {
      expression: `(() => {
        const source = ${targetExpression};
        const target = source?.closest?.('button,input,a,[role="button"]') || source;
        if (!(target instanceof Element)) return null;
        const form = target.closest('form');
        const summaryRoot = form
          || target.closest('[role="dialog"],main,[data-checkout],section')
          || document.body;
        const label = target.getAttribute('aria-label')
          || target.getAttribute('title')
          || (target instanceof HTMLInputElement ? target.value : target.innerText)
          || '';
        return {
          tag: target.tagName.toLowerCase(),
          role: target.getAttribute('role') || '',
          type: target.getAttribute('type') || '',
          label,
          href: target instanceof HTMLAnchorElement ? target.href : '',
          formAction: form?.action || '',
          pageTitle: document.title || '',
          pageUrl: location.href,
          summary: summaryRoot?.innerText || ''
        };
      })()`,
      returnByValue: true,
    }, signal));
    const raw = asRecord(asRecord(result.result).value);
    const descriptor: PurchaseTargetDescriptor = {
      tag: cleanText(raw.tag, 30),
      role: cleanText(raw.role, 50),
      type: cleanText(raw.type, 50),
      label: cleanText(raw.label, 500),
      href: cleanText(raw.href, 2_000),
      formAction: cleanText(raw.formAction, 2_000),
      pageTitle: cleanText(raw.pageTitle, 500),
      pageUrl: cleanText(raw.pageUrl, 8_000),
      summary: cleanText(raw.summary, 4_000),
    };
    if (!isFinalPurchaseTarget(descriptor)) return;
    if (!this.options.onPurchaseApproval) {
      throw new Error('Final order or payment submission is blocked without one-time user approval');
    }
    let merchant = descriptor.pageTitle || descriptor.pageUrl;
    try {
      merchant = new URL(descriptor.pageUrl).host || merchant;
    } catch {
      // Keep the page title or raw URL for the approval dialog.
    }
    const approved = await this.options.onPurchaseApproval({
      merchant,
      url: descriptor.pageUrl,
      actionLabel: descriptor.label || 'Order or payment submission',
      pageSummary: descriptor.summary,
    });
    if (!approved) {
      throw new Error('User cancelled the final order or payment action');
    }
    if (permit) {
      await this.requiredClient().call('Mixdog.authorizePurchase', permit, signal);
    }
  }

  private async clickPoint(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    clickCount: number,
    modifiers: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.requiredClient();
    await client.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, modifiers,
    }, signal);
    await client.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount, modifiers,
    }, signal);
    await client.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount, modifiers,
    }, signal);
  }

  private async focusRef(
    ref: string,
    snapshotId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.requiredRef(ref, snapshotId);
    await this.requiredClient().call('DOM.focus', {
      backendNodeId: entry.backendNodeId,
    }, signal);
  }

  private async fillRef(
    ref: string,
    snapshotId: string | undefined,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.focusRef(ref, snapshotId, signal);
    await this.dispatchKey('Control+A', signal);
    await this.dispatchKey('Backspace', signal);
    if (text) await this.requiredClient().call('Input.insertText', { text }, signal);
  }

  private async selectRef(
    ref: string,
    snapshotId: string | undefined,
    values: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const selected = await this.callOnRef(
      ref,
      snapshotId,
      `function (requested) {
        if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: 'not a select' };
        const wanted = new Set(requested.map(String));
        let matched = 0;
        for (const option of this.options) {
          option.selected = wanted.has(option.value) || wanted.has(option.text);
          if (option.selected) matched += 1;
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: matched > 0, matched };
      }`,
      signal,
      [values],
    );
    if (asRecord(selected).ok !== true) {
      throw new Error(`Chrome ref "${ref}" did not match a selectable option`);
    }
  }

  private async checkRef(
    ref: string,
    snapshotId: string | undefined,
    desired: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const checked = await this.callOnRef(
      ref,
      snapshotId,
      `function () {
        if (!('checked' in this)) return null;
        return Boolean(this.checked);
      }`,
      signal,
    );
    if (typeof checked !== 'boolean') throw new Error(`Chrome ref "${ref}" is not checkable`);
    if (checked === desired) return;
    const point = await this.refPoint(ref, snapshotId, signal);
    await this.clickPoint(point.x, point.y, 'left', 1, 0, signal);
  }

  private async dispatchKey(keySpec: string, signal?: AbortSignal): Promise<void> {
    const parts = String(keySpec || '').split('+').map((value) => value.trim()).filter(Boolean);
    if (!parts.length) throw new Error('key is required');
    const keyName = parts.pop()!;
    const modifiers = modifierMask(parts);
    const upper = keyName.toUpperCase();
    const info = KEY_INFO[upper] || (
      keyName.length === 1
        ? {
            key: modifiers & 8 ? keyName.toUpperCase() : keyName,
            code: `Key${keyName.toUpperCase()}`,
            vk: keyName.toUpperCase().charCodeAt(0),
          }
        : { key: keyName, code: keyName, vk: 0 }
    );
    const client = this.requiredClient();
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers,
      ...(keyName.length === 1 && modifiers === 0 ? { text: info.key } : {}),
    }, signal);
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers,
    }, signal);
  }

  private async afterAction(
    command: ChromeBrowserCommand,
    signal?: AbortSignal,
  ): Promise<ChromeBrowserCommandResult> {
    if (command.expect) {
      await this.waitForState({
        text: cleanText(command.expect.text, 2_000),
        textGone: cleanText(command.expect.textGone, 2_000),
        url: cleanText(command.expect.url, 4_000),
        timeoutMs: boundedInteger(command.expect.timeoutMs, 5_000, 500, 20_000),
      }, signal);
    }
    const settleMs = boundedInteger(command.settleMs, 250, 0, 5_000);
    if (settleMs) await pause(settleMs, signal);
    return await this.snapshot(command, signal);
  }

  private async waitForState(
    expected: { text: string; textGone: string; url: string; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!expected.text && !expected.textGone && !expected.url) {
      await pause(Math.min(expected.timeoutMs, 1_000), signal);
      return;
    }
    const deadline = Date.now() + expected.timeoutMs;
    for (;;) {
      const state = await this.pageState(signal);
      const text = state.text.toLowerCase();
      const url = state.url.toLowerCase();
      const matches = (!expected.text || text.includes(expected.text.toLowerCase()))
        && (!expected.textGone || !text.includes(expected.textGone.toLowerCase()))
        && (!expected.url || url.includes(expected.url.toLowerCase()));
      if (matches) return;
      if (Date.now() >= deadline) {
        throw new Error(
          'Chrome postcondition timed out: '
          + [
            expected.text && `text ${JSON.stringify(expected.text)}`,
            expected.textGone && `textGone ${JSON.stringify(expected.textGone)}`,
            expected.url && `url ${JSON.stringify(expected.url)}`,
          ].filter(Boolean).join(' and '),
        );
      }
      await pause(100, signal);
    }
  }
}

export function createChromeCdpBrowser(
  options?: ChromeCdpBrowserOptions | string,
): ChromeCdpBrowser {
  return new ChromeCdpBrowser(
    typeof options === 'string' ? { browserWSEndpoint: options } : options,
  );
}

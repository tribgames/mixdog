import {
  consumePurchasePermit,
  createPurchasePermit,
  isFinalPurchaseTarget,
} from './purchase-policy.js';

const RELAY_PORT = 18795;
const GROUP_TITLE = 'Mixdog';
const DEBUGGER_VERSION = '1.3';
const RECONNECT_MS = 2000;

let relaySocket = null;
let reconnectTimer = null;
const attachedTabs = new Set();
const purchasePermits = new Map();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function targetTabId(targetId) {
  const match = /^tab:(\d+)$/.exec(String(targetId || ''));
  if (!match) throw new Error('Invalid Mixdog tab target');
  return Number(match[1]);
}

function supportedUrl(url) {
  return /^https?:/i.test(String(url || ''));
}

async function isAllowedTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  if (!tab || !supportedUrl(tab.url) || tab.incognito || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title === GROUP_TITLE;
  } catch {
    return false;
  }
}

async function ensureAllowedTab(tabId) {
  if (!await isAllowedTab(tabId)) {
    await detachTab(tabId);
    throw new Error('This tab is outside the Mixdog tab group or is no longer allowed');
  }
  return await chrome.tabs.get(tabId);
}

async function attachTab(tabId) {
  await ensureAllowedTab(tabId);
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    attachedTabs.add(tabId);
  } catch (error) {
    if (!/already attached/i.test(errorMessage(error))) throw error;
    throw new Error('Chrome DevTools or another extension is already attached to this tab');
  }
}

async function detachTab(tabId) {
  purchasePermits.delete(tabId);
  if (!attachedTabs.delete(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Chrome may already have detached a closed or revoked tab.
  }
}

async function allowTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !supportedUrl(tab.url) || tab.incognito) {
    throw new Error('Only regular http or https tabs can be connected');
  }
  let groupId = tab.groupId;
  if (groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group.title !== GROUP_TITLE) groupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
    } catch {
      groupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
    }
  }
  if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  }
  await chrome.tabGroups.update(groupId, {
    title: GROUP_TITLE,
    color: 'purple',
    collapsed: false,
  });
}

async function disallowTab(tabId) {
  await detachTab(tabId);
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // The tab may have closed while the popup was open.
  }
}

async function listTargets() {
  const tabs = await chrome.tabs.query({});
  const allowed = [];
  for (const tab of tabs) {
    if (!tab.id || !await isAllowedTab(tab.id)) continue;
    allowed.push({
      targetId: `tab:${tab.id}`,
      type: 'page',
      title: tab.title || 'Untitled tab',
      url: tab.url || '',
      attached: attachedTabs.has(tab.id),
    });
  }
  return { targetInfos: allowed };
}

async function describePurchaseTarget(tabId, kind, params) {
  const pointExpression = kind === 'pointer'
    ? `document.elementFromPoint(${Number(params.x)}, ${Number(params.y)})`
    : `(() => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.form) {
          return active.form.querySelector(
            'button[type="submit"],input[type="submit"],button:not([type])'
          ) || active;
        }
        return active;
      })()`;
  const evaluation = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    {
      expression: `(() => {
        const source = ${pointExpression};
        const target = source?.closest?.('button,input,a,[role="button"]') || source;
        if (!(target instanceof Element)) return null;
        const form = target.closest('form');
        return {
          tag: target.tagName.toLowerCase(),
          role: target.getAttribute('role') || '',
          type: target.getAttribute('type') || '',
          label: target.getAttribute('aria-label')
            || target.getAttribute('title')
            || (target instanceof HTMLInputElement ? target.value : target.innerText)
            || '',
          href: target instanceof HTMLAnchorElement ? target.href : '',
          formAction: form?.action || ''
        };
      })()`,
      returnByValue: true,
    },
  );
  return evaluation?.result?.value || null;
}

function setPurchasePermit(tabId, permit) {
  purchasePermits.set(tabId, createPurchasePermit(permit));
}

async function guardPurchaseInput(tabId, method, params) {
  let kind = null;
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && params.button === 'left') {
    kind = 'pointer';
  }
  if (
    method === 'Input.dispatchKeyEvent'
    && params.type === 'keyDown'
    && /^(?:Enter|Return|Space| )$/i.test(String(params.key || ''))
  ) {
    kind = 'keyboard';
  }
  if (!kind) return;
  const authorized = consumePurchasePermit(purchasePermits, tabId, kind, params);
  const target = await describePurchaseTarget(tabId, kind, params);
  if (!isFinalPurchaseTarget(target)) return;
  if (!authorized) {
    throw new Error('Final order or payment submission requires a fresh Mixdog approval');
  }
}

async function executeRequest(message) {
  if (message.action === 'listTargets') return await listTargets();
  const tabId = targetTabId(message.targetId);
  if (message.action === 'attachTarget') {
    await attachTab(tabId);
    return {};
  }
  if (message.action === 'detachTarget') {
    await detachTab(tabId);
    return {};
  }
  if (message.action !== 'cdp') throw new Error('Unsupported relay action');
  await ensureAllowedTab(tabId);
  await attachTab(tabId);
  const method = String(message.method || '');
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (/^(?:Network|Storage)\.(?:getAllCookies|getCookies|setCookie|setCookies|clearDataForOrigin)$/i.test(method)) {
    throw new Error('Cookie and profile storage export is disabled for connected Chrome tabs');
  }
  if (method === 'Mixdog.authorizePurchase') {
    setPurchasePermit(tabId, params);
    return {};
  }
  await guardPurchaseInput(tabId, method, params);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

async function handleRelayMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === 'ping') {
    relaySocket?.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    return;
  }
  if (message.type !== 'request' || !message.requestId) return;
  try {
    const result = await executeRequest(message);
    relaySocket?.send(JSON.stringify({
      type: 'response',
      requestId: message.requestId,
      result,
    }));
  } catch (error) {
    relaySocket?.send(JSON.stringify({
      type: 'response',
      requestId: message.requestId,
      error: errorMessage(error),
    }));
  }
}

async function connectRelay() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const { pairingToken = '' } = await chrome.storage.local.get('pairingToken');
  if (!/^[a-f0-9]{64}$/i.test(pairingToken)) {
    await chrome.action.setBadgeText({ text: '?' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    return;
  }
  relaySocket?.close();
  const socket = new WebSocket(
    `ws://127.0.0.1:${RELAY_PORT}/extension?token=${encodeURIComponent(pairingToken)}`,
  );
  relaySocket = socket;
  socket.addEventListener('open', async () => {
    await chrome.action.setBadgeText({ text: 'M' });
    await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  });
  socket.addEventListener('message', (event) => {
    void handleRelayMessage(event);
  });
  socket.addEventListener('close', async () => {
    if (relaySocket !== socket) return;
    relaySocket = null;
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    reconnectTimer = setTimeout(() => {
      void connectRelay();
    }, RECONNECT_MS);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.action === 'savePairing') {
      const pairingToken = String(message.pairingToken || '').trim();
      if (!/^[a-f0-9]{64}$/i.test(pairingToken)) throw new Error('Pairing token must be 64 hexadecimal characters');
      await chrome.storage.local.set({ pairingToken });
      await connectRelay();
    }
    if (message?.action === 'allowCurrent' || message?.action === 'disallowCurrent') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active Chrome tab');
      if (message.action === 'allowCurrent') await allowTab(tab.id);
      else await disallowTab(tab.id);
    }
    if (message?.action === 'state') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const { pairingToken = '' } = await chrome.storage.local.get('pairingToken');
      sendResponse({
        paired: /^[a-f0-9]{64}$/i.test(pairingToken),
        connected: relaySocket?.readyState === WebSocket.OPEN,
        allowed: tab?.id ? await isAllowedTab(tab.id) : false,
        supported: Boolean(tab && supportedUrl(tab.url) && !tab.incognito),
      });
      return;
    }
    sendResponse({ ok: true });
  })().catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !attachedTabs.has(source.tabId) || relaySocket?.readyState !== WebSocket.OPEN) return;
  void (async () => {
    if (!await isAllowedTab(source.tabId)) {
      await detachTab(source.tabId);
      return;
    }
    relaySocket?.send(JSON.stringify({
      type: 'event',
      targetId: `tab:${source.tabId}`,
      method,
      params,
    }));
  })();
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    purchasePermits.delete(source.tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ('groupId' in changeInfo && attachedTabs.has(tabId)) {
    void isAllowedTab(tabId).then((allowed) => {
      if (!allowed) return detachTab(tabId);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  purchasePermits.delete(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  void connectRelay();
});

chrome.runtime.onInstalled.addListener(() => {
  void connectRelay();
});

void connectRelay();

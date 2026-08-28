import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { createChromeCdpBrowser, isFinalPurchaseTarget } from './browser-chrome-cdp';

async function createFakeChrome(options = {}) {
  const calls = [];
  let pageUrl = 'https://accounts.example.test/profile';
  const server = createServer((_request, response) => response.writeHead(404).end());
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/devtools/browser/test') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.testPath = request.url;
      sockets.emit('connection', websocket, request);
    });
  });
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      calls.push({
        path: socket.testPath,
        method: request.method,
        params: request.params,
        sessionId: request.sessionId,
      });
      const result = responseFor(request.method, request.params);
      socket.send(JSON.stringify({
        id: request.id,
        result,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      }));
    });
  });
  function responseFor(method, params) {
    if (method === 'Target.getTargets') {
      return {
        targetInfos: [
          {
            targetId: 'tab-1',
            type: 'page',
            title: 'Account profile',
            url: pageUrl,
          },
          {
            targetId: 'tab-2',
            type: 'page',
            title: 'Private mail',
            url: 'https://mail.example.test/',
          },
          {
            targetId: 'extension',
            type: 'page',
            title: 'Extension',
            url: 'chrome-extension://secret/index.html',
          },
          {
            targetId: 'worker',
            type: 'service_worker',
            title: 'Worker',
            url: 'https://accounts.example.test/sw.js',
          },
        ],
      };
    }
    if (method === 'Target.attachToTarget') {
      return { sessionId: 'selected-tab-session' };
    }
    if (method === 'Runtime.evaluate') {
      if (String(params.expression).includes('summaryRoot')) {
        return {
          result: {
            type: 'object',
            value: options.purchaseTarget || null,
          },
        };
      }
      if (String(params.expression).includes('document.body?.innerText')) {
        return {
          result: {
            type: 'object',
            value: {
              title: 'Account profile',
              url: pageUrl,
              text: 'Profile\nEmail\nSave changes',
            },
          },
        };
      }
      return { result: { type: 'string', value: 'evaluated' } };
    }
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            nodeId: 'root',
            backendDOMNodeId: 1,
            role: { value: 'document' },
            name: { value: 'Account profile' },
          },
          {
            nodeId: 'email',
            parentId: 'root',
            backendDOMNodeId: 2,
            role: { value: 'textbox' },
            name: { value: 'Email' },
            value: { value: 'person@example.test' },
            properties: [{ name: 'focusable', value: { value: true } }],
          },
          {
            nodeId: 'save',
            parentId: 'root',
            backendDOMNodeId: 3,
            role: { value: 'button' },
            name: { value: 'Save changes' },
            properties: [{ name: 'focusable', value: { value: true } }],
          },
        ],
      };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: `object-${params.backendNodeId}` } };
    }
    if (method === 'Runtime.callFunctionOn') {
      if (String(params.functionDeclaration).includes('getBoundingClientRect')) {
        return { result: { value: { x: 120, y: 80, width: 100, height: 30 } } };
      }
      return { result: { value: true } };
    }
    if (method === 'Page.navigate') {
      pageUrl = String(params.url);
      return { frameId: 'frame-1' };
    }
    if (method === 'Page.captureScreenshot') {
      return { data: Buffer.from('fake-image').toString('base64') };
    }
    if (method === 'Page.getNavigationHistory') {
      return {
        currentIndex: 1,
        entries: [{ id: 10 }, { id: 11 }, { id: 12 }],
      };
    }
    if (method === 'Performance.getMetrics') {
      return { metrics: [{ name: 'TaskDuration', value: 1.25 }] };
    }
    return {};
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    endpoint: `ws://127.0.0.1:${port}/devtools/browser/test`,
    calls,
    async close() {
      for (const client of sockets.clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('Chrome CDP Browser Use binds one selected page target and never exposes its socket', async () => {
  const fake = await createFakeChrome();
  const browser = createChromeCdpBrowser(fake.endpoint);
  try {
    const targets = await browser.listTargets();
    assert.deepEqual(targets.map(({ id }) => id), ['tab-1', 'tab-2']);
    assert.equal(Object.hasOwn(targets[0], 'webSocketDebuggerUrl'), false);

    const status = await browser.connect('tab-1');
    assert.equal(status.connected, true);
    assert.equal(status.target?.id, 'tab-1');

    const tabs = await browser.run({ action: 'list_tabs' });
    assert.match(tabs.text, /Account profile/);
    assert.doesNotMatch(tabs.text, /Private mail/);

    const snapshot = await browser.run({
      action: 'snapshot',
      mode: 'both',
      maxElements: 20,
    });
    assert.match(snapshot.text, /Snapshot: chrome-s1/);
    assert.match(snapshot.text, /textbox "Email".*\[ref=c1\]/);
    assert.match(snapshot.text, /button "Save changes".*\[ref=c2\]/);
    assert.equal(snapshot.image?.mimeType, 'image/png');
    assert.equal(Buffer.from(snapshot.image?.data || '', 'base64').toString(), 'fake-image');

    const clicked = await browser.run({
      action: 'click',
      ref: 'c2',
      snapshotId: 'chrome-s1',
    });
    assert.match(clicked.text, /Snapshot: chrome-s2/);
    assert.deepEqual(
      fake.calls
        .filter(({ method }) => method === 'Input.dispatchMouseEvent')
        .map(({ params }) => params.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased'],
    );
    assert.ok(fake.calls.every(({ path }) => path === '/devtools/browser/test'));
    assert.ok(fake.calls
      .filter(({ method }) => !method.startsWith('Target.'))
      .every(({ sessionId }) => sessionId === 'selected-tab-session'));
  } finally {
    browser.disconnect();
    await fake.close();
  }
});

test('Chrome CDP Browser Use supports form input but rejects tab escape and profile secrets', async () => {
  const fake = await createFakeChrome();
  const browser = createChromeCdpBrowser(fake.endpoint);
  try {
    await browser.connect('tab-1');
    const snapshot = await browser.run({ action: 'snapshot' });
    assert.match(snapshot.text, /Snapshot: chrome-s1/);

    await browser.run({
      action: 'fill',
      ref: 'c1',
      snapshotId: 'chrome-s1',
      text: 'new@example.test',
    });
    assert.ok(fake.calls.some(({ method, params }) =>
      method === 'Input.insertText' && params.text === 'new@example.test'));

    await assert.rejects(
      browser.run({ action: 'snapshot', background: true }),
      /background pages are disabled/,
    );
    await assert.rejects(
      browser.run({ action: 'snapshot', tab: 'v2' }),
      /cannot switch to another tab/,
    );
    await assert.rejects(
      browser.run({ action: 'cookies' }),
      /never exports profile secrets/,
    );
    const disconnected = browser.disconnect();
    assert.equal(disconnected.connected, false);
    await assert.rejects(
      browser.run({ action: 'snapshot' }),
      /No Chrome tab is connected/,
    );
  } finally {
    browser.disconnect();
    await fake.close();
  }
});

test('Chrome CDP Browser Use discovers the protected browser endpoint from DevToolsActivePort', async () => {
  const fake = await createFakeChrome();
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-chrome-cdp-'));
  const endpoint = new URL(fake.endpoint);
  await writeFile(
    join(directory, 'DevToolsActivePort'),
    `${endpoint.port}\n${endpoint.pathname}\n`,
    'utf8',
  );
  const browser = createChromeCdpBrowser({ userDataDirectories: [directory] });
  try {
    const targets = await browser.listTargets();
    assert.equal(targets[0]?.id, 'tab-1');
    const status = await browser.connect('tab-1');
    assert.equal(status.connected, true);
    assert.equal(status.endpoint, 'chrome://inspect/#remote-debugging');
    assert.ok(fake.calls.some(({ method }) => method === 'Target.attachToTarget'));
  } finally {
    browser.disconnect();
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Chrome CDP Browser Use prefers protected auto-connect before the extension relay fallback', async () => {
  const direct = await createFakeChrome();
  const fallback = await createFakeChrome();
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-chrome-cdp-order-'));
  const endpoint = new URL(direct.endpoint);
  await writeFile(
    join(directory, 'DevToolsActivePort'),
    `${endpoint.port}\n${endpoint.pathname}\n`,
    'utf8',
  );
  let providerCalls = 0;
  const browser = createChromeCdpBrowser({
    userDataDirectories: [directory],
    browserWSEndpointProvider: async () => {
      providerCalls += 1;
      return fallback.endpoint;
    },
  });
  try {
    const targets = await browser.listTargets();
    assert.equal(targets[0]?.id, 'tab-1');
    assert.equal(providerCalls, 1);
    assert.ok(direct.calls.some(({ method }) => method === 'Target.getTargets'));
    assert.equal(fallback.calls.length, 0);
  } finally {
    browser.disconnect();
    await direct.close();
    await fallback.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('protected Chrome tabs block arbitrary evaluate and require one-time approval before purchase input', async () => {
  const fake = await createFakeChrome({
    purchaseTarget: {
      tag: 'button',
      role: '',
      type: 'submit',
      label: 'Place order',
      href: '',
      formAction: 'https://shop.example.test/checkout/submit',
      pageTitle: 'Checkout',
      pageUrl: 'https://shop.example.test/checkout',
      summary: 'Widget\nQuantity 1\nTotal $24.00',
    },
  });
  let approved = false;
  const approvals = [];
  const browser = createChromeCdpBrowser({
    browserWSEndpoint: fake.endpoint,
    protectedExistingProfile: true,
    onPurchaseApproval: async (request) => {
      approvals.push(request);
      return approved;
    },
  });
  try {
    await browser.connect('tab-1');
    await assert.rejects(
      browser.run({ action: 'evaluate', script: 'document.cookie' }),
      /evaluate is disabled/,
    );
    await assert.rejects(
      browser.run({ action: 'click', x: 120, y: 80 }),
      /User cancelled/,
    );
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].merchant, 'shop.example.test');
    assert.equal(
      fake.calls.some(({ method }) => method === 'Input.dispatchMouseEvent'),
      false,
    );

    approved = true;
    await browser.run({ action: 'click', x: 120, y: 80 });
    assert.equal(approvals.length, 2);
    assert.ok(fake.calls.some(({ method, params }) =>
      method === 'Mixdog.authorizePurchase'
      && params.kind === 'pointer'
      && params.x === 120
      && params.y === 80));
    assert.equal(
      fake.calls.filter(({ method, params }) =>
        method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed').length,
      1,
    );
  } finally {
    browser.disconnect();
    await fake.close();
  }
});

test('final purchase policy excludes cart and checkout navigation actions', () => {
  assert.equal(isFinalPurchaseTarget({
    tag: 'button',
    role: '',
    type: 'submit',
    label: '결제하기',
    href: '',
    formAction: '/checkout/payment',
  }), true);
  assert.equal(isFinalPurchaseTarget({
    tag: 'button',
    role: '',
    type: 'button',
    label: 'Add to cart',
    href: '/cart',
    formAction: '',
  }), false);
  assert.equal(isFinalPurchaseTarget({
    tag: 'a',
    role: 'button',
    type: '',
    label: 'Proceed to checkout',
    href: '/checkout',
    formAction: '',
  }), false);
});

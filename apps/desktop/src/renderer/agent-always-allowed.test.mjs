import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AlwaysAllowedList, alwaysAllowedItems, prefetchAlwaysAllowed } = await import('./agent-always-allowed.tsx');
const { alwaysAllowNote } = await import('./BrowserApprovalHost.tsx');

const PERMISSIONS = [
  { action: 'comment', mode: 'ask', rememberable: true },
  { action: 'email', mode: 'allow', rememberable: true },
  { action: 'browser_submit', mode: 'allow', rememberable: true },
  { action: 'browser_post', mode: 'block', rememberable: true },
];
const TOOLS = [{ connector: 'notion', tool: 'create_page' }];

test('the allowed rows are the bot allows only, each with the call that turns it back to asking', () => {
  const items = alwaysAllowedItems('marketer', PERMISSIONS, TOOLS);
  assert.deepEqual(
    items.map((item) => [item.label, item.revoke.capability, item.revoke.args]),
    [
      ['Send an email', 'setAgentPermission', ['marketer', 'email', 'ask']],
      ['Submit a form in the browser', 'setAgentPermission', ['marketer', 'browser_submit', 'ask']],
      [
        'create_page (notion)',
        'setAgentConnectorToolPermission',
        ['marketer', 'notion', 'create_page', 'needs_approval'],
      ],
    ]
  );
  assert.deepEqual(alwaysAllowedItems('marketer', null, undefined), []);
});

test('the card note says exactly what always allow changes', () => {
  assert.equal(
    alwaysAllowNote('Marketer', ['submit', 'post']),
    "With Always allow, Marketer's Submit a form in the browser, Click a send or post button in the browser won't ask again"
  );
  assert.equal(
    alwaysAllowNote('Marketer', ['upload']),
    "With Always allow, Marketer's Upload files in the browser won't ask again"
  );
});

test('an upload allow is listed in the profile and revoked back to asking', () => {
  const items = alwaysAllowedItems('marketer', [{ action: 'browser_upload', mode: 'allow', rememberable: true }], []);
  assert.deepEqual(
    items.map((item) => [item.label, item.revoke.args]),
    [['Upload files in the browser', ['marketer', 'browser_upload', 'ask']]]
  );
});

test('the upload card shows the destination origin, each file with its size, and the outside-project mark', async () => {
  const { BrowserApprovalHost, BrowserApprovalCard, useBrowserApprovals } = await import('./BrowserApprovalHost.tsx');
  // The host only queues (b1f10baa3): the card shows where its chat docks it.
  const Dock = ({ sessionId }) => {
    const prompts = useBrowserApprovals(sessionId);
    return prompts[0] ? React.createElement(BrowserApprovalCard, { prompt: prompts[0] }) : null;
  };
  let listener = null;
  dom.window.mixdogDesktop = {
    onBrowserApproval: (next) => {
      listener = next;
      return () => {};
    },
    browserApprovalDecide: async () => {},
  };
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(BrowserApprovalHost)));
  const dock = dom.window.document.createElement('div');
  dom.window.document.body.append(dock);
  const chat = createRoot(dock);
  await act(async () => chat.render(React.createElement(Dock, { sessionId: 'sess_home_marketer' })));
  const prompt = {
    id: 'a1',
    action: 'upload',
    url: 'https://app.example/form',
    sessionId: 'sess_home_marketer',
    requester: 'Marketer',
    target: 'button "Choose file"',
    paths: ['C:\\proj\\in.txt', 'C:\\other\\out.bin'],
    origin: 'https://app.example',
    receiverOrigin: 'https://pay.other.example',
    files: [
      { name: 'in.txt', path: 'C:\\proj\\in.txt', size: 512, outside: false },
      { name: 'out.bin', path: 'C:\\other\\out.bin', size: 3 * 1024 * 1024, outside: true },
    ],
    expiresAt: Date.now() + 30_000,
    remember: { kinds: ['upload'] },
  };
  await act(async () => listener(prompt));
  const card = dock.textContent;
  assert.match(card, /Upload to/);
  assert.match(card, /https:\/\/pay\.other\.example/);
  assert.match(card, /Frame embedded in https:\/\/app\.example/);
  assert.match(card, /in\.txt/);
  assert.match(card, /512 B/);
  assert.match(card, /C:\\proj\\in\.txt/);
  assert.match(card, /out\.bin/);
  assert.match(card, /3\.0 MB/);
  const outside = [...dock.querySelectorAll('li')].map((li) => li.textContent.includes('Outside the project'));
  assert.deepEqual(outside, [false, true]);
  assert.match(card, /Upload files in the browser/);
  // The receiving frame is the page itself: that origin, with no "embedded" line.
  await act(async () => listener({ ...prompt, id: 'a2', receiverOrigin: 'https://app.example' }));
  await act(async () => listener({ id: 'a1', closed: true }));
  assert.equal(dock.querySelector('.browser-approval-destination').textContent, 'https://app.example');
  // Not confirmed: never shown as if the page origin were the destination.
  await act(async () => listener({ ...prompt, id: 'a3', receiverOrigin: '' }));
  await act(async () => listener({ id: 'a2', closed: true }));
  assert.equal(
    dock.querySelector('.browser-approval-destination').textContent,
    'Receiving site not confirmedPage: https://app.example'
  );
  await act(async () => listener({ id: 'a3', closed: true }));
  await act(async () => chat.unmount());
  await act(async () => root.unmount());
});

test('the profile lists allows and "Ask again" revokes one, leaving the rest', async () => {
  let permissions = PERMISSIONS.map((row) => ({ ...row }));
  let tools = TOOLS.map((row) => ({ ...row }));
  const calls = [];
  const api = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, args]);
      if (capability === 'getAgentPermissions') return { value: permissions };
      if (capability === 'getAgentAlwaysAllowedTools') return { value: tools };
      if (capability === 'setAgentPermission') {
        permissions = permissions.map((row) => (row.action === args[1] ? { ...row, mode: args[2] } : row));
      }
      if (capability === 'setAgentConnectorToolPermission') tools = [];
      return { value: null };
    },
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(AlwaysAllowedList, { api, agentId: 'marketer' })));
  const names = () =>
    [...dom.window.document.querySelectorAll('.connector-switch-name')].map((node) => node.textContent);
  assert.deepEqual(names(), ['Send an email', 'Submit a form in the browser', 'create_page (notion)']);
  const revoke = (index) =>
    act(async () =>
      dom.window.document
        .querySelectorAll('.connector-switches-link')
        [index].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
  await revoke(1);
  assert.deepEqual(names(), ['Send an email', 'create_page (notion)']);
  await revoke(1);
  assert.deepEqual(names(), ['Send an email']);
  assert.ok(calls.some(([capability]) => capability === 'setAgentConnectorToolPermission'));
  await revoke(0);
  assert.equal(
    dom.window.document.querySelector('.agent-profile-always-allowed'),
    null,
    'the section hides when empty'
  );
  await act(async () => root.unmount());
});

/** A host whose permission reads the test answers by hand. */
function slowPermissionsHost() {
  const reads = [];
  const api = {
    invokeCapability: ({ capability }) => {
      if (capability !== 'getAgentPermissions') return Promise.resolve({ value: [] });
      const answer = Promise.withResolvers();
      reads.push(answer);
      return answer.promise;
    },
  };
  return { api, reads };
}
const allow = (...actions) => ({ value: actions.map((action) => ({ action, mode: 'allow', rememberable: true })) });
const flush = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const listed = () =>
  [...dom.window.document.querySelectorAll('.connector-switch-name')].map((node) => node.textContent);

test("a warm-up's read in flight is the mounted list's read: the host is asked once", async () => {
  const { api, reads } = slowPermissionsHost();
  const warm = prefetchAlwaysAllowed(api, 'shared-bot');
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(AlwaysAllowedList, { api, agentId: 'shared-bot' })));
  assert.equal(reads.length, 1);
  reads[0].resolve(allow('email'));
  await warm;
  await flush();
  assert.deepEqual(listed(), ['Send an email']);
  await act(async () => root.unmount());
});

test('a change announced mid-read ends on the newer answer, whatever order the host answers in', async () => {
  const { api, reads } = slowPermissionsHost();
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(AlwaysAllowedList, { api, agentId: 'ordered-bot' })));
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.CustomEvent('mixdog:setup-changed'));
  });
  // The newer read answers first when both are out; the older one last.
  if (reads[1]) reads[1].resolve(allow('email', 'browser_submit'));
  reads[0].resolve(allow('email'));
  await flush();
  reads[1].resolve(allow('email', 'browser_submit'));
  await flush();
  assert.deepEqual(listed(), ['Send an email', 'Submit a form in the browser']);
  await act(async () => root.unmount());
});

test('a grant made while the list is open appears on the settings-changed broadcast, with no reload', async () => {
  let permissions = [{ action: 'email', mode: 'ask', rememberable: true }];
  const api = {
    invokeCapability: async ({ capability }) => ({
      value: capability === 'getAgentPermissions' ? permissions : [],
    }),
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(AlwaysAllowedList, { api, agentId: 'marketer' })));
  assert.equal(dom.window.document.querySelector('.agent-profile-always-allowed'), null);
  permissions = [{ action: 'email', mode: 'allow', rememberable: true }];
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.CustomEvent('mixdog:setup-changed', { detail: { action: 'settings_changed' } })
    );
  });
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.connector-switch-name')].map((node) => node.textContent),
    ['Send an email']
  );
  await act(async () => root.unmount());
  // Unmounted: the broadcast no longer reads anything.
  let reads = 0;
  api.invokeCapability = async () => {
    reads += 1;
    return { value: [] };
  };
  dom.window.dispatchEvent(new dom.window.CustomEvent('mixdog:setup-changed'));
  assert.equal(reads, 0);
});

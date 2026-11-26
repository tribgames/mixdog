import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ContextBody } from './ContextBody.tsx';
import { contextPreviewMarkdown, toolResultLine } from './ContextInspector.tsx';
import MarkdownBody from './MarkdownBody.tsx';
import { CopyControl } from './transcript-primitives.tsx';
import { parseStreamingMarkdownAst } from './markdown-worker-client.ts';
import { t } from './i18n.ts';
import { requiredDesktopCapabilityRequest } from '../main/ipc-capability-request.ts';

test('reasoning uses current occupancy for category percentages and maps, never cumulative generation', () => {
  for (const reasoningTokens of [0, 1200]) {
    for (const inspection of [
      undefined,
      {
        revision: 'reasoning',
        estimatedTokens: 100 + reasoningTokens,
        categories: [
          { key: 'system', label: 'System prompt', tokens: 100, count: 1 },
          { key: 'reasoning', label: 'Reasoning tokens', tokens: reasoningTokens, count: reasoningTokens ? 1 : 0 },
        ],
        entries: [],
      },
    ]) {
      const status = {
        contextWindow: 10000,
        measurement: { source: 'last_api_request', tokens: 100 + reasoningTokens },
        usage: { reasoningUsage: { reasoningTokens: 999999, reasoningTokensComplete: true } },
        messages: { semantic: { system: { tokens: 100 }, reasoning: { tokens: reasoningTokens } } },
        inspection,
      };
      const html = renderToStaticMarkup(React.createElement(ContextBody, { status, snapshot: {} }));
      const dom = new JSDOM(html);
      const document = dom.window.document;
      const row = document.querySelector('.context-mix-row[data-context-key="reasoning"]');
      assert.ok(row);
      assert.ok(row.textContent.includes(t('Reasoning tokens')));
      assert.doesNotMatch(document.body.textContent, /999,999|999999/);
      assert.equal(document.querySelectorAll('.context-usage-overview').length, 1);
      assert.equal(
        Boolean(
          document.querySelector(
            '.context-main-bar [data-context-key="reasoning"], .context-block-map [data-context-key="reasoning"], .context-stack-bar [data-context-key="reasoning"]'
          )
        ),
        reasoningTokens > 0
      );
      if (inspection) {
        assert.equal(row.querySelector('strong').textContent, `≈${reasoningTokens.toLocaleString()}`);
        assert.equal(row.querySelector('em').textContent, `${reasoningTokens / 100}%`);
        assert.equal(
          document.querySelector('[data-context-key="free"] strong').textContent,
          `≈${(9900 - reasoningTokens).toLocaleString()}`
        );
      }
      dom.window.close();
    }
  }
});

test('a turn traces which tools it called without growing with the call count', () => {
  // Sizes live on the tool rows; this line only names the tools, most-used
  // first, so the row cannot grow with how many times the turn called them.
  assert.equal(
    toolResultLine({
      toolResults: [
        { name: 'edit', tokens: 70 },
        { name: 'read', tokens: 621 },
        { name: 'edit', tokens: 71 },
        { name: 'task', tokens: 42 },
        { name: 'edit', tokens: 73 },
        { name: 'grep', tokens: 213 },
        { name: 'shell', tokens: 19 },
      ],
    }),
    'edit ×3 · grep · read · +2'
  );
  assert.equal(toolResultLine({ toolResults: [{ name: 'read', tokens: 12 }] }), 'read');
  assert.equal(toolResultLine({}), '');
});

test('inspection capability validates opt-in and preview revision without changing ordinary reads', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'contextStatus' }).args, []);
  assert.doesNotThrow(() =>
    requiredDesktopCapabilityRequest({ capability: 'contextStatus', args: [{ inspect: true }] })
  );
  assert.throws(() =>
    requiredDesktopCapabilityRequest({ capability: 'contextStatus', args: [{ inspect: true, entryId: 'message:0' }] })
  );
  assert.throws(() =>
    requiredDesktopCapabilityRequest({ capability: 'contextStatus', args: [{ inspect: true, persist: true }] })
  );
});

test('context tool previews use highlighted JSON cards without changing the source', async () => {
  for (const source of ['{\n  "description": "```example```"\n}', '{\n  "name": "truncated']) {
    const markdown = contextPreviewMarkdown(source, 'tool');
    await parseStreamingMarkdownAst(markdown);
    const dom = new JSDOM(
      renderToStaticMarkup(
        React.createElement(MarkdownBody, {
          text: markdown,
          copyControl: CopyControl,
        })
      )
    );
    const code = dom.window.document.querySelector('.markdown-code code.language-json');
    assert.ok(code);
    // The highlighter keeps the fence's closing newline only inside an
    // unterminated string token; the visible source is the same either way.
    assert.equal(code.textContent.replace(/\n$/, ''), source);
    assert.ok(code.querySelector('span'));
    assert.ok(dom.window.document.querySelector('.markdown-code-copy'));
    dom.window.close();
  }
  const prose = '# Heading\n\n**Unchanged**';
  assert.equal(contextPreviewMarkdown(prose, 'instruction'), prose);
});

function installContextDom(context) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(() => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    dom.window.close();
  });
  return root;
}

const click = (selector) =>
  act(async () => {
    document.querySelector(selector).click();
  });

const PREVIEW_TEXT = '# PRIVATE_PREVIEW\n\n**Formatted**\n\n- Item\n\n<script>not executable</script>';

async function mountPreviewInspector(context) {
  const root = installContextDom(context);
  const requests = [];
  const inspection = {
    revision: 'first',
    estimatedTokens: 20,
    categories: [{ key: 'system', label: 'System prompt', tokens: 20, count: 1 }],
    entries: [{ id: 'message:0', category: 'system', label: 'Rules', tokens: 20, kind: 'instruction' }],
  };
  const status = {
    sessionId: 'test',
    contextWindow: 100,
    rawContextWindow: 120,
    measurement: { source: 'last_api_request', tokens: 30 },
    inspection,
  };
  const pending = { deferred: false, release: null };
  await parseStreamingMarkdownAst(PREVIEW_TEXT);
  const request = async (capability, args) => {
    requests.push({ capability, args });
    if (pending.deferred)
      return new Promise((resolve) => {
        pending.release = resolve;
      });
    return { inspection: { preview: { id: 'message:0', text: PREVIEW_TEXT } } };
  };
  const render = () => act(() => root.render(React.createElement(ContextBody, { status, snapshot: {}, request })));
  await render();
  return { inspection, pending, render, requests, status };
}

const openFirstEntry = async () => {
  await click('button[data-context-key="system"]');
  await click('.context-entry-list button');
};

test('the context inspector requests no preview until an entry is selected', async (context) => {
  const { requests } = await mountPreviewInspector(context);
  assert.equal(document.querySelectorAll('.context-block-map i').length, 128);
  assert.equal(requests.length, 0);
  assert.doesNotMatch(document.body.textContent, /PRIVATE_PREVIEW/);
  await click('button[data-context-key="system"]');
  assert.equal(requests.length, 0);
  await click('.context-entry-list button');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].args, [{ inspect: true, entryId: 'message:0', revision: 'first' }]);
});

test('a selected entry previews as formatted markdown without executing its html', async (context) => {
  await mountPreviewInspector(context);
  await openFirstEntry();
  assert.equal(document.querySelector('.context-preview-content h1').textContent, 'PRIVATE_PREVIEW');
  assert.equal(document.querySelector('.context-preview-content strong').textContent, 'Formatted');
  assert.equal(document.querySelector('.context-preview-content li').textContent, 'Item');
  assert.equal(document.querySelector('script'), null);
});

test('the preview replaces the entry list and the back control returns to it', async (context) => {
  await mountPreviewInspector(context);
  await openFirstEntry();
  assert.equal(document.querySelector('.context-entry-list'), null);
  await click('.context-entry-preview .context-detail-icon');
  assert.equal(document.querySelector('.context-preview-content'), null);
  assert.ok(document.querySelector('.context-entry-list'));
  await click('.context-entry-list button');
  assert.match(document.querySelector('.context-preview-content').textContent, /PRIVATE_PREVIEW/);
});

test('a new revision drops the preview state', async (context) => {
  const { inspection, render, status } = await mountPreviewInspector(context);
  await openFirstEntry();
  status.inspection = { ...inspection, revision: 'second' };
  await render();
  assert.equal(document.querySelector('.context-preview-content'), null);
  assert.doesNotMatch(document.body.textContent, /PRIVATE_PREVIEW/);
});

test('a preview that answers after a new revision is discarded', async (context) => {
  const { inspection, pending, render, status } = await mountPreviewInspector(context);
  pending.deferred = true;
  await openFirstEntry();
  status.inspection = { ...inspection, revision: 'third' };
  await render();
  await act(async () => {
    pending.release({ inspection: { preview: { text: 'LATE_PRIVATE_PREVIEW' } } });
  });
  assert.equal(document.querySelector('.context-preview-content'), null);
  assert.doesNotMatch(document.body.textContent, /LATE_PRIVATE_PREVIEW/);
});

async function mountCategoryInspector(context) {
  const root = installContextDom(context);
  const inspection = {
    revision: 'r',
    estimatedTokens: 60,
    categories: [
      { key: 'system', label: 'System prompt', tokens: 10, count: 1 },
      { key: 'tools', label: 'System tools', tokens: 0, count: 0 },
      { key: 'messages', label: 'Messages', tokens: 50, count: 4 },
    ],
    entries: [
      {
        id: 'message:0',
        category: 'messages',
        group: 'user',
        label: 'user · 1',
        tokens: 30,
        estimatedTokens: 40,
        kind: 'message',
        role: 'user',
        ordinal: 1,
      },
      {
        id: 'message:1',
        category: 'messages',
        group: 'assistant',
        label: 'assistant · 1',
        tokens: 20,
        estimatedTokens: 26,
        kind: 'message',
        role: 'assistant',
        ordinal: 1,
        toolResults: [{ name: 'read', tokens: 12 }],
      },
    ],
    calibration: { source: 'provider', measuredTokens: 60, ratio: 0.75, coveredMessages: 2, estimatedTokens: 80 },
  };
  const status = {
    sessionId: 'test',
    contextWindow: 100,
    rawContextWindow: 120,
    measurement: { source: 'last_api_request', tokens: 60 },
    inspection,
  };
  await act(() => root.render(React.createElement(ContextBody, { status, snapshot: {}, request: async () => ({}) })));
}

const ENTRY_BUTTON = '.context-entry-list button:not(.context-entry-group-head)';

test('category rows rank by size and mark empty rows', async (context) => {
  await mountCategoryInspector(context);
  const keys = [...document.querySelectorAll('.context-inspector button.context-mix-row')].map(
    (row) => row.dataset.contextKey
  );
  assert.deepEqual(keys, ['messages', 'system', 'tools']);
  assert.equal(document.querySelector('button[data-context-key="tools"]').dataset.empty, 'true');
  assert.equal(document.querySelector('button[data-context-key="messages"]').dataset.empty, undefined);
  assert.equal(document.querySelector('button[data-context-key="messages"] em').textContent, '50%');
  assert.ok(document.querySelector('.context-mix-remainder [data-context-key="free"]'));
  assert.equal(document.querySelector('.context-entry-section'), null);
});

test('the detail pane shows the chosen category and its × returns to the placeholder', async (context) => {
  await mountCategoryInspector(context);
  assert.ok(document.querySelector('.context-inspector-detail .context-detail-empty'));
  await click('button[data-context-key="messages"]');
  assert.ok(document.querySelector('.context-inspector-detail .context-entry-section'));
  assert.equal(document.querySelector('.context-detail-empty'), null);
  assert.equal(document.querySelector('button[data-context-key="messages"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('.context-detail-bar h3').textContent, t('Messages'));
  await click('.context-detail-bar [aria-label]');
  assert.equal(document.querySelector('.context-entry-section'), null);
  assert.ok(document.querySelector('.context-detail-empty'));
});

test('role groups stay closed until their heads are clicked and name the tool results they carry', async (context) => {
  await mountCategoryInspector(context);
  await click('button[data-context-key="messages"]');
  const heads = [...document.querySelectorAll('.context-entry-group-head > span')].map((node) => node.textContent);
  assert.deepEqual(heads, [t('User'), t('Assistant')]);
  assert.equal(document.querySelectorAll(ENTRY_BUTTON).length, 0);
  await act(async () => {
    for (const head of document.querySelectorAll('.context-entry-group-head')) head.click();
  });
  const labels = [...document.querySelectorAll(`${ENTRY_BUTTON} > span`)].map((node) => node.textContent);
  assert.deepEqual(labels, [`${t('User')} 1`, `${t('Assistant')} 1read`]);
  assert.equal(document.querySelector('.context-entry-tools').textContent, 'read');
  assert.equal(document.querySelector(ENTRY_BUTTON).title, t('Raw estimate: ≈{{tokens}}', { tokens: '40' }));
  await click('.context-entry-group-head');
  assert.equal(document.querySelectorAll(ENTRY_BUTTON).length, 1);
  assert.equal(document.querySelector('.context-inspector-toggle'), null);
});

test('external agent self-compaction (negative hostInspectionGap) reconciles ContextInspector to reported usage without overflow', async (context) => {
  const root = installContextDom(context);
  const inspection = {
    revision: 'acp-compact',
    estimatedTokens: 1_500_000,
    categories: [
      { key: 'system', label: 'System prompt', tokens: 20_000, count: 1 },
      { key: 'tools', label: 'System tools', tokens: 20_000, count: 2 },
      { key: 'mcp', label: 'MCP tools', tokens: 10_000, count: 1 },
      { key: 'messages', label: 'Messages', tokens: 1_450_000, count: 2 },
    ],
    entries: [
      { id: 'sys:0', category: 'system', label: 'Prompt', tokens: 20_000, kind: 'instruction' },
      { id: 'tool:read', category: 'tools', group: 'active', label: 'read', tokens: 15_000, kind: 'tool' },
      {
        id: 'overhead:0',
        category: 'tools',
        group: 'overhead',
        label: 'Request framing',
        tokens: 5_000,
        kind: 'overhead',
      },
      { id: 'mcp:0', category: 'mcp', group: 'active', label: 'mcp.list', tokens: 10_000, kind: 'tool' },
      {
        id: 'message:0',
        category: 'messages',
        group: 'user',
        label: 'User 1',
        tokens: 450_000,
        kind: 'message',
        role: 'user',
        ordinal: 1,
      },
      {
        id: 'message:1',
        category: 'messages',
        group: 'assistant',
        label: 'Assistant 1',
        tokens: 1_000_000,
        kind: 'message',
        role: 'assistant',
        ordinal: 1,
      },
    ],
  };
  const status = {
    sessionId: 'acp-compacted',
    contextWindow: 1_000_000,
    measurement: { source: 'last_api_request', tokens: 210_000 },
    messages: { semantic: { system: { tokens: 20_000 }, chat: { tokens: 1_450_000 } } },
    request: {
      toolSchemaBreakdown: { code: { tokens: 15_000 }, mcp: { tokens: 10_000 } },
      requestOverheadTokens: 5_000,
    },
    inspection,
  };
  await act(() =>
    root.render(
      React.createElement(ContextBody, { status, snapshot: { provider: 'acp-codex' }, request: async () => ({}) })
    )
  );
  // Header shows 21% usage; inspector must match 21% used / 79% free with zero overflow.
  assert.match(document.querySelector('.context-usage-heading').textContent, /210k \/ 1\.0m · 21%/);
  assert.equal(document.querySelector('[data-context-key="system"] strong').textContent, '≈20,000');
  assert.equal(
    document.querySelector('[data-context-key="tools"] strong').textContent,
    '≈15,000',
    'provider HTTP overhead entry is omitted on external agent sessions'
  );
  assert.equal(
    document.querySelector('[data-context-key="tools"] small').textContent,
    t('{{count}} items', { count: 1 })
  );
  assert.equal(document.querySelector('[data-context-key="mcp"] strong').textContent, '≈10,000');
  assert.equal(document.querySelector('[data-context-key="messages"] strong').textContent, '≈165,000');
  assert.equal(document.querySelector('[data-context-key="free"] strong').textContent, '≈790,000');
  assert.equal(document.querySelector('[data-context-key="free"] em').textContent, '79%');
  const map = document.querySelector('.context-block-map');
  assert.doesNotMatch(map.getAttribute('aria-label'), /Estimated content exceeds the context window\./);
  assert.ok(map.querySelectorAll('i[data-context-key="free"]').length >= 90, 'block map shows ~79% free cells');
  assert.equal(document.querySelector('[data-context-key="host"]'), null, 'no host row when estimate exceeded used');
  // Opening Tools confirms the overhead entry was stripped.
  await click('button[data-context-key="tools"]');
  assert.doesNotMatch(document.querySelector('.context-entry-list').textContent, /Request framing/);
});

test('external agent host (Other) remainder row is a non-clickable summary without 0 items', async (context) => {
  const root = installContextDom(context);
  const status = {
    sessionId: 'acp-host-gap',
    contextWindow: 1000,
    measurement: { source: 'last_api_request', tokens: 900 },
    messages: { semantic: { system: { tokens: 100 } } },
    inspection: {
      revision: 'host-gap',
      estimatedTokens: 100,
      categories: [{ key: 'system', label: 'System prompt', tokens: 100, count: 1 }],
      entries: [{ id: 'sys:0', category: 'system', label: 'Rules', tokens: 100, kind: 'instruction' }],
    },
  };
  await act(() =>
    root.render(
      React.createElement(ContextBody, { status, snapshot: { provider: 'acp-antigravity' }, request: async () => ({}) })
    )
  );
  const hostRow = document.querySelector('.context-mix-row[data-context-key="host"]');
  assert.ok(hostRow, 'host remainder row renders');
  assert.equal(hostRow.tagName.toLowerCase(), 'div', 'host row is a non-interactive div, not a button');
  assert.equal(document.querySelector('button.context-mix-row[data-context-key="host"]'), null);
  assert.doesNotMatch(hostRow.textContent, /0 items/);
  assert.equal(hostRow.querySelector('strong').textContent, '≈800');
  assert.equal(document.querySelector('[data-context-key="free"] strong').textContent, '≈100');
  // Clicking a host cell in the block map does not open an empty "No entries." detail view.
  const hostCell = document.querySelector('.context-block-map i[data-context-key="host"]');
  assert.ok(hostCell);
  await act(async () => hostCell.click());
  assert.ok(document.querySelector('.context-inspector-detail .context-detail-empty'));
  assert.equal(document.querySelector('.context-entry-section'), null);

  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./desktop/24-context-dock.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.context-block-map i\[data-context-key="free"\],\s*\.context-block-map i\[data-context-key="host"\]\s*\{\s*cursor:\s*default;/,
    'non-clickable host cells show default cursor in the block map'
  );
});

test('reconcileAgentInspection subtracts entry.estimatedTokens from category.estimatedTokens when stripping calibrated overhead', async (context) => {
  const root = installContextDom(context);
  const status = {
    sessionId: 'acp-calibrated-overhead',
    contextWindow: 1000,
    measurement: { source: 'last_api_request', tokens: 300 },
    inspection: {
      revision: 'cal',
      estimatedTokens: 180,
      calibration: { source: 'provider', measuredTokens: 180, ratio: 0.75, coveredMessages: 1, estimatedTokens: 240 },
      categories: [{ key: 'tools', label: 'System tools', tokens: 180, estimatedTokens: 240, count: 2 }],
      entries: [
        {
          id: 'tool:read',
          category: 'tools',
          group: 'active',
          label: 'read',
          tokens: 150,
          estimatedTokens: 200,
          kind: 'tool',
        },
        {
          id: 'overhead:0',
          category: 'tools',
          group: 'overhead',
          label: 'Request framing',
          tokens: 30,
          estimatedTokens: 40,
          kind: 'overhead',
        },
      ],
    },
  };
  await act(() =>
    root.render(
      React.createElement(ContextBody, { status, snapshot: { provider: 'acp-codex' }, request: async () => ({}) })
    )
  );
  const toolsStrong = document.querySelector('[data-context-key="tools"] strong');
  assert.equal(toolsStrong.textContent, '≈150');
  assert.equal(
    toolsStrong.title,
    t('Raw estimate: ≈{{tokens}}', { tokens: '200' }),
    'raw category estimatedTokens subtracted overhead estimatedTokens (40), not calibrated tokens (30)'
  );
});

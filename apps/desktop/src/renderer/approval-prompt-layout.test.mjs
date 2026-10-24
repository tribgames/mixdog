// Layout invariants of the docked approval card in a real Chrome: the card
// sits in the composer island above the composer and never breaks — equal
// button columns exactly as wide as the preview, never wider than the
// composer, no horizontal overflow for long names, chains, URLs, paths, many
// files or long translated labels, a stacked row in a narrow pane, and the
// phone sheet's 44px stacked buttons with the primary on top.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const css = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const registered = (css('./font-faces.css').match(/@property[^}]*\}/g) ?? []).join('\n');
const STYLES = [
  registered,
  css('./desktop/01-tokens.css'),
  css('./desktop/15-composer.css'),
  css('./desktop/15-approval-prompt.css'),
].join('\n');

const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { ComposerDock } from './ComposerDock.tsx';
  import { ApprovalPrompt, ApprovalPreviewRow } from './approval-prompt.tsx';
  import { PixelIcon } from './pixel-icon.tsx';
  window.mixdogDesktop = new Proxy({}, {
    get: (_, name) => (String(name).startsWith('subscribe') ? () => () => {} : async () => []),
  });
  const h = React.createElement;
  const LONG_URL = 'https://publisher.unity.com/' + 'very-long-path-segment-'.repeat(12) + '?query=' + 'x'.repeat(80);
  const LONG_PATH = 'C:\\\\Project\\\\' + 'DeeplyNestedFolderName\\\\'.repeat(10) + 'UniCell_Manual_Final_v2.pdf';
  const files = (n) => Array.from({ length: n }, (_, i) =>
    h(ApprovalPreviewRow, { key: i, icon: h(PixelIcon, { name: 'file' }), main: 'file-' + i + '.pdf · 2.4 MB', sub: LONG_PATH }));
  const SCENARIOS = {
    standard: { buttons: ['Deny', 'Always allow', 'Allow just once'], preview: [h(ApprovalPreviewRow, { key: 'u', icon: h(PixelIcon, { name: 'globe' }), main: LONG_URL, sub: LONG_PATH })] },
    german: { buttons: ['Ablehnen', 'Immer erlauben für diesen Assistenten', 'Nur dieses eine Mal erlauben'], preview: [h(ApprovalPreviewRow, { key: 'm', icon: h(PixelIcon, { name: 'mail' }), main: 'assetstore@unity3d.com' })] },
    files: { buttons: ['Deny', 'Always allow', 'Allow just once'], preview: files(24) },
    danger: { buttons: ['Deny', 'Allow payment'], danger: true, preview: [h('div', { key: 'a', className: 'approval-amount' }, h('b', null, '₩ 23,100'))] },
    risky: { buttons: ['Deny', 'Always allow', 'Allow just once'], risky: true, preview: files(1) },
  };
  const card = (name) => {
    const s = SCENARIOS[name];
    return h(ApprovalPrompt, {
      key: name,
      title: 'Upload these files to the receiving site of this extremely long page title?',
      faceAgentId: 'marketer-with-a-very-long-identifier',
      tone: 'need',
      requester: '사무관의 아주 긴 이름을 가진 봇 › Worker › Reviewer › Another very long sub-agent name',
      service: 'Gmail · ' + 'connector-tool-with-a-long-name'.repeat(2),
      sessionLink: { sessionId: 's', label: 'Open session' },
      queue: '1/3',
      corner: '0:28 left',
      preview: s.preview,
      buttons: s.buttons.map((label, i) => ({
        label, deny: i === 0, tone: i === s.buttons.length - 1 ? 'primary' : undefined,
        hint: label === 'Always allow'
          ? "With Always allow, Marketer's Upload files in the browser won't ask again"
          : i > 0 && (s.danger || s.risky) ? 'Allowing takes a click; Enter does not allow.' : undefined,
        onClick: () => (window.__pressed ??= []).push(label),
      })),
      focus: s.danger || s.risky ? 'deny' : 'primary',
      enterAllows: !(s.danger || s.risky),
      onDeny: (reason) => (window.__pressed ??= []).push('deny:' + reason),
    });
  };
  const root = createRoot(document.getElementById('root'));
  window.__render = (name) => flushSync(() => root.render(h(ComposerDock, {
    sessionId: 'sess', reviewSessionId: 'sess', goalSubmissionId: '', showProjectSelector: false,
    reviewItems: [], reviewActive: true, reviewBusy: false, reviewCwd: '',
    approval: card(name),
    children: h('form', { className: 'composer', style: { height: '96px' } }),
  })));
  // The phone dock: a conversation column (transcript above, dock below) with
  // a tall email card docked over a composer that holds the input.
  const body = Array.from({ length: 14 }, (_, i) => 'Line ' + (i + 1) + ' of the message body that the agent wants to send.').join('\\n');
  const phoneCard = () => h(ApprovalPrompt, {
    title: 'Send this email?',
    faceAgentId: 'clerk',
    requester: '사무관',
    service: 'Gmail',
    queue: '1/2',
    corner: '4:32 left',
    preview: [
      h(ApprovalPreviewRow, { key: 'to', icon: h(PixelIcon, { name: 'mail' }), main: 'kim.minjun@example.com', sub: 'Sent as admin@example.com' }),
      h('div', { key: 'body', className: 'approval-text' }, body),
    ],
    buttons: [
      { label: 'Deny', deny: true },
      { label: 'Always allow', hint: "With Always allow, 사무관's Send an email won't ask again", onClick: () => (window.__pressed ??= []).push('always') },
      { label: 'Allow just once', tone: 'primary', onClick: () => (window.__pressed ??= []).push('once') },
    ],
    focus: 'primary',
    enterAllows: true,
    onDeny: () => {},
  });
  const paymentCard = () => h(ApprovalPrompt, {
    title: 'Make this payment?',
    faceAgentId: 'clerk',
    tone: 'need',
    requester: '사무관',
    service: 'shop',
    corner: '2:00 left',
    preview: h('div', { className: 'approval-amount' }, h('b', null, '₩129,000'), h('small', null, 'Shop · KRW')),
    buttons: [
      { label: 'Deny', deny: true },
      { label: 'Allow payment', tone: 'primary', hint: 'Allowing takes a click; Enter does not allow.', onClick: () => (window.__pressed ??= []).push('pay') },
    ],
    focus: 'deny',
    enterAllows: false,
    onDeny: () => {},
  });
  window.__renderPhone = (kind = 'email') => flushSync(() => root.render(h(React.Fragment, null,
    h('div', { className: 'transcript-shell', style: { flex: '1 1 0', minHeight: 0 } }),
    h(ComposerDock, {
      sessionId: 'sess', reviewSessionId: 'sess', goalSubmissionId: '', showProjectSelector: false,
      reviewItems: [], reviewActive: true, reviewBusy: false, reviewCwd: '',
      approval: h(kind === 'payment' ? paymentCard : phoneCard, { key: kind }),
      children: h('form', { className: 'composer', style: { height: '96px' } },
        h('div', { className: 'composer-input-row' }, h('textarea', { 'aria-label': 'Message' }))),
    }))));
  window.__renderDesktopShell = (withApproval = true) => flushSync(() => root.render(h('section', { className: 'conversation', style: { display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative' } },
    h('div', { className: 'transcript-shell', style: { flex: '1 1 0', minHeight: 0 } }),
    h(ComposerDock, {
      sessionId: 'sess', reviewSessionId: 'sess', goalSubmissionId: '', showProjectSelector: false,
      reviewItems: [], reviewActive: true, reviewBusy: false, reviewCwd: '',
      approval: !withApproval ? null : h(ApprovalPrompt, {
        title: 'Run this command?',
        faceAgentId: 'clerk',
        requester: '사무관',
        service: 'Shell',
        preview: [
          h('div', { key: 'cmd', className: 'approval-text' }, Array.from({ length: 12 }, (_, i) => 'step_' + i + ' --flag value-' + i + ' && echo "running long shell command part ' + i + '"').join(' && ')),
        ],
        buttons: [
          { label: 'Deny', deny: true },
          { label: 'Always allow' },
          { label: 'Allow just once', tone: 'primary' },
        ],
        focus: 'primary',
        enterAllows: true,
        onDeny: () => {},
      }),
      children: [
        h('form', { key: 'f', className: 'composer' }, h('div', { className: 'composer-input-row' }, h('textarea', { 'aria-label': 'Message', defaultValue: Array.from({ length: 6 }, (_, i) => 'draft line ' + i).join('\\n') })), h('div', { style: { height: '44px' } })),
        h('div', { key: 'm', className: 'composer-model-line' }, 'model line'),
      ],
    }))));
  window.__desktopShortMeasure = () => {
    const r = (node) => node.getBoundingClientRect();
    const pane = r(document.querySelector('.conversation'));
    const island = document.querySelector('.composer-island');
    const line = r(document.querySelector('.composer-model-line'));
    const title = document.querySelector('.approval-title');
    const who = r(document.querySelector('.approval-who'));
    const composer = r(document.querySelector('form.composer'));
    const buttons = [...document.querySelectorAll('.approval-buttons > .approval-button')];
    const hit = buttons.map((b) => {
      const box = r(b);
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { inButton: Boolean(el?.closest('.approval-button')), onScreen: box.top >= pane.top && box.bottom <= pane.bottom };
    });
    return {
      viewport: innerHeight,
      fit: document.querySelector('.composer-island-slot').getAttribute('data-approval-fit') ?? '',
      island: { top: r(island).top, bottom: r(island).bottom, scrolls: island.scrollHeight > island.clientHeight + 1 },
      title: { top: r(title).top, bottom: r(title).bottom },
      who: { top: who.top, bottom: who.bottom },
      composer: composer.height,
      line: { top: line.top, bottom: line.bottom },
      buttons: buttons.map((b) => ({ top: r(b).top, bottom: r(b).bottom })),
      hit,
      sticky: getComputedStyle(document.querySelector('.approval-buttons')).position,
    };
  };  window.__phoneMeasure = () => {
    const r = (node) => node.getBoundingClientRect();
    const island = document.querySelector('.composer-island');
    const conversation = document.querySelector('.conversation');
    const preview = document.querySelector('.approval-preview');
    const prompt = document.querySelector('.approval-prompt');
    const kept = [...document.querySelectorAll('.approval-buttons > .approval-button')];
    const style = preview && getComputedStyle(preview);
    const px = (value) => Number.parseFloat(value) || 0;
    const frame = style ? px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth) : 0;
    const amount = document.querySelector('.approval-amount b');
    const shown = preview && preview.offsetParent !== null;
    return {
      viewport: innerHeight,
      conversationTop: r(conversation).top,
      island: { top: r(island).top, bottom: r(island).bottom, overflow: island.scrollHeight - island.clientHeight },
      room: px(getComputedStyle(document.querySelector('.composer-island-slot')).getPropertyValue('--island-approval-room')),
      padBottom: px(getComputedStyle(prompt).paddingBottom),
      promptOverflow: prompt.scrollHeight - prompt.clientHeight,
      fit: document.querySelector('.composer-island-slot').getAttribute('data-approval-fit') ?? '',
      preview: shown
        ? {
            height: preview.offsetHeight,
            natural: preview.scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth),
            threeLines: frame + 3 * px(style.lineHeight),
            amount: amount ? r(amount).top >= r(preview).top - 0.5 && r(amount).bottom <= r(preview).bottom + 0.5 : null,
          }
        : null,
      previewScrolls: preview ? preview.scrollHeight > preview.clientHeight : false,
      kept: kept.map((node) => ({ name: node.className || node.tagName, top: r(node).top, bottom: r(node).bottom })),
      focused: document.activeElement?.tagName,
    };
  };
  window.__shortMeasure = () => {
    const r = (node) => node.getBoundingClientRect();
    const island = document.querySelector('.composer-island');
    const title = document.querySelector('.approval-title');
    const preview = document.querySelector('.approval-preview');
    const row = preview.querySelector('.approval-preview-row');
    const buttons = [...document.querySelectorAll('.approval-buttons > .approval-button')];
    return {
      fit: document.querySelector('.composer-island-slot').getAttribute('data-approval-fit') ?? '',
      island: { top: r(island).top, bottom: r(island).bottom, scrolls: island.scrollHeight > island.clientHeight + 1 },
      title: { top: r(title).top, bottom: r(title).bottom },
      preview: { top: r(preview).top, bottom: r(preview).bottom },
      row: { top: r(row).top, bottom: r(row).bottom },
      buttons: buttons.map((b) => ({ top: r(b).top, bottom: r(b).bottom })),
      sticky: getComputedStyle(document.querySelector('.approval-buttons')).position,
    };
  };
  // Resolves once every finite animation/transition has finished and a frame
  // has since delivered the resize observers (the dock's fit steps).
  window.__idle = async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (;;) {
      await frames();
      const running = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity && a.playState !== 'finished' && a.playState !== 'idle');
      if (running.length === 0) return;
      await Promise.all(running.map((a) => a.finished.catch(() => {})));
    }
  };
  window.__measure = () => {
    const box =(node) => node.getBoundingClientRect();
    const prompt = document.querySelector('.approval-prompt');
    const buttons = [...prompt.querySelectorAll('.approval-buttons > .approval-button')];
    const preview = prompt.querySelector('.approval-preview');
    const composer = document.querySelector('.composer');
    const p = box(prompt);
    const outside = [...prompt.querySelectorAll('*')].filter((node) => {
      const r = box(node);
      return r.width > 0 && (r.left < p.left - 0.5 || r.right > p.right + 0.5);
    }).map((node) => node.className?.baseVal ?? node.className);
    return {
      card: p.width,
      composer: box(composer).width,
      cardOverflow: prompt.scrollWidth - prompt.clientWidth,
      previewOverflow: preview.scrollWidth - preview.clientWidth,
      previewWidth: box(preview).width,
      previewHeight: preview.clientHeight,
      previewScrolls: preview.scrollHeight > preview.clientHeight,
      row: box(prompt.querySelector('.approval-buttons')).width,
      buttons: buttons.map((b) => {
        const r = box(b);
        return { w: r.width, h: r.height, left: r.left, top: r.top, tone: b.dataset.tone || '', kbd: Boolean(b.querySelector('.approval-kbd')?.offsetParent) };
      }),
      labelsFit: buttons.every((b) => b.scrollWidth <= b.clientWidth + 0.5),
      outside,
      focused: document.activeElement?.textContent || '',
    };
  };
`;

async function page(t, { phone = false } = {}) {
  const bundle = await build({
    plugins: [
      {
        name: 'worker-stub',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
            contents: 'export default class {};',
            loader: 'js',
          }));
        },
      },
    ],
    stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
    outfile: 'approval-prompt-layout.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  const shell = phone ? '<html data-mixdog-mobile-tabs><head><style>' : '<html><head><style>';
  const root = phone
    ? '<section class="conversation" id="root" style="display:flex;flex-direction:column;height:100vh"></section>'
    : '<div id="root"></div>';
  await tab.setContent(`<!doctype html>${shell}
    body { margin: 0; font-family: sans-serif; }
    ${STYLES}
    #root { position: fixed; right: 0; bottom: 0; left: 0; height: 100vh; display: flex; flex-direction: column; justify-content: flex-end; }
    .composer-region { --pane-column: 800px; --pane-inset: 16px; display: flex; flex-direction: column; max-height: 100%; }
    ${phone ? '#root { position: static; justify-content: stretch; }' : ''}
  </style></head><body>${root}</body></html>`);
  await tab.addScriptTag({ content: script });
  return tab;
}

const near = (a, b) => Math.abs(a - b) <= 0.75;
const idle = (tab) => tab.evaluate(() => window.__idle());
// The card answers keys (and shows its chips) once its settle window is over.
const keysOpen = (tab) => tab.waitForFunction(() => document.querySelector('.approval-prompt')?.hasAttribute('data-keys'));

test('the docked card never breaks: equal buttons as wide as the preview, never wider than the composer', async (t) => {
  const tab = await page(t);
  for (const width of [1400, 900, 600, 360]) {
    for (const scenario of ['standard', 'german', 'files', 'danger']) {
      await tab.setViewport({ width, height: 900 });
      await tab.evaluate((name) => window.__render(name), scenario);
      await idle(tab);
      const m = await tab.evaluate(() => window.__measure());
      const label = `${scenario} @${width}px`;
      assert.ok(m.card <= m.composer + 0.5, `${label}: card ${m.card} ≤ composer ${m.composer}`);
      assert.ok(m.card <= 560.5, `${label}: card stays within 560px`);
      assert.ok(m.cardOverflow <= 0, `${label}: no horizontal overflow in the card ${JSON.stringify(m)}`);
      assert.ok(m.previewOverflow <= 0, `${label}: long URLs and paths wrap inside the preview`);
      assert.deepEqual(m.outside, [], `${label}: nothing pokes out of the card`);
      assert.ok(m.labelsFit, `${label}: no label spills out of its button`);
      assert.ok(near(m.row, m.previewWidth), `${label}: the row is exactly as wide as the preview`);
      // Equal columns; on the phone sheet the primary takes the full top row
      // and the rest share the row below in equal columns.
      const equal = width <= 640 ? m.buttons.filter((b) => !b.tone) : m.buttons;
      const widths = equal.map((b) => b.w);
      assert.ok(
        widths.every((w) => near(w, widths[0])),
        `${label}: equal button widths ${widths}`
      );
      if (width <= 640) {
        const primary = m.buttons.find((b) => b.tone);
        assert.ok(near(primary.w, m.row), `${label}: the primary spans the row`);
      }
      const stacked = new Set(m.buttons.map((b) => Math.round(b.top))).size === m.buttons.length;
      if (width <= 640) {
        // The phone/narrow layout: primary on top, at least 44px (a long
        // label wraps rather than being cut), no shortcut chips.
        assert.ok(
          m.buttons.every((b) => b.h >= 44),
          `${label}: 44px buttons`
        );
        const top = m.buttons.reduce((a, b) => (b.top < a.top ? b : a));
        assert.ok(top.tone, `${label}: the primary is on top`);
        assert.ok(
          m.buttons.every((b) => !b.kbd),
          `${label}: no shortcut chips`
        );
      } else {
        assert.ok(!stacked || m.buttons.length === 1, `${label}: one row at desktop widths`);
        assert.ok(
          m.buttons.every((b) => b.h === 30),
          `${label}: 30px buttons`
        );
      }
      if (scenario === 'files') {
        assert.ok(m.previewScrolls && m.previewHeight <= 200, `${label}: many files scroll inside the preview`);
      }
      if (scenario === 'danger') assert.match(m.focused, /^Deny/, `${label}: focus starts on Deny`);
    }
  }
});

test('a narrow pane (split view, side panel open) stacks the row at desktop media width', async (t) => {
  const tab = await page(t);
  await tab.setViewport({ width: 1400, height: 900 });
  await tab.evaluate(() => {
    document.querySelector('#root').style.right = `${1400 - 360}px`;
  });
  await tab.evaluate(() => window.__render('german'));
  await idle(tab);
  const m = await tab.evaluate(() => window.__measure());
  assert.ok(m.card <= 360);
  assert.equal(new Set(m.buttons.map((b) => Math.round(b.top))).size, 3, 'stacked');
  assert.ok(
    m.buttons.every((b) => near(b.w, m.previewWidth)),
    'each as wide as the preview'
  );
  assert.deepEqual(m.outside, []);
  assert.equal(m.cardOverflow, 0);
});

test('a click-only allow (payment, delete, unconfirmed receiver, outside file) ignores Enter and Space; a click allows', async (t) => {
  const tab = await page(t);
  await tab.setViewport({ width: 1400, height: 900 });
  for (const [scenario, allows] of [
    ['danger', ['Allow payment']],
    ['risky', ['Always allow', 'Allow just once']],
  ]) {
    await tab.evaluate((name) => {
      window.__pressed = [];
      window.__render(name);
    }, scenario);
    await idle(tab);
    await keysOpen(tab);
    const focused = () =>
      tab.evaluate(() => document.activeElement?.querySelector('.approval-button-label')?.textContent);
    assert.equal(await focused(), 'Deny', `${scenario}: focus starts on Deny`);
    // Rapid key sequences on the focused allow, each sent as one burst so
    // no timer runs between its events: Enter then Space, Space then Enter,
    // Space held (auto-repeat), Enter held, and the two overlapping.
    const kb = tab.keyboard;
    const BURSTS = [
      [
        ['down', 'Enter'],
        ['up', 'Enter'],
        ['down', 'Space'],
        ['up', 'Space'],
      ],
      [
        ['down', 'Space'],
        ['up', 'Space'],
        ['down', 'Enter'],
        ['up', 'Enter'],
      ],
      [
        ['down', 'Space'],
        ['down', 'Space'],
        ['down', 'Space'],
        ['up', 'Space'],
      ],
      [
        ['down', 'Enter'],
        ['down', 'Enter'],
        ['up', 'Enter'],
      ],
      [
        ['down', 'Enter'],
        ['down', 'Space'],
        ['up', 'Enter'],
        ['up', 'Space'],
      ],
      [
        ['down', 'Space'],
        ['down', 'Enter'],
        ['up', 'Space'],
        ['up', 'Enter'],
      ],
    ];
    for (const label of allows) {
      while ((await focused()) !== label) await tab.keyboard.press('Tab');
      for (let round = 0; round < 50; round += 1) {
        for (const burst of BURSTS) await Promise.all(burst.map(([kind, key]) => kb[kind](key)));
        await kb.press('Enter');
        await kb.press('Space');
        assert.equal(await focused(), label, `${scenario}: focus stays on ${label} (round ${round})`);
        assert.deepEqual(
          await tab.evaluate(() => window.__pressed),
          [],
          `${scenario}: Tab to ${label} + Enter/Space never allows (round ${round})`
        );
      }
    }
    await idle(tab);
    assert.deepEqual(await tab.evaluate(() => window.__pressed), [], `${scenario}: nor a late click`);
    for (const label of allows) {
      const box = await tab.evaluate((text) => {
        const node = [...document.querySelectorAll('.approval-button')].find((b) => b.textContent.startsWith(text));
        const r = node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, label);
      await tab.mouse.click(box.x, box.y);
    }
    assert.deepEqual(await tab.evaluate(() => window.__pressed), allows, `${scenario}: a click allows`);
    // An assistive-tech activation (a click with detail 0 and no key before it) allows.
    await tab.evaluate(() => {
      window.__pressed = [];
      [...document.querySelectorAll('.approval-button[data-pointer-only]')].at(-1).click();
    });
    assert.deepEqual(
      await tab.evaluate(() => window.__pressed),
      allows.slice(-1),
      `${scenario}: element.click() allows`
    );
    // 거절 keeps its keyboard access: Enter on it denies at once, no reason
    // screen (once the card has settled after the decisions above).
    await tab.evaluate(() => {
      window.__pressed = [];
      document.querySelector('.approval-button[data-deny]').focus();
    });
    await keysOpen(tab);
    await tab.keyboard.press('Enter');
    assert.deepEqual(await tab.evaluate(() => window.__pressed), ['deny:'], `${scenario}: Deny by key`);
    assert.equal(
      await tab.evaluate(() => document.querySelector('.approval-deny, textarea[aria-label="What to do instead"]')),
      null,
      `${scenario}: no reason screen`
    );
  }
});

// The order in which a short room reclaims space before the preview gets
// smaller than readable (fitDockedApproval, ComposerIsland.tsx).
const FIT_ORDER = ['row', 'compact', 'scroll'];
// The least room a docked card keeps clear above it (ComposerIsland.tsx).
const APPROVAL_TOP_GAP = 8;

test('the trimmed card: the neutral island edge, no text lines under it, the scope and click notes as tooltips, shortcut chips only with focus inside', async (t) => {
  const tab = await page(t);
  await tab.setViewport({ width: 1400, height: 900 });
  for (const theme of ['dark', 'light']) {
    await tab.evaluate((name) => {
      if (name === 'light') document.documentElement.setAttribute('data-mixdog-theme', 'light');
      else document.documentElement.removeAttribute('data-mixdog-theme');
    }, theme);
    for (const scenario of ['standard', 'danger', 'risky']) {
      await tab.evaluate((name) => window.__render(name), scenario);
      await idle(tab);
      await keysOpen(tab);
      const m = await tab.evaluate(async () => {
        const island = document.querySelector('.composer-island');
        const prompt = document.querySelector('.approval-prompt');
        const probe = document.createElement('div');
        probe.className = 'composer-island';
        document.body.append(probe);
        const neutral = getComputedStyle(probe).boxShadow;
        probe.remove();
        const chips = () =>
          [...prompt.querySelectorAll('.approval-kbd')].filter((chip) => chip.getClientRects().length > 0).length;
        const withFocus = chips();
        // Focus outside the card's conversation (here: a stray button) takes the chips away.
        const outside = document.createElement('button');
        document.body.append(outside);
        outside.focus();
        while (prompt.hasAttribute('data-keys')) await new Promise((resolve) => requestAnimationFrame(resolve));
        const blurred = chips();
        outside.remove();
        return {
          mode: island.dataset.mode,
          edge: getComputedStyle(island).boxShadow,
          neutral,
          promptBorder: getComputedStyle(prompt).borderTopWidth,
          lines: prompt.querySelectorAll('.approval-reason, .approval-note, .approval-scope').length,
          buttons: [...prompt.querySelectorAll('.approval-buttons > .approval-button')].map((b) => ({
            label: b.querySelector('.approval-button-label').textContent,
            title: b.title,
            described: (b.getAttribute('aria-describedby') || '')
              .split(' ')
              .filter(Boolean)
              .map((id) => {
                const node = document.getElementById(id);
                const r = node.getBoundingClientRect();
                return { text: node.textContent, seen: r.width > 1 && r.height > 1 };
              }),
          })),
          withFocus,
          blurred,
          dot: getComputedStyle(prompt.querySelector('.approval-need-dot')).display,
        };
      });
      const at = `${scenario} ${theme} ${JSON.stringify(m)}`;
      assert.equal(m.mode, 'approval');
      assert.equal(m.edge, m.neutral, `${at}: the approval island keeps the neutral edge, no amber ring`);
      assert.equal(m.promptBorder, '0px', `${at}: docked, the card draws no border of its own`);
      assert.equal(m.lines, 0, `${at}: no reason, note or scope line`);
      assert.notEqual(m.dot, 'none', `${at}: the need-dot stays`);
      const always = m.buttons.find((b) => b.label === 'Always allow');
      if (always) assert.match(always.title, /won't ask again/, `${at}: the scope is the tooltip of Always allow`);
      for (const button of m.buttons) {
        if (button.label !== 'Always allow') {
          assert.ok(button.title === button.label || /click/.test(button.title), `${at}: ${button.label} title`);
        }
      }
      if (scenario !== 'standard') {
        const allow = m.buttons.at(-1);
        assert.equal(allow.title, 'Allowing takes a click; Enter does not allow.');
        assert.deepEqual(
          allow.described,
          [{ text: 'Allowing takes a click; Enter does not allow.', seen: false }],
          `${at}: the click note is the allow's hidden accessible description`
        );
      }
      assert.ok(m.withFocus > 0, `${at}: chips show while focus is inside the card`);
      assert.equal(m.blurred, 0, `${at}: chips hide when focus is outside the card's conversation`);
    }
  }
  // Off the dock (a floating or held card) the frame is the neutral border.
  await tab.evaluate(() => document.documentElement.removeAttribute('data-mixdog-theme'));
  await idle(tab);
  const floating = await tab.evaluate(() => {
    const prompt = document.querySelector('.approval-prompt').cloneNode(true);
    document.body.append(prompt);
    const probe = document.createElement('div');
    probe.style.borderColor = 'var(--mx-border-muted)';
    document.body.append(probe);
    const style = getComputedStyle(prompt);
    const result = {
      width: style.borderTopWidth,
      color: style.borderTopColor,
      neutral: getComputedStyle(probe).borderTopColor,
    };
    prompt.remove();
    probe.remove();
    return result;
  });
  assert.equal(floating.width, '1px');
  assert.equal(floating.color, floating.neutral, 'a floating card has the neutral border');
});

test('phone: on a very short viewport (keyboard up) nothing overlaps: title, the recipient row and the buttons stay apart, the island scrolls if it must', async (t) => {
  const tab = await page(t, { phone: true });
  const settle = () => idle(tab);
  for (const [width, height] of [
    [375, 376],
    [390, 400],
  ]) {
    await tab.setViewport({ width, height });
    await tab.evaluate(() => window.__renderPhone('email'));
    await settle();
    const m = await tab.evaluate(() => window.__shortMeasure());
    if (process.env.APPROVAL_SHOTS)
      await tab.screenshot({ path: `${process.env.APPROVAL_SHOTS}/short-${width}x${height}.png` });
    const at = `${width}×${height} ${JSON.stringify(m)}`;
    const first = m.buttons[0];
    assert.ok(m.title.bottom <= m.preview.top + 0.5, `${at}: the title sits above the preview`);
    assert.ok(m.preview.bottom <= first.top + 0.5, `${at}: the buttons never cover the preview`);
    assert.ok(
      m.row.bottom <= m.preview.bottom + 0.5 && m.row.top >= m.preview.top - 0.5,
      `${at}: the recipient row shows whole`
    );
    assert.ok(m.title.top >= m.island.top - 0.5, `${at}: the title is not cut off at the top`);
    if (m.island.scrolls)
      assert.equal(m.sticky, 'static', `${at}: a scrolling island does not float the buttons over the content`);
    else assert.ok(first.bottom <= m.island.bottom + 0.5, `${at}: the buttons are on screen`);
  }
});

test('phone: the docked card keeps its buttons on screen (411×806, and 470px / 400px with the keyboard)', async (t) => {
  const tab = await page(t, { phone: true });
  const settle = () => idle(tab);
  const check = (m, label) => {
    const at = `${label} ${JSON.stringify(m)}`;
    assert.ok(
      m.island.top >= m.conversationTop + APPROVAL_TOP_GAP - 0.5,
      `${at}: the island stays in the pane, a gap clear of its top edge`
    );
    assert.ok(m.island.overflow <= 1, `${at}: nothing is clipped or scrolled away in the island`);
    assert.ok(m.promptOverflow <= 1, `${at}: nothing spills out of the card`);
    for (const node of m.kept) {
      // Inside the island, above the card's own bottom padding.
      assert.ok(
        node.top >= m.island.top - 0.5 &&
          node.bottom <= m.island.bottom - m.padBottom + 0.5 &&
          node.bottom <= m.viewport,
        `${at}: ${node.name} is visible, the card's bottom padding kept`
      );
    }
    if (m.preview) {
      // The approved content stays readable: three lines, or all of it.
      assert.ok(
        m.preview.height >= Math.min(m.preview.natural, m.preview.threeLines) - 0.5,
        `${at}: the preview stays readable`
      );
      if (m.preview.amount !== null) assert.ok(m.preview.amount, `${at}: the amount shows whole`);
    }
    const fit = m.fit ? m.fit.split(' ') : [];
    assert.deepEqual(fit, FIT_ORDER.slice(0, fit.length), `${at}: space is reclaimed in the defined order`);
    assert.ok(!fit.includes('scroll'), `${at}: the card fits without scrolling`);
  };
  for (const height of [806, 470, 400]) {
    await tab.setViewport({ width: 411, height });
    await tab.evaluate(() => window.__renderPhone('payment'));
    await settle();
    const pay = await tab.evaluate(() => window.__phoneMeasure());
    assert.equal(pay.kept.length, 2, 'two buttons');
    check(pay, `payment ${height}px`);
    if (height === 806) assert.equal(pay.fit, '', 'a tall room reclaims nothing');
    await tab.evaluate(() => window.__renderPhone('email'));
    await settle();
    const m = await tab.evaluate(() => window.__phoneMeasure());
    assert.equal(m.kept.length, 3, 'three buttons');
    check(m, `${height}px`);
    assert.ok(m.previewScrolls, `${height}px: the tall preview gives way first and scrolls`);
  }
});

test('desktop: in a short pane (1200×340, 1200×300) the approval card never sits under the model line: a fit step engages and the buttons are hit-testable', async (t) => {
  const tab = await page(t);
  const settle = () => idle(tab);
  for (const height of [340, 300, 280]) {
    await tab.setViewport({ width: 1200, height });
    await tab.evaluate(() => window.__renderDesktopShell());
    await settle();
    const m = await tab.evaluate(() => window.__desktopShortMeasure());
    if (process.env.APPROVAL_SHOTS)
      await tab.screenshot({ path: `${process.env.APPROVAL_SHOTS}/desktop-short-${height}.png` });
    const at = `1200×${height} ${JSON.stringify(m)}`;
    assert.ok(m.fit !== '', `${at}: a fit step engages`);
    assert.ok(m.island.top >= 0, `${at}: the island stays inside the pane`);
    assert.ok(m.island.bottom <= m.line.top + 0.5, `${at}: the island ends above the model line`);
    for (const [i, hit] of m.hit.entries()) {
      assert.ok(hit.onScreen && hit.inButton, `${at}: button ${i} is visible and hit-testable`);
      assert.ok(m.buttons[i].bottom <= m.line.top + 0.5, `${at}: button ${i} is not under the model line`);
    }
  }
});
test('desktop: the composer collapses to one line while a short pane holds an approval and is back to normal after it resolves', async (t) => {
  const tab = await page(t);
  const settle = () => idle(tab);
  await tab.setViewport({ width: 1200, height: 300 });
  await tab.evaluate(() => window.__renderDesktopShell());
  await settle();
  const input = () => tab.evaluate(() => document.querySelector('form.composer textarea').offsetHeight);
  assert.ok((await input()) <= 30, 'one line while the approval is docked');
  await tab.evaluate(() => window.__renderDesktopShell(false));
  await settle();
  assert.ok((await input()) > 60, 'the draft shows again once the approval is gone');
});

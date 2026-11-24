// AGENT_PANEL_SHOT_TAG=before|after names the screenshots written under
// %TEMP%/agent-panel-header/.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { PANEL_TYPE_ROLES, typeOffTier } from './test-support/panel-type-roles.mjs';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const HOST =
  '<section class="conversation" id="host" style="display:flex;flex-direction:column;height:100vh;margin:0"></section>';
// Korean is the reported one; German and Russian carry the longest labels.
const LANGUAGES = ['ko', 'de', 'ru', 'es', 'fr', 'it', 'ja', 'pt-BR', 'vi', 'zh-CN', 'zh-TW'];
const SHOTS = join(tmpdir(), 'agent-panel-header');
const TAG = process.env.AGENT_PANEL_SHOT_TAG || 'run';

const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import i18next from './i18n.ts';
  import { ComposerDock } from './ComposerDock.tsx';
  import ko from './locales/ko.json';
  import de from './locales/de.json';
  import ru from './locales/ru.json';
  import es from './locales/es.json';
  import fr from './locales/fr.json';
  import it from './locales/it.json';
  import ja from './locales/ja.json';
  import ptBR from './locales/pt-BR.json';
  import vi from './locales/vi.json';
  import zhCN from './locales/zh-CN.json';
  import zhTW from './locales/zh-TW.json';
  const h = React.createElement;
  const NOW = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  // The island remembers a session's last usage answer, so every case gets a
  // lead of its own (__lead) instead of a fresh document.
  let LEAD = 'lead-a';
  let rows = [];
  let usage = null;
  const row = (tag, overrides) => ({
    tag: LEAD + ':' + tag, agent: 'worker', sessionId: 's-' + LEAD + '-' + tag, ownerSessionId: LEAD, parentSessionId: LEAD,
    title: tag, provider: 'anthropic', model: 'claude-opus-4-5', effort: 'auto',
    status: 'idle', stage: 'idle', startedAt: NOW - 50_000, idleSince: iso(NOW - 10_000), ...overrides,
  });
  // 17 agents like the report: 1 running, 1 queued, 15 resting (clearable).
  const build = () => {
  const own = [
    { tag: 'lead:' + LEAD, agent: 'lead', sessionId: LEAD, ownerSessionId: LEAD, status: 'running', stage: 'running', startedAt: NOW - 60_000 },
    row('feat-approval-button-ui-with-a-really-long-branch-name', { status: 'running', stage: 'running', idleSince: null, turnStartedAt: NOW - 583_000, todo: { completed: 6, total: 9 } }),
    row('queued-one', { status: 'queued', stage: 'queued', idleSince: null, todo: { completed: 0, total: 3 } }),
    row('needs-approval', { status: 'running', stage: 'running', idleSince: null, turnStartedAt: NOW - 5_000, awaitingUser: 'approval' }),
    row('long-route', { model: 'a-model-whose-name-is-far-too-long-to-fit-in-a-phone-row-at-all', effort: 'high', idleSince: null, status: 'running', stage: 'running', turnStartedAt: NOW - 3_723_000, todo: { completed: 8, total: 9 } }),
    ...Array.from({ length: 13 }, (_, i) => row('rested-' + i)),
  ];
    rows.push(...own);
  };
  // The agent pool is one shared snapshot, so every lead's 17 agents are in
  // it from the start and a case picks its own by the session it renders.
  for (let n = 0; n < 48; n++) { LEAD = 'lead-' + n; build(); }
  LEAD = 'lead-0';
  const sessions = Object.fromEntries(rows.map((r, i) => [r.sessionId, {
    turns: 3, tokens: 67_751_234 + i, input: 1000, cacheRead: 5000, cacheWrite: 10, unmeasuredTurns: 0, costUsd: 1, costUnpricedTurns: 0,
  }]));
  usage = {
    turns: 9, tokens: 200_000_000, input: 1000, cacheRead: 98000, cacheWrite: 10, unmeasuredTurns: 0, costUsd: 120.5, costUnpricedTurns: 0,
    agents: { turns: 20, tokens: 580_000_000, input: 1000, cacheRead: 98000, cacheWrite: 10, unmeasuredTurns: 0, costUsd: 178.85, costUnpricedTurns: 0 },
    sessions,
  };
  // The same session with figures the ledger can only bound: unmeasured and unpriced turns on both parts and on
  // every other row, so every item of the footer and those rows are floors, which their tooltips say.
  const exact = usage;
  const floored = {
    ...exact,
    unmeasuredTurns: 1,
    costUnpricedTurns: 1,
    agents: { ...exact.agents, unmeasuredTurns: 3, costUnpricedTurns: 3 },
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, s], i) => [id, i % 2 ? s : { ...s, unmeasuredTurns: 1 }])),
  };
  window.__floors = (on) => { usage = on ? floored : exact; };
  // A long-running session as reported: its agents at 23B tokens beside a Lead at 5.1B, a high cache hit, a four-figure cost.
  const large = {
    ...exact, tokens: 5_100_000_000, input: 3_000_000, cacheRead: 97_000_000, costUsd: 4_000,
    agents: { ...exact.agents, tokens: 23_000_000_000, costUsd: 8_724.54 },
  };
  window.__large = (on) => { usage = on ? large : exact; };
  // The phone's report: a Lead at 5.3B tokens whose agents' aggregate holds calls that reported no usage or price,
  // while each agent's own row is exact.
  const reported = {
    ...large, tokens: 5_300_000_000,
    agents: { ...large.agents, turns: 121_873, unmeasuredTurns: 68, costUnpricedTurns: 68 },
  };
  window.__reported = (on) => { usage = on ? reported : exact; };
  window.__lead = (n) => { LEAD = 'lead-' + n; };
  // __usageGate holds getSessionUsage so the loading footer can be measured.
  window.mixdogDesktop = new Proxy({
    // The island reads the pool from the core's agentPool section.
    sections: {
      core: async () => false,
      snapshot: async () => ({ status: 'ready', entries: [{ section: 'agentPool', key: null, revision: 1, value: rows }] }),
      subscribe: () => () => {},
    },
    invokeCapability: async () => { if (window.__usageGate) await window.__usageGate; return { value: usage }; },
  }, {
    get: (target, name) => name in target ? target[name]
      : String(name).startsWith('subscribe') ? () => () => {} : async () => [],
  });
  let root = null;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  // Polls once per frame until the condition holds; a bound turns a missing
  // element into a failure instead of a hang.
  const until = async (what, ready, bound = 3000) => {
    const start = performance.now();
    while (!ready()) {
      if (performance.now() - start > bound) throw new Error('timed out waiting for ' + what);
      await frame();
    }
  };
  const loaded = () => /\\d/.test(document.querySelector('.composer-island-summary')?.textContent ?? '');
  // Resting: no animation running toward an end (a working kind's pulse never ends), no island easing, and the
  // panel, its first row and the footer on the same boxes for three frames in a row.
  const calm = async () => {
    const signature = () => {
      const slot = document.querySelector('.composer-island-slot');
      const moving = document.getAnimations().some((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
      const rest = !moving && !slot?.hasAttribute('data-motion') && slot?.getAttribute('data-presence') !== 'grace';
      const boxes = ['.composer-island-panel', '.composer-island-agent-item', '.composer-island-summary']
        .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
        .map((b) => (b ? [b.left, b.top, b.width, b.height].join() : ''));
      return rest ? boxes.join('|') : null;
    };
    let last = null;
    let same = 0;
    const start = performance.now();
    while (same < 3) {
      if (performance.now() - start > 5000) throw new Error('the panel never came to rest');
      await frame();
      const now = signature();
      same = now !== null && now === last ? same + 1 : 0;
      last = now;
    }
  };
  const geometry = () => {
    const rect = (node) => { const b = node.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 2) / 2); };
    const panel = document.querySelector('.composer-island-panel');
    const summary = panel.querySelector('.composer-island-summary');
    return {
      panel: rect(panel),
      firstRow: rect(panel.querySelector('.composer-island-agent-item')),
      // Each row's height and its name column's width with what it reads, to name a row that grows or whose
      // figures column widens.
      rowHeights: [...panel.querySelectorAll('.composer-island-agent-item')].map((item) => [
        Math.round(item.getBoundingClientRect().height),
        item.textContent,
        item.querySelector('.schedules-row-copy').getBoundingClientRect().width,
      ]),
      foot: rect(panel.querySelector('.composer-island-panel-foot')),
      line: Boolean(summary),
      text: summary?.textContent ?? '',
      overflow: summary ? summary.scrollWidth - summary.clientWidth : 0,
    };
  };
  // Opens the panel with getSessionUsage held, records the footer's geometry
  // (Clean up alone, no usage line yet), releases the answer and records it again.
  window.__renderHeld = async (language) => {
    let release;
    window.__usageGate = new Promise((r) => { release = r; });
    await window.__render(language, true);
    await calm();
    const loading = geometry();
    release();
    window.__usageGate = null;
    await until('the usage figures', loaded);
    await calm();
    return { loading, data: geometry() };
  };
  window.__render = async (language, held) => {
    if (root) { root.unmount(); root = null; }
    const catalogs = { ko, de, ru, es, fr, it, ja, 'pt-BR': ptBR, vi, 'zh-CN': zhCN, 'zh-TW': zhTW };
    if (language !== 'en') i18next.addResourceBundle(language, 'translation', catalogs[language]);
    await i18next.changeLanguage(language);
    root = createRoot(document.getElementById('host'));
    flushSync(() => root.render(h(React.Fragment, null,
      h('div', { className: 'transcript-shell', style: { flex: '1 1 0', minHeight: 0 } }),
      h(ComposerDock, {
        sessionId: LEAD, reviewSessionId: LEAD, goalSubmissionId: '', showProjectSelector: false,
        reviewItems: [], reviewActive: true, reviewBusy: false, reviewCwd: '',
        children: h('form', { className: 'composer', style: { height: '96px' } }),
      }))));
    await until('the Agents segment', () => document.querySelector('.composer-island-seg-agents'));
    document.querySelector('.composer-island-seg-agents').click();
    if (held) { await until('the footer', () => document.querySelector('.composer-island-panel-foot')); return; }
    await until('the usage figures', loaded);
    await calm();
  };
  // The foot at the pane's width: its usage line and Clean up on one row, Clean up in its last slot at the row's end,
  // the line clear of it.
  window.__footRow = async (width) => {
    document.querySelector('#host').style.width = width + 'px';
    await calm();
    const box = (node) => node.getBoundingClientRect();
    const panel = document.querySelector('.composer-island-panel');
    const foot = panel.querySelector('.composer-island-panel-foot');
    const summary = foot.querySelector('.composer-island-summary');
    const end = foot.querySelector('.composer-island-panel-foot-end');
    const [s, e, f] = [box(summary), box(end), box(foot)];
    const centre = (b) => (b.top + b.bottom) / 2;
    return {
      panel: box(panel).width,
      shown: !summary.hidden,
      text: summary.textContent,
      parts: summary.children.length,
      sameRow: Math.abs(centre(s) - centre(e)) <= 1,
      footHeight: f.height,
      last: foot.lastElementChild === end,
      atEnd: Math.abs(e.right - (f.right - Number.parseFloat(getComputedStyle(foot).paddingRight))) <= 0.5,
      clear: s.right <= e.left + 0.5,
    };
  };
  window.__measure = () => {
    const box = (node) => node.getBoundingClientRect();
    const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const name = (node) => (node.className?.baseVal ?? node.className) + ':' + (node.textContent || '').trim().slice(0, 24);
    const panel = document.querySelector('.composer-island-panel');
    const head = panel.querySelector('.composer-island-phead');
    const leaves = [...head.children];
    const overlaps = [];
    for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
      if (overlap(box(leaves[i]), box(leaves[j]))) overlaps.push(name(leaves[i]) + ' × ' + name(leaves[j]));
    }
    const p = box(panel);
    const frame = box(document.querySelector('.composer-island'));
    const clipped = leaves.filter((node) => {
      const r = box(node);
      const m = box(head);
      return r.left < m.left - 0.5 || r.right > m.right + 0.5 || node.scrollWidth > node.clientWidth + 1;
    }).map(name);
    const hiddenByAncestor = (node) => {
      for (let a = node.parentElement; a && a !== panel; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === 'hidden') return true;
      }
      return false;
    };
    const outside = [...panel.querySelectorAll('*')].filter((node) => {
      if (hiddenByAncestor(node)) return false;
      const r = box(node);
      return r.width > 0 && (r.left < p.left - 0.5 || r.right > p.right + 0.5);
    }).map(name);
    const foot = panel.querySelector('.composer-island-panel-foot');
    const action = foot.querySelector('.composer-island-panel-foot-end [data-kind="clear-finished"]');
    const close = head.querySelector('.composer-island-close');
    const size = (node) => node ? { w: box(node).width, h: box(node).height } : null;
    const items = [...panel.querySelectorAll('.composer-island-agent-item')];
    const touch = document.documentElement.hasAttribute('data-mixdog-mobile-tabs');
    const rowOverlaps = [];
    for (const item of items) {
      const it = box(item);
      const status = item.querySelector('.agent-activity-status');
      // The name's text itself (not just its flex box) must stay clear of the step and state columns.
      const right = box(status);
      for (const text of item.querySelectorAll('.agent-pool-name')) {
        const range = document.createRange();
        range.selectNodeContents(text);
        const t = range.getBoundingClientRect();
        const visible = { left: t.left, right: Math.min(t.right, box(text).right), top: t.top, bottom: t.bottom };
        for (const column of [right, box(item.querySelector('.agent-row-steps'))]) {
          if (overlap(visible, column)) rowOverlaps.push('text ' + name(text));
        }
      }
      if (right.right > it.right + 0.5) rowOverlaps.push('the state leaves the row');
      // One line: no model line or figure under the name (on touch, the 44px touch row).
      if (it.height > (touch ? 44 : 37) || item.querySelector('.model-route-label, .composer-island-agent-tokens')) {
        const row = item.querySelector('.agent-pool-row');
        rowOverlaps.push('more than one line: ' + it.height + 'px: ' + name(row) + ' [' +
          [...row.querySelectorAll('*')].filter((node) => box(node).height > 24)
            .map((node) => (node.className?.baseVal ?? node.className) + ' ' + Math.round(box(node).height) + '/' + Math.round(box(node).width)).join('; ') + ']');
      }
    }
    // The step figures, each in its row's step column, on the name's line.
    const marks = [...panel.querySelectorAll('.agent-row-steps')].filter((node) => node.textContent).map((node) => {
      const mark = box(node);
      const nameBox = box(node.parentElement.querySelector('.agent-pool-name'));
      return Math.abs((mark.top + mark.bottom) / 2 - (nameBox.top + nameBox.bottom) / 2) <= 3;
    });
    // The rows' rings: each a 16px slot centred on its line's text, on one left line.
    const centre = (b) => (b.top + b.bottom) / 2;
    const slotLines = (slots) => {
      const left = slots.length ? box(slots[0][0]).left : 0;
      return slots.map(([slot, text]) => {
        const mark = box(slot);
        return mark.width === 16 && Math.abs(mark.left - left) <= 0.5 && Math.abs(centre(mark) - centre(box(text))) <= 0.5
          ? null
          : [name(slot), mark.width, mark.left - left, centre(mark) - centre(box(text))].join('/');
      });
    };
    const brands = slotLines(
      items.map((item) => [item.querySelector('.agent-row-ring'), item.querySelector('.agent-pool-name')])
    ).filter(Boolean);
    // Touch rows: every fold head and agent row at least the 44px touch floor.
    const shortRows = touch
      ? [...panel.querySelectorAll('.composer-island-agent-fold, .composer-island-agent-item > .agent-pool-row')]
          .filter((node) => box(node).height < 44)
          .map(name)
      : [];
    // The panel's type on its tokens: a state, a clock and a step mark in the regular weight, the foot's usage line
    // at the supporting size, regular, muted.
    const token = (property, value) => {
      const probe = document.createElement('span');
      probe.style[property] = value;
      panel.append(probe);
      const read = getComputedStyle(probe)[property];
      probe.remove();
      return read;
    };
    const regular = token('fontWeight', 'var(--mx-weight-regular)');
    const type = {
      heavy: [...panel.querySelectorAll('.composer-island-agent-item :is(.agent-activity-elapsed, .agent-row-steps)')]
        .filter((node) => getComputedStyle(node).fontWeight !== regular)
        .map(name),
    };
    const list = panel.querySelector('.composer-island-jobs');
    const shown = box(list);
    // Frameless: no rule under the head or between the list's groups and rows; the one rule stands above the foot's
    // actions, between the text insets.
    const edge = (node, side) => Number.parseFloat(getComputedStyle(node)['border' + side + 'Width']) || 0;
    const footStyle = getComputedStyle(foot);
    const inset = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--island-panel-inset'));
    const rules = {
      head: edge(head, 'Bottom'),
      list: [...list.children].filter((child) => edge(child, 'Top') || edge(child, 'Bottom')).map(name),
      footBorder: edge(foot, 'Top'),
      footRule:
        footStyle.backgroundImage.startsWith('linear-gradient') &&
        footStyle.backgroundSize.startsWith('calc(100% - ' + 2 * inset + 'px) '),
      footSize: footStyle.backgroundSize,
    };
    const cutRows = items
      .filter((item) => box(item).top < shown.bottom - 0.5 && box(item).bottom > shown.bottom + 0.5)
      .map(name);
    const names = [...panel.querySelectorAll('.agent-pool-name')];
    const summary = panel.querySelector('.composer-island-summary');
    const summaryStyle = getComputedStyle(summary);
    type.summary =
      summaryStyle.fontSize === token('fontSize', 'var(--mx-font-supporting)') &&
      summaryStyle.fontWeight === regular &&
      summaryStyle.color === token('color', 'var(--mx-text-muted)')
        ? null
        : [summaryStyle.fontSize, summaryStyle.fontWeight, summaryStyle.color].join(' ');
    // The list starts right under the head; the foot 4px under the last whole row shown.
    const lastShown = Math.max(...[...list.children].map((child) => box(child).bottom).filter((bottom) => bottom <= shown.bottom + 0.5));
    const spacing = {
      top: box(list.firstElementChild).top - box(head).bottom,
      foot: box(foot).top - lastShown,
      headHeight: box(head).height,
      footHeight: box(foot).height,
    };
    const parts = summary.hidden ? [] : [...summary.children];
    const summaryOverlaps = [];
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      if (overlap(box(parts[i]), box(parts[j]))) summaryOverlaps.push(name(parts[i]) + ' × ' + name(parts[j]));
    }
    // "Clean up" keeps the footer row's right end beside the usage line.
    const a = action && box(action);
    const f = box(foot);
    const footAction = action && {
      visible: a.width > 0 && a.height > 0,
      inside: a.left >= f.left - 0.5 && a.right <= f.right + 0.5 && a.top >= f.top - 0.5 && a.bottom <= f.bottom + 0.5,
      overSummary: !summary.hidden && overlap(a, box(summary)),
      sameRow: summary.hidden || Math.abs((a.top + a.bottom) / 2 - (box(summary).top + box(summary).bottom) / 2) <= 4,
    };
    return {
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      panel: { width: p.width, frame: frame.width, left: p.left, overflow: panel.scrollWidth - panel.clientWidth },
      head: { height: box(head).height, overflow: head.scrollWidth - head.clientWidth },
      headParts: leaves.map((node) => node.className),
      actionLabel: action?.textContent ?? null,
      overlaps, clipped, outside,
      brands, shortRows, type, spacing,
      footAction,
      close: size(close),
      rows: items.length,
      rowOverlaps,
      marks,
      rules,
      cutRows,
      moreBelow: list.hasAttribute('data-more'),
      namesEllipsize: names.every((n) => getComputedStyle(n).textOverflow === 'ellipsis' && getComputedStyle(n).overflow === 'hidden'),
      summary: {
        overflow: summary.scrollWidth - summary.clientWidth,
        overlaps: summaryOverlaps,
        text: summary.textContent,
        parts: parts.map((part) => part.textContent.replace(/·$/, '')),
        lines: new Set(parts.map((part) => Math.round(box(part).top))).size,
        clipped: parts.some((part) => part.scrollWidth > part.clientWidth + 1 || box(part).right > box(summary).right + 0.5),
        titles: parts.map((part) => part.title),
      },
      markedRows: items.filter((item) => item.querySelector('.agent-pool-row').textContent.includes('≥')).length,
      // A floor's tooltip carries the note on a line of its own, after the model and the total.
      flooredRows: items.filter((item) => item.querySelector('.agent-pool-row').title.split('\\n').length > 2).length,
      rowNotesNamingMark: items.filter((item) => item.querySelector('.agent-pool-row').title.includes('≥')).length,
    };
  };
`;

/** Every broken invariant of one measurement, so a run lists them all. */
function problems(label, m, phone) {
  const found = [];
  const expect = (ok, what) => {
    if (!ok) found.push(`${label}: ${what}`);
  };
  expect(m.rows === 17, `the agents show (${m.rows} rows)`);
  expect(
    m.headParts.join() === 'composer-island-tab,composer-island-close',
    `the head is the chip and the close button: ${m.headParts}`
  );
  expect(m.overlaps.length === 0, `header children overlap: ${m.overlaps}`);
  expect(m.clipped.length === 0, `header text or button clipped: ${m.clipped}`);
  expect(m.brands.length === 0, `rings not a 16px slot on one left line (w/left/offset): ${m.brands}`);
  expect(m.type.heavy.length === 0, `states, clocks or step marks not regular: ${m.type.heavy}`);
  expect(m.type.summary === null, `the usage line is not supporting, regular, muted: ${m.type.summary}`);
  // The head 40px and the foot 44px on a desktop pane (on a phone the touch targets set them).
  expect(
    Math.abs(m.spacing.top) <= 0.5 &&
      Math.abs(m.spacing.foot - 4) <= 0.5 &&
      (phone || (m.spacing.headHeight === 40 && m.spacing.footHeight === 44)),
    `the head 40px, the list under it, the foot 44px and 4px under the last row: ${JSON.stringify(m.spacing)}`
  );
  expect(m.pageOverflow <= 0, `the page overflows by ${m.pageOverflow}px`);
  expect(m.panel.overflow <= 0 && m.head.overflow <= 0, `panel/header overflow ${m.panel.overflow}/${m.head.overflow}`);
  expect(m.outside.length === 0, `pokes out of the panel: ${m.outside}`);
  expect(m.rowOverlaps.length === 0, `row text under the right column: ${m.rowOverlaps}`);
  expect(m.namesEllipsize, 'row titles ellipsize');
  expect(m.marks.length === 3 && m.marks.every(Boolean), `step figures off their names' line: ${m.marks}`);
  expect(
    m.rules.head === 0 && m.rules.list.length === 0 && m.rules.footBorder === 0 && m.rules.footRule,
    `rules: one above the foot between the insets, none else: ${JSON.stringify(m.rules)}`
  );
  expect(m.cutRows.length === 0 && m.moreBelow, `the list ends mid-row or without its shadow: ${m.cutRows}`);
  expect(m.summary.overflow <= 0 && m.summary.overlaps.length === 0, `footer overflow/overlap ${m.summary.overlaps}`);
  const a = m.footAction;
  expect(
    a?.visible && a.inside && !a.overSummary && a.sameRow,
    `Clean up is not at the footer row's end beside the usage line: ${JSON.stringify(a)}`
  );
  if (phone) {
    expect(m.close && m.close.w >= 44 && m.close.h >= 44, `Close is ${JSON.stringify(m.close)}, not a 44px target`);
    expect(m.shortRows.length === 0, `heads or rows under the 44px touch floor: ${m.shortRows}`);
  }
  return found;
}

/** The footer is laid out before getSessionUsage answers: Clean up alone in
 *  it, no usage line and no placeholder; the answer adds the line in the same
 *  footer box, nothing moves, and nothing overflows sideways. */
function stabilityProblems(label, { loading, data }) {
  const found = [];
  const same = (a, b) => a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) <= 0.5);
  const expect = (ok, what) => {
    if (!ok) found.push(`${label}: ${what}`);
  };
  // The usage line fits like the composer's readout (it may drop items as
  // the figures widen), but the footer row keeps its place and height.
  expect(!loading.line, `loading footer holds no usage line: ${loading.text}`);
  expect(
    data.line && /\d/.test(data.text) && !/(^|[\s·])-([\s·]|$)/.test(data.text),
    `data footer carries the figures: ${data.text}`
  );
  expect(same(loading.panel, data.panel), `panel moved ${loading.panel} -> ${data.panel}`);
  expect(same(loading.firstRow, data.firstRow), `rows moved ${loading.firstRow} -> ${data.firstRow}`);
  for (const [index, [height, text, copy]] of data.rowHeights.entries()) {
    const [before, , copyBefore] = loading.rowHeights[index] ?? [];
    expect(before === height, `row ${index} grew ${before} -> ${height}: ${text}`);
    // The token figures arriving add nothing to the figures column: the names keep their room.
    expect(Math.abs(copyBefore - copy) <= 0.5, `row ${index}'s names narrowed ${copyBefore} -> ${copy}: ${text}`);
  }
  expect(same(loading.foot, data.foot), `footer moved ${loading.foot} -> ${data.foot}`);
  expect(loading.overflow <= 0 && data.overflow <= 0, `footer overflows ${loading.overflow}/${data.overflow}`);
  return found;
}

async function bundle(entry, loader) {
  return build({
    stdin: { contents: entry, resolveDir, loader },
    outfile: 'agent-panel-header.out',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
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
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.jpg': 'dataurl',
      '.png': 'dataurl',
    },
  });
}

// One bundle build and one Chrome for the whole file, and one page for each
// form, a 360px phone (the touch layout) and a desktop pane: each case sets
// the pane's width and renders a lead of its own.
const errors = [];
let shared = null;
function sharedBrowser() {
  shared ??= (async () => {
    const [script, styles] = await Promise.all([
      bundle(PAGE, 'tsx'),
      bundle('@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";', 'css'),
    ]);
    const browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    return {
      browser,
      js: script.outputFiles.find((file) => file.path.endsWith('.out')).text,
      css: styles.outputFiles.find((file) => file.path.endsWith('.out')).text,
    };
  })();
  return shared;
}
const pages = new Map();
function formPage(phone) {
  if (!pages.has(phone)) {
    pages.set(
      phone,
      (async () => {
        const { browser, js, css } = await sharedBrowser();
        const tab = await browser.newPage();
        tab.on('pageerror', (error) => errors.push(error.message));
        await tab.setViewport(
          phone
            ? { width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
            : { width: 1400, height: 900 }
        );
        await tab.setContent(
          phone
            ? `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${HOST}</body></html>`
            : `<!doctype html><html><head><style>${css}</style></head><body>${HOST}</body></html>`
        );
        await tab.addScriptTag({ content: js });
        return tab;
      })()
    );
  }
  return pages.get(phone);
}

after(async () => {
  if (shared) await (await shared).browser.close();
});

let leads = 0;
/** The phone's page, or the desktop's with its pane `paneWidth` wide. */
async function sized(paneWidth) {
  const tab = await formPage(!paneWidth);
  // A page behind the other gets no animation frames, and the harness waits on them.
  await tab.bringToFront();
  if (paneWidth)
    await tab.evaluate((width) => {
      document.querySelector('#host').style.width = `${width}px`;
    }, paneWidth);
  return tab;
}
/** A lead no case has used: the island remembers a session's last usage answer, which would hide the loading state
 *  and a changed answer on a re-render. */
const freshLead = (tab) => tab.evaluate((n) => window.__lead(n), ++leads);

// Width is the only thing that makes a label too long, so the narrowest size
// takes every language and a roomier one the longest catalogs plus the
// reported one (ko, de, ru); en is the baseline on the desktop pane.
const LONGEST = ['ko', 'de', 'ru'];

test('the Agents popover header never overlaps or clips on a phone, in any language', async () => {
  const failures = [];
  if (process.env.AGENT_PANEL_SHOT_TAG) mkdirSync(SHOTS, { recursive: true });
  const tab = await sized(0);
  for (const language of LANGUAGES) {
    await freshLead(tab);
    const held = await tab.evaluate((lang) => window.__renderHeld(lang), language);
    failures.push(...stabilityProblems(`${language} @360 loading->data`, held));
    // The settled data state is measured as it stands; the first language also takes the other road, a fresh mount
    // that already has the answer cached.
    if (language === LANGUAGES[0]) await tab.evaluate((lang) => window.__render(lang), language);
    const m = await tab.evaluate(() => window.__measure());
    if (process.env.AGENT_PANEL_SHOT_TAG) {
      await tab.screenshot({ path: join(SHOTS, `${TAG}-${language}-360x800.png`) });
    }
    failures.push(...problems(`${language} @360`, m, true));
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
});

test('figures that are lower bounds stand plain, their tooltips saying so, and keep the footer on one unclipped line and the rows clear, in every language', async () => {
  const failures = [];
  for (const [label, paneWidth, languages] of [
    ['phone', 0, ['en', ...LANGUAGES]],
    ['desktop', 340, ['en', ...LONGEST]],
  ]) {
    const phone = !paneWidth;
    const tab = await sized(paneWidth);
    await tab.evaluate(() => window.__floors(true));
    try {
      for (const language of languages) {
        await freshLead(tab);
        await tab.evaluate((lang) => window.__render(lang), language);
        const m = await tab.evaluate(() => window.__measure());
        const at = `${label} ${language} @${paneWidth || 360}`;
        failures.push(...problems(`${at} floors`, m, phone));
        if (m.summary.text.includes('≥')) failures.push(`${at}: the footer marks a figure: ${m.summary.text}`);
        if (!m.summary.titles.some((title) => title.includes('\n'))) {
          failures.push(`${at}: no footer tooltip says a figure is a floor: ${m.summary.titles}`);
        }
        // The note names no mark: the figures carry none.
        if (m.summary.titles.some((title) => title.includes('≥')) || m.rowNotesNamingMark > 0) {
          failures.push(`${at}: a tooltip names the ≥ mark: ${m.summary.titles}`);
        }
        if (m.summary.lines !== 1 || m.summary.clipped)
          failures.push(`${at}: the footer wraps or clips: ${m.summary.text}`);
        if (m.markedRows > 0) failures.push(`${at}: ${m.markedRows} rows mark their total`);
        if (m.flooredRows === 0) failures.push(`${at}: no row's tooltip says its total is a floor`);
      }
    } finally {
      await tab.evaluate(() => window.__floors(false));
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
});

test("the foot's usage line and Clean up share one row at every pane width, Clean up in the row's last slot, the line fitted to the room it leaves and its cost the amount alone", async () => {
  const failures = [];
  const tab = await sized(900);
  await tab.evaluate(() => window.__large(true));
  try {
    await freshLead(tab);
    await tab.evaluate(() => window.__render('en'));
    const forms = new Set();
    // Down to a pane's floor (PANE_MIN_WIDTH in pane-layout.ts): only there does the three-part line outgrow its room.
    for (let width = 900; width >= 320; width -= 10) {
      const row = await tab.evaluate((next) => window.__footRow(next), width);
      const at = `@${width} (panel ${row.panel}px, "${row.text}")`;
      forms.add(row.parts);
      if (!row.shown) failures.push(`${at}: no usage line`);
      if (!row.sameRow || row.footHeight > 44.5) {
        failures.push(`${at}: the line and Clean up on two rows (${row.footHeight}px)`);
      }
      if (!row.last || !row.atEnd) failures.push(`${at}: Clean up not in the row's last slot at its end`);
      if (!row.clear) failures.push(`${at}: the line runs under Clean up`);
      if (/est\. cost/.test(row.text)) failures.push(`${at}: the cost is labelled`);
    }
    // Wide, the whole line of the agents' own figures (the Lead's 5.1B and $4,000 are its readout's); narrow, parts dropped.
    assert.ok(forms.size > 1, `the line keeps one form at every width: ${[...forms]}`);
    const wide = await tab.evaluate(() => window.__footRow(900));
    assert.match(wide.text, /^23B tokens.*\$8,724\.54$/);
    assert.doesNotMatch(wide.text, /Lead|5\.1B|12,724/);
  } finally {
    await tab.evaluate(() => window.__large(false));
    await tab.evaluate(() => {
      document.querySelector('#host').style.width = '';
    });
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
});

test("on a 412px phone, agents whose usage is a floor get their figures on one line, never a placeholder, the cache hit dropped first and the cost next", async () => {
  const tab = await sized(0);
  await tab.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await tab.evaluate(() => window.__reported(true));
  try {
    await freshLead(tab);
    await tab.evaluate(() => window.__render('ko'));
    const { summary } = await tab.evaluate(() => window.__measure());
    assert.ok(summary.parts.length > 0, `no usage line: ${summary.text}`);
    assert.doesNotMatch(summary.text, /(^|[\s·])-([\s·]|$)/, 'no placeholder');
    assert.match(summary.parts[0], /^23B/);
    const kind = (text) => (text.includes('$') ? 'cost' : text.includes('%') ? 'hit' : 'total');
    const kept = ['total', 'cost', 'hit'].slice(0, summary.parts.length);
    assert.deepEqual(
      summary.parts.map(kind),
      ['total', 'hit', 'cost'].filter((name) => kept.includes(name))
    );
    assert.ok(summary.lines === 1 && !summary.clipped && summary.overflow <= 0, `wraps or clips: ${summary.text}`);
  } finally {
    await tab.evaluate(() => window.__reported(false));
    await tab.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  }
  assert.deepEqual(errors, []);
});

test("the agents panel's type on the session panel's tiers: each role (title, kind line, row name at rest and at work, state and clock, foot line, button) one size, line height and weight token", async () => {
  const tab = await sized(560);
  await freshLead(tab);
  await tab.evaluate(() => window.__render('en'));
  const off = await tab.evaluate(typeOffTier, PANEL_TYPE_ROLES, {
    title: '.composer-island-panel .composer-island-tab',
    kind: '.composer-island-panel .composer-island-agent-fold',
    name: '.composer-island-panel .agent-pool-row:not([data-working]) .agent-pool-name',
    working: '.composer-island-panel .agent-pool-row[data-working] .agent-pool-name',
    state: '.composer-island-panel .agent-pool-row .agent-activity-elapsed',
    foot: '.composer-island-panel .composer-island-summary',
    button: '.composer-island-panel-foot .composer-island-button',
  });
  assert.deepEqual(off, []);
  assert.deepEqual(errors, []);
});

test('a narrow desktop pane gets the same header', async () => {
  const failures = [];
  // 560 is the panel's own width; 340 a split pane or side panel's.
  for (const [paneWidth, languages] of [
    [560, ['en']],
    [340, ['en', ...LANGUAGES]],
  ]) {
    const tab = await sized(paneWidth);
    for (const language of languages) {
      await freshLead(tab);
      const held = await tab.evaluate((lang) => window.__renderHeld(lang), language);
      failures.push(...stabilityProblems(`desktop ${language} @${paneWidth} loading->data`, held));
      if (language === languages[0]) await tab.evaluate((lang) => window.__render(lang), language);
      const m = await tab.evaluate(() => window.__measure());
      failures.push(...problems(`desktop ${language} @${paneWidth}`, m, false));
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
});

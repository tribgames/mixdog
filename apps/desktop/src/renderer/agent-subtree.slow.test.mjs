import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The Leads rows sit under the bot rows with no visual foreignness: the same
// pixel face (a grey pup) in the same avatar box, the provider as a small
// badge where Mixy's star sits, the same title, 2-line muted preview, time and
// spinner / "!" in the same places, and the same row height. Real CSS and
// components in headless Chrome at the default and the narrow pane widths.
// MIXDOG_QA_DIR keeps the screenshots (harmony-*.png).

const lazyChunkBoundary = {
  name: 'lazy-chunk-boundary',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

const PAGE = `
  import "./process-shim";
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { AgentActivityPane } from "./AgentActivityPane";
  import { AgentEditorDialog } from "./workflow-dialogs";
  import { ApprovalFace } from "./approval-prompt";
  import { MIXY_AGENT_ID } from "../shared/agent-contacts";

  const NOW = Date.now();
  const lead = (id, extra = {}) => ({ tag: "lead:" + id, agent: "lead", sessionId: id, ownerSessionId: id, status: "running", stage: "running", turnStartedAt: NOW - 65000, provider: "openai", model: "gpt-6", ...extra });
  const child = (id, owner, parent, agent, extra = {}) => ({ tag: "w:" + id, agent, sessionId: id, ownerSessionId: owner, parentSessionId: parent, status: "running", stage: "running", turnStartedAt: NOW - 20000, provider: "anthropic", model: "claude-sonnet", ...extra });
  const pool = [
    lead("home-1"), child("h-s1", "home-1", "home-1", "worker", { status: "idle", stage: "idle" }),
    lead("c1"), child("s1", "c1", "c1", "worker"), child("s2", "c1", "s1", "reviewer"),
    lead("c2"), child("s3", "c2", "c2", "worker", { awaitingUser: "approval" }),
    lead("c3"),
  ];
  const sessions = [
    { id: "home-1", title: "비서", preview: "무엇을 도와드릴까요?", updatedAt: NOW, messageCount: 1, agentHome: MIXY_AGENT_ID },
    { id: "c1", title: "Refactor the settings pane", preview: "Checking the build output", updatedAt: NOW, messageCount: 1 },
    { id: "c2", title: "Fix flaky approval test", preview: "", updatedAt: NOW - 60000, messageCount: 1 },
    { id: "c3", title: "Plain Lead without helpers", preview: "Reading the config", updatedAt: NOW - 90000, messageCount: 1 },
  ];
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.mixdogDesktop = {
    listAgentPool: async () => pool,
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability }) => ({
      value: capability === "listAgents" ? [{ id: "reviewer", kind: "agent", custom: true, label: "Reviewer" }] : null,
    }),
  };
  const route = { provider: "openai", model: "gpt-6" };
  const view = location.search;
  createRoot(document.getElementById("root")).render(
    view === "?agents" ? (
      <div className="utility-dock" style={{ width: "420px", padding: 12 }}>
        <div id="faces" style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <span style={{ width: 48, height: 48, display: "inline-grid" }}><ApprovalFace agentId="reviewer" /></span>
          <span style={{ width: 48, height: 48, display: "inline-grid" }}><ApprovalFace agentId="reviewer" /></span>
        </div>
        <AgentEditorDialog agent={{ id: "reviewer", name: "Reviewer", description: "Reviews PRs", body: "Review changes.", route }} deletable models={[]} busy={false} onCancel={() => {}} onSave={() => {}} onDelete={() => {}} />
      </div>
    ) : (
      <div className="utility-dock" style={{ width: "var(--probe-width)" }}>
        <AgentActivityPane active={false} sessions={sessions} onOpenLeadSession={() => {}} onOpenSession={() => {}} />
      </div>
    )
  );
`;
test('sub-agent trees under Lead and bot rows, and agent faces, in real CSS', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const shots = process.env.MIXDOG_QA_DIR || '';
  if (shots) mkdirSync(shots, { recursive: true });
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: PAGE },
      bundle: true,
      write: false,
      outfile: 'agent-subtree.js',
      loader: { '.jpg': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://mixdog.test/assets/index.js"' },
      plugins: [lazyChunkBoundary],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'agent-subtree.css',
      bundle: true,
      write: false,
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html data-mixdog-theme="dark"><head></head><body style="margin:0"><div id="root"></div></body></html>',
    })
  );
  const load = async (query, width) => {
    await page.goto(`http://mixdog.test/${query}`);
    await page.evaluate((w) => document.documentElement.style.setProperty('--probe-width', `${w}px`), width);
    for (const file of [...styles.outputFiles, ...bundle.outputFiles.filter((f) => f.path.endsWith('.css'))])
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  };
  await page.setViewport({ width: 520, height: 760, deviceScaleFactor: 2 });
  // Screenshots wait for a settled page: no hover, no focus, no running transition or animation.
  const settle = async () => {
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let tries = 0;
          const check = () => {
            const busy = document
              .getAnimations()
              .some((a) => a.effect?.getTiming().iterations !== Infinity && a.playState === 'running');
            if (busy && ++tries < 60) requestAnimationFrame(check);
            else requestAnimationFrame(() => requestAnimationFrame(resolve));
          };
          check();
        })
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  const configs = [
    { width: 420, theme: 'dark', phone: false },
    { width: 252, theme: 'dark', phone: false },
    { width: 420, theme: 'light', phone: false },
    { width: 252, theme: 'light', phone: false },
    { width: 390, theme: 'dark', phone: true },
    { width: 390, theme: 'light', phone: true },
  ];
  for (const config of configs) {
    const { width, theme, phone } = config;
    const tag = `${phone ? 'phone' : width === 252 ? 'narrow' : 'wide'}-${theme}`;
    await load('', width);
    await page.waitForSelector('[data-agent-lead="c1"]');
    await page.evaluate((cfg) => {
      document.documentElement.setAttribute('data-mixdog-theme', cfg.theme);
      if (cfg.phone) document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
    }, config);
    await page.evaluate(() => document.fonts.ready);
    // The shared stack: toggle centred under the face, text centred on face + toggle,
    // rows without sub-agents keep their height.
    const geo = await page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const measure = (row) => {
        const avatar = rect(row.querySelector('.agent-chat-avatar'));
        const toggle = row.querySelector(':scope > .agent-subtree-toggle');
        const tr = toggle ? rect(toggle) : null;
        const bodyEl = row.querySelector('.agent-contact-body');
        const body = rect(bodyEl);
        const title = rect(row.querySelector('.agent-chat-title'));
        const preview = rect(row.querySelector('.agent-chat-preview'));
        const time = row.querySelector('.agent-chat-time');
        const aside = row.querySelector('.agent-contact-aside');
        const asideRect = aside ? rect(aside) : null;
        // The text block is name + preview (the grid's own height).
        const textTop = title.top;
        const textBottom = preview.bottom;
        return {
          faceCx: avatar.left + avatar.width / 2,
          faceCy: avatar.top + avatar.height / 2,
          textCy: (textTop + textBottom) / 2,
          toggleCx: tr ? tr.left + tr.width / 2 : 0,
          toggleCy: tr ? tr.top + tr.height / 2 : 0,
          padTop: getComputedStyle(row.querySelector('.agent-chat-row-main')).paddingTop,
          padBottom: getComputedStyle(row.querySelector('.agent-chat-row-main')).paddingBottom,
          toggleWidth: tr ? tr.width : 0,
          avatarWidth: avatar.width,
          toggleHeight: tr ? tr.height : 0,
          hit: toggle ? parseFloat(getComputedStyle(toggle, '::before').height) : 0,
          timeRowOk: !time || (rect(time).top >= title.top - 2 && rect(time).bottom <= title.bottom + 2),
          nameSlack: asideRect ? body.right - asideRect.width - 8 - title.right : 0,
          titleWidth: title.width,
          bodyWidth: body.width,
          asideWidth: asideRect ? asideRect.width : 0,
          asideInside: !aside || (rect(aside).top >= rect(row).top && rect(aside).bottom <= rect(row).bottom),
        };
      };
      const plain = document.querySelector('[data-agent-lead="c3"]');
      return {
        plainGeo: measure(plain),
        lead: measure(document.querySelector('[data-agent-lead="c1"]')),
        bot: measure(document.querySelector('[data-agent-contact]')),
        plainHeight: rect(plain).height,
        leadHeight: rect(document.querySelector('[data-agent-lead="c1"]')).height,
        plainToggle: plain.querySelector('.agent-subtree-toggle'),
        plainMargin: getComputedStyle(plain.querySelector('.agent-chat-avatar')).marginBottom,
      };
    });
    assert.equal(geo.plainToggle, null, `${tag}: no toggle without sub-agents`);
    assert.equal(geo.plainMargin, '0px', `${tag}: a row without sub-agents keeps its avatar column`);
    assert.ok(
      geo.plainHeight <= geo.leadHeight,
      `${tag}: only rows with sub-agents grow (never shrink) (${geo.plainHeight} vs ${geo.leadHeight})`
    );
    for (const [kind, g] of [
      ['plain Lead', geo.plainGeo],
      ['Lead', geo.lead],
      ['bot', geo.bot],
    ]) {
      // Plain rows sit 1.5px off by line-height rounding; rows with sub-agents must match them.
      assert.ok(
        Math.abs(g.faceCy - g.textCy) <= 2,
        `${tag}: ${kind} face centred on the text block ${JSON.stringify(g)}`
      );
      assert.ok(
        kind === 'bot' || Math.abs(g.faceCy - g.textCy - (geo.plainGeo.faceCy - geo.plainGeo.textCy)) <= 1,
        `${tag}: ${kind} face offset equals the plain row's`
      );
      assert.ok(g.timeRowOk, `${tag}: ${kind} time on the name row`);
      assert.ok(g.asideInside, `${tag}: ${kind} right column inside the row`);
      assert.ok(
        g.nameSlack <= 1,
        `${tag}: ${kind} name takes all space up to the actual right column ${JSON.stringify(g)}`
      );
    }
    for (const [kind, g] of [
      ['Lead', geo.lead],
      ['bot', geo.bot],
    ]) {
      assert.ok(
        Math.abs(g.faceCx - g.toggleCx) <= 1 && Math.abs(g.faceCy - g.toggleCy) <= 1,
        `${tag}: ${kind} face button sits on the face ${JSON.stringify(g)}`
      );
      assert.ok(
        Math.abs(g.toggleWidth - g.avatarWidth) <= 1 && Math.abs(g.toggleHeight - g.avatarWidth) <= 1,
        `${tag}: ${kind} face button is the avatar's size`
      );
      assert.ok(g.hit >= (phone ? 44 : g.avatarWidth), `${tag}: ${kind} hit area ${g.hit}`);
      assert.equal(g.padTop, g.padBottom, `${tag}: ${kind} row keeps the plain symmetric padding`);
    }
    assert.equal(geo.plainGeo.padTop, geo.lead.padTop, `${tag}: same padding as a plain row`);
    const state = () =>
      page.evaluate(() => ({
        chevrons: [...document.querySelectorAll('.agent-chat-row > .agent-subtree-toggle')].map(
          (el) => el.parentElement.dataset.agentLead || el.parentElement.dataset.agentContact
        ),
        open: [...document.querySelectorAll('[data-agent-subtree]')].map((el) => el.dataset.agentSubtree),
      }));
    const before = await state();
    assert.deepEqual(before.chevrons.sort(), ['c1', 'c2', 'lead'].sort(), `${width}: chevrons on bot and Lead rows`);
    assert.deepEqual(before.open, ['c2'], `${width}: only the Lead with an approval wait opens itself`);
    if (shots) {
      await settle();
      const rest = await page.evaluate(() => {
        const row = document.querySelector('[data-agent-contact]');
        return {
          cls: row.className,
          bg: getComputedStyle(row).backgroundColor,
          hover: row.matches(':hover'),
          focus: row.matches(':focus-within'),
        };
      });
      assert.ok(
        !rest.hover && !rest.focus && !/selected/.test(rest.cls),
        `${tag}: resting bot row ${JSON.stringify(rest)}`
      );
      await page.screenshot({ path: join(shots, `tree-collapsed-${tag}.png`) });
    }
    // Keyboard: Enter opens, Space folds again.
    const toggleOf = '[data-agent-lead="c1"] > .agent-subtree-toggle';
    const expandedOf = () => page.$eval(toggleOf, (el) => el.getAttribute('aria-expanded'));
    await page.focus(toggleOf);
    await page.keyboard.press('Enter');
    assert.equal(await expandedOf(), 'true', `${tag}: Enter opens`);
    await page.keyboard.press('Space');
    assert.equal(await expandedOf(), 'false', `${tag}: Space folds`);
    await page.click('[data-agent-lead="c1"] .agent-chat-title');
    assert.equal(await expandedOf(), 'false', `${tag}: a click beside the face opens the chat, not the list`);
    await page.click('[data-agent-lead="c1"] > .agent-subtree-toggle');
    assert.equal(await expandedOf(), 'true', `${tag}: a click on the face toggles`);
    await page.click('[data-agent-contact] > .agent-subtree-toggle');
    await page.click('[data-agent-subtree="c1"] [data-agent-session-id="s1"]', { button: 'left' }).catch(() => {});
    await page.focus('[data-agent-subtree="c1"] [data-agent-session-id="s1"]').catch(() => {});
    await page.keyboard.press('ArrowRight');
    const after = await state();
    assert.deepEqual(after.open.sort(), ['c1', 'c2', 'home-1'].sort(), `${width}: expanded`);
    const box = await page.evaluate(() => {
      const tree = document.querySelector('[data-agent-subtree="c1"]').getBoundingClientRect();
      const page = document.querySelector('.agent-activity-page').getBoundingClientRect();
      return { overflow: tree.right > page.right + 1 || tree.left < page.left - 1 };
    });
    assert.equal(box.overflow, false, `${width}: the tree stays inside the pane`);
    const align = await page.evaluate(() => {
      const left = (el) => el.getBoundingClientRect().left;
      const width = (el) => el.getBoundingClientRect().width;
      const parent = document.querySelector('[data-agent-lead="c1"]');
      const avatar = parent.querySelector('.agent-chat-avatar');
      const first = document.querySelector(
        '[data-agent-subtree="c1"] [data-agent-session-id="s1"] .sidebar-resource-icon'
      );
      const second = document.querySelector(
        '[data-agent-subtree="c1"] [data-agent-session-id="s2"] .sidebar-resource-icon'
      );
      return {
        avatar: left(avatar),
        avatarWidth: width(avatar),
        first: left(first),
        second: left(second),
        firstWidth: width(first),
      };
    });
    assert.ok(
      Math.abs(align.first - align.avatar) <= 1,
      `${width}: child mark column starts at the parent avatar x (${JSON.stringify(align)})`
    );
    assert.ok(Math.abs(align.firstWidth - align.avatarWidth) <= 1, `${width}: same column width`);
    assert.ok(Math.abs(align.second - align.avatar) <= 1, `${width}: deeper level stays on the same line`);
    const kid = await page.evaluate(() => {
      const parent = document.querySelector('[data-agent-lead="c1"]');
      const main = getComputedStyle(parent.querySelector('.agent-chat-row-main'));
      const row = document.querySelector('[data-agent-subtree="c1"] [data-agent-session-id="s1"]');
      const cs = getComputedStyle(row);
      const p = parent.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const icon = row.querySelector('.sidebar-resource-icon').getBoundingClientRect();
      const copy = row.querySelector('.schedules-row-copy').getBoundingClientRect();
      const status = row.querySelector('.agent-activity-status').getBoundingClientRect();
      return {
        padL: [cs.paddingLeft, main.paddingLeft],
        padR: [cs.paddingRight, main.paddingRight],
        edges: [r.left - p.left, p.right - r.right],
        copySlack: status.left - copy.right,
        copyWidth: copy.width,
        freeWidth: status.left - icon.right,
      };
    });
    assert.equal(kid.padL[0], kid.padL[1], `${tag}: child left padding is the parent's ${JSON.stringify(kid)}`);
    assert.equal(kid.padR[0], kid.padR[1], `${tag}: child right padding is the parent's`);
    assert.ok(
      Math.abs(kid.edges[0]) <= 1 && Math.abs(kid.edges[1]) <= 1,
      `${tag}: same highlight inset ${JSON.stringify(kid)}`
    );
    assert.ok(kid.copySlack <= 12, `${tag}: the child's name takes the space up to its status ${JSON.stringify(kid)}`);
    if (shots) {
      await settle();
      await page.screenshot({ path: join(shots, `tree-expanded-${tag}.png`), fullPage: true });
    }
  }
  await load('?agents', 420);
  await page.waitForSelector('[data-lead-appearance], .workflows-dialog');
  await page.evaluate(() => document.fonts.ready);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const dialog = await page.evaluate(() => ({
    picker: document.querySelector('.workflows-dialog .agent-avatar-picker') !== null,
    text: /Avatar/.test(document.querySelector('.workflows-dialog').textContent),
    faces: [...document.querySelectorAll('#faces .agent-contact-mascot, #faces svg')].length,
  }));
  assert.equal(dialog.picker, false);
  assert.equal(dialog.text, false);
  if (shots) await page.screenshot({ path: join(shots, 'agents-edit-dialog.png') });
  assert.deepEqual(errors, []);
});

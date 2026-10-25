import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The Leads rows sit under the bot rows with no visual foreignness: the
// provider mark on a plate (5/6 of the bot face's box) in the same avatar box,
// the same title, 2-line muted preview, time and
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
  import { Star } from "lucide-react";
  import { AgentAvatar } from "./agent-avatar";
  import { AgentLeadRows } from "./agent-lead-rows";
  import { LeadAppearanceDialog } from "./lead-appearance-dialog";
  import { ProgressSpinner } from "./ProgressSpinner";
  import { agentChatTimeLabel } from "./agent-chat-summary";
  import { agentAvatar } from "../../../../src/runtime/shared/agent-avatar.mjs";

  const LONG = "Checking the build output and rewriting the failing settings tests so the pane keeps its two line preview";
  function Bot({ id, name, preview, mixy, working, time }) {
    return (
      <li className="agent-chat-row" data-kind="contact" data-bot={id}>
        <button type="button" className="agent-chat-row-main">
          <span className="agent-chat-avatar">
            <AgentAvatar agentId={id} avatar={agentAvatar(id, null)} className="agent-contact-mascot" state={working ? "typing" : "still"} />
            {mixy && (
              <span className="agent-contact-badge">
                <Star size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              </span>
            )}
          </span>
          <span className="agent-chat-body agent-contact-body">
            <b className="agent-chat-title">{name}</b>
            <span className="agent-chat-preview">{preview}</span>
            <span className="agent-contact-aside" data-has-status={working ? "true" : undefined}>
              <time className="agent-chat-time">{agentChatTimeLabel(time)}</time>
              {working && (
                <span className="agent-chat-status" data-kind="running">
                  <ProgressSpinner size={14} aria-hidden="true" />
                  <span className="sr-only">Working</span>
                </span>
              )}
            </span>
          </span>
        </button>
      </li>
    );
  }
  const leads = [
    { sessionId: "c1", title: "Refactor the settings pane", provider: "openai", preview: "gpt-6 · " + LONG, at: Date.now(), kind: "running" },
    { sessionId: "c2", title: "Fix flaky approval test", provider: "anthropic", preview: "claude · Waiting for approval", at: Date.now() - 60000, kind: "attention" },
  ];
  createRoot(document.getElementById("root")).render(
    <div className="utility-dock" style={{ width: "var(--probe-width)" }}>
      <div className="agent-activity-page">
        <ul className="agent-contact-list">
          <Bot id="mixy" name="비서" mixy preview="무엇을 도와드릴까요?" time={Date.now() - 600000} />
          <Bot id="b-alpha" name="조사관" working preview={LONG} time={Date.now()} />
          <Bot id="b-beta" name="디자이너" preview="Pixel faces are ready for review." time={Date.now() - 3600000} />
          <Bot id="b-gamma" name="리뷰어" preview="LGTM" time={Date.now() - 86400000} />
        </ul>
        <AgentLeadRows rows={leads} onOpen={() => {}} />
      </div>
      {location.search === "?dialog" && <LeadAppearanceDialog onClose={() => {}} />}
    </div>
  );
`;

const MEASURE = () => {
  const px = (value) => Number.parseFloat(value);
  const rowMetrics = (row, badgeOf) => {
    const rect = (el) => el.getBoundingClientRect();
    const r = rect(row);
    const avatar = row.querySelector('.agent-chat-avatar');
    const a = rect(avatar);
    const rel = (el) => {
      const b = rect(el);
      return { w: b.width, h: b.height, l: b.left - r.left, t: b.top - r.top, r: r.right - b.right };
    };
    const css = (el, ...props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));
    const badge = badgeOf(avatar);
    const bb = badge ? rect(badge) : null;
    const status = row.querySelector('.agent-chat-status');
    return {
      rowH: r.height,
      avatar: rel(avatar),
      face: { w: rect(avatar.firstElementChild).width, h: rect(avatar.firstElementChild).height },
      badge: badge
        ? {
            w: bb.width,
            h: bb.height,
            right: a.right - bb.right,
            bottom: a.bottom - bb.bottom,
            ...css(badge, 'boxShadow', 'backgroundColor', 'borderRadius'),
          }
        : null,
      title: {
        ...rel(row.querySelector('.agent-chat-title')),
        ...css(row.querySelector('.agent-chat-title'), 'fontSize', 'fontWeight', 'color', 'lineHeight'),
      },
      preview: {
        l: rel(row.querySelector('.agent-chat-preview')).l,
        ...css(
          row.querySelector('.agent-chat-preview'),
          'fontSize',
          'fontWeight',
          'color',
          'lineHeight',
          'webkitLineClamp'
        ),
      },
      time: { ...rel(row.querySelector('time')), ...css(row.querySelector('time'), 'fontSize', 'fontWeight', 'color') },
      status: status ? rel(status) : null,
      spinner: status?.querySelector('svg.progress-spinner')?.width.baseVal.value ?? null,
    };
  };
  const bot = document.querySelector('[data-bot="b-alpha"]');
  const mixy = document.querySelector('[data-bot="mixy"]');
  const lead = document.querySelector('[data-agent-lead="c1"]');
  const attention = document.querySelector('[data-agent-lead="c2"]');
  const star = (avatar) => avatar.querySelector('.agent-contact-badge');
  return {
    bot: rowMetrics(bot, star),
    mixy: rowMetrics(mixy, star),
    lead: rowMetrics(lead, star),
    attention: rowMetrics(attention, star),
    oneLineBot: rowMetrics(document.querySelector('[data-bot="b-beta"]'), star),
    px: px('1'),
  };
};

test('Lead rows match the bot rows: face, badge, text, time, status and row height', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const shots = process.env.MIXDOG_QA_DIR || '';
  if (shots) mkdirSync(shots, { recursive: true });
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: PAGE },
      bundle: true,
      write: false,
      outfile: 'agent-lead-avatar.js',
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
      outfile: 'agent-lead-avatar.css',
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
  await page.setViewport({ width: 520, height: 520, deviceScaleFactor: 2 });
  for (const [width, face] of [
    [420, 48],
    [252, 32],
  ]) {
    await page.setContent(
      '<!doctype html><html data-mixdog-theme="dark"><head></head><body style="margin:0"><div id="root"></div></body></html>'
    );
    await page.evaluate((w) => document.documentElement.style.setProperty('--probe-width', `${w}px`), width);
    for (const file of [...styles.outputFiles, ...bundle.outputFiles.filter((f) => f.path.endsWith('.css'))])
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
    await page.waitForSelector('[data-agent-lead]');
    await page.evaluate(() => document.fonts.ready);
    const m = await page.evaluate(MEASURE);
    if (shots) await page.screenshot({ path: join(shots, `harmony-${width}.png`) });
    const tag = `${width}px`;
    assert.equal(m.lead.avatar.w, face, `${tag}: avatar box`);
    assert.deepEqual(m.lead.avatar, m.bot.avatar, `${tag}: avatar box and place`);
    assert.deepEqual(m.bot.face, { w: face, h: face }, `${tag}: a bot's face fills the box`);
    // A Lead's face is a faint plate inset to 5/6 of the box (97602902e), so it
    // reads apart from the bare-mark sub-agents; layout snaps it to 1/64 px.
    const plate = Math.round((face * 5) / 6);
    assert.deepEqual(
      { w: Math.round(m.lead.face.w), h: Math.round(m.lead.face.h) },
      { w: plate, h: plate },
      `${tag}: the Lead's plate is the box inset to 5/6`
    );
    assert.equal(m.lead.badge, null, `${tag}: a Lead has no corner badge, the plate is the mark`);
    assert.equal(m.lead.rowH, m.bot.rowH, `${tag}: row height`);
    assert.deepEqual(m.lead.title, m.bot.title, `${tag}: title position and type`);
    assert.deepEqual(m.lead.preview, m.bot.preview, `${tag}: preview type, colour and 2-line clamp`);
    assert.equal(m.lead.preview.webkitLineClamp, '2');
    assert.deepEqual(m.lead.time, m.bot.time, `${tag}: time place and type`);
    assert.deepEqual(m.lead.status, m.bot.status, `${tag}: spinner place and size`);
    // An approval wait shows the shared amber triangle (2aba1580c; the "!" pill
    // is gone) in the same status slot the spinner sits in, so the slot is the same size.
    assert.equal(m.lead.spinner, 14, `${tag}: spinner glyph`);
    assert.deepEqual(
      { w: m.attention.status.w, h: m.attention.status.h },
      { w: m.lead.status.w, h: m.lead.status.h },
      `${tag}: the approval triangle's slot is the spinner's slot`
    );
    assert.equal(m.attention.rowH, m.oneLineBot.rowH, `${tag}: a one-line Lead is as tall as a one-line bot`);
  }
  // A face the user picked (Appearance): same box and badge, new palette and breed.
  // Storage needs a real origin (about:blank denies it).
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html data-mixdog-theme="dark"><head></head><body style="margin:0"><div id="root"></div></body></html>',
    })
  );
  await page.goto('http://mixdog.test/');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--probe-width', '420px');
    // The host stores the shared Lead face; this page's host holds a blue corgi.
    window.mixdogDesktop = {
      invokeCapability: async ({ capability }) => ({
        value:
          capability === 'getLeadAppearance'
            ? {
                avatar: {
                  kind: 'mascot',
                  species: 'corgi',
                  accessory: 'glasses',
                  expression: 'happy',
                  color: '#5b9bff',
                },
              }
            : null,
      }),
    };
  });
  for (const file of [...styles.outputFiles, ...bundle.outputFiles.filter((f) => f.path.endsWith('.css'))])
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.waitForSelector('[data-agent-lead]');
  const custom = await page.evaluate(MEASURE);
  if (shots) await page.screenshot({ path: join(shots, 'lead-custom.png') });
  assert.deepEqual(custom.lead.avatar, custom.bot.avatar, 'a stored Lead face leaves the avatar box alone');
  assert.equal(
    await page.evaluate(() => document.querySelector('[data-agent-lead] .agent-contact-mascot')),
    null,
    'the Lead row shows the provider plate, not the stored face'
  );
  // The Appearance dialog (the bots' own picker) over the page.
  await page.setViewport({ width: 520, height: 680, deviceScaleFactor: 1.5 });
  await page.goto('http://mixdog.test/?dialog');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--probe-width', '420px');
  });
  for (const file of [...styles.outputFiles, ...bundle.outputFiles.filter((f) => f.path.endsWith('.css'))])
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.waitForSelector('[data-lead-appearance] .agent-avatar-picker');
  // The card fades in: shoot it settled.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (shots) await page.screenshot({ path: join(shots, 'lead-appearance-dialog.png') });
  const dlg = await page.evaluate(() => {
    const box = (s) => {
      const el = document.querySelector(s);
      const r = el?.getBoundingClientRect();
      return r ? [Math.round(r.width), Math.round(r.height)] : null;
    };
    return {
      face: box('[data-lead-appearance] .lead-appearance-face'),
      card: box('[data-lead-appearance]'),
      swatches: document.querySelectorAll('[data-lead-appearance] .agent-avatar-colors [data-color]').length,
    };
  });
  assert.deepEqual(dlg.face, [64, 64], 'a face preview the size of a room tile');
  assert.equal(dlg.swatches, 10);
  assert.deepEqual(errors, []);
});

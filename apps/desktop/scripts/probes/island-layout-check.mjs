// Composer island layout check in real Chrome with the app's CSS.
// Renders ComposerDock states at desktop, narrow-pane and phone sizes, measures
// alignment (centering, edges, overflow, overlap) and writes screenshots.
// Usage (from apps/desktop): node scripts/probes/island-layout-check.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: island-layout-check.mjs <outDir>');
mkdirSync(outDir, { recursive: true });

const HARNESS = `
  import { useState } from 'react';
  import { createPortal, flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { useContext } from 'react';
  import { ComposerDock } from './ComposerDock';
  import { SessionGoalIsland } from './SessionGoalIsland';
  import { ApprovalCard } from './ApprovalCard';
  import { QueueList } from './composer-support';
  import { ComposerQueueTrayContext } from './composer-island-state';

  const files = [
    { path: 'src/payments/client.ts', status: 'M', additions: 62, deletions: 18 },
    { path: 'src/payments/webhook.ts', status: 'M', additions: 40, deletions: 12 },
    { path: 'test/payments.test.ts', status: 'A', additions: 5, deletions: 7 },
  ];
  window.mixdogDesktop = {
    invokeCapability: async () => ({ value: {
      supported: true, authoritative: true, snapshotKind: 'worktree',
      checkpointId: 'prompt', patch: '', files, agents: [],
    } }),
  };
  const reviewItems = [
    { kind: 'user', id: 'prompt', text: 'Change files' },
    { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated' },
  ];
  const goal = (title) => ({ sessionId: 's1', goal: {
    id: 'goal', title, objective: title, status: 'active', tasksTotal: 5, tasksCompleted: 3,
    tasks: [{ id: 't', text: 'Check layout', status: 'in_progress' }],
  } });
  function Composer({ queued }) {
    const tray = useContext(ComposerQueueTrayContext);
    return <>
      {tray && queued.length ? createPortal(<QueueList queued={queued} restoring={false}
        onEdit={() => {}} onSteer={() => {}} onRemove={() => {}} />, tray) : null}
      <form className="composer"><textarea aria-label="Composer" defaultValue="" placeholder="메시지 입력…" />
        <div className="composer-footer"><button type="button" className="composer-tool">+</button>
          <span className="model-trigger">Claude Opus 5.5 High</span></div></form>
    </>;
  }
  const root = createRoot(document.getElementById('root'));
  window.renderScenario = (name) => {
    const s = {
      draft: { draft: true },
      empty: {},
      goalFiles: { goal: goal('결제 모듈을 새 API로 이전'), review: true },
      crowded: { goal: goal('결제 모듈을 새 API로 이전하고 웹훅 서명 검증까지 마무리'), review: true, mismatch: true },
      approval: { goal: goal('결제 모듈 이전'), approval: true, queued: ['테스트 끝나면 커버리지도 알려줘'] },
      flash: { flash: true },
      queue: { queued: ['테스트 끝나면 커버리지도 알려줘', '그리고 README의 결제 설정 부분도 새 API 기준으로 고쳐줘', '세 번째 대기 메시지', '네 번째 대기 메시지'] },
    }[name];
    const queued = (s.queued || []).map((text, i) => ({ id: 'q' + i, text }));
    flushSync(() => root.render(
      <section className="conversation" key={name}>
        <div className="transcript-shell"><div className="transcript"><div className="thread" /></div></div>
        <ComposerDock sessionId={s.draft ? '' : 's1'} goalSubmissionId="" showProjectSelector={Boolean(s.draft)}
          contextBar={<><span className="ghost">mixdog</span><span className="ghost">Default</span></>}
          goalIsland={s.goal ? <SessionGoalIsland snapshot={s.goal} /> : null}
          approval={s.approval ? <ApprovalCard approval={{ id: 'a1', name: 'shell', args: { command: 'npm run migrate -- --env=staging' }, reason: '스테이징 DB에 마이그레이션을 적용합니다.' }} resolve={async () => true} /> : null}
          islandFlash={s.flash ? { key: 'f1', text: 'MacBook에서 허용했어요' } : null}
          quotaCard={s.mismatch ? { resetAt: Date.now() + 3_600_000, otherAccount: false, reserved: false, busy: false, onToggleResume() {} } : null}
          reviewItems={s.review ? reviewItems : []} reviewActive reviewBusy={false} reviewSessionId="s1" reviewCwd="C:/fixture"
          onOpenSessionDiff={() => {}}>
          <Composer queued={queued} />
        </ComposerDock>
      </section>));
  };
`;

const VIEWPORTS = [
  { name: 'pc-wide', width: 1440, height: 900 },
  { name: 'pc-narrow', width: 720, height: 800 },
  { name: 'phone', width: 390, height: 844, mobile: true },
];
const SCENARIOS = ['draft', 'empty', 'goalFiles', 'crowded', 'approval', 'flash', 'queue'];

const MEASURE = () => {
  const box = (el) => {
    if (!el?.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    return {
      l: +r.left.toFixed(1),
      r: +r.right.toFixed(1),
      t: +r.top.toFixed(1),
      b: +r.bottom.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
    };
  };
  const dock = document.querySelector('.composer-region');
  const composer = document.querySelector('form.composer');
  const slot = document.querySelector('.composer-island-slot');
  const visible = (sel) =>
    [...document.querySelectorAll(sel)].filter(
      (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
    );
  const pill = visible('.composer-island-pill')[0] || null;
  const card = visible('.composer-island .approval-card, .composer-island-panel, .composer-island-flash')[0] || null;
  const tray = document.querySelector('.composer-queue-tray');
  const issues = [];
  const cBox = box(composer);
  const center = (b) => (b.l + b.r) / 2;
  for (const [label, el] of [
    ['pill', pill],
    ['card', card],
  ]) {
    const b = box(el);
    if (!b || !cBox) continue;
    const off = Math.abs(center(b) - center(cBox));
    if (off > 1) issues.push(`${label} not centered on composer (off ${off.toFixed(1)}px)`);
    if (b.l < cBox.l - 0.5 || b.r > cBox.r + 0.5)
      issues.push(`${label} wider than composer (${b.l}..${b.r} vs ${cBox.l}..${cBox.r})`);
  }
  const pb = box(pill);
  if (pb) {
    for (const seg of [...pill.children].filter((c) => c.getClientRects().length)) {
      const sb = box(seg);
      const dv = Math.abs((sb.t + sb.b) / 2 - (pb.t + pb.b) / 2);
      if (dv > 1) issues.push(`segment "${seg.textContent.trim().slice(0, 20)}" vertically off ${dv.toFixed(1)}px`);
      if (sb.l < pb.l - 0.5 || sb.r > pb.r + 0.5)
        issues.push(`segment "${seg.textContent.trim().slice(0, 20)}" outside pill`);
    }
  }
  const tb = box(tray);
  const ql = tray?.querySelector('.queue-list');
  const qb = box(ql);
  if (qb && cBox) {
    // Codex-style rail: inset one card radius (16px) per side, lower edge tucked one card radius under the card.
    if (Math.abs(qb.l - (cBox.l + 16)) > 0.5 || Math.abs(qb.r - (cBox.r - 16)) > 0.5)
      issues.push(`queue rail edges ${qb.l}..${qb.r} vs composer ${cBox.l}..${cBox.r} (expected 16px inset)`);
    const tuck = qb.b - cBox.t;
    if (tuck < 15 || tuck > 17) issues.push(`queue rail tuck ${tuck.toFixed(1)}px (expected 16px under the card)`);
  }
  const sb = box(slot);
  if (sb && cBox && pb && pb.b > (qb ? qb.t : cBox.t) + 0.5) issues.push('pill overlaps tray/composer');
  for (const el of visible('.composer-island *, .queue-list *, .composer-context-bar *')) {
    const cs = getComputedStyle(el);
    if (
      el.children.length === 0 &&
      el.textContent.trim() &&
      el.scrollWidth > el.clientWidth + 1 &&
      cs.textOverflow !== 'ellipsis' &&
      cs.overflow !== 'visible'
    ) {
      issues.push(`text clipped without ellipsis: "${el.textContent.trim().slice(0, 30)}"`);
    }
  }
  const textRight = visible('.composer-island-pill *')
    .filter((el) => !el.children.length && el.textContent.trim())
    .map((el) => getComputedStyle(el).textAlign);
  return {
    dock: box(dock),
    slot: sb,
    pill: pb,
    card: box(card),
    tray: qb,
    trayHost: tb,
    composer: cBox,
    issues,
    textAlign: [...new Set(textRight)],
  };
};

const resolveDir = fileURLToPath(new URL('../../src/renderer/', import.meta.url));
const [bundle, styles] = await Promise.all([
  build({
    stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
    outfile: 'island-layout.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    plugins: [
      {
        name: 'lazy',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            a.kind === 'dynamic-import' && a.path !== './TurnReview' ? { path: a.path, external: true } : null
          );
        },
      },
    ],
  }),
  build({
    stdin: {
      resolveDir,
      loader: 'css',
      contents:
        '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'island-layout.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  }),
]);
const browser = await puppeteer.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  headless: true,
});
const report = {};
try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (vp.mobile) {
      await page.emulate({
        viewport: { width: vp.width, height: vp.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      });
    } else {
      await page.setViewport({ width: vp.width, height: vp.height });
    }
    // The phone boot script installs the attribute.
    await page.setContent(
      `<!doctype html><html${vp.mobile ? ' data-mixdog-mobile-tabs' : ''}><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body><div id="root"></div></body></html>`
    );
    await page.addStyleTag({ content: styles.outputFiles[0].text });
    for (const f of bundle.outputFiles.filter((f) => f.path.endsWith('.css')))
      await page.addStyleTag({ content: f.text });
    await page.addStyleTag({
      content:
        '#root{position:fixed;inset:0;display:flex;container-type:size}.conversation{position:relative;flex:1}.transcript-shell{position:absolute;inset:0}',
    });
    await page.addScriptTag({ content: bundle.outputFiles.find((f) => f.path.endsWith('.js')).text });
    report[vp.name] = {};
    for (const name of SCENARIOS) {
      await page.evaluate((n) => window.renderScenario(n), name);
      await new Promise((r) => setTimeout(r, 450));
      report[vp.name][name] = await page.evaluate(MEASURE);
      await page.screenshot({
        path: join(outDir, `${vp.name}-${name}.png`),
        clip: { x: 0, y: Math.max(0, vp.height - 420), width: vp.width, height: Math.min(420, vp.height) },
      });
    }
    report[vp.name].errors = errors;
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
for (const [vp, scenes] of Object.entries(report)) {
  for (const [name, m] of Object.entries(scenes)) {
    if (name === 'errors') {
      if (m.length) console.log(vp, 'PAGE ERRORS', m);
      continue;
    }
    console.log(
      `${vp.padEnd(10)} ${name.padEnd(10)} dock=${m.dock?.h} slot=${m.slot?.h ?? '-'} pill=${m.pill ? `${m.pill.w}x${m.pill.h}` : '-'} card=${m.card ? `${m.card.w}x${m.card.h}` : '-'} tray=${m.tray ? m.tray.h : '-'} ${m.issues.length ? `ISSUES: ${m.issues.join(' | ')}` : 'ok'}`
    );
  }
}

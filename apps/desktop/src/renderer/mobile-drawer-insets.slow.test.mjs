import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The phone drawer (rail + list panel, 07-mobile-chrome.css "Drawer inset
// system"): header, search, chips, section headings, cards and footer pills
// open on ONE box line; row highlights bleed past it by the same amount on both
// sides. The pages below mirror the real markup (AgentActivityPane,
// SchedulesView, SessionSidebar) closely enough for the CSS to resolve.

const rowShell = (inner) => `
  <div class="sidebar-drawer-frame" data-state="open" data-motion="instant">
    <nav class="activity-rail"></nav>
    <aside class="workbench-side-panel" data-side="left">
      <div class="workbench-side-panel-content"><div class="workbench-side-panel-body">${inner}</div></div>
    </aside>
  </div>`;

const sectioned = (inner) =>
  `<section class="workbench-side-section"><div class="workbench-side-section-body">${inner}</div></section>`;

const header = (title) => `
  <header class="session-panel-header"><span class="session-panel-title">${title}</span>
    <div class="session-panel-header-actions"><button class="session-panel-action" type="button"></button></div></header>`;

const PAGES = {
  // schedules and sessions sit in the left panel's section body, like the app.
  agents: rowShell(`
    <aside class="utility-dock">
      <header class="utility-dock-header session-panel-header" data-tab="agents"><span class="session-panel-title">봇</span>
        <div class="session-panel-header-actions"><button class="session-panel-action" type="button"></button></div></header>
      <div class="utility-dock-body"><div class="utility-dock-pane" data-tab="agents" data-surface-active="true">
        <div class="schedules-page agent-activity-page">
          <ul class="agent-contact-list">
            <li class="agent-chat-row" data-kind="contact" data-agent-contact="lead" id="lead"><button class="agent-chat-row-main" type="button"><span class="agent-chat-avatar"></span><span class="agent-chat-body agent-contact-body"><b class="agent-chat-title">Mixy</b></span></button></li>
            <li class="agent-chat-row" data-kind="contact" data-agent-contact="a" id="plain"><button class="agent-chat-row-main" type="button"><span class="agent-chat-avatar"></span><span class="agent-chat-body agent-contact-body"><b class="agent-chat-title">리서처</b><span class="agent-chat-preview">아직 메시지가 없습니다</span></span></button></li>
            <li class="agent-chat-row selected" data-kind="contact" data-agent-contact="b" id="selected"><button class="agent-chat-row-main" type="button"><span class="agent-chat-avatar"></span><span class="agent-chat-body agent-contact-body"><b class="agent-chat-title">사무관</b><span class="agent-chat-preview">아직 메시지가 없습니다</span></span></button></li>
          </ul>
          <section class="starter-guide connectors-pill"><div class="starter-guide-pill"><button class="starter-guide-toggle" type="button"><span class="starter-guide-title">커넥터</span></button></div></section>
        </div>
      </div></div>
    </aside>`),
  schedules: rowShell(
    sectioned(`
    <aside class="sidebar session-sidebar open">
      ${header('스케줄')}
      <div class="session-sidebar-scroll session-sidebar-panels session-sidebar-surface" data-surface-active="true">
        <div class="schedules-pane" data-surface-active="true"><div class="schedules-page">
          <div class="schedules-search"><input placeholder="스케줄 검색…"></div>
          <div class="routine-sort-chips" role="tablist"><button type="button" role="tab" aria-selected="true">다음 실행</button><button type="button" role="tab">주기</button></div>
          <div class="routine-side-groups"><div class="routine-side-list"><div class="routines-row"><button class="routines-main" type="button">아침 점검</button></div></div></div>
        </div></div>
      </div>
    </aside>`)
  ),
  sessions: rowShell(
    sectioned(`
    <aside class="sidebar session-sidebar open">
      ${header('세션')}
      <div class="session-sidebar-sessions">
        <nav class="session-sidebar-launchers"><button class="task-link session-launcher-row" type="button"><span class="session-launcher-label">새 작업</span></button></nav>
        <div class="session-sidebar-scroll">
          <section class="sidebar-recent">
            <div class="sidebar-category-header"><button class="sidebar-recent-heading sidebar-heading-toggle" type="button"><span>최근</span></button></div>
            <nav class="session-list recent-session-list">
              <div class="session-row" id="plain"><button class="session-row-main" type="button"><span class="session-row-copy"><b>세션 하나</b></span></button></div>
              <div class="session-row selected" id="selected"><button class="session-row-main" type="button"><span class="session-row-copy"><b>로컬 변경과 커밋 검증</b></span></button></div>
            </nav>
          </section>
        </div>
      </div>
    </aside>`)
  ),
};

const round = (value) => Math.round(value * 10) / 10;

/** Left/right of every named element of the open drawer, plus the frame. */
const MEASURE = () => {
  const edge = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, height: box.height };
  };
  const frame = edge('.sidebar-drawer-frame');
  const out = { frame };
  for (const [key, selector] of Object.entries({
    title: '.session-panel-title',
    actions: '.session-panel-header-actions',
    search: '.schedules-search',
    chip: '.routine-sort-chips > button',
    chips: '.routine-sort-chips',
    card: '.routine-side-list',
    heading: '.sidebar-recent-heading > span',
    launcher: '.session-launcher-row',
    launcherLabel: '.session-launcher-label',
    list: '.session-list',
    leadRow: '#lead',
    plainRow: '#plain',
    selectedRow: '#selected',
    rowText: '#plain .session-row-main',
    leadAvatar: '#lead .agent-chat-avatar',
    plainAvatar: '#plain .agent-chat-avatar',
    pill: '.starter-guide-pill',
    pillSection: '.connectors-pill',
  })) {
    out[key] = edge(selector);
  }
  const search = document.querySelector('.schedules-search');
  out.pinTone = search ? getComputedStyle(search).getPropertyValue('--mx-rail-pin-bg').trim() : null;
  out.sheetTone = getComputedStyle(document.documentElement).getPropertyValue('--mx-workspace-sheet').trim();
  return out;
};

test('every phone drawer page opens on one inset line, highlights bleed equally, nothing overflows', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const styles = await build({
    stdin: {
      resolveDir,
      loader: 'css',
      contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'mobile-drawer-insets.css',
    bundle: true,
    write: false,
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.jpg': 'dataurl',
      '.png': 'dataurl',
    },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true });

  const measure = async (name, gutter) => {
    await page.setContent(
      `<!doctype html><html data-mixdog-mobile-tabs style="--mx-scrollbar-gutter: ${gutter}px"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${PAGES[name]}</body></html>`
    );
    await page.addStyleTag({ content: styles.outputFiles[0].text });
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    return page.evaluate(MEASURE);
  };
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 0.6, `${message}: ${round(actual)} vs ${round(expected)}`);

  // A measured scrollbar gutter must not move anything: the phone hides its bars.
  for (const gutter of [0, 8]) {
    const frameLabel = `gutter ${gutter}`;
    const agents = await measure('agents', gutter);
    const schedules = await measure('schedules', gutter);
    const sessions = await measure('sessions', gutter);

    for (const [name, m] of Object.entries({ agents, schedules, sessions })) {
      const line = m.frame.left + 48 + 12;
      const lineRight = m.frame.right - 12;
      const label = `${name}, ${frameLabel}`;
      near(m.title.left, line, `${label}: header title opens on the line`);
      near(m.actions.right, lineRight, `${label}: header actions close on the line`);
    }

    const bleed = 4;
    const line = agents.frame.left + 48 + 12;
    const lineRight = agents.frame.right - 12;
    // Bots page: Mixy, a plain row and the selected row share one highlight box and one avatar line.
    for (const row of ['leadRow', 'plainRow', 'selectedRow']) {
      near(agents[row].left, line - bleed, `agents, ${frameLabel}: ${row} highlight starts one bleed outside the line`);
      near(
        agents[row].right,
        lineRight + bleed,
        `agents, ${frameLabel}: ${row} highlight ends one bleed outside the line`
      );
    }
    near(agents.leadAvatar.left, line, `agents, ${frameLabel}: Mixy's avatar sits on the line`);
    near(agents.plainAvatar.left, line, `agents, ${frameLabel}: a plain row's avatar sits on the line`);
    near(agents.pill.left, line, `agents, ${frameLabel}: the connectors pill starts on the line`);
    near(agents.pill.right, lineRight, `agents, ${frameLabel}: the connectors pill ends on the line (no overflow)`);
    assert.ok(agents.pill.right <= agents.frame.right, 'the connectors pill stays inside the panel');

    // Schedules: the search field, chips and card share the line; the pinned bar paints the sheet tone.
    near(schedules.search.left, line, `schedules, ${frameLabel}: search starts on the line`);
    near(schedules.search.right, lineRight, `schedules, ${frameLabel}: search ends on the line`);
    near(schedules.chip.left, line, `schedules, ${frameLabel}: the first chip starts on the line`);
    near(schedules.card.left, line, `schedules, ${frameLabel}: the card starts on the line`);
    near(schedules.card.right, lineRight, `schedules, ${frameLabel}: the card ends on the line`);
    assert.ok(schedules.chip.height <= 36, `schedules: compact chips (${schedules.chip.height}px)`);
    assert.equal(
      schedules.pinTone,
      schedules.sheetTone,
      'schedules: the pinned search bar paints the drawer sheet tone'
    );

    // Sessions: headings and row text on the line; launcher and row highlights bleed equally.
    near(sessions.heading.left, line, `sessions, ${frameLabel}: the section heading starts on the line`);
    near(sessions.rowText.left, line, `sessions, ${frameLabel}: row text starts on the line`);
    near(sessions.launcherLabel.left, line, `sessions, ${frameLabel}: launcher content stays on the line`);
    for (const key of ['launcher', 'plainRow', 'selectedRow']) {
      near(
        sessions[key].left,
        line - bleed,
        `sessions, ${frameLabel}: ${key} highlight starts one bleed outside the line`
      );
      near(
        sessions[key].right,
        lineRight + bleed,
        `sessions, ${frameLabel}: ${key} highlight ends one bleed outside the line`
      );
    }
  }
  assert.deepEqual(errors, []);
});

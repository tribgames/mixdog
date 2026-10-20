import '../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { executeOfficeTool } from './index.mjs';
import { value, workspace } from './office-test-support.mjs';
import { localBrowserAvailable } from '../shared/browser-launch.mjs';
import { createPortableOoxmlDocument } from './portable/portable-package.mjs';

const skip = !localBrowserAvailable() && 'no local Chrome or Edge';

const page = (
  body,
  css = ''
) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>분기 보고서</title><style>
@page { size: A4; margin: 20mm; @bottom-right { content: counter(page) " / " counter(pages); font-size: 9pt; } }
body { margin: 0; font-family: 'Malgun Gothic', 'Noto Sans KR', sans-serif; font-size: 11pt; line-height: 1.6;
  word-break: keep-all; overflow-wrap: break-word; }
h1, h2 { break-after: avoid; }
${css}
</style></head><body>${body}</body></html>`;

const REPORT = `<!-- BRIEF
subject/audience/action: 분기 운영 보고 / 운영팀 / 다음 분기 예산 승인
facts: F1 2,400건 — 운영 시트 B4
-->
<h1>운영 보고서</h1>
<p>이번 분기 처리량은 2,400건이고 대기 시간은 37분이었다.</p>
<h2>세부 내역</h2>
${'<p>세부 항목마다 같은 절차를 반복해 기록한다.</p>\n'.repeat(60)}
<h2>결론</h2>
<p>다음 분기에도 같은 체계를 유지한다.</p>`;

test('author prints an HTML document to a PDF under its @page rules', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'reports', 'report.pdf');
  const authored = value(
    await executeOfficeTool({ action: 'author', path, script: page(REPORT), render: false }, { cwd })
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  assert.equal(authored.output, path);
  assert.equal(authored.artifacts?.[0]?.operation, 'create');
  assert.ok(authored.pageCount >= 2, 'sixty paragraphs flow onto a second sheet');
  assert.deepEqual(authored.facts?.pages, [{ page: 1, figures: ['37'] }], 'the figure no fact carries is reported');
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: authored.session }, { cwd }));
  const first = snapshot.document.pages[0];
  assert.ok(Math.abs(first.width - 595.28) < 1 && Math.abs(first.height - 841.89) < 1, 'the sheet is A4');
  assert.match(first.text, /운영 보고서/);
  assert.match(first.text, /1 \/ \d/, 'the margin box numbers the page');
  const titles = snapshot.document.outline.map((entry) => entry.title);
  assert.ok(titles.includes('운영 보고서') && titles.includes('결론'), `headings become bookmarks: ${titles}`);
  const layout = value(
    await executeOfficeTool(
      { action: 'query', session: authored.session, queryKind: 'pdf-layout', pages: [1], query: '운영 보고서' },
      { cwd }
    )
  );
  const x = layout.matches?.[0]?.x;
  assert.ok(Math.abs(x - 56.69) < 2, `the text starts at the 20 mm margin, not twice it (x ${x})`);
  const again = value(
    await executeOfficeTool({ action: 'author', path, script: page(REPORT), render: false }, { cwd })
  );
  assert.equal(again.ok, true, 'a re-author replaces the PDF its own session holds');
});

const designed = ({ plan = true, margin = '0' } = {}) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<!-- BRIEF
subject/audience/action: 분기 운영 보고 / 운영팀 / 다음 분기 예산 승인
facts: F1 2,400건 — 운영 시트 B4 · F2 37분 — 운영 시트 B5
${plan ? 'slide plan: 1 job: cover · move: 처리량을 쥔다 · composition: 전면 색 면 위 큰 숫자 · carriers: hero\n  2 job: evidence · move: 세부를 확인한다 · composition: 표와 막대 · carriers: table, chart' : ''}
-->
<style>
@page { size: A4; margin: ${margin}; }
body { margin: 0; font-family: 'Malgun Gothic', sans-serif; }
.slide { position: relative; width: 210mm; height: 297mm; overflow: hidden; box-sizing: border-box; padding: 24mm 20mm; }
.cover { background: #0F3B3A; color: #FFFFFF; }
.hero { font-size: 72pt; font-weight: 700; margin: 0; }
table { border-collapse: collapse; font-size: 11pt; width: 120mm; }
td { border-bottom: 1px solid #C9CED6; padding: 2mm 0; }
</style></head><body>
<section class="slide cover"><p class="hero">2,400건</p><p style="font-size:14pt">이번 분기 처리량</p></section>
<section class="slide"><h1 style="font-size:20pt;margin:0 0 8mm">세부<br>내역</h1>
<table><tr><td>처리</td><td>정상</td></tr><tr><td>대기</td><td>짧음</td></tr></table>
<div data-chart='{"type":"col","labels":["처리","대기"],"values":[2400,37],"colors":["E4572E","C9CED6"],"format":"#,##0","labelColor":"161B26","size":10}' style="width:120mm;height:55mm;margin-top:8mm"></div>
<i data-icon="check" style="display:block;width:12mm;height:12mm;color:#0F3B3A;margin-top:8mm"></i></section>
</body></html>`;

const critique = (overrides = {}) => [
  {
    page: 1,
    role: 'cover',
    verdict: 'pass',
    hierarchy: 5,
    balance: 4,
    legibility: 5,
    cohesion: 4,
    evidence: 4,
    note: '전면 색 면 위에 처리량 숫자가 한눈에 들어오고 설명 한 줄이 그 아래 붙어 있다.',
    fixes: [],
    checks: [
      { item: '큰 숫자가 F1의 2,400건과 같다', pass: true },
      { item: '표지의 시선 중심이 숫자 하나다', pass: true },
      { item: '흰 글자가 색 면 위에서 충분히 읽힌다', pass: true },
    ],
    ...overrides,
  },
  {
    page: 2,
    verdict: 'pass',
    hierarchy: 4,
    balance: 4,
    legibility: 5,
    cohesion: 4,
    evidence: 4,
    note: '제목 아래 표 한 장과 막대 두 개가 세부를 담고 확인 아이콘이 그 아래에 정렬되어 있다.',
    fixes: [],
    checks: [
      { item: '계획한 표와 막대가 페이지에 있다', pass: true },
      { item: '표의 행이 모두 읽힌다', pass: true },
      { item: '아이콘이 표와 같은 왼쪽 축에 있다', pass: true },
    ],
  },
];

test('designed pages run the deck frame and print one sheet each', { skip }, async (t) => {
  const cwd = await workspace(t);
  const existingDeck = join(cwd, '.designed.frame.pptx');
  await createPortableOoxmlDocument(existingDeck, { fileKind: 'pptx' });
  const original = await readFile(existingDeck);
  const authored = value(
    await executeOfficeTool({ action: 'author', path: join(cwd, 'designed.pdf'), script: designed() }, { cwd })
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  assert.deepEqual(await readFile(existingDeck), original, 'the working deck must not replace a neighboring file');
  assert.equal(authored.pageCount, 2);
  assert.equal(authored.designedPages, true);
  assert.ok(authored.audit?.status, 'the measured audit of the deck rides on the PDF');
  assert.equal(authored.receipt?.slides?.length, 2, 'the composition receipt reads both pages');
  assert.ok(
    typeof authored.receipt.slides[0].observe?.renderAir === 'number',
    'the printed pages’ pixels join the receipt'
  );
  assert.equal(authored.receipt.slides[1].tables, 1);
  assert.equal(authored.receipt.slides[1].charts, 1, 'the data-chart is a chart to the deck frame');
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: authored.session }, { cwd }));
  const first = snapshot.document.pages[0];
  assert.ok(Math.abs(first.width - 595.28) < 1 && Math.abs(first.height - 841.89) < 1, 'each page is the A4 sheet');
  assert.match(first.text, /2,400건\n이번 분기 처리량/, 'the numeral and its label read as two lines');
  assert.ok(
    snapshot.document.outline.some((entry) => entry.title === '세부 내역'),
    `a heading set on two lines keeps its space in the bookmark: ${snapshot.document.outline.map((e) => e.title)}`
  );
  assert.match(snapshot.document.pages[1].text, /2,400/, 'the chart prints its value labels as text');
  // Page 2 paints #0F3B3A only in the icon's stroke and #E4572E only in the chart's first bar.
  const { data, info } = await sharp(authored.render.images[1].path).raw().toBuffer({ resolveWithObject: true });
  const count = ([r, g, b]) => {
    let hits = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      if (Math.abs(data[index] - r) < 30 && Math.abs(data[index + 1] - g) < 30 && Math.abs(data[index + 2] - b) < 30)
        hits += 1;
    }
    return hits;
  };
  const teal = count([15, 59, 58]);
  assert.ok(teal > 50, `the data-icon prints as drawn (${teal} icon pixels)`);
  const coral = count([228, 87, 46]);
  assert.ok(coral > 2000, `the data-chart prints as drawn (${coral} bar pixels)`);
  // A render on its own carries what the author's render did: the receipt and the contact sheet.
  const rendered = value(await executeOfficeTool({ action: 'render', session: authored.session }, { cwd }));
  assert.ok(rendered.receipt?.slides?.length === 2 || rendered.receipt?.deck, 'render returns the receipt');
  assert.ok(rendered.contactSheet?.path, 'render writes the contact sheet');
  const token = rendered.reviewToken;
  const unscored = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: authored.session,
        design: { reviewed: true, reviewToken: token, critique: critique({ hierarchy: undefined }) },
      },
      { cwd }
    )
  );
  assert.equal(unscored.finalized, false, 'the deck critique holds a page without its scores');
  const finalized = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: authored.session,
        design: { reviewed: true, reviewToken: token, critique: critique() },
      },
      { cwd }
    )
  );
  assert.equal(finalized.finalized, true, JSON.stringify(finalized.reason || finalized.blockingIssues || ''));
  // A fix is an edit to the kept HTML: author without a script reads it, and replaces its own PDF.
  const again = value(
    await executeOfficeTool({ action: 'author', path: join(cwd, 'designed.pdf'), render: false }, { cwd })
  );
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.designedPages, true);
});

test('qa reads a designed PDF against its brief', { skip }, async (t) => {
  const cwd = await workspace(t);
  // A plan that names a third page the document never drew: information the deck's qa reports.
  const script = designed().replace(
    'carriers: table, chart',
    'carriers: table, chart\n  3 job: closing · move: 결정한다 · composition: 띠 · carriers: statement'
  );
  const authored = value(
    await executeOfficeTool({ action: 'author', path: join(cwd, 'planned.pdf'), script, render: false }, { cwd })
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session, render: false }, { cwd }));
  assert.match(JSON.stringify(qa), /plan_count_mismatch/);
});

test('designed pages are gated like a deck: no plan, no landing', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'gated.pdf');
  const existingDeck = join(cwd, '.gated.frame.pptx');
  await createPortableOoxmlDocument(existingDeck, { fileKind: 'pptx' });
  const original = await readFile(existingDeck);
  const unplanned = value(
    await executeOfficeTool({ action: 'author', path, script: designed({ plan: false }), render: false }, { cwd })
  );
  assert.equal(unplanned.ok, false);
  assert.equal(unplanned.reason, 'plan_gate');
  const margined = value(
    await executeOfficeTool({ action: 'author', path, script: designed({ margin: '20mm' }), render: false }, { cwd })
  );
  assert.equal(margined.reason, 'html_failed');
  assert.match(margined.error.message, /full-bleed/);
  assert.deepEqual(await readFile(existingDeck), original, 'refusing a PDF must not delete a neighboring file');
  const opened = await executeOfficeTool({ action: 'open', path }, { cwd });
  assert.equal(opened.isError, true, 'no file was written');
});

test('the layout check refuses what print would cut, and nothing lands', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'refused.pdf');
  const refused = value(
    await executeOfficeTool(
      {
        action: 'author',
        path,
        script: page('<img src="https://example.com/a.png"><div style="width:400mm">넓은 표</div>'),
        render: false,
      },
      { cwd }
    )
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'layout_gate');
  assert.deepEqual(refused.findings.map((finding) => finding.code).sort(), ['overflow_x', 'remote_image']);
  const unsized = value(
    await executeOfficeTool(
      { action: 'author', path, script: '<!doctype html><html><body><p>본문</p></body></html>', render: false },
      { cwd }
    )
  );
  assert.equal(unsized.reason, 'html_failed');
  assert.match(unsized.error.message, /@page size/);
  const opened = await executeOfficeTool({ action: 'open', path }, { cwd });
  assert.equal(opened.isError, true, 'no file was written');
});

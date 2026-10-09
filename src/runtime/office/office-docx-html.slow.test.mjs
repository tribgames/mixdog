import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { parts, value, workspace } from './office-test-support.mjs';
import { localBrowserAvailable } from '../shared/browser-launch.mjs';
import { snapshotPdf } from './pdf/pdf-adapter.mjs';

const skip = !localBrowserAvailable() && 'no local Chrome or Edge';

const DOCUMENT = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>운영 보고</title>
<!-- BRIEF
subject/audience/action: 운영 보고 / 운영팀 / 승인
facts: F1 184,200건 — 운영 시트 B4 · F2 37분 — 운영 시트 B5 · F3 동부 69,800건 — 운영 시트 B6 · F4 대기 52분 15분 — 운영 시트 C2:C3
-->
<style>
@page { size: A4; margin: 20mm; }
body { font-family: 'Malgun Gothic', sans-serif; font-size: 10.5pt; line-height: 1.6; color: #374151; }
h1 { font-size: 24pt; line-height: 1.3; color: #111827; margin: 0 0 10pt; }
h2 { font-size: 14pt; color: #111827; margin: 18pt 0 6pt; }
p { margin: 0 0 8pt; }
.cards { display: flex; gap: 10pt; }
.card { flex: 1; background: #EEF4F1; padding: 10pt; }
.card .v { font-size: 22pt; font-weight: 700; color: #1F5E4B; line-height: 1.2; margin: 0; }
.card .l { font-size: 9pt; color: #374151; margin: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4pt 6pt 4pt 0; border-bottom: 0.75pt solid #CCCCCC; }
td.n, th.n { text-align: right; }
</style></head><body>
<header data-first-page="none">운영 보고</header>
<footer>{page} / {pages}</footer>
<h1>처리량은 184,200건이었다</h1>
<div class="cards"><div class="card"><p class="v">184,200건</p><p class="l">3분기 처리량</p></div><div class="card"><p class="v">37분</p><p class="l">대기 시간 단축</p></div></div>
<h2>세부</h2>
<ul><li>동부가 가장 많이 늘었다</li><li>서부도 늘었다</li></ul>
<table><thead><tr><th>허브</th><th class="n">처리량</th></tr></thead><tbody><tr><td>동부</td><td class="n">69,800</td></tr></tbody></table>
<div data-chart='{"type":"col","labels":["6월","9월"],"values":[52,15],"colors":["C9CED6","1F5E4B"]}' style="height:120pt"></div>
</body></html>`;

test('author writes an HTML document as a native Word document', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'report.docx');
  const authored = value(
    await executeOfficeTool({ action: 'author', path, script: DOCUMENT, mode: 'portable' }, { cwd })
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  assert.equal(authored.backend, 'mixdog-ooxml');
  assert.ok(authored.render?.compare?.length >= 1, 'the HTML print and the Word render come back as pairs');
  const docx = await parts(path);
  const document = await docx.text('word/document.xml');
  const styles = await docx.text('word/styles.xml');
  assert.match(document, /<w:pgSz w:w="11906" w:h="16838"/, 'the @page sheet is the Word page');
  assert.match(document, /<w:pStyle w:val="Heading1"\/>[\s\S]*?처리량은 184,200건이었다/, 'h1 is Heading 1');
  assert.match(styles, /w:styleId="Heading1"[\s\S]*?<w:sz w:val="48"\/>/, 'Heading 1 carries the h1 size');
  const cards = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(document)[0];
  assert.equal((cards.match(/w:fill="EEF4F1"/g) || []).length, 2, 'the two cards are two filled cells');
  assert.match(
    cards,
    /<w:sz w:val="44"\/>[\s\S]*?184,200건[\s\S]*?<w:sz w:val="18"\/>[\s\S]*?3분기 처리량/,
    'figure over label'
  );
  assert.match(
    document,
    /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>[\s\S]*?동부가 가장/,
    'li is a Word list item'
  );
  assert.match(document, /<w:tblHeader\/>[\s\S]*?허브/, 'thead repeats');
  assert.match(document, /<w:drawing>/, 'the data-chart is a picture');
  const footer = ['word/footer1.xml', 'word/footer2.xml'].find((name) => docx.has(name));
  assert.match(await docx.text(footer), /NUMPAGES/, '{page} / {pages} is the page field and the total');
  // The figures are the brief's: nothing unfounded; the scored critique is owed at finalize.
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session, render: false }, { cwd }));
  assert.doesNotMatch(JSON.stringify(qa), /number_without_fact/);
  const unscored = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: authored.session,
        design: {
          reviewed: true,
          reviewToken: authored.render.reviewToken,
          critique: authored.render.images.map((image) => ({
            page: image.page,
            verdict: 'pass',
            note: '제목, 카드, 목록, 표, 차트가 HTML 인쇄와 같은 자리에 있다.',
          })),
        },
      },
      { cwd }
    )
  );
  assert.equal(unscored.finalized, false, 'a briefed document owes the five scores');
  // A fix is an edit to the kept HTML: author without a script reads it.
  const again = value(await executeOfficeTool({ action: 'author', path, mode: 'portable', render: false }, { cwd }));
  assert.equal(again.ok, true, JSON.stringify(again));
});

test('a page break before a table survives the Word render', { skip }, async (t) => {
  const cwd = await workspace(t);
  const authored = value(
    await executeOfficeTool(
      {
        action: 'author',
        path: join(cwd, 'table-break.docx'),
        mode: 'portable',
        script: `<!doctype html><style>
      @page { size: A4; margin: 20mm; }
      body { margin: 0; font-size: 11pt; }
      table { break-before: page; }
    </style><p>Before table</p><table><tr><td>Next page</td></tr></table>`,
      },
      { cwd }
    )
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  const rendered = await snapshotPdf(authored.render.output);
  assert.equal(rendered.pageCount, 2);
  assert.match(rendered.pages[0].text, /Before table/);
  assert.doesNotMatch(rendered.pages[0].text, /Next\s+page/);
  assert.match(rendered.pages[1].text, /Next\s+page/);
});

test('a Latin-led font stack sets Hangul in the stack\'s Korean face, not the Latin lead', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'memo.docx');
  const authored = value(
    await executeOfficeTool(
      {
        action: 'author',
        path,
        mode: 'portable',
        render: false,
        script: `<!doctype html><style>
      @page { size: A4; margin: 20mm; }
      body { font-family: Georgia, 'Noto Serif KR', serif; font-size: 11pt; }
      h1 { font-family: Georgia, serif; }
    </style><h1>상담 요청</h1><p>장부 기준 정정을 부탁드립니다.</p>`,
      },
      { cwd }
    )
  );
  assert.equal(authored.ok, true, JSON.stringify(authored));
  const docx = await parts(path);
  const xml = `${await docx.text('word/document.xml')}${await docx.text('word/styles.xml')}`;
  assert.match(xml, /w:ascii="Georgia"/, 'the Latin face stays the author\'s');
  assert.match(xml, /w:eastAsia="Noto Serif KR"/, 'Hangul takes the Korean family of the stack');
  assert.match(xml, /w:eastAsia="Batang"/, 'a serif stack with no Korean family takes the serif system face');
  assert.doesNotMatch(xml, /w:eastAsia="Georgia"/);
});

test('a document without an @page size is refused before anything lands', { skip }, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'bare.docx');
  const neighbor = join(cwd, '.bare.authoring.docx');
  await writeFile(neighbor, 'unrelated existing document');
  const refused = value(
    await executeOfficeTool(
      { action: 'author', path, script: '<!doctype html><html><body><p>본문</p></body></html>', mode: 'portable' },
      { cwd }
    )
  );
  assert.equal(refused.reason, 'html_failed');
  assert.match(refused.error.message, /@page size/);
  assert.equal(await readFile(neighbor, 'utf8'), 'unrelated existing document');
  assert.ok(!(await readdir(cwd)).some((name) => name.startsWith('.mixdog-authoring-')));
  const opened = await executeOfficeTool({ action: 'open', path }, { cwd });
  assert.equal(opened.isError, true);
});

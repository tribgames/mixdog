import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { parts, value, workspace } from './office-test-support.mjs';

const create = async (cwd, name, operations) => {
  const path = join(cwd, name);
  const created = value(
    await executeOfficeTool({ action: 'create', path, format: 'docx', mode: 'portable', operations }, { cwd })
  );
  await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
  return { path, created, package: await parts(path) };
};

const styleXml = (styles, id) =>
  new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`).exec(styles)?.[0] || '';

test('define_styles sets the styles once and paragraphs naming them carry no properties of their own', async (t) => {
  const cwd = await workspace(t);
  const { package: docx, created } = await create(cwd, 'styles.docx', [
    {
      op: 'define_styles',
      styles: {
        Title: { size: 24, bold: true, color: '111827', spacingAfter: 8 },
        'Heading 1': {
          name: 'Malgun Gothic',
          nameEastAsia: 'Malgun Gothic',
          size: 15,
          color: '1F5E4B',
          spacingBefore: 18,
          spacingAfter: 6,
          keepWithNext: true,
        },
        Normal: { lineSpacing: 18, spacingAfter: 8, alignment: 'left' },
        Caption: { size: 9, color: '6B7280' },
      },
    },
    { op: 'append_text', style: 'Heading 1', text: '1. 근거' },
  ]);
  assert.deepEqual(created.batch.results[0].styles, ['Title', 'Heading 1', 'Normal', 'Caption']);
  const styles = await docx.text('word/styles.xml');
  const heading = styleXml(styles, 'Heading1');
  assert.match(heading, /<w:keepNext w:val="1"\/>/);
  assert.match(heading, /w:before="360"/);
  assert.match(heading, /<w:color w:val="1F5E4B"\/>/);
  assert.match(heading, /<w:sz w:val="30"\/>/);
  assert.match(heading, /w:eastAsia="Malgun Gothic"/);
  // Schema order: name before pPr, pPr before rPr.
  assert.ok(
    heading.indexOf('<w:name') < heading.indexOf('<w:pPr>') && heading.indexOf('<w:pPr>') < heading.indexOf('<w:rPr>')
  );
  assert.match(styleXml(styles, 'Caption'), /<w:sz w:val="18"\/>/);
  const document = await docx.text('word/document.xml');
  assert.match(
    document,
    /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t[^>]*>1\. 근거/,
    'the paragraph names the style alone'
  );
});

test('define_styles refuses a misspelt field on every backend before writing', async (t) => {
  const cwd = await workspace(t);
  const refused = await executeOfficeTool(
    {
      action: 'create',
      path: join(cwd, 'bad.docx'),
      format: 'docx',
      mode: 'portable',
      operations: [{ op: 'define_styles', styles: { 'Heading 1': { fontSize: 15 } } }],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Heading 1: unknown fields fontSize/);
});

test('a stat strip sets figures and labels apart in one table, and a total row stands over a rule', async (t) => {
  const cwd = await workspace(t);
  const { package: docx } = await create(cwd, 'tables.docx', [
    {
      op: 'add_table',
      values: [
        ['37분', '184,200건'],
        ['평균 대기 시간 단축', '3분기 처리량'],
      ],
      properties: {
        repeatHeader: false,
        fontSize: 11,
        rowStyles: [
          { fontSize: 22, color: '1F5E4B', bold: true },
          { fontSize: 9, color: '6B7280' },
        ],
      },
    },
    {
      op: 'add_table',
      values: [
        ['허브', '처리량 (건)'],
        ['동부', '69,800'],
        ['합계', '184,200'],
      ],
      properties: { totalRow: true },
    },
  ]);
  const document = await docx.text('word/document.xml');
  const [strip, totals] = [...document.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((match) => match[0]);
  const rows = [...strip.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map((match) => match[0]);
  assert.match(rows[0], /<w:sz w:val="44"\/>/);
  assert.match(rows[0], /<w:color w:val="1F5E4B"\/>/);
  assert.match(rows[0], /w:line="572" w:lineRule="exact"/, "the figures' line follows their size");
  assert.match(rows[1], /<w:sz w:val="18"\/>/);
  assert.doesNotMatch(rows[1], /<w:sz w:val="44"\/>|<w:b\/>/);
  const totalRows = [...totals.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map((match) => match[0]);
  assert.match(totalRows[2], /<w:tcBorders><w:top w:val="single" w:sz="8"/);
  assert.match(totalRows[2], /<w:b\/>/);
  assert.doesNotMatch(totalRows[1], /<w:tcBorders>|<w:b\/>/, 'a data row stays plain');
});

// The macOS CI LibreOffice (26.8) draws no Hangul in a docx under any East Asian face (Noto Sans KR,
// Apple SD Gothic Neo, NanumGothic all fall back to a face without Hangul), so the page renders blank.
// Skipped there until that rendering is fixed.
const MACOS_HANGUL_DOCX_RENDER =
  process.platform === 'darwin' && 'macOS LibreOffice renders docx Hangul blank; tracked separately';

test('a document written to a brief reports unfounded figures and takes the scored review at finalize', {
  skip: MACOS_HANGUL_DOCX_RENDER,
}, async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'briefed.docx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path,
        format: 'docx',
        mode: 'portable',
        design: { brief: 'subject/audience/action: 운영 보고 / 운영팀 / 승인\nfacts: F1 184,200건 — 운영 시트 B4' },
        operations: [
          { op: 'append_text', style: 'Heading 1', text: '처리량은 184,200건이었다' },
          { op: 'append_text', text: '대기 시간은 37분 줄었다.' },
        ],
      },
      { cwd }
    )
  );
  const qa = value(await executeOfficeTool({ action: 'qa', session: created.session, render: false }, { cwd }));
  const unfounded = JSON.stringify(qa).match(/Figures with no fact behind them: ([^.]*)\./)?.[1] || '';
  assert.equal(unfounded, '37', 'only the figure no fact carries');
  const rendered = value(await executeOfficeTool({ action: 'render', session: created.session }, { cwd }));
  const note = '제목이 처리량 결론을 먼저 말하고 본문 한 줄이 대기 시간의 변화를 덧붙인다.';
  const page = { page: 1, verdict: 'pass', note, fixes: [] };
  const unscored = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: created.session,
        design: { reviewed: true, reviewToken: rendered.reviewToken, critique: [page] },
      },
      { cwd }
    )
  );
  assert.equal(unscored.finalized, false, 'a briefed document owes the five scores');
  const scored = {
    ...page,
    hierarchy: 4,
    balance: 4,
    legibility: 5,
    cohesion: 4,
    evidence: 4,
    checks: [
      { item: '제목의 184,200건이 F1과 같다', pass: true },
      { item: '제목이 결론 한 문장이다', pass: true },
      { item: '본문이 제목을 반복하지 않는다', pass: true },
    ],
  };
  const finalized = value(
    await executeOfficeTool(
      {
        action: 'finalize',
        session: created.session,
        design: { reviewed: true, reviewToken: rendered.reviewToken, critique: [scored] },
      },
      { cwd }
    )
  );
  assert.equal(
    finalized.finalized,
    true,
    JSON.stringify({ reason: finalized.reason, blockingIssues: finalized.blockingIssues })
  );
});

test('the review reads a stat strip label at display size and an unmarked total row', async (t) => {
  const cwd = await workspace(t);
  const { created } = await create(cwd, 'review.docx', [
    {
      op: 'add_table',
      values: [
        ['37분', '184,200건'],
        ['평균 대기 시간 단축', '3분기 처리량'],
      ],
      properties: { fontSize: 22, repeatHeader: false },
    },
    {
      op: 'add_table',
      values: [
        ['허브', '처리량'],
        ['동부', '69,800'],
        ['합계', '184,200'],
      ],
    },
  ]);
  const opened = value(
    await executeOfficeTool({ action: 'open', path: join(cwd, 'review.docx'), mode: 'portable' }, { cwd })
  );
  const found = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  const codes = JSON.stringify(found);
  assert.match(codes, /table_label_oversized/);
  assert.match(codes, /total_row_unmarked/);
  assert.ok(created);
});

test('a separator numbers pages against the total', async (t) => {
  const cwd = await workspace(t);
  const { package: docx } = await create(cwd, 'numbers.docx', [
    { op: 'append_text', text: '본문' },
    { op: 'add_page_numbers', separator: ' / ' },
  ]);
  const footerOf = (pkg) => ['word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'].find((name) => pkg.has(name));
  const xml = await docx.text(footerOf(docx));
  assert.match(xml, /w:instr=" PAGE "/);
  assert.match(xml, /<w:t xml:space="preserve"> \/ <\/w:t>/, 'the separator keeps one space a side');
  assert.match(xml, /w:instr=" NUMPAGES "/);
  const alone = await create(cwd, 'alone.docx', [
    { op: 'append_text', text: '본문' },
    { op: 'add_page_numbers', separator: ' / ', includeTotal: false },
  ]);
  assert.doesNotMatch(await alone.package.text(footerOf(alone.package)), /NUMPAGES/);
});

// Without Office (always, on a Mac) this backend is the only one, and a phrase
// in a table cell could take no comment, hyperlink, or bookmark.
test('a comment anchors to a phrase in a table cell when the body does not hold it', async (t) => {
  const cwd = await workspace(t);
  const { package: docx, created } = await create(cwd, 'cell-comment.docx', [
    { op: 'append_text', text: '본문 문단' },
    {
      op: 'add_table',
      values: [
        ['항목', '값'],
        ['처리량', '1,200'],
      ],
    },
    { op: 'append_text', text: '처리량은 위 표에 있습니다.' },
    { op: 'add_comment', find: '1,200', text: '출처 확인', author: '검토자' },
  ]);
  assert.equal(created.batch.results.at(-1).anchor, 'phrase');
  const document = await docx.text('word/document.xml');
  const table = /<w:tbl>[\s\S]*<\/w:tbl>/.exec(document)?.[0] || '';
  assert.match(table, /<w:commentRangeStart w:id="1"\/>[\s\S]*1,200[\s\S]*<w:commentRangeEnd w:id="1"\/>/);
  // The body is searched first: a phrase in both lands on the body paragraph.
  const both = await create(cwd, 'body-first.docx', [
    { op: 'add_table', values: [['처리량', '1']] },
    { op: 'append_text', text: '처리량 설명' },
    { op: 'add_comment', find: '처리량', text: '본문 우선' },
  ]);
  const bodyFirst = await both.package.text('word/document.xml');
  assert.doesNotMatch(/<w:tbl>[\s\S]*<\/w:tbl>/.exec(bodyFirst)?.[0] || '', /commentRangeStart/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { extractOoxmlText } from './read-office-files.mjs';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

async function writePackage(path, files) {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    await fs.writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('a document table is read as rows, not one value per line', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'report.docx');
    const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const cell = (text) => `<w:tc>${paragraph(text)}</w:tc>`;
    await writePackage(path, {
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>`
            + paragraph('조치')
            + `<w:tbl><w:tr>${cell('항목')}${cell('수량')}${cell('월 비용')}</w:tr>`
            + `<w:tr>${cell('야간 인력')}${cell('12명')}${cell('38,400,000원')}</w:tr></w:tbl>`
            + paragraph('끝')
            + '</w:body></w:document>',
    });
    // Which column a value belongs to is the table's meaning; a flat list loses it.
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '조치',
        '항목\t수량\t월 비용',
        '야간 인력\t12명\t38,400,000원',
        '끝',
    ]);
});

test('a workbook reads as its grid, sheet by sheet', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-xlsx-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'kpi.xlsx');
    const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    await writePackage(path, {
        'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>`
            + '<sheet name="실적" sheetId="1" r:id="rId1"/><sheet name="메모" sheetId="2" r:id="rId2"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
            + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
            + '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${SHEET_NS}"><si><t>허브</t></si><si><t>처리량</t></si><si><t>대전</t></si></sst>`,
        // B2 is a formula: the cached value is what the sheet shows. C2 is empty,
        // so D2 must still line up under its own header.
        'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>`
            + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>비고</t></is></c></row>'
            + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>SUM(E1:E3)</f><v>128400</v></c><c r="D2" t="inlineStr"><is><t>야간</t></is></c></row>'
            + '</sheetData></worksheet>',
        'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`,
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '--- sheet 실적 ---',
        '허브\t처리량\t\t비고',
        '대전\t128400\t\t야간',
        '',
        '--- sheet 메모 ---',
        '(empty sheet)',
    ]);
});

// A figure carries no text runs, so a picture or a chart used to leave nothing
// behind: a report built around them read as prose with an unexplained gap.
test('a figure is read as a figure, with the description the file gives it', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-figure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const PICTURE_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    const WORD_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    const drawing = (descr, inner) => `<w:drawing><wp:inline xmlns:wp="${WORD_DRAWING_NS}">`
        + `<wp:docPr id="1" name="image1.png"${descr ? ` descr="${descr}"` : ''}/>`
        + `<a:graphic xmlns:a="${DRAWING_NS}"><a:graphicData>${inner}</a:graphicData></a:graphic>`
        + '</wp:inline></w:drawing>';
    const document = join(root, 'report.docx');
    await writePackage(document, {
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>`
            + '<w:p><w:r><w:t>10월 운영 현황</w:t></w:r></w:p>'
            + `<w:p><w:r>${drawing('출고율 추이 꺾은선', `<pic:pic xmlns:pic="${PICTURE_NS}"/>`)}</w:r></w:p>`
            + `<w:p><w:r>${drawing('', '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/>')}</w:r></w:p>`
            // A text box lives inside a drawing; its words are still the document's.
            + `<w:p><w:r>${drawing('', `<pic:pic xmlns:pic="${PICTURE_NS}"/><w:txbxContent><w:p><w:r><w:t>증원 12명</w:t></w:r></w:p></w:txbxContent>`)}</w:r></w:p>`
            + '</w:body></w:document>',
    });
    assert.deepEqual((await extractOoxmlText(document)).split('\n'), [
        '10월 운영 현황',
        '[image: 출고율 추이 꺾은선]',
        '[chart]',
        '[image] 증원 12명',
    ]);

    // A dashboard sheet's chart lives outside the cell grid, so a sheet whose
    // message is the chart used to read as an empty sheet.
    const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const DRAWING_SHEET_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
    const workbook = join(root, 'kpi.xlsx');
    await writePackage(workbook, {
        'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>`
            + '<sheet name="대시보드" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`,
        'xl/worksheets/_rels/sheet1.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="drawing" Target="../drawings/drawing1.xml"/></Relationships>',
        'xl/drawings/drawing1.xml': `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="${DRAWING_SHEET_NS}" xmlns:a="${DRAWING_NS}" xmlns:r="${RELATIONSHIP_NS}">`
            + '<xdr:absoluteAnchor><a:graphic><a:graphicData>'
            + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/>'
            + '</a:graphicData></a:graphic></xdr:absoluteAnchor>'
            + '<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 3" descr="허브 배치도"/></xdr:nvPicPr></xdr:pic></xdr:twoCellAnchor>'
            + '</xdr:wsDr>',
        'xl/drawings/_rels/drawing1.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="chart" Target="../charts/chart1.xml"/></Relationships>',
        'xl/charts/chart1.xml': '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
            + ` xmlns:a="${DRAWING_NS}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>분기 매출</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>`,
    });
    assert.deepEqual((await extractOoxmlText(workbook)).split('\n'), [
        '--- sheet 대시보드 ---',
        '(empty sheet)',
        '[chart: 분기 매출]',
        '[image: 허브 배치도]',
    ]);

    const deck = join(root, 'deck.pptx');
    await writePackage(deck, {
        'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>`
            + '<p:sp><p:txBody><a:p><a:r><a:t>대전 허브</a:t></a:r></a:p></p:txBody></p:sp>'
            + '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 3" descr="야간 작업 사진"/></p:nvPicPr></p:pic>'
            + '</p:spTree></p:cSld></p:sld>',
    });
    assert.deepEqual((await extractOoxmlText(deck)).split('\n'), [
        '--- slide 1 ---',
        '대전 허브',
        '[image: 야간 작업 사진]',
    ]);
});

// A report keeps the source of a figure in the footnote beside it, in a part of
// its own: read as body text alone, every citation disappeared.
test('a footnote is read where it is cited and its source is kept', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-note-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'report.docx');
    await writePackage(path, {
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>`
            + '<w:p><w:r><w:t>정시 출고율은 92.8%</w:t></w:r>'
            + '<w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t>로 집계됐습니다.</w:t></w:r></w:p>'
            + '<w:p><w:r><w:t>야간 인력은 12명</w:t></w:r><w:r><w:endnoteReference w:id="5"/></w:r>'
            + '<w:r><w:t> 부족합니다.</w:t></w:r></w:p>'
            + '</w:body></w:document>',
        // Word's separator entries carry a type and no words; they are not notes.
        'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes xmlns:w="${WORD_NS}">`
            + '<w:footnote w:type="separator" w:id="0"><w:p><w:r><w:t> </w:t></w:r></w:p></w:footnote>'
            + '<w:footnote w:id="2"><w:p><w:r><w:t>물류팀 주간보고 p.12</w:t></w:r></w:p></w:footnote></w:footnotes>',
        'word/endnotes.xml': `<?xml version="1.0"?><w:endnotes xmlns:w="${WORD_NS}">`
            + '<w:endnote w:id="5"><w:p><w:r><w:t>인사팀 시트 B4</w:t></w:r></w:p></w:endnote></w:endnotes>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '정시 출고율은 92.8%[note 1]로 집계됐습니다.',
        '야간 인력은 12명[note 2] 부족합니다.',
        '',
        '--- notes ---',
        '[note 1] 물류팀 주간보고 p.12',
        '[note 2] 인사팀 시트 B4',
    ]);
});

// A hidden sheet and a hidden slide are content the file does not show. Read as
// ordinary ones, withheld numbers and a withdrawn page enter the summary as if
// the author had presented them.
test('hidden sheets and hidden slides say they are hidden', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-hidden-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const workbook = join(root, 'ledger.xlsx');
    const cellSheet = (text) => `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>`
        + `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`;
    await writePackage(workbook, {
        'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>`
            + '<sheet name="실적" sheetId="1" r:id="rId1"/>'
            + '<sheet name="내부메모" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
            + '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': cellSheet('허브'),
        'xl/worksheets/sheet2.xml': cellSheet('내부 단가'),
    });
    assert.deepEqual((await extractOoxmlText(workbook)).split('\n'), [
        '--- sheet 실적 ---',
        '허브',
        '',
        '--- sheet 내부메모 (hidden) ---',
        '내부 단가',
    ]);

    const deck = join(root, 'deck.pptx');
    const slide = (text, hidden) => `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"${hidden ? ' show="0"' : ''}>`
        + `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    await writePackage(deck, {
        'ppt/slides/slide1.xml': slide('야간 운영 전환', false),
        'ppt/slides/slide2.xml': slide('부록 초안', true),
    });
    assert.deepEqual((await extractOoxmlText(deck)).split('\n'), [
        '--- slide 1 ---',
        '야간 운영 전환',
        '',
        '--- slide 2 (hidden) ---',
        '부록 초안',
    ]);
});

// A shape hidden in the selection pane is a withdrawn draft or a production
// note: it ships with the deck and the page does not show it.
test('a hidden shape is marked instead of read as the slide’s words', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-hidden-shape-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'deck.pptx');
    const shape = (text, hidden) => '<p:sp><p:nvSpPr>'
        + `<p:cNvPr id="2" name="TextBox 2"${hidden ? ' hidden="1"' : ''}/></p:nvSpPr>`
        + `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    await writePackage(path, {
        'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>`
            + shape('야간 운영 전환 승인', false)
            + shape('이전 초안: 주간 인력 6명으로 대체', true)
            + '</p:spTree></p:cSld></p:sld>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '--- slide 1 ---',
        '야간 운영 전환 승인',
        '[hidden: 이전 초안: 주간 인력 6명으로 대체]',
    ]);
});

// Word keeps hidden text in the file and does not show it on the page. Read as
// ordinary prose, an internal remark left in a template is quoted back as the
// document's own words — the worst kind of wrong answer about a contract.
test('hidden Word text is marked, not read as the document body', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-vanish-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'contract.docx');
    const run = (text, hidden) => `<w:r>${hidden ? '<w:rPr><w:vanish/></w:rPr>' : ''}<w:t>${text}</w:t></w:r>`;
    const cell = (inner) => `<w:tc><w:p>${inner}</w:p></w:tc>`;
    await writePackage(path, {
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>`
            + `<w:p>${run('계약 금액은 ')}${run('38,400,000원')}${run('입니다.')}</w:p>`
            // Consecutive hidden runs are one withheld passage, not three.
            + `<w:p>${run('내부 메모: ', true)}${run('상한 42,000,000까지 승인됨', true)}</w:p>`
            // An inline hidden phrase keeps the visible sentence intact around it.
            + `<w:p>${run('검토 후 ')}${run('(법무 확인 전)', true)}${run(' 회신 바랍니다.')}</w:p>`
            // A run whose hidden flag is turned off is ordinary text.
            + `<w:p><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>공개 조항</w:t></w:r></w:p>`
            + `<w:tbl><w:tr>${cell(run('항목'))}${cell(run('금액'))}</w:tr>`
            + `<w:tr>${cell(run('야간 인력'))}${cell(`${run('38,400,000원')}${run('(내부 상한 42,000,000)', true)}`)}</w:tr></w:tbl>`
            + '</w:body></w:document>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '계약 금액은 38,400,000원입니다.',
        '[hidden: 내부 메모: 상한 42,000,000까지 승인됨]',
        '검토 후 [hidden: (법무 확인 전)] 회신 바랍니다.',
        '공개 조항',
        '항목\t금액',
        '야간 인력\t38,400,000원[hidden: (내부 상한 42,000,000)]',
    ]);
});

// A filtered view and a working column are withheld the same way a whole sheet
// is: the values stay in the file and the sheet does not show them. Read as
// ordinary cells, a filtered-out record is quoted back as part of the answer.
test('hidden rows and columns are marked in the sheet they belong to', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-hidden-grid-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const path = join(root, 'plan.xlsx');
    const text = (ref, value) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
    const number = (ref, value) => `<c r="${ref}"><v>${value}</v></c>`;
    await writePackage(path, {
        'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>`
            + '<sheet name="배치" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}">`
            + '<cols><col min="3" max="3" width="12" hidden="1"/></cols><sheetData>'
            + `<row r="1">${text('A1', '허브')}${number('B1', 1240)}${text('C1', '내부메모')}</row>`
            + `<row r="2">${text('A2', '대전')}${number('B2', 1240)}${text('C2', '협의 중')}</row>`
            + `<row r="3" hidden="1">${text('A3', '광주')}${number('B3', 880)}${text('C3', '보류')}</row>`
            + '</sheetData></worksheet>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '--- sheet 배치 ---',
        '허브\t1240\t내부메모',
        '대전\t1240\t협의 중',
        '[hidden] 광주\t880\t보류',
        '[hidden columns: C (내부메모)]',
    ]);
});

// A header and a footer print on every page — the confidentiality mark, the
// document number. They live in their own parts, so a document read from the
// body alone loses what each of its pages says.
test('a document reads its header and footer, not only the body', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-chrome-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'contract.docx');
    const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    await writePackage(path, {
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>`
            + paragraph('계약 금액은 38,400,000원입니다.')
            + '</w:body></w:document>',
        'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${WORD_NS}">${paragraph('대외비 — 물류본부 2026-10 v3')}</w:hdr>`,
        // The first-page variant repeats the same words; they are one fact.
        'word/header2.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${WORD_NS}">${paragraph('대외비 — 물류본부 2026-10 v3')}</w:hdr>`,
        // A bare page number says nothing once its page is gone.
        'word/footer1.xml': `<?xml version="1.0"?><w:ftr xmlns:w="${WORD_NS}">${paragraph('문서번호 LOG-2026-114')}${paragraph('- 1 -')}</w:ftr>`,
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '계약 금액은 38,400,000원입니다.',
        '',
        '--- header ---',
        '대외비 — 물류본부 2026-10 v3',
        '',
        '--- footer ---',
        '문서번호 LOG-2026-114',
    ]);
});

// A legacy .doc is an OLE compound file, and it reaches a reader renamed to
// .docx more often than not. "Not a ZIP container" names a library's problem,
// not the user's file or the way out of it.
test('a legacy Office file says what it is instead of a ZIP complaint', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-legacy-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'memo.docx');
    await fs.writeFile(path, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]));
    const answer = await extractOoxmlText(path);
    assert.match(answer, /legacy Office file \(\.doc\/\.xls\/\.ppt\)/);
    assert.match(answer, /save a copy as \.docx/);
    assert.doesNotMatch(answer, /ZIP|central directory/i);
});

// Excel keeps a date as a day count and a percentage as a fraction, so the
// stored value and the value the sheet shows are different facts: a deadline
// read as 46311 and a rate read as 0.928 are both wrong answers about the file.
test('a sheet reads dates and percentages the way it shows them', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-format-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'schedule.xlsx');
    const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    await writePackage(path, {
        'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>`
            + '<sheet name="일정" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        // Style 1 is a custom date format, style 2 the built-in 0.00%, style 3 plain.
        'xl/styles.xml': `<?xml version="1.0"?><styleSheet xmlns="${SHEET_NS}">`
            + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;년&quot; mm&quot;월&quot; dd&quot;일&quot;"/></numFmts>'
            + '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/>'
            + '<xf numFmtId="10" applyNumberFormat="1"/><xf numFmtId="3" applyNumberFormat="1"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>`
            + '<row r="1"><c r="A1" t="inlineStr"><is><t>기한</t></is></c><c r="B1" t="inlineStr"><is><t>비중</t></is></c>'
            + '<c r="C1" t="inlineStr"><is><t>건수</t></is></c></row>'
            + '<row r="2"><c r="A2" s="1"><v>46311</v></c><c r="B2" s="2"><v>0.928</v></c><c r="C2" s="3"><v>47210</v></c></row>'
            + '</sheetData></worksheet>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '--- sheet 일정 ---',
        '기한\t비중\t건수',
        // The day count becomes the date, the fraction the percentage, and a
        // plain number stays the number it is.
        '2026-10-16\t92.80%\t47210',
    ]);
});

test('a slide table keeps its rows too', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-pptx-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'deck.pptx');
    const cell = (text) => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
    await writePackage(path, {
        // PowerPoint always wraps a table in a graphic frame, the same holder a
        // chart uses — reading the frame must not swallow the table's words.
        'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>`
            + '<p:sp><p:txBody><a:p><a:r><a:t>비용 비교</a:t></a:r></a:p></p:txBody></p:sp>'
            + '<p:graphicFrame><a:graphic><a:graphicData>'
            + `<a:tbl><a:tr>${cell('안')}${cell('월 비용')}</a:tr><a:tr>${cell('증원')}${cell('38,400,000원')}</a:tr></a:tbl>`
            + '</a:graphicData></a:graphic></p:graphicFrame>'
            + '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart 5" descr="월 비용 추이"/></p:nvGraphicFramePr>'
            + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
            + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId3"/>'
            + '</a:graphicData></a:graphic></p:graphicFrame>'
            + '</p:spTree></p:cSld></p:sld>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '--- slide 1 ---',
        '비용 비교',
        '안\t월 비용',
        '증원\t38,400,000원',
        '[chart: 월 비용 추이]',
    ]);
});

test('speaker notes are read with their slide, without the thumbnail placeholders', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-office-notes-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'deck.pptx');
    const shape = (placeholder, text) => '<p:sp><p:nvSpPr><p:nvPr>'
        + `<p:ph type="${placeholder}"/></p:nvPr></p:nvSpPr>`
        + `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    await writePackage(path, {
        'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>`
            + '<p:sp><p:txBody><a:p><a:r><a:t>야간 운영 전환 결과</a:t></a:r></a:p></p:txBody></p:sp>'
            + '</p:spTree></p:cSld></p:sld>',
        'ppt/slides/_rels/slide1.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
            + '<Relationship Id="rId2" Type="notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
        'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0"?><p:notes xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>`
            + shape('sldNum', '1')
            + shape('body', '증원 승인을 요청합니다.')
            + '</p:spTree></p:cSld></p:notes>',
    });
    assert.deepEqual((await extractOoxmlText(path)).split('\n'), [
        '--- slide 1 ---',
        '야간 운영 전환 결과',
        '[notes] 증원 승인을 요청합니다.',
    ]);
});

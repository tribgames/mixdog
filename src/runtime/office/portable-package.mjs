import { writeFile } from 'node:fs/promises';
import JSZip from 'jszip';

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORD_MAIN = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SHEET_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PRESENTATION_MAIN = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_MAIN = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const MAIN_PART_TYPES = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
});

const FILE_KIND_FAMILIES = Object.freeze({
  docx: 'docx',
  dotx: 'docx',
  xlsx: 'xlsx',
  xltx: 'xlsx',
  pptx: 'pptx',
  potx: 'pptx',
});

const SLIDE_WIDTH = 12_192_000;
const SLIDE_HEIGHT = 6_858_000;
const NOTES_WIDTH = 6_858_000;
const NOTES_HEIGHT = 9_144_000;

function encode(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function document(body) {
  return `${DECLARATION}\r\n${body}`;
}

function relationships(entries) {
  const items = entries
    .map(({ id, type, target, mode }) => `<Relationship Id="${id}" Type="${type}" Target="${encode(target)}"${mode ? ` TargetMode="${mode}"` : ''}/>`)
    .join('');
  return document(`<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">${items}</Relationships>`);
}

function contentTypes({ defaults = [], overrides = [] }) {
  const defaultEntries = [
    { extension: 'rels', type: 'application/vnd.openxmlformats-package.relationships+xml' },
    { extension: 'xml', type: 'application/xml' },
    ...defaults,
  ].map(({ extension, type }) => `<Default Extension="${extension}" ContentType="${type}"/>`).join('');
  const overrideEntries = overrides
    .map(({ part, type }) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join('');
  return document(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaultEntries}${overrideEntries}</Types>`);
}

function coreProperties(title) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return document('<cp:coreProperties'
    + ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
    + ' xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${encode(title)}</dc:title>`
    + '<dc:creator>Mixdog</dc:creator>'
    + '<cp:lastModifiedBy>Mixdog</cp:lastModifiedBy>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`
    + '</cp:coreProperties>');
}

const CORE_PROPERTY_TYPE = 'application/vnd.openxmlformats-package.core-properties+xml';
const CORE_PROPERTY_RELATIONSHIP = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';

function wordHeadingStyle(id, name, outline, size, spacingBefore) {
  return `<w:style w:type="paragraph" w:styleId="${id}">`
    + `<w:name w:val="${name}"/>`
    + '<w:basedOn w:val="Normal"/>'
    + '<w:next w:val="Normal"/>'
    + '<w:qFormat/>'
    + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${spacingBefore}" w:after="120"/><w:outlineLvl w:val="${outline}"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
    + '</w:style>';
}

function wordStyles() {
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join('');
  return document(`<w:styles xmlns:w="${WORD_MAIN}">`
    + '<w:docDefaults>'
    + '<w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic" w:cs="Arial"/>'
    + '<w:sz w:val="22"/><w:szCs w:val="22"/>'
    + '</w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="120"/><w:contextualSpacing/></w:pPr>'
    + '<w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="240"/></w:pPr>'
    + '<w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>'
    + wordHeadingStyle('Heading1', 'heading 1', 0, 32, 240)
    + wordHeadingStyle('Heading2', 'heading 2', 1, 28, 200)
    + wordHeadingStyle('Heading3', 'heading 3', 2, 26, 160)
    + wordHeadingStyle('Heading4', 'heading 4', 3, 24, 160)
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>'
    + '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
    + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>'
    + '</w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/>'
    + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    + `<w:tblPr><w:tblBorders>${border}</w:tblBorders></w:tblPr></w:style>`
    + '</w:styles>');
}

function wordDocument() {
  return document(`<w:document xmlns:w="${WORD_MAIN}" xmlns:r="${OFFICE_RELATIONSHIPS}">`
    + '<w:body><w:p/>'
    + '<w:sectPr>'
    + '<w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/>'
    + '<w:cols w:space="708"/>'
    + '<w:docGrid w:linePitch="360"/>'
    + '</w:sectPr></w:body></w:document>');
}

function docxPackage({ title, fileKind }) {
  return new Map([
    ['[Content_Types].xml', contentTypes({
      overrides: [
        { part: '/word/document.xml', type: MAIN_PART_TYPES[fileKind] },
        { part: '/word/styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' },
        { part: '/docProps/core.xml', type: CORE_PROPERTY_TYPE },
      ],
    })],
    ['_rels/.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/officeDocument`, target: 'word/document.xml' },
      { id: 'rId2', type: CORE_PROPERTY_RELATIONSHIP, target: 'docProps/core.xml' },
    ])],
    ['docProps/core.xml', coreProperties(title)],
    ['word/document.xml', wordDocument()],
    ['word/_rels/document.xml.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/styles`, target: 'styles.xml' },
    ])],
    ['word/styles.xml', wordStyles()],
  ]);
}

function sheetStyles() {
  return document(`<styleSheet xmlns="${SHEET_MAIN}">`
    + '<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>');
}

function xlsxPackage({ title, fileKind, sheetName }) {
  const name = String(sheetName || 'Sheet1').slice(0, 31);
  return new Map([
    ['[Content_Types].xml', contentTypes({
      overrides: [
        { part: '/xl/workbook.xml', type: MAIN_PART_TYPES[fileKind] },
        { part: '/xl/worksheets/sheet1.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' },
        { part: '/xl/styles.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' },
        { part: '/xl/sharedStrings.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml' },
        { part: '/docProps/core.xml', type: CORE_PROPERTY_TYPE },
      ],
    })],
    ['_rels/.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/officeDocument`, target: 'xl/workbook.xml' },
      { id: 'rId2', type: CORE_PROPERTY_RELATIONSHIP, target: 'docProps/core.xml' },
    ])],
    ['docProps/core.xml', coreProperties(title)],
    ['xl/workbook.xml', document(`<workbook xmlns="${SHEET_MAIN}" xmlns:r="${OFFICE_RELATIONSHIPS}">`
      + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews>'
      + `<sheets><sheet name="${encode(name)}" sheetId="1" r:id="rId1"/></sheets>`
      + '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
      + '</workbook>')],
    ['xl/_rels/workbook.xml.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/worksheet`, target: 'worksheets/sheet1.xml' },
      { id: 'rId2', type: `${OFFICE_RELATIONSHIPS}/styles`, target: 'styles.xml' },
      { id: 'rId3', type: `${OFFICE_RELATIONSHIPS}/sharedStrings`, target: 'sharedStrings.xml' },
    ])],
    ['xl/worksheets/sheet1.xml', document(`<worksheet xmlns="${SHEET_MAIN}" xmlns:r="${OFFICE_RELATIONSHIPS}">`
      + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<sheetData/>'
      + '</worksheet>')],
    ['xl/styles.xml', sheetStyles()],
    ['xl/sharedStrings.xml', document(`<sst xmlns="${SHEET_MAIN}" count="0" uniqueCount="0"/>`)],
  ]);
}

function themeFill(modifiers = '') {
  return modifiers
    ? `<a:solidFill><a:schemeClr val="phClr">${modifiers}</a:schemeClr></a:solidFill>`
    : '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
}

function themeLine(width) {
  return `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">`
    + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    + '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>';
}

function presentationTheme() {
  const colors = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="1F2933"/>'],
    ['lt2', '<a:srgbClr val="F4F6F8"/>'],
    ['accent1', '<a:srgbClr val="1B4965"/>'],
    ['accent2', '<a:srgbClr val="5FA8D3"/>'],
    ['accent3', '<a:srgbClr val="62B6CB"/>'],
    ['accent4', '<a:srgbClr val="CAE9FF"/>'],
    ['accent5', '<a:srgbClr val="BEE9E8"/>'],
    ['accent6', '<a:srgbClr val="F4A259"/>'],
    ['hlink', '<a:srgbClr val="0B6BCB"/>'],
    ['folHlink', '<a:srgbClr val="6B47B8"/>'],
  ].map(([slot, value]) => `<a:${slot}>${value}</a:${slot}>`).join('');
  return document(`<a:theme xmlns:a="${DRAWING_MAIN}" name="Mixdog">`
    + '<a:themeElements>'
    + `<a:clrScheme name="Mixdog">${colors}</a:clrScheme>`
    + '<a:fontScheme name="Mixdog">'
    + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
    + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'
    + '</a:fontScheme>'
    + '<a:fmtScheme name="Mixdog">'
    + '<a:fillStyleLst>'
    + themeFill()
    + themeFill('<a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/>')
    + themeFill('<a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/>')
    + '</a:fillStyleLst>'
    + `<a:lnStyleLst>${themeLine(6350)}${themeLine(12700)}${themeLine(19050)}</a:lnStyleLst>`
    + '<a:effectStyleLst>'
    + '<a:effectStyle><a:effectLst/></a:effectStyle>'
    + '<a:effectStyle><a:effectLst/></a:effectStyle>'
    + '<a:effectStyle><a:effectLst/></a:effectStyle>'
    + '</a:effectStyleLst>'
    + '<a:bgFillStyleLst>'
    + themeFill()
    + themeFill('<a:tint val="95000"/><a:satMod val="170000"/>')
    + themeFill('<a:shade val="90000"/><a:satMod val="150000"/>')
    + '</a:bgFillStyleLst>'
    + '</a:fmtScheme>'
    + '</a:themeElements>'
    + '</a:theme>');
}

function emptyShapeTree() {
  return '<p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + '</p:spTree>';
}

function presentationNamespaces() {
  return `xmlns:a="${DRAWING_MAIN}" xmlns:r="${OFFICE_RELATIONSHIPS}" xmlns:p="${PRESENTATION_MAIN}"`;
}

function slideMaster() {
  const colorMap = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"'
    + ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
  return document(`<p:sldMaster ${presentationNamespaces()}>`
    + '<p:cSld>'
    + '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
    + emptyShapeTree()
    + '</p:cSld>'
    + `<p:clrMap ${colorMap}/>`
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + '<p:txStyles>'
    + '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"/></a:lvl1pPr></p:titleStyle>'
    + '<p:bodyStyle><a:lvl1pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>'
    + '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>'
    + '</p:txStyles>'
    + '</p:sldMaster>');
}

function slideLayout() {
  return document(`<p:sldLayout ${presentationNamespaces()} type="blank" preserve="1">`
    + `<p:cSld name="Blank">${emptyShapeTree()}</p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
    + '</p:sldLayout>');
}

function pptxPackage({ title, fileKind }) {
  return new Map([
    ['[Content_Types].xml', contentTypes({
      defaults: [
        { extension: 'jpeg', type: 'image/jpeg' },
        { extension: 'png', type: 'image/png' },
      ],
      overrides: [
        { part: '/ppt/presentation.xml', type: MAIN_PART_TYPES[fileKind] },
        { part: '/ppt/slideMasters/slideMaster1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml' },
        { part: '/ppt/slideLayouts/slideLayout1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml' },
        { part: '/ppt/theme/theme1.xml', type: 'application/vnd.openxmlformats-officedocument.theme+xml' },
        { part: '/docProps/core.xml', type: CORE_PROPERTY_TYPE },
      ],
    })],
    ['_rels/.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/officeDocument`, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: CORE_PROPERTY_RELATIONSHIP, target: 'docProps/core.xml' },
    ])],
    ['docProps/core.xml', coreProperties(title)],
    ['ppt/presentation.xml', document(`<p:presentation ${presentationNamespaces()} saveSubsetFonts="1">`
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
      + '<p:sldIdLst/>'
      + `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>`
      + `<p:notesSz cx="${NOTES_WIDTH}" cy="${NOTES_HEIGHT}"/>`
      + '</p:presentation>')],
    ['ppt/_rels/presentation.xml.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
      { id: 'rId2', type: `${OFFICE_RELATIONSHIPS}/theme`, target: 'theme/theme1.xml' },
    ])],
    ['ppt/slideMasters/slideMaster1.xml', slideMaster()],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: `${OFFICE_RELATIONSHIPS}/theme`, target: '../theme/theme1.xml' },
    ])],
    ['ppt/slideLayouts/slideLayout1.xml', slideLayout()],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships([
      { id: 'rId1', type: `${OFFICE_RELATIONSHIPS}/slideMaster`, target: '../slideMasters/slideMaster1.xml' },
    ])],
    ['ppt/theme/theme1.xml', presentationTheme()],
  ]);
}

function columnLabel(index) {
  let value = Math.max(1, Math.trunc(index));
  let label = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = `${String.fromCharCode(65 + remainder)}${label}`;
    value = Math.trunc((value - 1) / 26);
  }
  return label;
}

function worksheetWithRows(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : []).map((value, columnIndex) => {
      if (value == null || value === '') return '';
      const reference = `${columnLabel(columnIndex + 1)}${rowIndex + 1}`;
      const numeric = Number(value);
      if (typeof value === 'number' && Number.isFinite(numeric)) {
        return `<c r="${reference}"><v>${numeric}</v></c>`;
      }
      return `<c r="${reference}" t="inlineStr"><is><t>${encode(value)}</t></is></c>`;
    }).join('');
    return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : '';
  }).join('');
  return document(`<worksheet xmlns="${SHEET_MAIN}" xmlns:r="${OFFICE_RELATIONSHIPS}">`
    + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<sheetData>${body}</sheetData>`
    + '</worksheet>');
}

export async function createPortableChartWorkbook(rows = [], { sheetName = 'Sheet1' } = {}) {
  const parts = xlsxPackage({ title: 'Chart data', fileKind: 'xlsx', sheetName });
  parts.set('xl/worksheets/sheet1.xml', worksheetWithRows(rows));
  const zip = new JSZip();
  for (const [name, content] of parts) zip.file(name, content);
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
}

const BUILDERS = Object.freeze({
  docx: docxPackage,
  xlsx: xlsxPackage,
  pptx: pptxPackage,
});

export function portableCreateSupported(fileKind) {
  return Object.hasOwn(FILE_KIND_FAMILIES, String(fileKind || '').toLowerCase());
}

export function portableCreateFileKinds() {
  return Object.keys(FILE_KIND_FAMILIES);
}

export async function createPortableOoxmlDocument(path, {
  fileKind,
  title = '',
  sheetName = 'Sheet1',
} = {}) {
  const kind = String(fileKind || '').toLowerCase();
  const family = FILE_KIND_FAMILIES[kind];
  if (!family) {
    throw new Error(`Portable Office creation supports ${portableCreateFileKinds().join(', ')}; .${kind || 'unknown'} requires Microsoft Office`);
  }
  const parts = BUILDERS[family]({
    title: title || 'Untitled',
    fileKind: kind,
    sheetName,
  });
  const zip = new JSZip();
  for (const [name, content] of parts) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  }));
  return { path, format: family, fileKind: kind, parts: [...parts.keys()] };
}

import { basename, join } from 'node:path';
import { booleanXmlAttribute, cellRecords, formulaReferences, sharedStrings, workbookCalculation, workbookSheets } from './portable-cells.mjs';
import { loadPackage, partRelationshipPath, relationshipTarget, zipText } from './portable-opc.mjs';
import { containerInner, paragraphTexts, textNodes, topLevelElements, xmlDecode } from './portable-xml.mjs';


export function docxBodyModel(documentXml) {
  const body = containerInner(documentXml, 'w:body');
  if (!body) return { paragraphs: [], tables: [], blocks: [] };
  const blocks = topLevelElements(body.inner, ['w:p', 'w:tbl']);
  let paragraphIndex = 0;
  let tableIndex = 0;
  const paragraphs = [];
  const tables = [];
  for (const block of blocks) {
    if (block.name === 'w:p') {
      paragraphIndex += 1;
      const runs = textNodes(block.xml, 'w:t').map((node, index) => ({
        path: `/body/p[${paragraphIndex}]/run[${index + 1}]`,
        index: index + 1,
        text: node.text,
      }));
      paragraphs.push({
        path: `/body/p[${paragraphIndex}]`,
        index: paragraphIndex,
        // Word numbers every paragraph in the document, table cells included, so
        // the Office reader reports those too. This model walks body blocks only.
        // Stating the scope lets a caller compare the two readings instead of
        // silently mistaking cell text for body text.
        inTable: false,
        text: runs.map((run) => run.text).join(''),
        // Word resolves a paragraph carrying no explicit style to Normal, and the
        // Office reader reports it that way. Answering with an empty string made
        // the same paragraph look unstyled to one backend and styled to the other.
        style: xmlDecode(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(block.xml)?.[1] || 'Normal'),
        runs,
      });
      block.logicalIndex = paragraphIndex;
    } else {
      tableIndex += 1;
      const tableInner = containerInner(block.xml, 'w:tbl')?.inner || '';
      const rows = topLevelElements(tableInner, ['w:tr']).map((row, rowIndex) => ({
        path: `/body/tbl[${tableIndex}]/row[${rowIndex + 1}]`,
        index: rowIndex + 1,
        cells: topLevelElements(containerInner(row.xml, 'w:tr')?.inner || '', ['w:tc']).map((cell, cellIndex) => ({
          path: `/body/tbl[${tableIndex}]/row[${rowIndex + 1}]/cell[${cellIndex + 1}]`,
          index: cellIndex + 1,
          text: paragraphTexts(cell.xml, 'w:t').join(''),
        })),
      }));
      tables.push({
        path: `/body/tbl[${tableIndex}]`,
        index: tableIndex,
        // Word falls back to TableNormal when a table declares no style, which is
        // what the Office reader reports; without this the two backends disagreed
        // on the style of the very same table.
        style: xmlDecode(/<w:tblStyle\b[^>]*\bw:val="([^"]+)"/.exec(block.xml)?.[1] || 'TableNormal'),
        rows,
      });
      block.logicalIndex = tableIndex;
    }
  }
  return { paragraphs, tables, blocks, body };
}


export function appendDocxBlock(documentXml, block) {
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const onlyEmptyParagraph = model.blocks.length === 1
    && model.blocks[0].name === 'w:p'
    && !paragraphTexts(model.blocks[0].xml, 'w:t').length
    && !/<w:drawing\b/.test(model.blocks[0].xml);
  if (onlyEmptyParagraph) {
    const placeholder = model.blocks[0];
    const replaced = `${model.body.inner.slice(0, placeholder.start)}${block}${model.body.inner.slice(placeholder.end)}`;
    return `${documentXml.slice(0, model.body.start)}${replaced}${documentXml.slice(model.body.end)}`;
  }
  const trailingSection = /<w:sectPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:sectPr>)\s*$/.exec(model.body.inner);
  const position = trailingSection ? trailingSection.index : model.body.inner.length;
  const inner = `${model.body.inner.slice(0, position)}${block}${model.body.inner.slice(position)}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
}


export async function snapshotDocx(zip, options = {}) {
  const parts = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort();
  const content = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    content.push({ part, text: paragraphTexts(xml, 'w:t').join('') });
  }
  const documentXml = await zipText(zip, 'word/document.xml');
  const model = docxBodyModel(documentXml);
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 200) : model.blocks.length;
  let selectedBlocks = model.blocks;
  if (paged && options.target) {
    const paragraph = /^\/body\/p\[(\d+)]/.exec(String(options.target));
    const table = /^\/body\/tbl\[(\d+)]/.exec(String(options.target));
    selectedBlocks = paragraph
      ? model.blocks.filter((block) => block.name === 'w:p' && block.logicalIndex === Number(paragraph[1]))
      : table
        ? model.blocks.filter((block) => block.name === 'w:tbl' && block.logicalIndex === Number(table[1]))
        : model.blocks.slice(offset, offset + limit);
  } else if (paged) {
    selectedBlocks = model.blocks.slice(offset, offset + limit);
  }
  const paragraphIndexes = new Set(selectedBlocks.filter((block) => block.name === 'w:p').map((block) => block.logicalIndex));
  const tableIndexes = new Set(selectedBlocks.filter((block) => block.name === 'w:tbl').map((block) => block.logicalIndex));
  const storyParts = parts.filter((name) => !/\/comments\.xml$/i.test(name));
  const comments = [];
  const commentsXml = await zipText(zip, 'word/comments.xml');
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attributes = match[1];
    const id = xmlDecode(/\bw:id="([^"]+)"/.exec(attributes)?.[1] || '');
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let anchoredText = '';
    let anchoredPart = '';
    for (const part of storyParts) {
      const xml = await zipText(zip, part);
      const start = new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id="${escapedId}"[^>]*/?>`).exec(xml);
      const end = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${escapedId}"[^>]*/?>`).exec(xml);
      if (!start || !end || end.index < start.index) continue;
      anchoredText = paragraphTexts(xml.slice(start.index + start[0].length, end.index), 'w:t').join('');
      anchoredPart = part;
      break;
    }
    comments.push({
      path: `/body/comment[${comments.length + 1}]`,
      index: comments.length + 1,
      id,
      author: xmlDecode(/\bw:author="([^"]*)"/.exec(attributes)?.[1] || ''),
      initials: xmlDecode(/\bw:initials="([^"]*)"/.exec(attributes)?.[1] || ''),
      date: xmlDecode(/\bw:date="([^"]*)"/.exec(attributes)?.[1] || ''),
      text: paragraphTexts(match[2], 'w:t').join(''),
      anchoredText,
      part: anchoredPart,
    });
  }
  const revisions = [];
  for (const part of storyParts) {
    const xml = await zipText(zip, part);
    for (const match of xml.matchAll(/<w:(ins|del)\b([^>]*)>([\s\S]*?)<\/w:\1>/g)) {
      const kind = match[1];
      const attributes = match[2];
      revisions.push({
        path: `/body/revision[${revisions.length + 1}]`,
        index: revisions.length + 1,
        id: xmlDecode(/\bw:id="([^"]+)"/.exec(attributes)?.[1] || ''),
        author: xmlDecode(/\bw:author="([^"]*)"/.exec(attributes)?.[1] || ''),
        date: xmlDecode(/\bw:date="([^"]*)"/.exec(attributes)?.[1] || ''),
        type: kind === 'ins' ? 'insertion' : 'deletion',
        text: paragraphTexts(match[3], kind === 'ins' ? 'w:t' : 'w:delText').join(''),
        part,
      });
    }
  }
  const notes = [];
  for (const [kind, part, tag] of [
    ['footnote', 'word/footnotes.xml', 'w:footnote'],
    ['endnote', 'word/endnotes.xml', 'w:endnote'],
  ]) {
    const xml = await zipText(zip, part);
    const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g');
    for (const match of xml.matchAll(pattern)) {
      const id = xmlDecode(/\bw:id="([^"]+)"/.exec(match[1])?.[1] || '');
      if (Number(id) < 0) continue;
      notes.push({
        path: `/body/${kind}[${notes.filter((entry) => entry.kind === kind).length + 1}]`,
        kind,
        id,
        text: paragraphTexts(match[2], 'w:t').join(''),
        part,
      });
    }
  }
  const contentControls = [];
  for (const part of storyParts) {
    const xml = await zipText(zip, part);
    for (const match of xml.matchAll(/<w:sdt\b[^>]*>([\s\S]*?)<\/w:sdt>/g)) {
      const properties = /<w:sdtPr\b[^>]*>([\s\S]*?)<\/w:sdtPr>/.exec(match[1])?.[1] || '';
      contentControls.push({
        path: `/body/content-control[${contentControls.length + 1}]`,
        index: contentControls.length + 1,
        tag: xmlDecode(/<w:tag\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || ''),
        title: xmlDecode(/<w:alias\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || ''),
        lock: xmlDecode(/<w:lock\b[^>]*\bw:val="([^"]*)"/.exec(properties)?.[1] || ''),
        text: paragraphTexts(match[1], 'w:t').join(''),
        part,
      });
    }
  }
  const commentThreads = [];
  const commentsExtended = await zipText(zip, 'word/commentsExtended.xml');
  for (const match of commentsExtended.matchAll(/<w15:commentEx\b([^>]*?)\/?>/g)) {
    commentThreads.push({
      path: `/body/comment-thread[${commentThreads.length + 1}]`,
      index: commentThreads.length + 1,
      paraId: xmlDecode(/\bw15:paraId="([^"]*)"/.exec(match[1])?.[1] || ''),
      parentParaId: xmlDecode(/\bw15:paraIdParent="([^"]*)"/.exec(match[1])?.[1] || ''),
      resolved: /^(?:1|true)$/i.test(/\bw15:done="([^"]*)"/.exec(match[1])?.[1] || ''),
    });
  }
  return {
    format: 'docx',
    path: '/',
    paragraphCount: model.paragraphs.length,
    tableCount: model.tables.length,
    paragraphs: paged ? model.paragraphs.filter((paragraph) => paragraphIndexes.has(paragraph.index)) : model.paragraphs,
    tables: paged ? model.tables.filter((table) => tableIndexes.has(table.index)) : model.tables,
    blockOrder: selectedBlocks.map((block) => ({
      type: block.name === 'w:p' ? 'paragraph' : 'table',
      index: block.logicalIndex,
      path: block.name === 'w:p'
        ? `/body/p[${block.logicalIndex}]`
        : `/body/tbl[${block.logicalIndex}]`,
      start: block.start,
    })),
    parts: paged && model.blocks.length > limit
      ? content.map((part) => ({ part: part.part, chars: part.text.length }))
      : content,
    commentCount: comments.length,
    revisionCount: revisions.length,
    comments,
    revisions,
    footnoteCount: notes.filter((entry) => entry.kind === 'footnote').length,
    endnoteCount: notes.filter((entry) => entry.kind === 'endnote').length,
    footnotes: notes.filter((entry) => entry.kind === 'footnote'),
    endnotes: notes.filter((entry) => entry.kind === 'endnote'),
    contentControlCount: contentControls.length,
    contentControls,
    commentThreadCount: commentThreads.length,
    commentThreads,
    ...(paged ? {
      pagination: {
        unit: 'body-block',
        offset,
        limit,
        returned: selectedBlocks.length,
        total: model.blocks.length,
        nextOffset: offset + selectedBlocks.length < model.blocks.length
          ? offset + selectedBlocks.length
          : null,
      },
    } : {}),
  };
}


export async function snapshotXlsx(zip, options = {}) {
  const sheets = await workbookSheets(zip);
  const strings = await sharedStrings(zip);
  const workbookXml = await zipText(zip, 'xl/workbook.xml');
  const calculation = workbookCalculation(workbookXml);
  const definedNames = [];
  for (const match of workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const attributes = match[1];
    definedNames.push({
      path: `/defined-name[${definedNames.length + 1}]`,
      index: definedNames.length + 1,
      name: xmlDecode(/\bname="([^"]+)"/.exec(attributes)?.[1] || ''),
      localSheetId: Number(/\blocalSheetId="(\d+)"/.exec(attributes)?.[1] ?? -1),
      hidden: booleanXmlAttribute(attributes, 'hidden'),
      refersTo: xmlDecode(match[2]),
    });
  }
  const output = [];
  let formulaCount = 0;
  let formulaCacheMissing = 0;
  const paged = options.paged === true;
  const selectedSheets = paged
    ? [options.sheet
        ? sheets.find((sheet) => sheet.name.toLowerCase() === String(options.sheet).toLowerCase())
        : sheets[0]].filter(Boolean)
    : sheets;
  if (paged && options.sheet && !selectedSheets.length) throw new Error(`XLSX sheet not found: ${options.sheet}`);
  let page = null;
  for (const sheet of selectedSheets) {
    const xml = await zipText(zip, sheet.path);
    const cellResult = cellRecords(xml, strings, paged ? options : null);
    const cells = paged ? cellResult.records : cellResult;
    const validations = [];
    for (const match of xml.matchAll(/<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
      const attributes = match[1];
      const body = match[2] || '';
      validations.push({
        path: `/sheet[${sheet.name}]/validation[${validations.length + 1}]`,
        index: validations.length + 1,
        ranges: xmlDecode(/\bsqref="([^"]+)"/.exec(attributes)?.[1] || '').split(/\s+/).filter(Boolean),
        type: /\btype="([^"]+)"/.exec(attributes)?.[1] || '',
        operator: /\boperator="([^"]+)"/.exec(attributes)?.[1] || '',
        allowBlank: booleanXmlAttribute(attributes, 'allowBlank'),
        showInputMessage: booleanXmlAttribute(attributes, 'showInputMessage'),
        showErrorMessage: booleanXmlAttribute(attributes, 'showErrorMessage'),
        formula1: xmlDecode(/<formula1(?:\s[^>]*)?>([\s\S]*?)<\/formula1>/.exec(body)?.[1] || ''),
        formula2: xmlDecode(/<formula2(?:\s[^>]*)?>([\s\S]*?)<\/formula2>/.exec(body)?.[1] || ''),
      });
    }
    const conditionalFormats = [];
    for (const match of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
      const ranges = xmlDecode(/\bsqref="([^"]+)"/.exec(match[1])?.[1] || '').split(/\s+/).filter(Boolean);
      for (const rule of match[2].matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)) {
        const attributes = rule[1];
        const body = rule[2] || '';
        conditionalFormats.push({
          path: `/sheet[${sheet.name}]/conditional-format[${conditionalFormats.length + 1}]`,
          index: conditionalFormats.length + 1,
          ranges,
          type: xmlDecode(/\btype="([^"]+)"/.exec(attributes)?.[1] || ''),
          operator: xmlDecode(/\boperator="([^"]+)"/.exec(attributes)?.[1] || ''),
          priority: Number(/\bpriority="(\d+)"/.exec(attributes)?.[1] || 0),
          formulas: [...body.matchAll(/<formula(?:\s[^>]*)?>([\s\S]*?)<\/formula>/g)].map((entry) => xmlDecode(entry[1])),
        });
      }
    }
    const lineage = cells.filter((cell) => cell.formula).map((cell) => ({
      path: `/sheet[${sheet.name}]/cell[${cell.ref}]/lineage`,
      from: `/sheet[${sheet.name}]/cell[${cell.ref}]`,
      formula: cell.formula,
      precedents: formulaReferences(cell.formula, sheet.name),
    }));
    formulaCount += paged ? cellResult.formulaCount : cells.filter((cell) => cell.formula).length;
    formulaCacheMissing += paged ? cellResult.formulaCacheMissing : cells.filter((cell) => cell.formula && cell.cacheState === 'missing').length;
    if (paged) page = cellResult;
    output.push({
      path: `/sheet[${sheet.name}]`,
      name: sheet.name,
      cellCount: paged ? cellResult.total : cells.length,
      cells: (paged ? cells : cells.slice(0, 2000)).map((cell) => ({
        path: `/sheet[${sheet.name}]/cell[${cell.ref}]`,
        ...cell,
      })),
      truncated: paged ? cellResult.total > cells.length : cells.length > 2000,
      validationCount: validations.length,
      validations,
      conditionalFormatCount: conditionalFormats.length,
      conditionalFormats,
      lineageCount: lineage.length,
      formulaLineage: lineage,
    });
  }
  return {
    format: 'xlsx',
    sheetCount: sheets.length,
    sheets: output,
    formulaCount,
    formulaCacheMissing,
    needsRecalculation: formulaCacheMissing > 0,
    calculation,
    definedNameCount: definedNames.length,
    definedNames,
    ...(paged ? {
      pagination: {
        unit: 'populated-cell',
        scope: `${selectedSheets[0]?.name || ''}${options.range ? `!${options.range}` : ''}`,
        offset: Math.max(0, Number(options.offset) || 0),
        limit: Math.max(1, Number(options.limit) || 2_000),
        returned: page?.records.length || 0,
        total: page?.total || 0,
        nextOffset: page && (Math.max(0, Number(options.offset) || 0) + page.records.length < page.total)
          ? Math.max(0, Number(options.offset) || 0) + page.records.length
          : null,
      },
    } : {}),
  };
}


const SLIDE_BACKGROUND = /<p:bg\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/;


async function pptxRelatedPart(zip, part, suffix) {
  const relationshipPath = partRelationshipPath(part);
  const relationships = await zipText(zip, relationshipPath);
  if (!relationships) return '';
  for (const match of relationships.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    if (/\bTargetMode="External"/i.test(match[0])) continue;
    if (!(/\bType="([^"]*)"/.exec(match[0])?.[1] || '').endsWith(suffix)) continue;
    const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1] || '';
    if (target) return relationshipTarget(relationshipPath, target);
  }
  return '';
}


// Microsoft Office reports a resolved background per slide, and the theme review
// abandons the whole deck as soon as one slide has none. Reading only the slide
// part would leave every template deck unreviewed, so inheritance is resolved
// through the layout and master exactly as PowerPoint does.
async function pptxSlideBackground(zip, slidePath, slideXml) {
  const own = SLIDE_BACKGROUND.exec(slideXml)?.[1];
  if (own) return { color: own.toUpperCase(), followMaster: false, source: 'slide' };
  const layoutPath = await pptxRelatedPart(zip, slidePath, '/slideLayout');
  if (layoutPath) {
    const layoutXml = await zipText(zip, layoutPath);
    const inherited = SLIDE_BACKGROUND.exec(layoutXml)?.[1];
    if (inherited) return { color: inherited.toUpperCase(), followMaster: true, source: 'layout' };
    const masterPath = await pptxRelatedPart(zip, layoutPath, '/slideMaster');
    if (masterPath) {
      const fromMaster = SLIDE_BACKGROUND.exec(await zipText(zip, masterPath))?.[1];
      if (fromMaster) return { color: fromMaster.toUpperCase(), followMaster: true, source: 'master' };
    }
  }
  return { color: '', followMaster: true, source: 'master' };
}


async function pptxSlideNotes(zip, slidePath) {
  const notesPath = await pptxRelatedPart(zip, slidePath, '/notesSlide');
  if (!notesPath) return '';
  const xml = await zipText(zip, notesPath);
  const tree = containerInner(xml, 'p:spTree');
  if (!tree) return '';
  for (const shape of topLevelElements(tree.inner, ['p:sp'])) {
    if (/<p:ph\b[^>]*\btype="body"/i.test(shape.xml)) {
      return paragraphTexts(shape.xml, 'a:t').join('\n');
    }
  }
  return paragraphTexts(xml, 'a:t').join('\n');
}


async function snapshotPptx(zip, options = {}) {
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(basename(a))?.[0]) - Number(/\d+/.exec(basename(b))?.[0]));
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 20) : slidePaths.length;
  const requested = paged && Array.isArray(options.pages) && options.pages.length
    ? options.pages.map((page) => slidePaths.find((path) => Number(/slide(\d+)\.xml$/.exec(path)?.[1]) === Number(page))).filter(Boolean)
    : paged
      ? slidePaths.slice(offset, offset + limit)
      : slidePaths;
  const slides = [];
  for (const path of requested) {
    const xml = await zipText(zip, path);
    const index = Number(/slide(\d+)\.xml$/.exec(path)?.[1]);
    const tree = containerInner(xml, 'p:spTree');
    const shapeBlocks = tree ? topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']) : [];
    slides.push({
      path: `/slide[${index}]`,
      index,
      background: await pptxSlideBackground(zip, path, xml),
      notes: await pptxSlideNotes(zip, path),
      text: paragraphTexts(xml, 'a:t'),
      shapes: shapeBlocks.map((shape, shapeIndex) => {
        const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i.exec(shape.xml);
        const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(shape.xml);
        // Design review reads evidence from the same fields Microsoft Office
        // reports. Publishing only the raw element name left every chart, table,
        // group, picture, and type-scale rule blind on portable decks.
        const shapePath = `/slide[${index}]/shape[${shapeIndex + 1}]`;
        const fontSizes = [...shape.xml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/gi)]
          .map((match) => Number(match[1]) / 100)
          .filter((size) => size > 0);
        const tableRows = [...shape.xml.matchAll(/<a:tr\b/gi)].length;
        const tableColumns = [...shape.xml.matchAll(/<a:gridCol\b/gi)].length;
        // Typeface and color inventories feed the deck discipline review; a
        // shape that mixes families or invents colors is otherwise invisible.
        const fonts = [...new Set([...shape.xml.matchAll(/<a:latin\b[^>]*\btypeface="([^"]+)"/gi)]
          .map((match) => xmlDecode(match[1]))
          .filter(Boolean))];
        const colors = [...new Set([...shape.xml.matchAll(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/gi)]
          .map((match) => match[1].toUpperCase()))];
        const shapeName = xmlDecode(/<p:cNvPr\b[^>]*\bname="([^"]*)"/i.exec(shape.xml)?.[1] || '');
        // Preset geometry tells the diversity review which native structure a
        // slide carries (chevron process, block-arc share, trapezoid tiers).
        const geometry = shape.name === 'p:sp'
          ? (/<a:custGeom\b/i.test(shape.xml) ? 'custGeom' : /<a:prstGeom\b[^>]*\bprst="([^"]+)"/i.exec(shape.xml)?.[1] || '')
          : '';
        // The shape's own surface color (spPr solidFill), distinct from text colors.
        const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/i.exec(shape.xml)?.[1] || '';
        const fill = /<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(spPr)?.[1]?.toUpperCase() || '';
        return {
          path: shapePath,
          index: shapeIndex + 1,
          type: shape.name,
          ...(shapeName ? { name: shapeName } : {}),
          ...(geometry ? { geometry } : {}),
          ...(fill ? { fill: { color: fill } } : {}),
          text: paragraphTexts(shape.xml, 'a:t').join(''),
          ...(shape.name === 'p:grpSp' ? { group: true } : {}),
          ...(/<p:ph\b/i.test(shape.xml) ? { placeholder: true } : {}),
          ...(/<c:chart\b/i.test(shape.xml) ? { chart: { path: `${shapePath}/chart` } } : {}),
          ...(tableRows ? { table: { rows: tableRows, columns: tableColumns } } : {}),
          ...(fontSizes.length ? { font: { size: Math.max(...fontSizes), ...(fonts.length ? { name: fonts[0] } : {}) } } : {}),
          ...(fonts.length ? { fonts } : {}),
          ...(colors.length ? { colors } : {}),
          ...(offset && extent ? {
            left: Number(offset[1]) / 12_700,
            top: Number(offset[2]) / 12_700,
            width: Number(extent[1]) / 12_700,
            height: Number(extent[2]) / 12_700,
          } : {}),
        };
      }),
    });
  }
  const layoutPaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(basename(a))?.[0]) - Number(/\d+/.exec(basename(b))?.[0]));
  const layouts = [];
  for (const path of layoutPaths) {
    const xml = await zipText(zip, path);
    layouts.push({
      path: `/layout[${layouts.length + 1}]`,
      index: layouts.length + 1,
      name: xmlDecode(/<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] || ''),
      packagePart: path,
    });
  }
  const presentationXml = await zipText(zip, 'ppt/presentation.xml');
  const slideSize = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(presentationXml);
  return {
    format: 'pptx',
    slideCount: slidePaths.length,
    slideWidth: slideSize ? Number(slideSize[1]) / 12_700 : 0,
    slideHeight: slideSize ? Number(slideSize[2]) / 12_700 : 0,
    slides,
    layoutCount: layouts.length,
    layouts,
    ...(paged ? {
      pagination: {
        unit: 'slide',
        offset,
        limit,
        returned: slides.length,
        total: Array.isArray(options.pages) && options.pages.length ? requested.length : slidePaths.length,
        nextOffset: !options.pages?.length && offset + slides.length < slidePaths.length
          ? offset + slides.length
          : null,
      },
    } : {}),
  };
}


export async function snapshotPortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  if (format === 'docx') return await snapshotDocx(zip, options);
  if (format === 'xlsx') return await snapshotXlsx(zip, options);
  if (format === 'pptx') return await snapshotPptx(zip, options);
  throw new Error(`Unsupported OOXML format: ${format}`);
}

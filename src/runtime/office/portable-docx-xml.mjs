import { join } from 'node:path';
import { tableXml } from './portable-slide-shapes.mjs';
import { appendDocxBlock, docxBodyModel } from './portable-snapshot.mjs';
import { containerInner, topLevelElements, xmlEncode } from './portable-xml.mjs';

function pointsToTwips(value) {
  return Math.max(1, Math.round(Number(value) * 20));
}



export function wordTableProperties(properties = {}) {
  const borders = properties.borders || {};
  const borderXml = Object.keys(borders).length
    ? `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => {
        const value = typeof borders[side] === 'object' ? borders[side] : borders;
        if (!value || value.enabled === false) return '';
        return `<w:${side} w:val="${xmlEncode(value.style || 'single')}" w:sz="${Math.max(1, Number(value.size) || 4)}" w:space="${Math.max(0, Number(value.space) || 0)}" w:color="${xmlEncode(String(value.color || 'auto').replace(/^#/, ''))}"/>`;
      }).join('')}</w:tblBorders>`
    : '';
  return [
    properties.style ? `<w:tblStyle w:val="${xmlEncode(docxStyleId(properties.style))}"/>` : '',
    `<w:tblW w:w="0" w:type="auto"/>`,
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
    borderXml,
    properties.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.shading).replace(/^#/, ''))}"/>` : '',
  ].join('');
}



export function wordCellProperties(properties = {}) {
  return [
    properties.width ? `<w:tcW w:w="${pointsToTwips(properties.width)}" w:type="dxa"/>` : '',
    properties.fillColor ? `<w:shd w:val="clear" w:color="auto" w:fill="${xmlEncode(String(properties.fillColor).replace(/^#/, ''))}"/>` : '',
    properties.verticalAlignment ? `<w:vAlign w:val="${xmlEncode(properties.verticalAlignment)}"/>` : '',
  ].join('');
}



export function wordTableXml(operation) {
  const values = Array.isArray(operation.values) ? operation.values : [];
  const rows = Math.max(1, Number(operation.rows) || values.length || 1);
  const columns = Math.max(1, Number(operation.columns) || Math.max(0, ...values.map((row) => row.length)) || 1);
  const widths = operation.properties?.columnWidths || [];
  const heights = operation.properties?.rowHeights || [];
  const grid = Array.from({ length: columns }, (_, column) => `<w:gridCol${widths[column] ? ` w:w="${pointsToTwips(widths[column])}"` : ''}/>`).join('');
  const body = Array.from({ length: rows }, (_, row) => `<w:tr>${heights[row] ? `<w:trPr><w:trHeight w:val="${pointsToTwips(heights[row])}" w:hRule="atLeast"/></w:trPr>` : ''}${Array.from({ length: columns }, (_, column) => {
    const text = String(values[row]?.[column] ?? '');
    const width = widths[column] ? `<w:tcW w:w="${pointsToTwips(widths[column])}" w:type="dxa"/>` : '';
    return `<w:tc>${width ? `<w:tcPr>${width}</w:tcPr>` : ''}<w:p><w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:tc>`;
  }).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr>${wordTableProperties(operation.properties)}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}



export function insertDocxBlockAt(documentXml, block, paragraphNumber) {
  if (!paragraphNumber) return appendDocxBlock(documentXml, block);
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const paragraph = model.blocks.filter((entry) => entry.name === 'w:p')[Number(paragraphNumber) - 1];
  if (!paragraph) throw new Error(`DOCX paragraph ${paragraphNumber} not found`);
  const inner = `${model.body.inner.slice(0, paragraph.end)}${block}${model.body.inner.slice(paragraph.end)}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
}



const WORD_STYLE_IDS = Object.freeze({
  'heading 1': 'Heading1',
  'heading 2': 'Heading2',
  'heading 3': 'Heading3',
  'heading 4': 'Heading4',
  'list paragraph': 'ListParagraph',
  'table grid': 'TableGrid',
  'normal table': 'TableNormal',
  'no spacing': 'NoSpacing',
  'intense quote': 'IntenseQuote',
});



export function docxStyleId(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return WORD_STYLE_IDS[raw.toLowerCase()] || raw.replace(/\s+/g, '');
}



export function wordRunProperties(properties = {}) {
  const size = Number(properties.size ?? properties.fontSize);
  const half = Number.isFinite(size) && size > 0 ? Math.max(2, Math.round(size * 2)) : 0;
  return [
    properties.name ? `<w:rFonts w:ascii="${xmlEncode(properties.name)}" w:hAnsi="${xmlEncode(properties.name)}" w:eastAsia="${xmlEncode(properties.name)}"/>` : '',
    properties.bold === true ? '<w:b/>' : '',
    properties.italic === true ? '<w:i/>' : '',
    properties.underline === true ? '<w:u w:val="single"/>' : '',
    properties.color ? `<w:color w:val="${xmlEncode(String(properties.color).replace(/^#/, ''))}"/>` : '',
    half ? `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>` : '',
  ].join('');
}



export function wordParagraph(text, { alignment = '', style = '' } = {}) {
  const properties = [
    style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : '',
    alignment ? `<w:jc w:val="${xmlEncode(alignment)}"/>` : '',
  ].join('');
  const value = String(text ?? '');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}`
    + `<w:r><w:t${/^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''}>${xmlEncode(value)}</w:t></w:r></w:p>`;
}



export function blankTableCells(xml) {
  return xml.replace(/(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/g, '$1$2');
}



export function rewriteTableColumns(tableXml, columnIndex, mode) {
  const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(tableXml);
  let next = tableXml;
  if (grid) {
    const columns = [...grid[0].matchAll(/<w:gridCol\b[^>]*\/>/g)].map((match) => match[0]);
    if (mode === 'delete') {
      if (columns.length <= 1) throw new Error('A table must keep at least one column');
      columns.splice(columnIndex - 1, 1);
    } else {
      columns.splice(columnIndex - 1, 0, columns[columnIndex - 1] || columns.at(-1) || '<w:gridCol/>');
    }
    next = next.replace(grid[0], `<w:tblGrid>${columns.join('')}</w:tblGrid>`);
  }
  return mapTableRows(next, (row) => {
    const cells = tableRowCells(row);
    if (!cells.length) return row;
    if (mode === 'delete') {
      if (cells.length <= 1) return row;
      cells.splice(columnIndex - 1, 1);
    } else {
      const template = cells[columnIndex - 1] || cells.at(-1);
      cells.splice(columnIndex - 1, 0, blankTableCells(template));
    }
    const open = /^<w:tr(?:\s[^>]*)?>/.exec(row)?.[0] || '<w:tr>';
    const properties = /<w:trPr(?:\s[^>]*)?>[\s\S]*?<\/w:trPr>/.exec(row)?.[0] || '';
    return `${open}${properties}${cells.join('')}</w:tr>`;
  });
}


export function tableRows(tableXml) {
  const inner = containerInner(tableXml, 'w:tbl');
  if (!inner) return [];
  return topLevelElements(inner.inner, ['w:tr']).map((row) => ({
    ...row,
    start: inner.start + row.start,
    end: inner.start + row.end,
  }));
}


export function tableRowCells(rowXml) {
  const inner = containerInner(rowXml, 'w:tr');
  if (!inner) return [];
  return topLevelElements(inner.inner, ['w:tc']).map((cell) => cell.xml);
}


export function tableRowMatches(tableXml) {
  return tableRows(tableXml).map((row) => {
    const match = [row.xml];
    match.index = row.start;
    return match;
  });
}


export function rowCellMatches(rowXml) {
  const inner = containerInner(rowXml, 'w:tr');
  if (!inner) return [];
  return topLevelElements(inner.inner, ['w:tc']).map((cell) => {
    const match = [cell.xml];
    match.index = inner.start + cell.start;
    return match;
  });
}


export function mapTableRows(tableXml, transform) {
  const rows = tableRows(tableXml);
  if (!rows.length) return tableXml;
  let output = '';
  let cursor = 0;
  for (const row of rows) {
    output += tableXml.slice(cursor, row.start) + transform(row.xml);
    cursor = row.end;
  }
  return output + tableXml.slice(cursor);
}



export function docxTables(current) {
  const body = containerInner(current, 'w:body');
  const scope = body ? body.inner : current;
  const offset = body ? body.start : 0;
  return topLevelElements(scope, ['w:tbl']).map((element) => {
    const match = [element.xml];
    match.index = offset + element.start;
    return match;
  });
}

export function docxTable(current, number) {
  const match = docxTables(current)[Number(number) - 1];
  if (!match) throw new Error(`DOCX table ${number} not found`);
  return match;
}



export function replaceDocxTable(current, table, nextTable) {
  return `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`;
}



export function replaceWordProperties(xml, owner, propertyTag, value) {
  const pattern = new RegExp(`<w:${propertyTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:${propertyTag}>`);
  if (pattern.test(xml)) return xml.replace(pattern, `<w:${propertyTag}>${value}</w:${propertyTag}>`);
  return xml.replace(new RegExp(`<w:${owner}(?:\\s[^>]*)?>`), (open) => `${open}<w:${propertyTag}>${value}</w:${propertyTag}>`);
}



export function paragraphFormatXml(properties = {}, numbering = null) {
  const border = properties.border || null;
  const tabs = Array.isArray(properties.tabStops) ? properties.tabStops : [];
  return [
    properties.keepWithNext === true ? '<w:keepNext/>' : '',
    properties.pageBreakBefore === true ? '<w:pageBreakBefore/>' : '',
    numbering
      ? `<w:numPr><w:ilvl w:val="${Math.max(0, Math.min(2, Number(numbering.level) || 0))}"/>`
        + `<w:numId w:val="${numbering.numId}"/></w:numPr>`
      : '',
    border ? `<w:pBdr><w:${xmlEncode(border.side || 'bottom')} w:val="${xmlEncode(border.style || 'single')}" w:sz="${Math.max(1, Number(border.size) || 4)}" w:space="${Math.max(0, Number(border.space) || 1)}" w:color="${xmlEncode(String(border.color || 'auto').replace(/^#/, ''))}"/></w:pBdr>` : '',
    tabs.length ? `<w:tabs>${tabs.map((tab) => `<w:tab w:val="${xmlEncode(tab.alignment || 'left')}" w:pos="${pointsToTwips(tab.position || 0)}"${tab.leader ? ` w:leader="${xmlEncode(tab.leader)}"` : ''}/>`).join('')}</w:tabs>` : '',
    (properties.spacingBefore !== undefined || properties.spacingAfter !== undefined || properties.lineSpacing !== undefined)
      ? `<w:spacing${properties.spacingBefore !== undefined ? ` w:before="${Math.max(0, Math.round(Number(properties.spacingBefore) * 20))}"` : ''}${properties.spacingAfter !== undefined ? ` w:after="${Math.max(0, Math.round(Number(properties.spacingAfter) * 20))}"` : ''}${properties.lineSpacing !== undefined ? ` w:line="${Math.max(1, Math.round(Number(properties.lineSpacing) * 20))}" w:lineRule="auto"` : ''}/>`
      : '',
    properties.alignment ? `<w:jc w:val="${xmlEncode(properties.alignment)}"/>` : '',
  ].join('');
}

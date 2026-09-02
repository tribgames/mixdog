import { join } from 'node:path';
import { PIXELS_TO_POINTS, addPackageRelationship, ensureContentTypeOverride, fillTemplateParts, partRelationshipPath, provenanceCitation, zipText } from './portable-opc.mjs';
import { appendDocxBlock, docxBodyModel } from './portable-snapshot.mjs';
import { OFFICE_RELATIONSHIP_BASE, XML_HEADER, paragraphTexts, rebuildTextNodes, replaceAcrossRuns, textNodes, upsertOrderedChild, xmlEncode } from './portable-xml.mjs';
import { SETTINGS_CONTENT_TYPE, SETTINGS_ORDER, WORD_2010_NS, WORD_MAIN_NS, addDocumentImage, anchorDocxComment, commentParagraphId, documentTracksChanges, ensureCommentsPart, ensureNumbering, markRunsDeleted, nextRevisionId, registerCommentThread, revisionAttributes, trailingSectionProperties, upsertSectionChild, upsertSectionReference, wordDrawingXml, writeHeaderFooterPart, writeSectionProperties } from './portable-docx-parts.mjs';
import { blankTableCells, docxStyleId, docxTable, insertDocxBlockAt, paragraphFormatXml, replaceDocxTable, replaceWordProperties, rewriteTableColumns, rowCellMatches, tableRowMatches, wordCellProperties, wordParagraph, wordRunProperties, wordTableProperties, wordTableXml } from './portable-docx-xml.mjs';

export async function applyDocx(zip, operations) {
  const parts = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name));
  const results = [];
  let tracking = await documentTracksChanges(zip);
  for (const op of operations) {
    if (op.op === 'track_changes') {
      const enabled = op.enabled !== false;
      const part = 'word/settings.xml';
      let settings = await zipText(zip, part);
      if (!settings) {
        settings = `${XML_HEADER}<w:settings xmlns:w="${WORD_MAIN_NS}"></w:settings>`;
        await ensureContentTypeOverride(zip, `/${part}`, SETTINGS_CONTENT_TYPE);
        await addPackageRelationship(
          zip,
          partRelationshipPath('word/document.xml'),
          `${OFFICE_RELATIONSHIP_BASE}/settings`,
          'settings.xml',
        );
      }
      zip.file(part, upsertOrderedChild(
        settings,
        SETTINGS_ORDER,
        'w:trackRevisions',
        enabled ? '<w:trackRevisions/>' : '',
      ));
      tracking = enabled;
      results.push({ op: op.op, changed: true, enabled });
      continue;
    }
    if (op.op === 'fill_template') {
      results.push(await fillTemplateParts(zip, parts, 'w:t', op));
      continue;
    }
    if (op.op === 'replace_text') {
      let count = 0;
      for (const part of parts) {
        const current = await zipText(zip, part);
        const replaced = replaceAcrossRuns(current, 'w:t', String(op.find || ''), String(op.replace ?? ''));
        if (replaced.count) zip.file(part, replaced.xml);
        count += replaced.count;
      }
      results.push({ op: op.op, changed: count > 0, count });
      continue;
    }
    if (op.op === 'append_text') {
      const current = await zipText(zip, 'word/document.xml');
      const properties = op.properties || {};
      const listKind = String(properties.listKind || '').toLowerCase();
      const numbering = listKind
        ? await ensureNumbering(zip, listKind === 'number' ? 'number' : 'bullet')
        : null;
      const style = docxStyleId(op.style || properties.style || (numbering ? 'List Paragraph' : ''));
      const format = paragraphFormatXml(
        properties,
        numbering ? { numId: numbering.numId, level: properties.listLevel } : null,
      );
      const paragraphProperties = style || format
        ? `<w:pPr>${style ? `<w:pStyle w:val="${xmlEncode(style)}"/>` : ''}${format}</w:pPr>`
        : '';
      const runProperties = wordRunProperties(properties);
      const run = `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}`
        + `<w:t${/^\s|\s$/.test(String(op.text || '')) ? ' xml:space="preserve"' : ''}>${xmlEncode(op.text || '')}</w:t></w:r>`;
      const content = tracking
        ? `<w:ins ${revisionAttributes(nextRevisionId(current), properties.author)}>${run}</w:ins>`
        : run;
      const block = `<w:p>${paragraphProperties}${content}</w:p>`;
      zip.file('word/document.xml', appendDocxBlock(current, block));
      results.push({ op: op.op, changed: true, style: style || '', ...(tracking ? { tracked: true } : {}) });
      continue;
    }
    if (op.op === 'add_table') {
      let current = await zipText(zip, 'word/document.xml');
      const table = wordTableXml(op);
      if (op.paragraph) {
        const model = docxBodyModel(current);
        const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
        if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
        const position = paragraph.end;
        const nextInner = `${model.body.inner.slice(0, position)}${table}${model.body.inner.slice(position)}`;
        current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      } else {
        current = appendDocxBlock(current, table);
      }
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, table: docxBodyModel(current).blocks.filter((block) => block.name === 'w:tbl').length });
      continue;
    }
    if (op.op === 'set_paragraph_text' || op.op === 'set_run_text' || op.op === 'remove_paragraph' || op.op === 'move_paragraph') {
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      let nextInner = model.body.inner;
      if (op.op === 'remove_paragraph' && tracking) {
        const id = nextRevisionId(current);
        const marked = markRunsDeleted(paragraph.xml, id, op.author);
        const mark = `<w:del ${revisionAttributes(id + 900, op.author)}/>`;
        const withMark = /<w:pPr(?:\s[^>]*)?>/.test(marked)
          ? (/<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>\s*<\/w:pPr>/.test(marked)
            ? marked.replace(/(<w:rPr(?:\s[^>]*)?>)/, `$1${mark}`)
            : marked.replace(/<\/w:pPr>/, `<w:rPr>${mark}</w:rPr></w:pPr>`))
          : marked.replace(/^(<w:p(?:\s[^>]*)?>)/, `$1<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`);
        nextInner = `${nextInner.slice(0, paragraph.start)}${withMark}${nextInner.slice(paragraph.end)}`;
      } else if (op.op === 'remove_paragraph') {
        nextInner = `${nextInner.slice(0, paragraph.start)}${nextInner.slice(paragraph.end)}`;
      } else if (op.op === 'move_paragraph') {
        const destination = Math.max(1, Number(op.index));
        const remaining = model.blocks.filter((block) => block !== paragraph);
        const paragraphBlocks = remaining.filter((block) => block.name === 'w:p');
        const anchor = paragraphBlocks[destination - 1];
        const without = `${nextInner.slice(0, paragraph.start)}${nextInner.slice(paragraph.end)}`;
        if (!anchor) {
          nextInner = `${without}${paragraph.xml}`;
        } else {
          const adjustedStart = anchor.start > paragraph.start ? anchor.start - paragraph.xml.length : anchor.start;
          nextInner = `${without.slice(0, adjustedStart)}${paragraph.xml}${without.slice(adjustedStart)}`;
        }
      } else {
        const nodes = textNodes(paragraph.xml, 'w:t');
        let nextParagraph;
        if (!nodes.length) {
          if (op.op === 'set_run_text') throw new Error(`DOCX paragraph ${op.paragraph} has no editable text`);
          const run = `<w:r><w:t xml:space="preserve">${xmlEncode(String(op.text ?? ''))}</w:t></w:r>`;
          if (/<\/w:p>\s*$/.test(paragraph.xml)) {
            nextParagraph = paragraph.xml.replace(/<\/w:p>\s*$/, `${run}</w:p>`);
          } else if (/\/>\s*$/.test(paragraph.xml)) {
            nextParagraph = paragraph.xml.replace(/\/>\s*$/, `>${run}</w:p>`);
          } else {
            throw new Error(`DOCX paragraph ${op.paragraph} is malformed`);
          }
        } else if (op.op === 'set_run_text') {
          const run = nodes[Number(op.run) - 1];
          if (!run) throw new Error(`DOCX run ${op.run} not found in paragraph ${op.paragraph}`);
          run.text = String(op.text ?? '');
          nextParagraph = rebuildTextNodes(paragraph.xml, 'w:t', nodes);
        } else {
          nodes[0].text = String(op.text ?? '');
          for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
          nextParagraph = rebuildTextNodes(paragraph.xml, 'w:t', nodes);
        }
        nextInner = `${nextInner.slice(0, paragraph.start)}${nextParagraph}${nextInner.slice(paragraph.end)}`;
      }
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true });
      continue;
    }
    if (op.op === 'set_paragraph_style') {
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const style = xmlEncode(op.style || 'Normal');
      let nextParagraph = paragraph.xml;
      if (/<w:pPr(?:\s[^>]*)?>/.test(nextParagraph)) {
        if (/<w:pStyle\b[^>]*\/>/.test(nextParagraph)) {
          nextParagraph = nextParagraph.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${style}"/>`);
        } else {
          nextParagraph = nextParagraph.replace(/<w:pPr(?:\s[^>]*)?>/, (open) => `${open}<w:pStyle w:val="${style}"/>`);
        }
      } else {
        nextParagraph = nextParagraph.replace(/<w:p(?:\s[^>]*)?>/, (open) => `${open}<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`);
      }
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, style: op.style || 'Normal' });
      continue;
    }
    if (op.op === 'set_table_cell') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const rows = tableRowMatches(table[0]);
      const row = rows[Number(op.row) - 1];
      if (!row) throw new Error(`DOCX table row ${op.row} not found`);
      const cells = rowCellMatches(row[0]);
      const cell = cells[Number(op.col) - 1];
      if (!cell) throw new Error(`DOCX table cell ${op.col} not found`);
      const nodes = textNodes(cell[0], 'w:t');
      let nextCell;
      if (nodes.length) {
        nodes[0].text = String(op.text ?? '');
        for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
        nextCell = rebuildTextNodes(cell[0], 'w:t', nodes);
      } else {
        nextCell = cell[0].replace('</w:tc>', `<w:p><w:r><w:t>${xmlEncode(op.text ?? '')}</w:t></w:r></w:p></w:tc>`);
      }
      const nextRow = row[0].replace(cell[0], nextCell);
      const nextTable = table[0].replace(row[0], nextRow);
      current = `${current.slice(0, table.index)}${nextTable}${current.slice(table.index + table[0].length)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true });
      continue;
    }
    if (op.op === 'set_table_style') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const nextTable = replaceWordProperties(table[0], 'tbl', 'tblPr', wordTableProperties(op.properties));
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextTable !== table[0], table: Number(op.table) });
      continue;
    }
    if (op.op === 'set_table_cell_style' || op.op === 'merge_table_cells') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const rows = tableRowMatches(table[0]);
      const row = rows[Number(op.row) - 1];
      if (!row) throw new Error(`DOCX table row ${op.row} not found`);
      const cells = rowCellMatches(row[0]);
      const cell = cells[Number(op.col) - 1];
      if (!cell) throw new Error(`DOCX table cell ${op.col} not found`);
      let nextTable = table[0];
      if (op.op === 'set_table_cell_style') {
        let nextCell = replaceWordProperties(cell[0], 'tc', 'tcPr', wordCellProperties(op.properties));
        const runFormat = [
          op.properties?.bold ? '<w:b/>' : '',
          op.properties?.italic ? '<w:i/>' : '',
          op.properties?.color ? `<w:color w:val="${xmlEncode(String(op.properties.color).replace(/^#/, ''))}"/>` : '',
        ].join('');
        if (runFormat) {
          nextCell = /<w:rPr(?:\s[^>]*)?>/.test(nextCell)
            ? nextCell.replace(/<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/, (_, inner) => {
              const fonts = /<w:rFonts\b[^>]*\/>/.exec(inner);
              return fonts
                ? `<w:rPr>${fonts[0]}${runFormat}${inner.replace(fonts[0], '')}</w:rPr>`
                : `<w:rPr>${runFormat}${inner}</w:rPr>`;
            })
            : nextCell.replace(/<w:r(?:\s[^>]*)?>/, (open) => `${open}<w:rPr>${runFormat}</w:rPr>`);
        }
        nextTable = table[0].replace(cell[0], nextCell);
      } else {
        const colSpan = Math.max(1, Number(op.colSpan) || 1);
        const rowSpan = Math.max(1, Number(op.rowSpan) || 1);
        let merged = replaceWordProperties(cell[0], 'tc', 'tcPr', `${colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : ''}${rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : ''}`);
        let nextRow = row[0].replace(cell[0], merged);
        for (let index = Number(op.col); index < Number(op.col) + colSpan - 1; index += 1) {
          const remove = cells[index];
          if (remove) nextRow = nextRow.replace(remove[0], '');
        }
        nextTable = table[0].replace(row[0], nextRow);
        if (rowSpan > 1) {
          for (let rowIndex = Number(op.row); rowIndex < Number(op.row) + rowSpan - 1; rowIndex += 1) {
            const continuationRow = rows[rowIndex];
            if (!continuationRow) break;
            const continuationCells = rowCellMatches(continuationRow[0]);
            const continuation = continuationCells[Number(op.col) - 1];
            if (!continuation) continue;
            const nextCell = replaceWordProperties(continuation[0], 'tc', 'tcPr', `${colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : ''}<w:vMerge/>`);
            nextTable = nextTable.replace(continuation[0], nextCell);
          }
        }
      }
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextTable !== table[0], table: Number(op.table), row: Number(op.row), col: Number(op.col) });
      continue;
    }
    if (op.op === 'set_paragraph_format') {
      const properties = op.properties || {};
      const listKind = String(properties.listKind || '').toLowerCase();
      const numbering = listKind
        ? await ensureNumbering(zip, listKind === 'number' ? 'number' : 'bullet')
        : null;
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const existingStyle = /<w:pStyle\b[^>]*\/>/.exec(paragraph.xml)?.[0] || '';
      const nextParagraph = replaceWordProperties(
        paragraph.xml,
        'p',
        'pPr',
        `${existingStyle}${paragraphFormatXml(
          properties,
          numbering ? { numId: numbering.numId, level: properties.listLevel } : null,
        )}`,
      );
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextParagraph !== paragraph.xml, paragraph: Number(op.paragraph) });
      continue;
    }
    if (op.op === 'add_image') {
      const current = await zipText(zip, 'word/document.xml');
      const media = await addDocumentImage(zip, op.path);
      const pixels = media.pixels;
      const width = Number(op.width) > 0
        ? Number(op.width)
        : (pixels ? pixels.width * PIXELS_TO_POINTS : 240);
      const height = Number(op.height) > 0
        ? Number(op.height)
        : (pixels ? pixels.height * PIXELS_TO_POINTS * (Number(op.width) > 0 ? Number(op.width) / (pixels.width * PIXELS_TO_POINTS) : 1) : 180);
      const id = [...current.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)]
        .reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
      const block = `<w:p><w:r>${wordDrawingXml({
        id,
        embedId: media.relationshipId,
        name: media.name,
        width,
        height,
      })}</w:r></w:p>`;
      zip.file('word/document.xml', insertDocxBlockAt(current, block, op.paragraph));
      results.push({ op: op.op, changed: true, image: media.part, width, height });
      continue;
    }
    if (op.op === 'set_page') {
      const current = await zipText(zip, 'word/document.xml');
      const properties = op.properties || {};
      const orientation = String(properties.orientation || '').toLowerCase();
      if (orientation && !['portrait', 'landscape'].includes(orientation)) {
        throw new Error('set_page orientation must be portrait or landscape');
      }
      const next = writeSectionProperties(current, (section) => {
        const size = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
        let pageWidth = Number(/\bw:w="(\d+)"/.exec(size)?.[1]) || 11_906;
        let pageHeight = Number(/\bw:h="(\d+)"/.exec(size)?.[1]) || 16_838;
        if (orientation === 'landscape' && pageWidth < pageHeight) {
          [pageWidth, pageHeight] = [pageHeight, pageWidth];
        }
        if (orientation === 'portrait' && pageWidth > pageHeight) {
          [pageWidth, pageHeight] = [pageHeight, pageWidth];
        }
        const margins = /<w:pgMar\b([^>]*)\/>/.exec(section)?.[1] || '';
        const margin = (name, key, fallback) => {
          const requested = properties[key];
          if (requested != null) return Math.max(0, Math.round(Number(requested) * 20));
          const existing = new RegExp(`\\bw:${name}="(-?\\d+)"`).exec(margins)?.[1];
          return existing == null ? fallback : Number(existing);
        };
        const withSize = upsertSectionChild(
          section,
          'pgSz',
          `<w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"${orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`,
          ['type'],
        );
        return upsertSectionChild(
          withSize,
          'pgMar',
          `<w:pgMar w:top="${margin('top', 'topMargin', 1418)}" w:right="${margin('right', 'rightMargin', 1418)}"`
          + ` w:bottom="${margin('bottom', 'bottomMargin', 1418)}" w:left="${margin('left', 'leftMargin', 1418)}"`
          + ` w:header="${margin('header', 'headerMargin', 709)}" w:footer="${margin('footer', 'footerMargin', 709)}" w:gutter="0"/>`,
          ['pgSz'],
        );
      });
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: next !== current, orientation: orientation || 'unchanged' });
      continue;
    }
    if (['insert_table_row', 'delete_table_row', 'insert_table_column', 'delete_table_column'].includes(op.op)) {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      let nextTable = table[0];
      if (op.op === 'insert_table_row' || op.op === 'delete_table_row') {
        const rows = tableRowMatches(table[0]);
        if (!rows.length) throw new Error(`DOCX table ${op.table} has no rows`);
        if (op.op === 'delete_table_row') {
          if (rows.length <= 1) throw new Error('A table must keep at least one row');
          const row = rows[Number(op.row) - 1];
          if (!row) throw new Error(`DOCX table row ${op.row} not found`);
          nextTable = `${table[0].slice(0, row.index)}${table[0].slice(row.index + row[0].length)}`;
        } else {
          const position = Math.max(1, Math.min(Number(op.row) || rows.length + 1, rows.length + 1));
          const template = rows[Math.min(position, rows.length) - 1];
          const blank = blankTableCells(template[0]);
          nextTable = position > rows.length
            ? table[0].replace(/<\/w:tbl>$/, `${blank}</w:tbl>`)
            : `${table[0].slice(0, template.index)}${blank}${table[0].slice(template.index)}`;
        }
      } else {
        const columnIndex = Math.max(1, Number(op.column) || 1);
        nextTable = rewriteTableColumns(
          table[0],
          columnIndex,
          op.op === 'delete_table_column' ? 'delete' : 'insert',
        );
      }
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: nextTable !== table[0], table: Number(op.table) });
      continue;
    }
    if (op.op === 'set_list') {
      const kind = String(op.kind || 'bullet').toLowerCase() === 'number' ? 'number' : 'bullet';
      const numbering = await ensureNumbering(zip, kind);
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
      if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
      const level = Math.max(0, Math.min(2, Number(op.level) || 0));
      const existing = /<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/.exec(paragraph.xml)?.[1] || '';
      const cleaned = existing
        .replace(/<w:numPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:numPr>)/, '')
        .replace(/<w:pStyle\b[^>]*\/>/, '');
      const properties = '<w:pStyle w:val="ListParagraph"/>'
        + `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numbering.numId}"/></w:numPr>`
        + cleaned;
      const nextParagraph = replaceWordProperties(paragraph.xml, 'p', 'pPr', properties);
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, paragraph: Number(op.paragraph), kind, numId: numbering.numId });
      continue;
    }
    if (op.op === 'add_hyperlink') {
      const address = String(op.address || '').trim();
      const display = String(op.display || address || '').trim();
      if (!address && !op.subAddress) throw new Error('add_hyperlink requires address or subAddress');
      if (!display) throw new Error('add_hyperlink requires display text');
      let current = await zipText(zip, 'word/document.xml');
      const relationshipId = address
        ? await addPackageRelationship(
          zip,
          partRelationshipPath('word/document.xml'),
          `${OFFICE_RELATIONSHIP_BASE}/hyperlink`,
          address,
          'External',
        )
        : '';
      const run = '<w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'
        + `<w:t${/^\s|\s$/.test(display) ? ' xml:space="preserve"' : ''}>${xmlEncode(display)}</w:t></w:r>`;
      const link = `<w:hyperlink${relationshipId ? ` r:id="${relationshipId}"` : ''}`
        + `${op.subAddress ? ` w:anchor="${xmlEncode(op.subAddress)}"` : ''}>${run}</w:hyperlink>`;
      if (op.paragraph) {
        const model = docxBodyModel(current);
        const paragraph = model.blocks.filter((block) => block.name === 'w:p')[Number(op.paragraph) - 1];
        if (!paragraph) throw new Error(`DOCX paragraph ${op.paragraph} not found`);
        const nextParagraph = paragraph.xml.replace(/<\/w:p>$/, `${link}</w:p>`);
        const nextInner = `${model.body.inner.slice(0, paragraph.start)}${nextParagraph}${model.body.inner.slice(paragraph.end)}`;
        current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      } else {
        current = appendDocxBlock(current, `<w:p>${link}</w:p>`);
      }
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, address, display });
      continue;
    }
    if (op.op === 'set_font') {
      const find = String(op.find || '');
      if (!find) throw new Error('set_font requires non-empty find');
      const properties = wordRunProperties(op.properties || {});
      if (!properties) throw new Error('set_font requires at least one font property');
      let count = 0;
      for (const part of parts) {
        const current = await zipText(zip, part);
        if (!current) continue;
        const next = current.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) => {
          if (!paragraphTexts(run, 'w:t').join('').includes(find)) return run;
          count += 1;
          return replaceWordProperties(run, 'r', 'rPr', properties);
        });
        if (next !== current) zip.file(part, next);
      }
      results.push({ op: op.op, changed: count > 0, runs: count });
      continue;
    }
    if (op.op === 'add_comment' || op.op === 'add_provenance') {
      const text = op.op === 'add_provenance' ? provenanceCitation(op.source) : String(op.text || '');
      if (!text) throw new Error(`${op.op} requires ${op.op === 'add_provenance' ? 'source' : 'text'}`);
      let current = await zipText(zip, 'word/document.xml');
      const model = docxBodyModel(current);
      const paragraphs = model.blocks.filter((block) => block.name === 'w:p');
      const paragraph = op.op === 'add_provenance'
        ? paragraphs[Number(op.paragraph) - 1]
        : paragraphs.find((entry) => paragraphTexts(entry.xml, 'w:t').join('').includes(String(op.find || '')));
      if (!paragraph) {
        throw new Error(op.op === 'add_provenance'
          ? `DOCX paragraph ${op.paragraph} not found`
          : `DOCX text not found for comment anchor: ${op.find}`);
      }
      const comments = await ensureCommentsPart(zip);
      const ids = [...comments.xml.matchAll(/<w:comment\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
      const id = Math.max(0, ...ids) + 1;
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const entry = `<w:comment w:id="${id}" w:author="${xmlEncode(op.author || 'Mixdog')}"`
        + ` w:date="${stamp}" w:initials="${xmlEncode(op.initials || 'MD')}">`
        + `<w:p xmlns:w14="${WORD_2010_NS}" w14:paraId="${commentParagraphId(id)}">`
        + `<w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:comment>`;
      zip.file(comments.part, comments.xml.replace('</w:comments>', `${entry}</w:comments>`));
      await registerCommentThread(zip, { commentId: id });
      const anchored = anchorDocxComment(paragraph.xml, id);
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${anchored}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({
        op: op.op,
        changed: true,
        comment: id,
        ...(op.op === 'add_provenance' ? { target: `/body/p[${Number(op.paragraph)}]`, citation: text } : {}),
      });
      continue;
    }
    if (op.op === 'add_comment_reply' || op.op === 'set_comment_resolved') {
      const parent = Number(op.comment);
      if (!Number.isInteger(parent) || parent < 1) throw new Error(`${op.op} requires a positive comment id`);
      const comments = await ensureCommentsPart(zip);
      const parentPattern = new RegExp(`<w:comment\\b[^>]*\\bw:id="${parent}"[^>]*>[\\s\\S]*?<\\/w:comment>`);
      const parentEntry = parentPattern.exec(comments.xml);
      if (!parentEntry) throw new Error(`DOCX comment ${parent} not found`);
      if (op.op === 'set_comment_resolved') {
        await registerCommentThread(zip, { commentId: parent, done: op.resolved !== false });
        results.push({ op: op.op, changed: true, comment: parent, resolved: op.resolved !== false });
        continue;
      }
      const text = String(op.text || '');
      if (!text) throw new Error('add_comment_reply requires text');
      const ids = [...comments.xml.matchAll(/<w:comment\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
      const id = Math.max(0, ...ids) + 1;
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const reply = `<w:comment w:id="${id}" w:author="${xmlEncode(op.author || 'Mixdog')}"`
        + ` w:date="${stamp}" w:initials="${xmlEncode(op.initials || 'MD')}">`
        + `<w:p xmlns:w14="${WORD_2010_NS}" w14:paraId="${commentParagraphId(id)}">`
        + `<w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${xmlEncode(text)}</w:t></w:r></w:p></w:comment>`;
      zip.file(comments.part, comments.xml.replace('</w:comments>', `${reply}</w:comments>`));
      await registerCommentThread(zip, { commentId: id, parentId: parent });
      const current = await zipText(zip, 'word/document.xml');
      const anchor = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${parent}"[^>]*\\/>`).exec(current);
      if (anchor) {
        const position = anchor.index;
        const marks = `<w:commentRangeStart w:id="${id}"/><w:commentRangeEnd w:id="${id}"/>`
          + `<w:r><w:commentReference w:id="${id}"/></w:r>`;
        zip.file('word/document.xml', `${current.slice(0, position)}${marks}${current.slice(position)}`);
      }
      results.push({ op: op.op, changed: true, comment: id, parent });
      continue;
    }
    if (op.op === 'delete_comment') {
      const id = Number(op.comment);
      if (!Number.isInteger(id) || id < 1) throw new Error('delete_comment requires a positive comment id');
      const comments = await ensureCommentsPart(zip);
      const pattern = new RegExp(`<w:comment\\b[^>]*\\bw:id="${id}"[^>]*>[\\s\\S]*?<\\/w:comment>`);
      if (!pattern.test(comments.xml)) throw new Error(`DOCX comment ${id} not found`);
      zip.file(comments.part, comments.xml.replace(pattern, ''));
      const current = await zipText(zip, 'word/document.xml');
      const next = current
        .replace(new RegExp(`<w:commentRangeStart\\b[^>]*\\bw:id="${id}"[^>]*\\/>`, 'g'), '')
        .replace(new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${id}"[^>]*\\/>`, 'g'), '')
        .replace(new RegExp(`<w:r>(?:(?!<\\/w:r>)[\\s\\S])*?<w:commentReference\\b[^>]*\\bw:id="${id}"[^>]*\\/>[\\s\\S]*?<\\/w:r>`, 'g'), '');
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: true, comment: id });
      continue;
    }
    if (op.op === 'resolve_revision' || op.op === 'resolve_revisions') {
      const resolution = String(op.resolution || 'accept').toLowerCase();
      if (!['accept', 'reject'].includes(resolution)) {
        throw new Error(`${op.op} resolution must be accept or reject`);
      }
      const target = op.op === 'resolve_revision' ? Math.max(1, Number(op.revision) || 1) : 0;
      let resolved = 0;
      let index = 0;
      let paragraphMarks = 0;
      let current = await zipText(zip, 'word/document.xml');
      const next = current.replace(/<w:(ins|del)\b[^>]*>[\s\S]*?<\/w:\1>/g, (block, tag) => {
        index += 1;
        if (target && index !== target) return block;
        resolved += 1;
        const inner = block.slice(block.indexOf('>') + 1, block.lastIndexOf(`</w:${tag}>`));
        if (tag === 'ins') return resolution === 'accept' ? inner : '';
        return resolution === 'accept'
          ? ''
          : inner.replace(/<w:delText/g, '<w:t').replace(/<\/w:delText>/g, '</w:t>');
      });
      current = next.replace(/<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?<w:del\b[^>]*\/>[\s\S]*?<\/w:rPr>/g, (block) => {
        if (target) return block;
        paragraphMarks += 1;
        return block.replace(/<w:del\b[^>]*\/>/, '');
      });
      if (!resolved && target) throw new Error(`DOCX revision ${target} not found`);
      zip.file('word/document.xml', current);
      results.push({
        op: op.op,
        changed: resolved > 0 || paragraphMarks > 0,
        resolution,
        resolved,
        ...(paragraphMarks ? {
          paragraphMarks,
          note: 'Deleted paragraph marks were cleared without merging the paragraphs; review the layout.',
        } : {}),
      });
      continue;
    }
    if (op.op === 'fit_table') {
      let current = await zipText(zip, 'word/document.xml');
      const table = docxTable(current, op.table);
      const section = trailingSectionProperties(current).match?.[0] || '';
      const size = /<w:pgSz\b([^>]*)\/>/.exec(section)?.[1] || '';
      const margins = /<w:pgMar\b([^>]*)\/>/.exec(section)?.[1] || '';
      const pageWidth = Number(/\bw:w="(\d+)"/.exec(size)?.[1]) || 11_906;
      const marginLeft = Number(/\bw:left="(-?\d+)"/.exec(margins)?.[1]) || 1418;
      const marginRight = Number(/\bw:right="(-?\d+)"/.exec(margins)?.[1]) || 1418;
      const usable = Math.max(720, pageWidth - marginLeft - marginRight);
      const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(table[0]);
      const columns = grid ? [...grid[0].matchAll(/<w:gridCol\b([^>]*)\/>/g)] : [];
      const count = Math.max(1, columns.length);
      const current_widths = columns.map((column) => Number(/\bw:w="(\d+)"/.exec(column[1])?.[1]) || 0);
      const total = current_widths.reduce((sum, width) => sum + width, 0);
      const widths = total > 0
        ? current_widths.map((width) => Math.max(240, Math.round((width / total) * usable)))
        : Array.from({ length: count }, () => Math.round(usable / count));
      let nextTable = grid
        ? table[0].replace(grid[0], `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`)
        : table[0];
      const declared = `<w:tblW w:w="${usable}" w:type="dxa"/>`;
      let tableProperties = op.properties
        ? wordTableProperties(op.properties)
        : /<w:tblPr>([\s\S]*?)<\/w:tblPr>/.exec(nextTable)?.[1] || '';
      if (/<w:tblW\b[^>]*\/>/.test(tableProperties)) {
        tableProperties = tableProperties.replace(/<w:tblW\b[^>]*\/>/, declared);
      } else if (/<w:tblStyle\b[^>]*\/>/.test(tableProperties)) {
        tableProperties = tableProperties.replace(/(<w:tblStyle\b[^>]*\/>)/, `$1${declared}`);
      } else {
        tableProperties = `${declared}${tableProperties}`;
      }
      nextTable = replaceWordProperties(
        nextTable,
        'tbl',
        'tblPr',
        tableProperties,
      );
      nextTable = nextTable.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) => {
        let index = 0;
        return row.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (cell) => {
          const existing = /<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(cell)?.[1] || '';
          const keep = (pattern) => pattern.exec(existing)?.[0] || '';
          const span = Math.max(1, Number(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/.exec(existing)?.[1]) || 1);
          const width = widths.slice(index, index + span).reduce((sum, column) => sum + (column || 0), 0)
            || widths.at(-1);
          index += span;
          return replaceWordProperties(
            cell,
            'tc',
            'tcPr',
            `<w:tcW w:w="${width}" w:type="dxa"/>`
            + keep(/<w:gridSpan\b[^>]*\/>/)
            + keep(/<w:hMerge\b[^>]*\/>/)
            + keep(/<w:vMerge\b[^>]*\/>/)
            + keep(/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/)
            + keep(/<w:shd\b[^>]*\/>/)
            + keep(/<w:vAlign\b[^>]*\/>/),
          );
        });
      });
      current = replaceDocxTable(current, table, nextTable);
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, table: Number(op.table), width: usable, columns: count });
      continue;
    }
    if (op.op === 'insert_toc') {
      const current = await zipText(zip, 'word/document.xml');
      const lower = Math.max(1, Number(op.lowerHeadingLevel) || 1);
      const upper = Math.max(lower, Number(op.upperHeadingLevel) || 3);
      const instruction = ` TOC \\o "${lower}-${upper}" \\h \\z \\u `;
      const block = `<w:p><w:fldSimple w:instr="${xmlEncode(instruction)}">`
        + '<w:r><w:t>Update this field in Word to build the table of contents.</w:t></w:r></w:fldSimple></w:p>';
      zip.file('word/document.xml', insertDocxBlockAt(current, block, op.paragraph));
      results.push({ op: op.op, changed: true, levels: `${lower}-${upper}` });
      continue;
    }
    if (op.op === 'add_bookmark') {
      const name = String(op.name || '').trim();
      if (!name) throw new Error('add_bookmark requires name');
      let current = await zipText(zip, 'word/document.xml');
      const ids = [...current.matchAll(/<w:bookmarkStart\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
      const id = Math.max(0, ...ids) + 1;
      const model = docxBodyModel(current);
      const paragraphs = model.blocks.filter((block) => block.name === 'w:p');
      const paragraph = op.paragraph
        ? paragraphs[Number(op.paragraph) - 1]
        : paragraphs.find((entry) => paragraphTexts(entry.xml, 'w:t').join('').includes(String(op.find || '')));
      if (!paragraph) throw new Error('add_bookmark could not resolve a target paragraph');
      const opening = /^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(paragraph.xml)?.[0] || '<w:p>';
      const marked = `${opening}<w:bookmarkStart w:id="${id}" w:name="${xmlEncode(name)}"/>`
        + `${paragraph.xml.slice(opening.length)}`.replace(/<\/w:p>$/, `<w:bookmarkEnd w:id="${id}"/></w:p>`);
      const nextInner = `${model.body.inner.slice(0, paragraph.start)}${marked}${model.body.inner.slice(paragraph.end)}`;
      current = `${current.slice(0, model.body.start)}${nextInner}${current.slice(model.body.end)}`;
      zip.file('word/document.xml', current);
      results.push({ op: op.op, changed: true, name, bookmark: id });
      continue;
    }
    if (op.op === 'set_header_footer') {
      const current = await zipText(zip, 'word/document.xml');
      const header = op.header !== false;
      const kind = ['default', 'first', 'even'].includes(String(op.kind || '').toLowerCase())
        ? String(op.kind).toLowerCase()
        : 'default';
      const written = await writeHeaderFooterPart(zip, {
        header,
        body: wordParagraph(op.text, { alignment: header ? '' : 'center' }),
      });
      const next = writeSectionProperties(current, (section) => {
        const referenced = upsertSectionReference(
          section,
          header ? 'headerReference' : 'footerReference',
          kind,
          written.relationshipId,
        );
        return kind === 'first' && !/<w:titlePg\b/.test(referenced)
          ? upsertSectionChild(referenced, 'titlePg', '<w:titlePg/>', ['pgMar', 'pgSz'])
          : referenced;
      });
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: true, part: written.part, header, kind });
      continue;
    }
    if (op.op === 'add_page_numbers') {
      const current = await zipText(zip, 'word/document.xml');
      const header = false;
      const kind = ['default', 'first', 'even'].includes(String(op.kind || '').toLowerCase())
        ? String(op.kind).toLowerCase()
        : 'default';
      const alignment = ['left', 'center', 'right'].includes(String(op.alignment || '').toLowerCase())
        ? String(op.alignment).toLowerCase()
        : 'center';
      const prefix = op.prefix ? `<w:r><w:t xml:space="preserve">${xmlEncode(op.prefix)} </w:t></w:r>` : '';
      const separator = op.includeTotal === true
        ? `<w:r><w:t xml:space="preserve"> ${xmlEncode(op.separator || '/')} </w:t></w:r>`
        + '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        : '';
      const body = `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr>${prefix}`
        + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        + `${separator}</w:p>`;
      const written = await writeHeaderFooterPart(zip, { header, body });
      const next = writeSectionProperties(current, (section) => upsertSectionReference(
        section,
        header ? 'headerReference' : 'footerReference',
        kind,
        written.relationshipId,
      ));
      zip.file('word/document.xml', next);
      results.push({ op: op.op, changed: true, part: written.part, includeTotal: op.includeTotal === true });
      continue;
    }
    if (op.op === 'insert_break') {
      const current = await zipText(zip, 'word/document.xml');
      const kind = String(op.kind || 'page').toLowerCase();
      if (!['page', 'column'].includes(kind)) {
        throw new Error('Portable insert_break supports page or column breaks');
      }
      const block = `<w:p><w:r><w:br w:type="${kind}"/></w:r></w:p>`;
      zip.file('word/document.xml', insertDocxBlockAt(current, block, op.paragraph));
      results.push({ op: op.op, changed: true, kind });
      continue;
    }
    throw new Error(`Portable DOCX backend does not support operation: ${op.op}`);
  }
  return results;
}

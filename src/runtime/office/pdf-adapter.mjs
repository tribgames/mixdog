import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';
import { inspectPdfBuffer } from '../attachments/pdf-extract.mjs';
import { ocrPdf } from './pdf-analysis.mjs';

function color(value = '') {
  const hex = String(value || '000000').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid PDF color: ${value}`);
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  );
}

function selectedPages(document, operation) {
  const count = document.getPageCount();
  const pages = Array.isArray(operation.pages) && operation.pages.length
    ? operation.pages
    : operation.page
      ? [operation.page]
      : Array.from({ length: count }, (_, index) => index + 1);
  return pages.map((page) => {
    const index = Number(page) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`PDF page out of range: ${page}`);
    return { page: document.getPage(index), index };
  });
}

function pageSize(properties = {}) {
  const named = String(properties.pageSize || 'a4').toLowerCase();
  if (named === 'letter') return [612, 792];
  if (named === 'legal') return [612, 1008];
  if (Array.isArray(properties.pageSize) && properties.pageSize.length === 2) {
    return properties.pageSize.map(Number);
  }
  return [595.28, 841.89];
}

function fieldWidgets(field, document) {
  try {
    return field.acroField.getWidgets().map((widget) => {
      const rectangle = widget.getRectangle();
      const pageRef = widget.P();
      const page = document.getPages().findIndex((entry) => entry.ref === pageRef) + 1;
      return {
        page,
        x: Number(rectangle.x),
        y: Number(rectangle.y),
        width: Number(rectangle.width),
        height: Number(rectangle.height),
      };
    });
  } catch {
    return [];
  }
}

function pdfAttachments(document) {
  try {
    const names = document.catalog.lookup(PDFName.of('Names'), PDFDict);
    const embedded = names?.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const entries = embedded?.lookup(PDFName.of('Names'), PDFArray);
    if (!entries) return [];
    const output = [];
    for (let index = 0; index + 1 < entries.size(); index += 2) {
      const nameObject = entries.lookup(index, PDFString, PDFHexString);
      const spec = entries.lookup(index + 1, PDFDict);
      const description = spec?.lookupMaybe?.(PDFName.of('Desc'), PDFString, PDFHexString);
      output.push({
        path: `/attachments[${output.length + 1}]`,
        index: output.length + 1,
        name: nameObject?.decodeText?.() || '',
        description: description?.decodeText?.() || '',
      });
    }
    return output;
  } catch {
    return [];
  }
}

function fieldValue(field) {
  const type = field.constructor?.name || '';
  try {
    if (type.includes('CheckBox')) return field.isChecked();
    if (type.includes('RadioGroup') || type.includes('Dropdown') || type.includes('OptionList')) return field.getSelected();
    if (type.includes('TextField')) return field.getText() || '';
  } catch {}
  return null;
}

function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function lintPdfFormFields(fields = [], pages = []) {
  const issues = [];
  const normalized = fields.map((field, index) => ({
    index: index + 1,
    name: String(field.name || ''),
    type: String(field.type || 'text').toLowerCase(),
    page: Math.max(1, Number(field.page) || 1),
    x: Number(field.x),
    y: Number(field.y),
    width: Number(field.width),
    height: Number(field.height),
  }));
  const names = new Set();
  for (const field of normalized) {
    const size = pages[field.page - 1] || [595.28, 841.89];
    if (!field.name) issues.push({ severity: 'error', code: 'missing_field_name', path: `/field[${field.index}]`, message: 'Form field name is required.' });
    if (names.has(field.name)) issues.push({ severity: 'error', code: 'duplicate_field_name', path: `/field[${field.index}]`, message: `Duplicate form field name: ${field.name}` });
    names.add(field.name);
    if (![field.x, field.y, field.width, field.height].every(Number.isFinite) || field.width <= 0 || field.height <= 0) {
      issues.push({ severity: 'error', code: 'invalid_field_box', path: `/field[${field.index}]`, message: 'Form field box must have finite positive dimensions.' });
    } else if (field.x < 0 || field.y < 0 || field.x + field.width > size[0] || field.y + field.height > size[1]) {
      issues.push({ severity: 'error', code: 'field_outside_page', path: `/field[${field.index}]`, message: `Form field is outside page ${field.page}.` });
    }
  }
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (normalized[left].page === normalized[right].page && rectanglesOverlap(normalized[left], normalized[right])) {
        issues.push({
          severity: 'warning',
          code: 'overlapping_form_fields',
          path: `/field[${normalized[left].index}]`,
          message: `Form fields ${normalized[left].name || normalized[left].index} and ${normalized[right].name || normalized[right].index} overlap.`,
        });
      }
    }
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), fields: normalized, issueCount: issues.length, issues };
}

async function embedPdfFont(document, properties = {}) {
  if (!properties.fontPath) return await document.embedFont(StandardFonts.Helvetica);
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  document.registerFontkit(fontkit);
  return await document.embedFont(await readFile(resolve(String(properties.fontPath))), { subset: true });
}

function wrapText(text, font, size, width) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

async function addFormField(document, field) {
  const page = document.getPage(Math.max(1, Number(field.page) || 1) - 1);
  const form = document.getForm();
  const name = String(field.name);
  const options = {
    x: Number(field.x),
    y: Number(field.y),
    width: Number(field.width),
    height: Number(field.height),
    borderWidth: Number(field.borderWidth ?? 1),
    textColor: color(field.textColor || '000000'),
    borderColor: color(field.borderColor || '666666'),
    backgroundColor: color(field.backgroundColor || 'FFFFFF'),
  };
  const type = String(field.type || 'text').toLowerCase();
  if (type === 'checkbox') {
    const control = form.createCheckBox(name);
    control.addToPage(page, options);
    if (field.value) control.check();
  } else if (type === 'dropdown') {
    const control = form.createDropdown(name);
    control.addOptions((field.options || []).map(String));
    control.addToPage(page, options);
    if (field.value != null) control.select(String(field.value));
  } else if (type === 'radio') {
    const control = form.createRadioGroup(name);
    for (const option of field.options || []) {
      control.addOptionToPage(String(option.value ?? option), page, {
        ...options,
        x: Number(option.x ?? field.x),
        y: Number(option.y ?? field.y),
      });
    }
    if (field.value != null) control.select(String(field.value));
  } else {
    const control = form.createTextField(name);
    control.addToPage(page, options);
    if (field.multiline) control.enableMultiline();
    if (field.value != null) control.setText(String(field.value));
  }
}

export async function createPdf(path, {
  blocks = [],
  fields = [],
  properties = {},
} = {}) {
  const document = await PDFDocument.create();
  const size = pageSize(properties);
  const margin = Number(properties.margin ?? 54);
  const font = await embedPdfFont(document, properties);
  const preparePage = (entry) => {
    if (properties.background) {
      entry.drawRectangle({
        x: 0,
        y: 0,
        width: entry.getWidth(),
        height: entry.getHeight(),
        color: color(properties.background),
      });
    }
    return entry;
  };
  let page = preparePage(document.addPage(size));
  let y = page.getHeight() - margin;
  const newPage = () => {
    page = preparePage(document.addPage(size));
    y = page.getHeight() - margin;
  };
  for (const block of blocks || []) {
    const type = String(block.type || 'paragraph').toLowerCase();
    if (type === 'pagebreak') {
      newPage();
      continue;
    }
    if (type === 'image') {
      const imagePath = resolve(dirname(path), String(block.path || ''));
      const data = await readFile(imagePath);
      const image = /\.png$/i.test(imagePath) ? await document.embedPng(data) : await document.embedJpg(data);
      const width = Number(block.width || Math.min(image.width, page.getWidth() - (margin * 2)));
      const height = Number(block.height || (image.height * width / image.width));
      if (y - height < margin) newPage();
      page.drawImage(image, { x: Number(block.x ?? margin), y: Number(block.y ?? y - height), width, height });
      y -= height + Number(block.after ?? 12);
      continue;
    }
    if (type === 'table') {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const columns = Math.max(1, ...rows.map((row) => row.length));
      const width = Number(block.width || page.getWidth() - (margin * 2));
      const cellWidth = width / columns;
      const rowHeight = Number(block.rowHeight || 24);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (y - rowHeight < margin) newPage();
        row.forEach((value, column) => {
          const x = margin + (column * cellWidth);
          const fill = rowIndex === 0
            ? block.headerFill
            : rowIndex % 2 === 0
              ? block.zebraFill
              : '';
          page.drawRectangle({
            x,
            y: y - rowHeight,
            width: cellWidth,
            height: rowHeight,
            ...(fill ? { color: color(fill) } : {}),
            borderWidth: 0.5,
            borderColor: color(block.borderColor || '999999'),
          });
          page.drawText(String(value ?? ''), {
            x: x + 4,
            y: y - rowHeight + 7,
            size: Number(block.fontSize || 9),
            font,
            color: color(rowIndex === 0 ? block.headerColor || block.color : block.color),
          });
        });
        y -= rowHeight;
      }
      y -= Number(block.after ?? 12);
      continue;
    }
    const heading = type === 'heading';
    const fontSize = Number(block.size || (heading ? 20 : 11));
    const lineHeight = Number(block.lineHeight || fontSize * 1.35);
    const lines = wrapText(block.text, font, fontSize, page.getWidth() - (margin * 2));
    for (const line of lines) {
      if (y - lineHeight < margin) newPage();
      page.drawText(line, { x: Number(block.x ?? margin), y: y - fontSize, size: fontSize, font, color: color(block.color) });
      y -= lineHeight;
    }
    y -= Number(block.after ?? (heading ? 10 : 6));
  }
  if (properties.title != null) document.setTitle(String(properties.title));
  if (properties.author != null) document.setAuthor(String(properties.author));
  if (properties.subject != null) document.setSubject(String(properties.subject));
  if (properties.keywords != null) document.setKeywords(Array.isArray(properties.keywords) ? properties.keywords.map(String) : [String(properties.keywords)]);
  const formCheck = lintPdfFormFields(fields, document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()]));
  if (!formCheck.ok) throw new Error(`PDF form layout is invalid: ${formCheck.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join(' ')}`);
  for (const field of fields || []) await addFormField(document, field);
  await writeFile(path, await document.save({ useObjectStreams: true, addDefaultPage: false }));
  return { ok: true, path, pages: document.getPageCount(), form: formCheck };
}

export async function snapshotPdf(path, options = {}) {
  const maxChars = Math.max(1_000, Number(options.maxChars) || 30_000);
  const buffer = await readFile(path);
  const structure = await PDFDocument.load(buffer, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = structure.getPageCount();
  const offset = options.paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = options.paged ? Math.max(1, Number(options.limit) || 20) : pageCount;
  const selected = Array.isArray(options.pages) && options.pages.length
    ? options.pages.map(Number)
    : Array.from({ length: Math.max(0, Math.min(limit, pageCount - offset)) }, (_, index) => offset + index + 1);
  const from = selected.length ? Math.min(...selected) : 1;
  const to = selected.length ? Math.max(...selected) : 1;
  const result = await inspectPdfBuffer(buffer, {
    extractText: true,
    maxPages: Math.max(500, pageCount),
    maxOutputBytes: maxChars,
    pageRange: { from, to },
  });
  const pages = [];
  const regex = /--- Page (\d+) ---\n([\s\S]*?)(?=\n\n--- Page \d+ ---|$)/g;
  let match;
  while ((match = regex.exec(result.text || ''))) {
    const index = Number(match[1]);
    if (selected.includes(index)) pages.push({ path: `/page[${index}]`, index, text: match[2] });
  }
  const fields = structure.getForm().getFields().map((field, index) => ({
    path: `/field[${index + 1}]`,
    index: index + 1,
    name: field.getName(),
    type: field.constructor?.name || '',
    value: fieldValue(field),
    widgets: fieldWidgets(field, structure),
  }));
  const attachments = pdfAttachments(structure);
  const likelyScannedPages = pages.filter((page) => page.text.includes('(no extractable text on this page)')).map((page) => page.index);
  return {
    format: 'pdf',
    ...result,
    pageCount,
    pages,
    fields,
    fieldCount: fields.length,
    attachmentCount: attachments.length,
    attachments,
    metadata: {
      title: structure.getTitle() || '',
      author: structure.getAuthor() || '',
      subject: structure.getSubject() || '',
      keywords: structure.getKeywords() || '',
    },
    likelyScannedPages,
    ocrRequired: likelyScannedPages.length > 0,
    encrypted: false,
    ...(options.paged ? {
      pagination: {
        unit: 'page',
        offset,
        limit,
        returned: pages.length,
        total: pageCount,
        nextOffset: !options.pages?.length && offset + pages.length < pageCount ? offset + pages.length : null,
      },
    } : {}),
  };
}

export async function applyPdfBatch(path, operations, context = {}) {
  let document = await PDFDocument.load(await readFile(path), {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const results = [];
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_text':
      case 'watermark': {
        const font = await embedPdfFont(document, operation);
        for (const { page } of selectedPages(document, operation)) {
          const size = Number(operation.size ?? (operation.op === 'watermark' ? 48 : 12));
          const opacity = Number(operation.opacity ?? (operation.op === 'watermark' ? 0.25 : 1));
          const x = Number(operation.x ?? 36);
          const y = Number(operation.y ?? (operation.op === 'watermark' ? page.getHeight() / 2 : 36));
          page.drawText(String(operation.text || ''), {
            x,
            y,
            size,
            font,
            color: color(operation.color),
            opacity,
            rotate: degrees(Number(operation.rotation ?? (operation.op === 'watermark' ? 45 : 0))),
          });
        }
        results.push({ op: operation.op, changed: true, fontEmbedded: Boolean(operation.fontPath) });
        break;
      }
      case 'stamp_image': {
        const imagePath = resolve(dirname(path), String(operation.path || ''));
        const data = await readFile(imagePath);
        const image = /\.png$/i.test(imagePath) ? await document.embedPng(data) : await document.embedJpg(data);
        for (const { page } of selectedPages(document, operation)) {
          const width = Number(operation.width || image.width);
          const height = Number(operation.height || (image.height * width / image.width));
          page.drawImage(image, {
            x: Number(operation.x || 0),
            y: Number(operation.y || 0),
            width,
            height,
            opacity: Number(operation.opacity ?? 1),
          });
        }
        results.push({ op: operation.op, changed: true, image: imagePath });
        break;
      }
      case 'ocr_pages': {
        await writeFile(path, await document.save({ useObjectStreams: true, addDefaultPage: false }));
        const result = await ocrPdf(path, operation, context);
        document = await PDFDocument.load(await readFile(path), {
          ignoreEncryption: false,
          updateMetadata: false,
        });
        results.push(result);
        break;
      }
      case 'rotate_pages': {
        for (const { page } of selectedPages(document, operation)) page.setRotation(degrees(Number(operation.rotation ?? 90)));
        results.push({ op: operation.op, changed: true });
        break;
      }
      case 'delete_pages': {
        const indexes = selectedPages(document, operation).map(({ index }) => index).sort((a, b) => b - a);
        for (const index of indexes) document.removePage(index);
        results.push({ op: operation.op, changed: indexes.length > 0, count: indexes.length });
        break;
      }
      case 'extract_pages': {
        const next = await PDFDocument.create();
        const indexes = selectedPages(document, operation).map(({ index }) => index);
        const copied = await next.copyPages(document, indexes);
        copied.forEach((page) => next.addPage(page));
        document = next;
        results.push({ op: operation.op, changed: true, count: indexes.length });
        break;
      }
      case 'fill_form': {
        const form = document.getForm();
        for (const [name, value] of Object.entries(operation.values || {})) {
          const field = form.getField(name);
          const type = field.constructor?.name || '';
          if (type.includes('CheckBox')) {
            value ? field.check() : field.uncheck();
          } else if (type.includes('Dropdown') || type.includes('OptionList') || type.includes('RadioGroup')) {
            field.select(String(value));
          } else {
            field.setText(String(value ?? ''));
          }
        }
        if (operation.flatten) form.flatten();
        results.push({ op: operation.op, changed: true });
        break;
      }
      case 'add_form_field': {
        const check = lintPdfFormFields([operation], document.getPages().map((entry) => [entry.getWidth(), entry.getHeight()]));
        if (!check.ok) throw new Error(check.issues.map((issue) => issue.message).join(' '));
        await addFormField(document, operation);
        results.push({ op: operation.op, changed: true, name: operation.name });
        break;
      }
      case 'flatten_form': {
        document.getForm().flatten();
        results.push({ op: operation.op, changed: true });
        break;
      }
      case 'add_attachment': {
        const attachmentPath = resolve(dirname(path), String(operation.path || ''));
        await document.attach(await readFile(attachmentPath), String(operation.name || basename(attachmentPath)), {
          mimeType: String(operation.mimeType || 'application/octet-stream'),
          description: String(operation.description || ''),
        });
        results.push({ op: operation.op, changed: true, name: String(operation.name || basename(attachmentPath)) });
        break;
      }
      case 'compress': {
        results.push({ op: operation.op, changed: true, method: 'object-streams' });
        break;
      }
      case 'merge_pdf': {
        const otherPath = resolve(dirname(path), String(operation.path || ''));
        const other = await PDFDocument.load(await readFile(otherPath));
        const copied = await document.copyPages(other, other.getPageIndices());
        copied.forEach((page) => document.addPage(page));
        results.push({ op: operation.op, changed: true, pagesAdded: copied.length });
        break;
      }
      case 'set_metadata': {
        const props = operation.properties || {};
        if (props.title !== undefined) document.setTitle(String(props.title));
        if (props.author !== undefined) document.setAuthor(String(props.author));
        if (props.subject !== undefined) document.setSubject(String(props.subject));
        if (props.keywords !== undefined) document.setKeywords(Array.isArray(props.keywords) ? props.keywords.map(String) : [String(props.keywords)]);
        results.push({ op: operation.op, changed: true });
        break;
      }
      case 'move_page': {
        const from = Number(operation.page) - 1;
        const to = Number(operation.index) - 1;
        const count = document.getPageCount();
        if (!Number.isInteger(from) || from < 0 || from >= count) throw new Error(`PDF page out of range: ${operation.page}`);
        if (!Number.isInteger(to) || to < 0 || to >= count) throw new Error(`PDF destination page out of range: ${operation.index}`);
        const order = document.getPageIndices();
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        const next = await PDFDocument.create();
        const copied = await next.copyPages(document, order);
        copied.forEach((page) => next.addPage(page));
        document = next;
        results.push({ op: operation.op, changed: from !== to, from: from + 1, to: to + 1 });
        break;
      }
      default:
        throw new Error(`PDF backend does not support operation: ${operation.op}`);
    }
  }
  await writeFile(path, await document.save({ useObjectStreams: true, addDefaultPage: false }));
  return results;
}

export async function validatePdf(path) {
  const document = await PDFDocument.load(await readFile(path), {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  return {
    ok: true,
    format: 'pdf',
    pages: document.getPageCount(),
    validation: 'pdf-parse',
  };
}

export async function issuesPdf(path, options = {}) {
  const snapshot = await snapshotPdf(path, { ...options, maxChars: options.maxChars || 30_000 });
  const issues = [];
  for (const page of snapshot.pages) {
    if (!page.text || page.text.includes('(no extractable text on this page)')) {
      issues.push({
        severity: 'warning',
        code: 'no_text_layer',
        path: page.path,
        message: 'Page has no extractable text layer; OCR may be required.',
      });
    }
  }
  for (const page of snapshot.likelyScannedPages) {
    issues.push({
      severity: 'warning',
      code: 'ocr_required',
      path: `/page[${page}]`,
      message: 'Page has no text layer. Render at high resolution and use OCR instead of treating it as empty.',
    });
  }
  const widgets = snapshot.fields.flatMap((field) => field.widgets.map((widget) => ({ ...widget, name: field.name, path: field.path })));
  for (let left = 0; left < widgets.length; left += 1) {
    for (let right = left + 1; right < widgets.length; right += 1) {
      if (widgets[left].page === widgets[right].page && rectanglesOverlap(widgets[left], widgets[right])) {
        issues.push({ severity: 'warning', code: 'overlapping_form_fields', path: widgets[left].path, message: `Form fields ${widgets[left].name} and ${widgets[right].name} overlap.` });
      }
    }
  }
  return { ok: true, format: 'pdf', issueCount: issues.length, issues };
}

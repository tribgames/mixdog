// Everything that lives on a worksheet's drawing part: the picture bytes and
// their anchor, the anchor arithmetic a cell placement needs, and the move /
// resize / delete of a picture or chart frame already on the sheet (including
// the parts a deleted frame owned alone).
import { extname, posix } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fitDrawingSheetOnePageWide, worksheetGeometry } from './portable-sheet-page.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { columnNumber, parseCellRef } from './portable-cells.mjs';
import {
  IMAGE_CONTENT_TYPES,
  PIXELS_TO_POINTS,
  addPackageRelationship,
  ensureDefaultContentType,
  imagePixelSize,
  partRelationshipPath,
  relationshipTargetByType,
  removeContentTypeOverride,
  removePackageRelationship,
  zipText,
} from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, tagPattern, xmlAttribute, xmlDecode, xmlEncode } from './portable-xml.mjs';
import { ensureWorksheetDrawing } from './portable-sheet-parts.mjs';

// A snapshot reports where a picture or chart sits as cells (A1 to C5), so a
// caller placing one names a cell too. The sheet's own column widths and row
// heights turn that cell into the point offset the drawing anchor stores.
export function cellAnchorPoints(xml, cell) {
  const { columnPoints, rowPoints } = worksheetGeometry(xml);
  const { col, row } = parseCellRef(cell);
  const column = columnNumber(col);
  let left = 0;
  for (let index = 1; index < column; index += 1) left += columnPoints(index);
  let top = 0;
  for (let index = 1; index < row; index += 1) top += rowPoints(index);
  return { left, top };
}

// A reader who cannot see the picture hears this description; Excel reads it
// from the drawing's descr.
function pictureDescription(altText) {
  const text = String(altText ?? '').trim();
  return text ? ` descr="${xmlEncode(text)}"` : '';
}

// Stores the image bytes as the next xl/media part of its type.
async function storeImageMedia(zip, op) {
  const extension = extname(String(op.path || ''))
    .replace(/^\./, '')
    .toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(
      `Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`
    );
  }
  const data = await readFile(op.path);
  let mediaOrdinal = 1;
  while (zip.file(`xl/media/image${mediaOrdinal}.${extension}`)) mediaOrdinal += 1;
  const mediaPart = `xl/media/image${mediaOrdinal}.${extension}`;
  zip.file(mediaPart, data);
  await ensureDefaultContentType(zip, extension, contentType);
  return { mediaPart, data };
}

// The requested size, or the picture's own size in points.
function imagePlacementSize(op, data) {
  const pixels = imagePixelSize(data);
  const naturalWidth = pixels ? pixels.width * PIXELS_TO_POINTS : 240;
  const naturalHeight = pixels ? pixels.height * PIXELS_TO_POINTS : 180;
  return {
    width: Number(op.width) > 0 ? Number(op.width) : naturalWidth,
    height: Number(op.height) > 0 ? Number(op.height) : naturalHeight,
  };
}

function imageAnchorXml({ embedId, anchorCount, left, top, width, height, altText }) {
  return (
    '<xdr:absoluteAnchor>' +
    `<xdr:pos x="${toEmu(left)}" y="${toEmu(top)}"/>` +
    `<xdr:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${anchorCount + 2}" name="Picture ${anchorCount + 1}"${pictureDescription(altText)}/>` +
    '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    `<xdr:blipFill><a:blip r:embed="${embedId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
    '<xdr:clientData/></xdr:absoluteAnchor>'
  );
}

// The anchors already on a sheet's drawing: a picture or a chart frame is
// numbered after them.
export function countDrawingAnchors(drawingXml) {
  return (drawingXml.match(/<xdr:(?:absolute|two|one)CellAnchor\b/g) || []).length;
}

/** Places a picture on the sheet's drawing, sized from the file when no size is given. */
export async function addWorksheetImage(zip, sheet, xml, op) {
  const { mediaPart, data } = await storeImageMedia(zip, op);
  const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
  const imageFit = fitDrawingSheetOnePageWide(drawing.worksheet);
  xml = imageFit.xml;
  const embedId = await addPackageRelationship(
    zip,
    partRelationshipPath(drawing.part),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    posix.relative(posix.dirname(drawing.part), mediaPart)
  );
  const drawingXml = await zipText(zip, drawing.part);
  const anchorCount = countDrawingAnchors(drawingXml);
  const placement = op.cell ? cellAnchorPoints(xml, op.cell) : { left: 0, top: 0 };
  const anchor = imageAnchorXml({
    embedId,
    anchorCount,
    left: op.left ?? placement.left,
    top: op.top ?? placement.top,
    ...imagePlacementSize(op, data),
    altText: op.altText,
  });
  zip.file(drawing.part, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`));
  zip.file(sheet.path, xml);
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    image: mediaPart,
    ...(op.cell ? { cell: String(op.cell).toUpperCase() } : {}),
    ...(String(op.altText ?? '').trim() ? { altText: String(op.altText).trim() } : {}),
  };
}

// A chart or picture could be placed and never moved again. The audit reports
// the ones that overlap each other or sit outside the print area and asks for
// them to be moved, and the only answer was to build the workbook again.
const DRAWING_ANCHOR = /<xdr:(absoluteAnchor|oneCellAnchor|twoCellAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g;
const EMU_PER_POINT_XLSX = 12700;

async function worksheetDrawingPart(zip, sheet) {
  const target = relationshipTargetByType(await zipText(zip, partRelationshipPath(sheet.path)), 'drawing');
  if (!target) throw new Error(`Worksheet holds no chart or picture: ${sheet.name}`);
  return posix.normalize(posix.join(posix.dirname(sheet.path), target));
}

function drawingAnchors(xml) {
  return [...String(xml || '').matchAll(DRAWING_ANCHOR)].map((match, index) => ({
    index: index + 1,
    kind: match[1],
    body: match[0],
    start: match.index,
    end: match.index + match[0].length,
    name: xmlDecode(/<xdr:cNvPr\b[^>]*\bname="([^"]*)"/.exec(match[0])?.[1] || ''),
    chartId: /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(match[0])?.[1] || '',
    embedId: /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(match[0])?.[1] || '',
  }));
}

function selectDrawing(anchors, op) {
  const wanted = op.drawing ?? op.name;
  if (wanted === undefined || wanted === null || String(wanted).trim() === '') {
    throw new Error(`XLSX ${op.op} requires drawing: the name the snapshot reports, or its 1-based index on the sheet`);
  }
  const ordinal = Number(wanted);
  const found = Number.isInteger(ordinal)
    ? anchors.find((anchor) => anchor.index === ordinal)
    : anchors.find((anchor) => anchor.name.toLowerCase() === String(wanted).trim().toLowerCase());
  if (found) return found;
  const known = anchors.map((anchor) => `${anchor.index}: ${anchor.name || anchor.kind}`).join(', ');
  throw new Error(`Drawing not found: ${wanted}. This sheet holds ${anchors.length ? known : 'no drawings'}.`);
}

function resolveRelationshipTarget(baseDir, target) {
  const value = String(target || '');
  if (!value || /^[a-z]+:/i.test(value)) return '';
  return value.startsWith('/') ? value.slice(1) : posix.normalize(posix.join(baseDir, value));
}

/** Whether any relationship still points at this part, so a picture placed
 *  twice survives the deletion of its first frame. */
async function packageStillReferences(zip, part) {
  for (const name of Object.keys(zip.files)) {
    if (!/\.rels$/i.test(name)) continue;
    const xml = await zipText(zip, name);
    if (!xml) continue;
    const baseDir = posix.dirname(posix.dirname(name));
    for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      if (resolveRelationshipTarget(baseDir, xmlAttribute(match[0], 'Target')) === part) return true;
    }
  }
  return false;
}

/** A chart owns its embedded workbook and its colour and style parts; deleting
 *  the frame without them leaves the package carrying parts nothing reaches. */
async function removePartTree(zip, part) {
  const relsPath = partRelationshipPath(part);
  const relsXml = await zipText(zip, relsPath);
  const children = [];
  if (relsXml) {
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      const child = resolveRelationshipTarget(posix.dirname(part), xmlAttribute(match[0], 'Target'));
      if (child) children.push(child);
    }
    zip.remove(relsPath);
  }
  zip.remove(part);
  await removeContentTypeOverride(zip, `/${part}`);
  const removed = [part];
  for (const child of children) {
    if (!zip.file(child) || (await packageStillReferences(zip, child))) continue;
    removed.push(...(await removePartTree(zip, child)));
  }
  return removed;
}

/** Moves or resizes a chart or picture already on the sheet; positions are
 *  points, the same unit add_chart places one with. */
export async function setWorksheetDrawing(zip, sheet, xml, op) {
  const part = await worksheetDrawingPart(zip, sheet);
  const drawingXml = await zipText(zip, part);
  const target = selectDrawing(drawingAnchors(drawingXml), op);
  const label = target.name || target.index;
  const emu = (value) => Math.round(Number(value) * EMU_PER_POINT_XLSX);
  let body = target.body;
  if (target.kind === 'twoCellAnchor') {
    // The frame hangs between two cells, so moving it means finding the cells
    // the new rectangle starts and ends in and the offset into each.
    const geometry = worksheetGeometry(xml);
    const marker = (tag) => {
      const value = new RegExp(`<xdr:${tag}>([\\s\\S]*?)<\\/xdr:${tag}>`).exec(body)?.[1] || '';
      const number = (name) => Number(new RegExp(`<xdr:${name}>(-?\\d+)<\\/xdr:${name}>`).exec(value)?.[1]) || 0;
      return { col: number('col'), colOff: number('colOff'), row: number('row'), rowOff: number('rowOff') };
    };
    const points = ({ col, colOff, row, rowOff }) => {
      let x = colOff / EMU_PER_POINT_XLSX;
      for (let index = 1; index <= col; index += 1) x += geometry.columnPoints(index);
      let y = rowOff / EMU_PER_POINT_XLSX;
      for (let index = 1; index <= row; index += 1) y += geometry.rowPoints(index);
      return { x, y };
    };
    const at = (x, y) => {
      const column = Math.max(1, geometry.columnAt(x));
      const row = Math.max(1, geometry.rowAt(y));
      let spent = 0;
      for (let index = 1; index < column; index += 1) spent += geometry.columnPoints(index);
      let used = 0;
      for (let index = 1; index < row; index += 1) used += geometry.rowPoints(index);
      return {
        col: column - 1,
        colOff: emu(Math.max(0, x - spent)),
        row: row - 1,
        rowOff: emu(Math.max(0, y - used)),
      };
    };
    const write = (tag, place) =>
      `<xdr:${tag}><xdr:col>${place.col}</xdr:col><xdr:colOff>${place.colOff}</xdr:colOff>` +
      `<xdr:row>${place.row}</xdr:row><xdr:rowOff>${place.rowOff}</xdr:rowOff></xdr:${tag}>`;
    const from = points(marker('from'));
    const to = points(marker('to'));
    const left = op.left !== undefined ? Number(op.left) : from.x;
    const top = op.top !== undefined ? Number(op.top) : from.y;
    const width = op.width !== undefined ? Number(op.width) : Math.max(1, to.x - from.x);
    const height = op.height !== undefined ? Number(op.height) : Math.max(1, to.y - from.y);
    body = body
      .replace(/<xdr:from>[\s\S]*?<\/xdr:from>/, write('from', at(left, top)))
      .replace(/<xdr:to>[\s\S]*?<\/xdr:to>/, write('to', at(left + width, top + height)));
  }
  if (target.kind !== 'twoCellAnchor' && (op.left !== undefined || op.top !== undefined)) {
    if (target.kind === 'absoluteAnchor') {
      const current = /<xdr:pos\b([^>]*)\/>/.exec(body)?.[1] || '';
      const x = op.left !== undefined ? emu(op.left) : Number(xmlAttribute(current, 'x')) || 0;
      const y = op.top !== undefined ? emu(op.top) : Number(xmlAttribute(current, 'y')) || 0;
      body = body.replace(/<xdr:pos\b[^>]*\/>/, `<xdr:pos x="${x}" y="${y}"/>`);
    } else {
      if (op.left === undefined || op.top === undefined) {
        throw new Error(`Drawing "${label}" hangs off a cell; set_drawing needs left and top together to move it.`);
      }
      // Measuring the offset from A1 makes the point given the point drawn.
      body = body.replace(
        /<xdr:from>[\s\S]*?<\/xdr:from>/,
        `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>${emu(op.left)}</xdr:colOff>` +
          `<xdr:row>0</xdr:row><xdr:rowOff>${emu(op.top)}</xdr:rowOff></xdr:from>`
      );
    }
  }
  if (op.width !== undefined || op.height !== undefined) {
    const current = /<xdr:ext\b([^>]*)\/>/.exec(body)?.[1] || '';
    const cx = op.width !== undefined ? emu(op.width) : Number(xmlAttribute(current, 'cx')) || 0;
    const cy = op.height !== undefined ? emu(op.height) : Number(xmlAttribute(current, 'cy')) || 0;
    body = body.replace(/<xdr:ext\b[^>]*\/>/, `<xdr:ext cx="${cx}" cy="${cy}"/>`);
  }
  if (body === target.body) throw new Error(`XLSX ${op.op} needs left, top, width, or height`);
  zip.file(part, `${drawingXml.slice(0, target.start)}${body}${drawingXml.slice(target.end)}`);
  return { op: op.op, changed: true, sheet: sheet.name, drawing: label, kind: target.kind };
}

/** Takes a chart or picture off the sheet with the parts only it owned. */
export async function deleteWorksheetDrawing(zip, sheet, _xml, op) {
  const part = await worksheetDrawingPart(zip, sheet);
  const drawingXml = await zipText(zip, part);
  const target = selectDrawing(drawingAnchors(drawingXml), op);
  const relsPath = partRelationshipPath(part);
  const relationshipId = target.chartId || target.embedId;
  const removedParts = [];
  if (relationshipId) {
    const entry =
      new RegExp(`<Relationship\\b[^>]*\\bId="${tagPattern(relationshipId)}"[^>]*\\/>`).exec(
        await zipText(zip, relsPath)
      )?.[0] || '';
    const linked = entry ? resolveRelationshipTarget(posix.dirname(part), xmlAttribute(entry, 'Target')) : '';
    await removePackageRelationship(zip, relsPath, relationshipId);
    if (linked && zip.file(linked) && !(await packageStillReferences(zip, linked))) {
      removedParts.push(...(await removePartTree(zip, linked)));
    }
  }
  zip.file(part, `${drawingXml.slice(0, target.start)}${drawingXml.slice(target.end)}`);
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    drawing: target.name || target.index,
    ...(removedParts.length ? { removedParts } : {}),
  };
}

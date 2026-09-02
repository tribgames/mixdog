import { basename, dirname, join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';
import {
  XML_HEADER,
  paragraphTexts,
  replaceAcrossRuns,
  tagPattern,
  xmlAttribute,
  xmlDecode,
  xmlEncode,
} from './portable-xml.mjs';

function templateTokenMatches(text) {
  return [...String(text || '').matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)]
    .map((match) => ({ raw: match[0], key: match[1] }));
}

export async function fillTemplateParts(zip, parts, tag, operation) {
  const tokens = operation.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('fill_template requires tokens as an object');
  }
  const filled = {};
  for (const part of parts) {
    let xml = await zipText(zip, part);
    const variants = new Map(templateTokenMatches(paragraphTexts(xml, tag).join('')).map((match) => [match.raw, match.key]));
    let changed = false;
    for (const [raw, key] of variants) {
      if (!Object.hasOwn(tokens, key)) continue;
      const replaced = replaceAcrossRuns(xml, tag, raw, String(tokens[key] ?? ''));
      if (!replaced.count) continue;
      xml = replaced.xml;
      changed = true;
      filled[key] = (filled[key] || 0) + replaced.count;
    }
    if (changed) zip.file(part, xml);
  }
  const remaining = new Set();
  for (const part of parts) {
    const xml = await zipText(zip, part);
    for (const match of templateTokenMatches(paragraphTexts(xml, tag).join(''))) remaining.add(match.key);
  }
  const unfilledTokens = [...remaining].sort();
  if (operation.strict && unfilledTokens.length) {
    throw new Error(`Unfilled template tokens: ${unfilledTokens.join(', ')}`);
  }
  return {
    op: 'fill_template',
    changed: Object.keys(filled).length > 0,
    filled,
    unfilledTokens,
    strict: operation.strict === true,
  };
}

export async function loadPackage(path) {
  return await JSZip.loadAsync(await readFile(path), {
    checkCRC32: true,
    createFolders: false,
  });
}


export async function zipText(zip, path) {
  const file = zip.file(path);
  return file ? await file.async('string') : '';
}


export async function savePackage(zip, path) {
  const data = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
  await writeFile(path, data);
}


export function relationshipMap(xml) {
  const map = new Map();
  const regex = /<Relationship\b([^>]+?)\/?>/g;
  let match;
  while ((match = regex.exec(xml))) {
    const attrs = match[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}


export const PIXELS_TO_POINTS = 0.75;


export function imagePixelSize(data) {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data[0] === 0xFF && data[1] === 0xD8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xFF) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (data.length > 10 && data.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  return null;
}


export function nextRelationshipId(rels) {
  const ids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
  return `rId${Math.max(0, ...ids) + 1}`;
}


export const PACKAGE_RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export const IMAGE_CONTENT_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
});

export async function ensureContentTypeOverride(zip, part, type) {
  const path = '[Content_Types].xml';
  const xml = await zipText(zip, path);
  if (xml.includes(`PartName="${part}"`)) return;
  zip.file(path, xml.replace('</Types>', `<Override PartName="${part}" ContentType="${type}"/></Types>`));
}


export async function removeContentTypeOverride(zip, part) {
  const path = '[Content_Types].xml';
  const xml = await zipText(zip, path);
  zip.file(path, xml.replace(new RegExp(`<Override\\b[^>]*\\bPartName="${tagPattern(part)}"[^>]*\\/>`), ''));
}


export async function ensureDefaultContentType(zip, extension, type) {
  const path = '[Content_Types].xml';
  const xml = await zipText(zip, path);
  if (new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"`, 'i').test(xml)) return;
  zip.file(path, xml.replace(/<Types\b[^>]*>/, `$&<Default Extension="${extension}" ContentType="${type}"/>`));
}


export async function addPackageRelationship(zip, relsPath, type, target, mode = '') {
  const existing = await zipText(zip, relsPath);
  const xml = existing || `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"></Relationships>`;
  const id = nextRelationshipId(xml);
  const relationship = `<Relationship Id="${id}" Type="${type}" Target="${xmlEncode(target)}"`
    + `${mode ? ` TargetMode="${mode}"` : ''}/>`;
  zip.file(relsPath, xml.replace('</Relationships>', `${relationship}</Relationships>`));
  return id;
}


export async function removePackageRelationship(zip, relsPath, id) {
  const xml = await zipText(zip, relsPath);
  if (!xml) return;
  zip.file(relsPath, xml.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${tagPattern(id)}"[^>]*\\/>`), ''));
}


export function partRelationshipPath(part) {
  return `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
}


export function provenanceCitation(source) {
  if (!source) return '';
  if (typeof source === 'string') return `Source: ${source.trim()}`;
  if (typeof source !== 'object') return '';
  const document = String(source.document || source.label || '').trim();
  const target = String(source.target || '').trim();
  if (!document) return '';
  return `Source: ${target ? `${document}#${target}` : document}`;
}


function partNaming(path) {
  const base = posix.basename(path);
  const match = /^([A-Za-z_]+?)\d*\.([A-Za-z0-9]+)$/.exec(base);
  if (match) return { prefix: match[1], extension: match[2] };
  const dot = base.lastIndexOf('.');
  return {
    prefix: dot > 0 ? base.slice(0, dot) : base,
    extension: dot > 0 ? base.slice(dot + 1) : 'bin',
  };
}


function nextAvailablePart(zip, directory, prefix, extension) {
  let ordinal = 1;
  while (zip.file(`${directory}/${prefix}${ordinal}.${extension}`)) ordinal += 1;
  return `${directory}/${prefix}${ordinal}.${extension}`;
}


async function partDigest(archive, path) {
  const file = archive.file(path);
  if (!file) return '';
  return createHash('sha1').update(await file.async('nodebuffer')).digest('hex');
}


async function findMatchingPart(zip, pattern, digest) {
  if (!digest) return '';
  for (const name of Object.keys(zip.files)) {
    if (!pattern.test(name)) continue;
    if (await partDigest(zip, name) === digest) return name;
  }
  return '';
}


async function copyPartContentType(source, zip, sourcePath, targetPath) {
  const types = await zipText(source, '[Content_Types].xml');
  const override = new RegExp(`<Override\\b[^>]*\\bPartName="/${tagPattern(sourcePath)}"[^>]*\\/>`).exec(types);
  if (override) {
    await ensureContentTypeOverride(zip, `/${targetPath}`, xmlAttribute(override[0], 'ContentType'));
    return;
  }
  const extension = partNaming(sourcePath).extension.toLowerCase();
  const fallback = new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"[^>]*\\/>`, 'i').exec(types);
  if (fallback) await ensureDefaultContentType(zip, extension, xmlAttribute(fallback[0], 'ContentType'));
}


async function importPartTree(source, zip, sourcePath, cache) {
  if (cache.has(sourcePath)) return cache.get(sourcePath);
  const file = source.file(sourcePath);
  if (!file) throw new Error(`import_slides source package is missing ${sourcePath}`);
  const data = await file.async('nodebuffer');
  const digest = createHash('sha1').update(data).digest('hex');
  const directory = posix.dirname(sourcePath);
  const naming = partNaming(sourcePath);
  const reused = await findMatchingPart(
    zip,
    new RegExp(`^${tagPattern(directory)}/${tagPattern(naming.prefix)}\\d*\\.${tagPattern(naming.extension)}$`, 'i'),
    digest,
  );
  if (reused) {
    cache.set(sourcePath, reused);
    return reused;
  }
  const targetPath = nextAvailablePart(zip, directory, naming.prefix, naming.extension);
  zip.file(targetPath, data);
  cache.set(sourcePath, targetPath);
  await copyPartContentType(source, zip, sourcePath, targetPath);
  const relationships = await zipText(source, partRelationshipPath(sourcePath));
  if (relationships) {
    zip.file(
      partRelationshipPath(targetPath),
      await rewriteImportedRelationships(source, zip, sourcePath, targetPath, relationships, cache),
    );
  }
  return targetPath;
}


export async function rewriteImportedRelationships(source, zip, sourceOwner, targetOwner, relationships, cache) {
  const sourceDirectory = posix.dirname(sourceOwner);
  const targetDirectory = posix.dirname(targetOwner);
  let output = relationships;
  for (const match of relationships.matchAll(/<Relationship\b[^>]*?\/>/g)) {
    const block = match[0];
    if (/\bTargetMode="External"/i.test(block)) continue;
    const type = xmlAttribute(block, 'Type');
    const target = xmlDecode(xmlAttribute(block, 'Target'));
    if (!target) continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(sourceDirectory, target));
    if (type.endsWith('/notesSlide')) {
      output = output.replace(block, '');
      continue;
    }
    let mapped = '';
    if (type.endsWith('/slideLayout')) {
      mapped = await findMatchingPart(
        zip,
        /^ppt\/slideLayouts\/slideLayout\d+\.xml$/,
        await partDigest(source, resolved),
      );
      if (!mapped) {
        throw new Error('portable import_slides requires the deck to be seeded from the same template; create the presentation from this template first');
      }
    } else if (type.endsWith('/slide')) {
      mapped = cache.get(`slide:${resolved}`) || '';
      if (!mapped) {
        output = output.replace(block, '');
        continue;
      }
    } else {
      mapped = await importPartTree(source, zip, resolved, cache);
    }
    output = output.replace(
      block,
      block.replace(/\bTarget="[^"]*"/, `Target="${xmlEncode(posix.relative(targetDirectory, mapped))}"`),
    );
  }
  return output;
}


export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

export const WORKBOOK_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';


export function relationshipOwner(relPath) {
  if (relPath === '_rels/.rels') return '';
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/i.exec(relPath);
  return match ? `${match[1]}/${match[2]}` : '';
}


export function relationshipTarget(relPath, target) {
  let decoded = xmlDecode(target).split('#')[0].split('?')[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  const owner = relationshipOwner(relPath);
  const base = owner ? posix.dirname(owner) : '';
  return posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(base, decoded));
}

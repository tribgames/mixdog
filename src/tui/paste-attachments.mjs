import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_TARGET_RAW_SIZE,
  imageMetadataText,
  resizeImageBuffer,
} from '../runtime/agent/orchestrator/tools/builtin/read-image-resize.mjs';

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp)$/i;
const MAX_IMAGE_BYTES_WITHOUT_RESIZE = IMAGE_TARGET_RAW_SIZE;

function cleanPathText(value) {
  let text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  if (text.startsWith('file://')) {
    try { text = decodeURIComponent(new URL(text).pathname); } catch {}
    if (process.platform === 'win32') text = text.replace(/^\/+([A-Za-z]:)/, '$1').replace(/\//g, '\\');
  }
  if (process.platform !== 'win32') {
    text = text.replace(/\\(.)/g, '$1');
  }
  return text;
}

function mimeForPath(path) {
  return IMAGE_MIME[extname(String(path || '')).toLowerCase()] || null;
}

function execFileBuffer(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5000,
      ...options,
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout, stderr, error });
    });
  });
}

function tempPngPath() {
  return resolve(tmpdir(), `mixdog-clipboard-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.png`);
}

export function formatImageRef(id) {
  return `[Image #${id}]`;
}

export function parsePasteReferences(input) {
  const re = /\[(?:Image|Pasted text|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?\]/g;
  return [...String(input || '').matchAll(re)]
    .map((m) => ({ id: Number(m[1]) || 0, match: m[0], index: m.index || 0 }))
    .filter((m) => m.id > 0);
}

export function imageReferenceIds(input) {
  const re = /\[Image #(\d+)\]/g;
  return new Set([...String(input || '').matchAll(re)].map((m) => Number(m[1]) || 0).filter(Boolean));
}

export function promptContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'image') return `[image: ${part.mimeType || part.mediaType || part.source?.media_type || 'image'}]`;
    return part?.text || '';
  }).filter(Boolean).join('\n');
}

export function buildPromptContentWithImages(text, pastedImages = {}) {
  const value = String(text ?? '');
  const refs = imageReferenceIds(value);
  const imageParts = Object.values(pastedImages || {})
    .filter((img) => img && img.type === 'image' && refs.has(Number(img.id)))
    .flatMap((img) => {
      const parts = [];
      if (img.metadataText) parts.push({ type: 'text', text: img.metadataText });
      parts.push({ type: 'image', data: img.content, mimeType: img.mediaType || 'image/png' });
      return parts;
    });
  if (imageParts.length === 0) return value;
  const parts = [];
  if (value.trim()) parts.push({ type: 'text', text: value });
  parts.push(...imageParts);
  return parts;
}

export function isImagePathText(value) {
  return IMAGE_PATH_RE.test(cleanPathText(value));
}

export function splitPastedImagePathCandidates(text) {
  const out = [];
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const chunks = line.split(/ (?=\/|~\/|\.\.?\/|[A-Za-z]:\\|file:\/\/)/g);
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const raw = chunks[ci];
      if (!raw) continue;
      out.push({ text: raw, imagePath: isImagePathText(raw) });
    }
    if (li < lines.length - 1) out.push({ text: '\n', imagePath: false });
  }
  return out;
}

async function imageAttachmentFromBuffer(buffer, mimeType, { filename = 'Pasted image', sourcePath = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('image is empty');
  const ext = (mimeType || 'image/png').split('/')[1] || 'png';
  const resized = await resizeImageBuffer(buffer, ext);
  if (resized) {
    return {
      type: 'image',
      content: resized.data,
      mediaType: resized.mimeType,
      filename,
      sourcePath,
      metadataText: imageMetadataText(resized.dimensions, sourcePath || filename),
    };
  }
  if (buffer.length > MAX_IMAGE_BYTES_WITHOUT_RESIZE) {
    throw new Error(`image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB; install optional sharp support or resize it first`);
  }
  const data = buffer.toString('base64');
  if (data.length > API_IMAGE_MAX_BASE64_SIZE) {
    throw new Error('image exceeds inline API size limit; resize it first');
  }
  return { type: 'image', content: data, mediaType: mimeType || 'image/png', filename, sourcePath };
}

export async function readImageAttachmentFromPath(rawPath, cwd = process.cwd()) {
  const cleaned = cleanPathText(rawPath);
  const mimeType = mimeForPath(cleaned);
  if (!mimeType) return null;
  const fullPath = isAbsolute(cleaned) ? cleaned : resolve(cwd || process.cwd(), cleaned);
  if (!existsSync(fullPath)) return null;
  const st = statSync(fullPath);
  if (!st.isFile()) return null;
  const buffer = readFileSync(fullPath);
  return imageAttachmentFromBuffer(buffer, mimeType, {
    filename: basename(fullPath),
    sourcePath: fullPath,
  });
}

async function readClipboardImageToTempFile() {
  const out = tempPngPath();
  if (process.platform === 'win32') {
    const ps = '$p=$env:MIXDOG_CLIPBOARD_IMAGE_PATH; Add-Type -AssemblyName System.Drawing; $img=Get-Clipboard -Format Image; if ($null -eq $img) { exit 2 }; $img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)';
    const r = await execFileBuffer('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, MIXDOG_CLIPBOARD_IMAGE_PATH: out },
    });
    return r.ok && existsSync(out) ? out : null;
  }
  if (process.platform === 'darwin') {
    const script = `set png_data to (the clipboard as «class PNGf»)\nset fp to open for access POSIX file "${out.replace(/"/g, '\\"')}" with write permission\nwrite png_data to fp\nclose access fp`;
    const r = await execFileBuffer('osascript', ['-e', script]);
    return r.ok && existsSync(out) ? out : null;
  }
  return null;
}

export async function readClipboardImageAttachment() {
  if (process.platform === 'linux') {
    const wl = await execFileBuffer('wl-paste', ['--type', 'image/png'], { timeout: 3000 });
    if (wl.ok && wl.stdout?.length) return imageAttachmentFromBuffer(wl.stdout, 'image/png');
    const xc = await execFileBuffer('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 3000 });
    if (xc.ok && xc.stdout?.length) return imageAttachmentFromBuffer(xc.stdout, 'image/png');
    return null;
  }
  const file = await readClipboardImageToTempFile();
  if (!file) return null;
  try {
    const buffer = readFileSync(file);
    return await imageAttachmentFromBuffer(buffer, 'image/png');
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

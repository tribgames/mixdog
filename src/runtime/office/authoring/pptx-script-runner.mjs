import { createRequire } from 'node:module';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import { PPTX_SCRIPT_CONTRACT } from './pptx-script-contract.mjs';
import { normalizeAuthoredPptx } from './pptx-script-normalize.mjs';
import { measureTextBlock } from '../portable/text-metrics.mjs';
import { iconGlobal } from './pptx-icons.mjs';
import { kitPrelude, scriptCarriesKit } from './pptx-kit.mjs';
import { relationOptions } from '../portable/pptx-relations.mjs';

// Inches, measured with the metrics the review reads the saved file with. lineHeight is PowerPoint's lineSpacingMultiple.
function measureForScript(
  text,
  { font = 'Calibri', size = 18, bold = false, italic = false, width = 0, lineHeight = 1 } = {}
) {
  const paragraphs = String(text ?? '')
    .split('\n')
    .map((line) => ({ text: line, fontName: font, fontSize: size, bold, italic }));
  const measured = measureTextBlock(paragraphs, {
    width: Math.max(0, Number(width) || 0) * 72,
    lineSpacing: lineHeight,
  });
  return { lines: measured.lines, height: measured.height / 72, width: measured.width / 72 };
}

const hostRequire = createRequire(import.meta.url);
const ALLOWED_MODULES = new Set(PPTX_SCRIPT_CONTRACT.require);
const NODE_PREFIX = /^node:/;

const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;

function scriptRequire(name) {
  const requested = String(name || '');
  const bare = requested.replace(NODE_PREFIX, '');
  const key = ALLOWED_MODULES.has(`node:${bare}`) ? `node:${bare}` : requested;
  if (!ALLOWED_MODULES.has(key)) {
    throw new Error(
      `require('${requested}') is not available to authoring scripts; allowed: ${[...ALLOWED_MODULES].join(', ')}`
    );
  }
  return hostRequire(key);
}

function captureConsole(lines) {
  const push =
    (level) =>
    (...parts) => {
      const text = parts.map((part) => (typeof part === 'string' ? part : safeString(part))).join(' ');
      lines.push({ level, text: text.slice(0, 2000) });
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    };
  return { log: push('log'), info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

function safeString(value) {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

function scriptError(error, script, preludeLines = 0) {
  const message = error?.message || String(error);
  const stack = String(error?.stack || '');
  const match = stack.match(/<anonymous>:(\d+):(\d+)/);
  const raw = match ? Number(match[1]) - 3 : null;
  if (raw !== null && preludeLines && raw <= preludeLines) {
    return {
      message: `${message} (inside the kit prelude, line ${raw} of the kit.md/charts.md/pictures.md code blocks — usually an argument the script passed)`,
      line: null,
      excerpt: '',
    };
  }
  const line = raw === null ? null : Math.max(1, raw - preludeLines);
  const lines = script.split('\n');
  return {
    message,
    line,
    excerpt: line ? lines.slice(Math.max(0, line - 2), line + 1).join('\n') : '',
  };
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function compileScriptBody(source, kit) {
  return new AsyncFunction(
    'require',
    'module',
    'exports',
    'OUTPUT',
    'console',
    'process',
    'MEASURE',
    'ICON',
    'RELATE',
    `"use strict";\n${kit ? `${kit.source}\n` : ''}${source}\n`
  );
}

async function ensureOutputWritten(output, exported) {
  if (await pathExists(output)) return;
  if (exported && typeof exported.writeFile === 'function') {
    await exported.writeFile({ fileName: output });
    return;
  }
  throw new Error('The script finished without writing OUTPUT; end with `await pres.writeFile({ fileName: OUTPUT })`.');
}

export async function runPptxAuthoringScript(
  script,
  output,
  { timeoutMs = PPTX_SCRIPT_CONTRACT.timeoutMs, cwd = dirname(output) } = {}
) {
  const source = String(script || '');
  if (!source.trim()) throw new Error('author requires a non-empty pptxgenjs script');
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  const logs = [];
  const module = { exports: {} };
  const startedAt = performance.now();
  const kit = scriptCarriesKit(source) ? null : kitPrelude();
  const preludeLines = kit ? kit.lines : 0;
  let body;
  try {
    body = compileScriptBody(source, kit);
  } catch (error) {
    return { ok: false, error: scriptError(error, source, preludeLines), logs, elapsedMs: 0 };
  }
  const scopedProcess = { env: { ...process.env }, cwd: () => cwd, platform: process.platform };
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Authoring script exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      body(
        scriptRequire,
        module,
        module.exports,
        output,
        captureConsole(logs),
        scopedProcess,
        measureForScript,
        iconGlobal(),
        relationOptions
      ),
      timeout,
    ]);
    await ensureOutputWritten(output, module.exports);
  } catch (error) {
    return {
      ok: false,
      error: scriptError(error, source, preludeLines),
      logs,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timer);
  }
  const normalized = await normalizeAuthoredPptx(output);
  const info = await stat(output);
  return {
    ok: true,
    output,
    bytes: info.size,
    logs,
    kit: kit ? 'runtime' : 'script',
    normalizedParagraphs: normalized.removed,
    ...(normalized.gradients ? { nativeGradients: normalized.gradients } : {}),
    ...(normalized.vectorIcons ? { vectorIcons: normalized.vectorIcons } : {}),
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

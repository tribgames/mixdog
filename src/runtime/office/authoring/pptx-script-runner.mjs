import { createRequire } from 'node:module';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import { PPTX_SCRIPT_CONTRACT } from './pptx-authoring-guide.mjs';

// The script runs inside this process: a child node cannot resolve pptxgenjs
// out of the packaged archive, and the model already holds shell access, so a
// separate process would add cost without adding a boundary.
const hostRequire = createRequire(import.meta.url);
const ALLOWED_MODULES = new Set(PPTX_SCRIPT_CONTRACT.require);
const NODE_PREFIX = /^node:/;

const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;

function scriptRequire(name) {
  const requested = String(name || '');
  const bare = requested.replace(NODE_PREFIX, '');
  const key = ALLOWED_MODULES.has(`node:${bare}`) ? `node:${bare}` : requested;
  if (!ALLOWED_MODULES.has(key)) {
    throw new Error(`require('${requested}') is not available to authoring scripts; allowed: ${[...ALLOWED_MODULES].join(', ')}`);
  }
  return hostRequire(key);
}

function captureConsole(lines) {
  const push = (level) => (...parts) => {
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

function scriptError(error, script) {
  const message = error?.message || String(error);
  const stack = String(error?.stack || '');
  const match = stack.match(/<anonymous>:(\d+):(\d+)/);
  // The generated wrapper places three lines (signature, brace, strict
  // pragma) before the script body.
  const line = match ? Math.max(1, Number(match[1]) - 3) : null;
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

export async function runPptxAuthoringScript(script, output, { timeoutMs = PPTX_SCRIPT_CONTRACT.timeoutMs } = {}) {
  const source = String(script || '');
  if (!source.trim()) throw new Error('author requires a non-empty pptxgenjs script');
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  const logs = [];
  const module = { exports: {} };
  const startedAt = performance.now();
  let body;
  try {
    body = new AsyncFunction('require', 'module', 'exports', 'OUTPUT', 'console', 'process', `"use strict";\n${source}\n`);
  } catch (error) {
    return { ok: false, error: scriptError(error, source), logs, elapsedMs: 0 };
  }
  const scopedProcess = { env: { ...process.env }, cwd: () => dirname(output), platform: process.platform };
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Authoring script exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      body(scriptRequire, module, module.exports, output, captureConsole(logs), scopedProcess),
      timeout,
    ]);
    if (!await pathExists(output)) {
      const exported = module.exports;
      if (exported && typeof exported.writeFile === 'function') {
        await exported.writeFile({ fileName: output });
      } else {
        throw new Error('The script finished without writing OUTPUT; end with `await pres.writeFile({ fileName: OUTPUT })`.');
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: scriptError(error, source),
      logs,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timer);
  }
  const info = await stat(output);
  return {
    ok: true,
    output,
    bytes: info.size,
    logs,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

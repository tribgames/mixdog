/**
 * Opt-in paid image probes. Persist a bounded request ledger before sending,
 * never log credentials, and retain generated artifacts for inspection.
 * Usage: node scripts/media-image-live.mjs <absolute-output-dir> <base|edits>
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCodexAuth } from '../src/runtime/media/auth.mjs';
import { codexImageRequestBody, codexImageRequestHeaders } from '../src/runtime/media/adapters/codex-image.mjs';
import { CODEX_RESPONSES_URL } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { warmCodexClientVersion } from '../src/runtime/agent/orchestrator/providers/codex-client-meta.mjs';
import { generateImage as geminiImage } from '../src/runtime/media/adapters/gemini-image.mjs';
import { generateImage as grokImage } from '../src/runtime/media/adapters/xai-media.mjs';

const [directory, phase] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || !['base', 'edits'].includes(phase)) {
  throw new Error('Supply an absolute artifact directory and base|edits');
}
await fs.mkdir(directory, { recursive: true });
const ledgerPath = path.join(directory, 'requests.json');
let ledger;
try { ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; ledger = []; }
const prompt = 'Draw a simple flat icon: one solid blue circle centered on a white background. No text.';
const geminiModels = [
  'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview', 'gemini-3-pro-image',
  'gemini-3-pro-image-preview', 'gemini-2.5-flash-image',
];
const grokModels = ['grok-imagine-image', 'grok-imagine-image-quality', 'grok-imagine-image-2.0'];
const openaiModels = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const cases = phase === 'base'
  ? [
    ...geminiModels.map(model => ({ lane: 'gemini', model, mode: 'generate', options: { aspectRatio: '16:9' } })),
    ...grokModels.map(model => ({ lane: 'grok-oauth', model, mode: 'generate', options: { aspectRatio: '16:9', resolution: '1k' } })),
    ...openaiModels.map(model => ({ lane: 'openai-oauth', model, mode: 'responses', options: { size: '1024x1024', quality: 'low' } })),
  ]
  : [
    ...geminiModels.filter(model => !model.endsWith('-preview')).map(model => ({
      lane: 'gemini', model, mode: 'edit', options: { aspectRatio: '1:1' },
    })),
    ...grokModels.map(model => ({ lane: 'grok-oauth', model, mode: 'edit', options: { aspectRatio: '1:1', resolution: '2k' } })),
    ...openaiModels.map(model => ({ lane: 'openai-oauth', model, mode: 'edit', options: { size: '1536x1024', quality: 'low' } })),
  ];
const pending = cases.filter(item => !ledger.some(row => row.lane === item.lane && row.model === item.model && row.mode === item.mode));
if (ledger.length + pending.length > 20) throw new Error('Paid request limit (20) exceeded');
const auth = await resolveCodexAuth();
await warmCodexClientVersion();
const sanitize = value => String(value ?? '').replaceAll(auth.access_token, '[REDACTED]')
  .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[ID]').slice(0, 1000);
function imageInfo(bytes) {
  const png = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return {
    bytes: bytes.length, signature: bytes.subarray(0, 12).toString('hex'),
    ...(png && bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}),
  };
}
async function openai(item, references) {
  const headers = codexImageRequestHeaders(auth);
  headers['x-codex-image-turn-id'] = randomUUID();
  let body;
  let url;
  if (item.mode === 'responses') {
    body = codexImageRequestBody({ model: 'gpt-6-astra', prompt, options: item.options });
    body.tools[0].model = item.model;
    url = CODEX_RESPONSES_URL;
  } else {
    headers.Accept = 'application/json';
    body = {
      model: item.model, prompt: 'Change the blue circle to a red circle. Keep the simple white background.',
      n: 1, ...item.options,
      images: references.map(ref => ({ image_url: `data:${ref.mime};base64,${ref.base64}` })),
    };
    url = CODEX_RESPONSES_URL.replace(/\/responses$/, '/images/edits');
  }
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  const models = new Set();
  const errors = [];
  let bytes;
  function collect(data) {
    if (!data || typeof data !== 'object') return;
    if (data.model) models.add(data.model);
    if (data.error) errors.push(sanitize(JSON.stringify(data.error)));
    if (data.type === 'error' && data.message) errors.push(sanitize(data.message));
    if (data.type === 'image_generation_call' && data.result) bytes = Buffer.from(data.result, 'base64');
    if (data.b64_json) bytes = Buffer.from(data.b64_json, 'base64');
    for (const [key, value] of Object.entries(data)) {
      if (['result', 'b64_json', 'partial_image_b64'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') collect(value);
    }
  }
  if (text.split('\n').some(line => line.startsWith('data:'))) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      try { collect(JSON.parse(line.slice(5))); } catch {}
    }
  } else {
    try { collect(JSON.parse(text)); } catch {}
  }
  if (!response.ok || !bytes) throw new Error(`HTTP ${response.status}: ${errors.join('; ') || sanitize(text.slice(0, 600))}`);
  return { bytes, mime: 'image/png', returnedModels: [...models], httpStatus: response.status };
}

// Sequential ledger writes, bounded workers; no automatic paid retries.
for (let offset = 0; offset < pending.length; offset += 3) {
  const batch = pending.slice(offset, offset + 3);
  ledger.push(...batch.map(item => ({ ...item, status: 'started', startedAt: new Date().toISOString() })));
  await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
  await Promise.all(batch.map(async item => {
    const row = ledger.find(entry => entry.lane === item.lane && entry.model === item.model && entry.mode === item.mode);
    const started = Date.now();
    try {
      let references = [];
      if (item.mode === 'edit') {
        const source = ledger.find(entry => entry.lane === item.lane && entry.model === item.model && entry.file)
          || ledger.find(entry => entry.file);
        if (!source) throw new Error('No successful base image for editing');
        references = [{ mime: source.mime, base64: (await fs.readFile(path.join(directory, source.file))).toString('base64') }];
      }
      const input = {
        ...item, references, prompt: item.mode === 'edit' ? 'Change the blue circle to a red circle. Keep the white background.' : prompt,
        signal: AbortSignal.timeout(240_000),
      };
      const result = item.lane === 'openai-oauth' ? await openai(item, references)
        : item.lane === 'gemini' ? await geminiImage(input) : await grokImage(input);
      row.file = `${item.lane}-${item.model}-${item.mode}.png`;
      await fs.writeFile(path.join(directory, row.file), result.bytes);
      Object.assign(row, { status: 'success', mime: result.mime, ...imageInfo(result.bytes), returnedModels: result.returnedModels });
    } catch (error) {
      Object.assign(row, { status: 'failed', error: sanitize(error.message) });
    }
    row.elapsedMs = Date.now() - started;
    console.log(JSON.stringify(row));
  }));
  await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
}
console.log(JSON.stringify({ artifactDirectory: directory, requests: ledger.length, phase }));

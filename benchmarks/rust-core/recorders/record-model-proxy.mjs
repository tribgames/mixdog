#!/usr/bin/env node
// Golden twin of the Node behavior the typed model proxy keeps (apps/desktop model-proxy-host.ts,
// model-proxy-provider.mjs, quota-reading.mjs, attachments/store.mjs): attachment references,
// credential redaction, the public provider config, quotaUsable, attachment inlining and stored text.
// Rust `mixdog_ai::service::model_proxy*` and `mixdog_protocol::message_class::user_text` must equal it.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//     benchmarks/rust-core/recorders/record-model-proxy.mjs --tree <dir> [--out <dir>]
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const hostPath = join(tree, 'apps/desktop/src/main/model-proxy-host.ts');
// The error record and the provider config projection are not exported: a sibling copy exports
// them for the recording and is removed again.
const recPath = join(tree, 'apps/desktop/src/main/model-proxy-host.rec.ts');
writeFileSync(recPath, `${readFileSync(hostPath, 'utf8')}\nexport { proxyErrorRecord, publicProviderConfig, redactedText };\n`);
let host;
try {
  host = await importFrom(tree, 'apps/desktop/src/main/model-proxy-host.rec.ts');
} finally {
  rmSync(recPath, { force: true });
}

let seed = 0x51ab77e3;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const outcome = (fn) => {
  try {
    return { value: plain(fn()) };
  } catch (error) {
    return { error: String(error?.message ?? error), code: error?.code ?? null, status: error?.status ?? null };
  }
};

const randomMessages = (depth = 0) => {
  const out = [];
  for (let j = 0; j < 1 + Math.floor(rnd() * 3); j += 1) {
    const part = { type: pick(['text', 'image', 'file']), text: pick(['a', 'b', '']) };
    if (chance(0.35)) {
      part.attachmentRef = pick(['ref-1', '', null, 3]);
      if (chance(0.7)) part.filename = pick(['a.png', 'C:\\x\\y.pdf', '/tmp/q.txt', 'bad\u0001name.txt', 'n'.repeat(300), '']);
      if (chance(0.5)) part.mimeType = pick(['image/png', 'application/pdf', '', 7]);
      if (chance(0.3)) part.mediaType = 'image/jpeg';
    }
    if (depth < 2 && chance(0.3)) part.content = randomMessages(depth + 1);
    out.push(part);
  }
  return out;
};
const attachmentCases = [];
for (let i = 0; i < 150; i += 1) {
  const input = randomMessages();
  attachmentCases.push({ input: plain(input), ...outcome(() => host.withoutAttachmentReferences(input)) });
}
let deep = { attachmentRef: 'x' };
for (let i = 0; i < 130; i += 1) deep = { child: deep };
// Nesting this deep is beyond a JSON reader's depth limit, so the case carries only its depth.
attachmentCases.push({ nest: 130, ...outcome(() => host.withoutAttachmentReferences(deep)) });
let ok = { attachmentRef: 'x', filename: 'f.txt' };
for (let i = 0; i < 128; i += 1) ok = { child: ok };
attachmentCases.push({ nest: 128, ...outcome(() => {
  let node = host.withoutAttachmentReferences(ok);
  for (let i = 0; i < 128; i += 1) node = node.child;
  return node;
}) });

const providerNames = ['openai', 'anthropic', 'custom-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'gemini', 'zzz'];
const providerConfigCases = [];
for (let i = 0; i < 120; i += 1) {
  const providers = {};
  for (const name of providerNames) {
    if (chance(0.25)) continue;
    const entry = { enabled: pick([true, false, 'yes']), apiKey: 'sk-secret', baseURL: 'https://x' };
    if (chance(0.4)) entry.type = 'custom';
    if (chance(0.4)) entry.name = pick(['  My GPU  ', 'sk-DUMMY-abcdefghijklmnop1234', '', 'n'.repeat(300), 5]);
    if (chance(0.5)) entry.models = [{ id: 'm1', hidden: true }, { id: 'm2' }, { id: 7, hidden: true }];
    if (chance(0.4)) entry.modelOverrides = { m3: { hidden: true }, m4: { hidden: false }, m1: { hidden: true } };
    if (chance(0.6)) entry.authState = pick(['present', 'absent', 'unreadable', 'other', 3]);
    if (chance(0.6)) {
      entry.modelProxy = {};
      if (chance(0.5)) entry.modelProxy.inputExcludesCache = pick([true, false, 'x']);
      if (chance(0.5)) entry.modelProxy.nativePdf = pick([true, false, 1]);
      if (chance(0.5)) entry.modelProxy.consumesReadWindows = pick([true, false, 1]);
      if (chance(0.5)) entry.modelProxy.takesImages = pick([true, false, 0]);
      if (chance(0.5)) entry.modelProxy.firstResponseBudget = pick([{ transportMs: 1000, semanticMs: 2000 }, { transportMs: 0, semanticMs: 5 }, { transportMs: 'a', semanticMs: 5 }, null]);
    }
    providers[name] = entry;
  }
  const allowList = providerNames.filter(() => chance(0.7));
  const input = chance(0.05) ? null : providers;
  providerConfigCases.push({ providers: input, allowList, ...outcome(() => host.publicProviderConfig(input, (n) => allowList.includes(n))) });
}

// quotaUsable (quota-reading.mjs): the single-credential path, where one forced reading decides.
const quota = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/quota-reading.mjs');
const quotaCases = [];
const LABELS = ['Weekly', '5h', '7D Spark', '7D opus', 'Spark (GPT-5.3)', '', undefined];
const QUOTA_MODELS = ['', 'gpt-5', 'gpt-5.3-codex-spark', 'claude-opus-4', 'claude-sonnet-4', 'spark'];
for (let i = 0; i < 300; i += 1) {
  const reading = chance(0.1) ? null : {};
  if (reading) {
    if (chance(0.5)) {
      reading.quotaWindows = Array.from({ length: Math.floor(rnd() * 4) }, () => {
        const w = {};
        if (chance(0.8)) w.label = pick(LABELS);
        if (chance(0.9)) w.usedPct = pick([0, 30, 99.9, 100, 120, 'x', null, 50]);
        if (chance(0.3)) w.models = pick([[], ['spark'], ['opus'], ['gpt-5']]);
        if (chance(0.2)) w.except = pick([[], ['spark'], ['opus']]);
        return w;
      });
    }
    if (chance(0.5)) reading.balance = pick([{ unlimited: true }, { remainingCredits: 5 }, { remainingUsd: 0 }, { remainingCredits: '5' }, {}, { unlimited: 'yes' }, { remainingUsd: 0.5 }]);
  }
  const useCredits = chance(0.5);
  const model = pick(QUOTA_MODELS);
  const noMeasurement = chance(0.04);
  quotaCases.push({ reading: plain(reading), useCredits, model, measurementNull: noMeasurement, ...outcome(() => quota.quotaMeasurementServesModel(noMeasurement ? null : { providerName: 'openai-oauth', useCredits, accounts: null, reading }, model)) });
}
quotaCases.push({ reading: null, useCredits: false, model: 'x', measurementNull: true, ...outcome(() => quota.quotaMeasurementServesModel(null, 'x')) });

// inlineModelProxyAttachments (model-proxy-provider.mjs:61): newest-first inlining under one byte
// budget, over a real attachment store in a temporary data directory.
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-rec-attach-'));
const attachStore = await importFrom(tree, 'src/runtime/attachments/store.mjs');
const proxyProvider = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs');
const inlineCases = [];
for (let i = 0; i < 200; i += 1) {
  const messages = [];
  const shape = [];
  for (let m = 0; m < 1 + Math.floor(rnd() * 3); m += 1) {
    const parts = [];
    const sizes = [];
    for (let k = 0; k < Math.floor(rnd() * 4); k += 1) {
      const missing = chance(0.15);
      const size = 1 + Math.floor(rnd() * 60);
      let ref;
      if (missing) ref = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
      else ref = attachStore.storeAttachmentBuffer(Buffer.from(Array.from({ length: size }, () => Math.floor(rnd() * 256)))).attachmentRef;
      parts.push({ type: 'file', attachmentRef: ref, mimeType: 'application/pdf', filename: 'a.pdf', sizeBytes: size });
      sizes.push({ size, missing });
    }
    messages.push({ role: 'user', content: parts });
    shape.push(sizes);
  }
  const maxBytes = pick([10, 40, 100, 400, 100000]);
  const out = proxyProvider.inlineModelProxyAttachments(messages, { maxBytes });
  inlineCases.push({
    maxBytes,
    shape,
    inlined: out.map((m) => m.content.map((p) => !p.attachmentRef && typeof p.data === 'string')),
    bytes: out.map((m) => m.content.map((p) => (typeof p.data === 'string' ? Buffer.from(p.data, 'base64').length : null))),
  });
}

// attachmentTextForPart: the text of a stored text attachment, wrapped when it was a file.
const textCases = [];
for (const text of ['hello', 'line1\nline2', '', 'ünï ✓']) {
  for (const textKind of [undefined, 'file', 'paste']) {
    for (const filename of [undefined, '', 'a.txt', 'we"ird<na\'me>.md']) {
      if (!text) continue;
      const ref = attachStore.storeAttachmentBuffer(Buffer.from(text, 'utf8')).attachmentRef;
      const part = { type: 'text', attachmentRef: ref, ...(textKind ? { textKind } : {}), ...(filename !== undefined ? { filename } : {}) };
      textCases.push({ text, textKind: textKind ?? null, filename: filename ?? null, value: attachStore.attachmentTextForPart(part) });
    }
  }
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'model-proxy-twin.json'), {
  domain: 'model-proxy-twin',
  recorder: 'benchmarks/rust-core/recorders/record-model-proxy.mjs',
  attachmentCases,
  providerConfigCases,
  quotaCases,
  inlineCases,
  textCases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-model-proxy.mjs',
  command: 'node benchmarks/rust-core/recorders/record-model-proxy.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${attachmentCases.length} attachment, ${providerConfigCases.length} providerConfig, ${quotaCases.length} quota, ${inlineCases.length} inline, ${textCases.length} text cases`);

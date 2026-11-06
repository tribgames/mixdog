#!/usr/bin/env node
// Goldens of the session turn actions the Rust core answers itself (WP-SESSION `wu-turn-ops`),
// each from the real Node code that answers them today:
//   secret-slots.json     `createSecretRequests` of apps/desktop/src/main/secret-requests.ts (the one-shot slots
//                         behind `provideSecretInput`) and `requiredString` of ipc-validation.ts
//   staged-originals.json `stageOriginalAttachment` (runtime/attachments/staged-originals.mjs) against a real data dir
//   composer-image.json   `imageProfileForProvider`, `imageMetadataText`, `imageAttachmentFromBuffer`'s thrown texts
//                         and the `resizeImage` / `stageAttachmentOriginal` actions of session-api/media.mjs
//   agent-control.json    `agentControl` of session-runtime/turn/agent-ops.mjs: the context it hands the agent tool
//
// The secret slots load a TypeScript module, so run from apps/desktop with tsx:
//   (cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-turn-ops.mjs --tree <tree>)
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const need = createRequire(join(tree, 'package.json'));
const sharp = need('sharp');
const scratch = mkdtempSync(join(tmpdir(), 'mixdog-turn-ops-'));
process.env.MIXDOG_DATA_DIR = join(scratch, 'data');

const { createSecretRequests } = await importFrom(tree, 'apps/desktop/src/main/secret-requests.ts');
const { requiredString } = await importFrom(tree, 'apps/desktop/src/main/ipc-validation.ts');
const { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } = await importFrom(tree, 'apps/desktop/src/shared/secret-slots.ts');
const { stageOriginalAttachment } = await importFrom(tree, 'src/runtime/attachments/staged-originals.mjs');
const { attachmentFilePath, storeAttachmentBuffer } = await importFrom(tree, 'src/runtime/attachments/store.mjs');
const { imageMetadataText, imageProfileForProvider, resizeImageBuffer } = await importFrom(tree, 'src/runtime/shared/read-image-resize.mjs');
const { imageAttachmentFromBuffer } = await importFrom(tree, 'src/tui/paste-attachments.mjs');
const { createSessionMediaApi } = await importFrom(tree, 'src/tui/session/session-api/media.mjs');
const { createAgentOps } = await importFrom(tree, 'src/session-runtime/turn/agent-ops.mjs');

const outDir = join(FIXTURES_ROOT, 'turn-ops');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const thrown = (error) => ({ name: error?.name, message: String(error?.message) });
const attempt = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: thrown(error) };
  }
};

// ---- secret slots -------------------------------------------------------------------------------
const ID = 'secret_0123456789ab';
const secretCases = [];
{
  const longest = 'x'.repeat(4096);
  const provides = [
    ['runtime-minted id and a value', ID, 'hunter2'],
    ['value of exactly 4096', ID, longest],
    ['value over 4096', ID, `${longest}x`],
    ['astral characters count as two units', ID, '😀'.repeat(2049)],
    ['astral characters within the limit', ID, '😀'.repeat(2048)],
    ['empty value', ID, ''],
    ['id without the prefix', 'not-a-request', 'v'],
    ['id with a short tail', 'secret_short', 'v'],
    ['id with 80 characters', `secret_${'a'.repeat(80)}`, 'v'],
    ['id with 81 characters', `secret_${'a'.repeat(81)}`, 'v'],
    ['id with a forbidden character', 'secret_0123456789_b', 'v'],
    ['id with a trailing newline', `${ID}\n`, 'v'],
  ];
  for (const [name, requestId, value] of provides) {
    const slots = createSecretRequests({});
    const accepted = slots.provide(requestId, value);
    secretCases.push({ name, requestId, value, accepted, held: slots.has(requestId), taken: slots.take(requestId), takenAgain: slots.take(requestId) });
  }
  const slots = createSecretRequests({});
  slots.provide(ID, 'a');
  slots.provide(ID + SECRET_USERNAME_SUFFIX, 'user');
  slots.provide(ID + SECRET_SAVE_SUFFIX, '1');
  const before = [ID, ID + SECRET_USERNAME_SUFFIX, ID + SECRET_SAVE_SUFFIX].map((id) => slots.has(id));
  slots.discard(ID);
  const after = [ID, ID + SECRET_USERNAME_SUFFIX, ID + SECRET_SAVE_SUFFIX].map((id) => slots.has(id));
  secretCases.push({ name: 'discard drops the value, username and save slots', before, after });
  const replaced = createSecretRequests({});
  replaced.provide(ID, 'first');
  replaced.provide(ID, 'second');
  secretCases.push({ name: 'a second value replaces the first', taken: replaced.take(ID) });
  const expiring = createSecretRequests({ timeoutMs: 20 });
  expiring.provide(ID, 'gone');
  await new Promise((resolve) => setTimeout(resolve, 80));
  secretCases.push({ name: 'a value expires after the timeout', timeoutMs: 20, held: expiring.has(ID) });
}
const requiredIds = [' secret_0123456789ab ', '', '   ', 'x'.repeat(120), 'x'.repeat(121), '😀'.repeat(60), '😀'.repeat(61), 42, null].map((value) => ({
  value,
  ...(() => {
    try {
      return { text: requiredString(value, 'secret request id', 120) };
    } catch (error) {
      return { error: thrown(error) };
    }
  })(),
}));

// ---- staged originals ---------------------------------------------------------------------------
const bytesOf = (text) => Buffer.from(text, 'utf8');
const stagedScenarios = [];
async function scenario(name, steps) {
  const dir = join(scratch, `staged-${stagedScenarios.length}`);
  process.env.MIXDOG_DATA_DIR = dir;
  rmSync(dir, { recursive: true, force: true });
  const root = join(dir, 'prompt-attachments');
  const recorded = [];
  const snapshot = () => ({
    index: existsSync(join(root, 'staged-originals.json')) ? readFileSync(join(root, 'staged-originals.json'), 'utf8') : null,
    blobs: existsSync(join(root, 'sha256'))
      ? readdirSync(join(root, 'sha256'), { recursive: true }).map((f) => f.split(/[\\/]/).pop()).filter((f) => /^[0-9a-f]{64}$/.test(f)).sort()
      : [],
    named: existsSync(join(root, 'files')) ? readdirSync(join(root, 'files'), { recursive: true }).map((f) => f.replaceAll('\\', '/')).sort() : [],
  });
  for (const step of steps) {
    const entry = { step };
    if (step.op === 'stage') {
      const options = { now: step.now, ...(step.maxBytes ? { maxBytes: step.maxBytes } : {}), ...(step.ttlMs !== undefined ? { ttlMs: step.ttlMs } : {}) };
      entry.result = await attempt(async () => (await stageOriginalAttachment(step.empty ? Buffer.alloc(0) : bytesOf(step.text), options)).attachmentRef);
    } else if (step.op === 'plantIndex') {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'staged-originals.json'), step.text);
    } else if (step.op === 'plantBlob') {
      storeAttachmentBuffer(bytesOf(step.text));
    } else if (step.op === 'plantNamed') {
      const folder = join(root, 'files', sha(bytesOf(step.text)));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'picked.png'), 'x');
    } else if (step.op === 'dropBlob') {
      rmSync(attachmentFilePath(sha(bytesOf(step.text))), { force: true });
    }
    entry.after = snapshot();
    recorded.push(entry);
  }
  stagedScenarios.push({ name, steps: recorded });
}
const ref = (text) => sha(bytesOf(text));
await scenario('a stage stores the blob and records the entry', [{ op: 'stage', text: 'hello', now: 1000 }]);
await scenario('an empty buffer is refused', [{ op: 'stage', empty: true, now: 1 }]);
await scenario('a buffer over the quota is refused', [{ op: 'stage', text: '12345', now: 1, maxBytes: 4 }]);
await scenario('the oldest entries are evicted to fit the quota', [
  { op: 'stage', text: 'aaaaaa', now: 1, maxBytes: 10 },
  { op: 'stage', text: 'bbbbbb', now: 2, maxBytes: 10 },
  { op: 'stage', text: 'cc', now: 3, maxBytes: 10 },
]);
await scenario('staging the same bytes again refreshes the entry', [
  { op: 'stage', text: 'again', now: 1 },
  { op: 'stage', text: 'again', now: 5 },
]);
await scenario('an expired entry goes with its blob and named copies', [
  { op: 'stage', text: 'old', now: 0, ttlMs: 100 },
  { op: 'plantNamed', text: 'old' },
  { op: 'stage', text: 'new', now: 200, ttlMs: 100 },
  { op: 'stage', text: 'new', now: 301, ttlMs: 100 },
]);
await scenario('an entry exactly at the retention edge is kept', [
  { op: 'stage', text: 'edge', now: 0, ttlMs: 100 },
  { op: 'stage', text: 'other', now: 100, ttlMs: 100 },
]);
await scenario('bytes already stored for a message are not tracked', [
  { op: 'plantBlob', text: 'kept-by-message' },
  { op: 'stage', text: 'kept-by-message', now: 1 },
]);
await scenario('an entry whose blob is gone is dropped', [
  { op: 'stage', text: 'vanishing', now: 1 },
  { op: 'dropBlob', text: 'vanishing' },
  { op: 'stage', text: 'next', now: 2 },
]);
await scenario('a damaged index reads as empty', [
  { op: 'plantIndex', text: 'not json' },
  { op: 'stage', text: 'fresh', now: 1 },
]);
await scenario('a stored entry keeps what else it carries and its odd size', [
  { op: 'plantBlob', text: 'carried' },
  { op: 'plantIndex', text: `[{"ref":"${ref('carried')}","size":"7","at":5,"note":"x"},{"ref":"nothex","size":1},{"ref":"${ref('zero')}","size":0},null]` },
  { op: 'stage', text: 'second', now: 6 },
]);
await scenario('an entry without a time never expires', [
  { op: 'plantBlob', text: 'timeless' },
  { op: 'plantIndex', text: `[{"ref":"${ref('timeless')}","size":8}]` },
  { op: 'stage', text: 'later', now: 1e12, ttlMs: 1 },
]);

// ---- composer image -----------------------------------------------------------------------------
const providers = ['', 'anthropic', 'openai', 'OpenAI', ' openai ', 'openai-codex', 'openai_x', 'xai', 'grok-3', 'deepseek', 'opencode-go', 'mixdog-local', 'mixdog-local-gguf', 'openaix', 'google', 'xaix', 'deepseek-', null];
const profileCases = providers.map((provider) => ({ provider, profile: imageProfileForProvider(provider) }));
const dimsList = [
  null,
  { originalWidth: 100, originalHeight: 50, displayWidth: 100, displayHeight: 50 },
  { originalWidth: 3000, originalHeight: 1500, displayWidth: 1568, displayHeight: 784 },
  { originalWidth: 4000, originalHeight: 3000, displayWidth: 1568, displayHeight: 1176 },
  { originalWidth: 10, originalHeight: 10, displayWidth: 200, displayHeight: 200 },
  { originalWidth: 0, originalHeight: 10, displayWidth: 5, displayHeight: 5 },
  { originalWidth: 1, originalHeight: 1, displayWidth: 3, displayHeight: 3 },
  { originalWidth: 5, originalHeight: 5, displayWidth: 3, displayHeight: 3 },
];
const metadataCases = [];
for (const dims of dimsList) for (const source of ['', 'Pasted image', 'C:\\pics\\a.png']) metadataCases.push({ dims, source, text: imageMetadataText(dims, source) });

const png = (width, height, color = { r: 20, g: 120, b: 220 }) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const images = {
  tiny: await png(3, 3),
  wide: await png(3000, 1500),
  fits: await png(400, 300),
  junk: Buffer.from('this is not an image'),
};
const dataOf = (buffer) => buffer.toString('base64');
// A payload too big to keep is recorded as its repeated character and length.
const shown = (input) => (input.data && input.data.length > 1_000_000 ? { ...input, data: { repeat: input.data[0], count: input.data.length } } : input);
const resizeCases = [];
const state = { provider: '' };
const media = createSessionMediaApi({ runtime: {}, getState: () => ({}), set() {}, pushNotice() {}, setProgressHint() {}, routeState: () => ({ provider: state.provider }) });
async function resizeCase(name, provider, input, bytes, ext) {
  state.provider = provider;
  process.env.MIXDOG_DATA_DIR = join(scratch, `resize-${resizeCases.length}`);
  const direct = bytes ? await attempt(async () => {
    const resized = await resizeImageBuffer(bytes, ext, { profile: imageProfileForProvider(provider) });
    return resized && { data: resized.data, mimeType: resized.mimeType, dimensions: resized.dimensions };
  }) : null;
  const answer = await attempt(() => media.resizeImage(input));
  resizeCases.push({ name, provider, input: shown(input), ext, resizer: direct, answer });
}
await resizeCase('a small image is scaled up and its original is staged', 'anthropic', { data: dataOf(images.tiny), mimeType: 'image/png', filename: 'tiny.png' }, images.tiny, 'png');
await resizeCase('a wide image is scaled down under the anthropic profile', 'anthropic', { data: dataOf(images.wide), mimeType: 'image/png', filename: 'wide.png' }, images.wide, 'png');
await resizeCase('the openai profile bounds the same image differently', 'openai', { data: dataOf(images.wide), mimeType: 'image/png', filename: 'wide.png' }, images.wide, 'png');
await resizeCase('the filename and mime default when absent', '', { data: dataOf(images.tiny) }, images.tiny, 'png');
await resizeCase('a null mime and filename default like absent ones', 'openai-codex', { data: dataOf(images.tiny), mimeType: null, filename: null }, images.tiny, 'png');
await resizeCase('an image that already fits answers its own bytes', 'anthropic', { data: dataOf(images.fits), mimeType: 'image/png', filename: 'fits.png' }, images.fits, 'png');
await resizeCase('undecodable bytes carry the decoder text', 'anthropic', { data: dataOf(images.junk), mimeType: 'image/png', filename: 'junk.png' }, images.junk, 'png');
await resizeCase('a missing payload is refused', 'anthropic', {}, null, '');
await resizeCase('an empty payload is refused', 'anthropic', { data: '' }, null, '');
await resizeCase('a payload over the limit is refused', 'anthropic', { data: 'A'.repeat(40_000_001) }, null, '');
await resizeCase('a payload that decodes to nothing is refused', 'anthropic', { data: '!!!!' }, null, '');
state.provider = '';

const stageCases = [];
for (const [name, input] of [
  ['bytes are staged', { data: Buffer.from('picked file').toString('base64') }],
  ['no payload', {}],
  ['an empty payload', { data: '' }],
  ['a payload over the limit', { data: 'A'.repeat(40_000_001) }],
  ['a payload that decodes to nothing', { data: '!!!!' }],
]) {
  process.env.MIXDOG_DATA_DIR = join(scratch, `stage-action-${stageCases.length}`);
  stageCases.push({ name, input: shown(input), answer: await attempt(() => media.stageAttachmentOriginal(input)) });
}

// ---- agent control ------------------------------------------------------------------------------
const controlCases = [];
for (const [name, session, cwd] of [
  ['a session with a host pid', { id: 's1', clientHostPid: 4321 }, 'C:\\work\\app'],
  ['a session without a host pid', { id: 's2' }, '/work/app'],
  ['a zero host pid reads as none', { id: 's3', clientHostPid: 0 }, '/w'],
]) {
  let context;
  const ops = createAgentOps({
    getSession: () => session,
    getCurrentCwd: () => cwd,
    notifyFnForSession: () => undefined,
    agentTool: {
      execute: (args, ctx) => {
        context = ctx;
        return 'ran';
      },
    },
  });
  const result = ops.agentControl({ action: 'list' });
  controlCases.push({ name, session, cwd, args: { action: 'list' }, result, context: { callerCwd: context.callerCwd, invocationSource: context.invocationSource, callerSessionId: context.callerSessionId, clientHostPid: context.clientHostPid === process.pid ? 'process.pid' : context.clientHostPid } });
}

const stage = stageSet(outDir);
writeJson(join(stage, 'secret-slots.json'), { cases: secretCases, requiredIds, suffixes: { username: SECRET_USERNAME_SUFFIX, save: SECRET_SAVE_SUFFIX } });
writeJson(join(stage, 'staged-originals.json'), stagedScenarios);
writeJson(join(stage, 'composer-image.json'), { profiles: profileCases, metadata: metadataCases, resize: resizeCases, stage: stageCases });
writeJson(join(stage, 'agent-control.json'), controlCases);
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'turn-ops',
  recorder: 'benchmarks/rust-core/recorders/record-turn-ops.mjs',
  command: '(cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-turn-ops.mjs --tree <tree>)',
  identityTree: tree,
});
rmSync(scratch, { recursive: true, force: true });
console.log(`recorded ${secretCases.length} secret, ${stagedScenarios.length} staged-original, ${resizeCases.length} resize, ${controlCases.length} agent-control cases`);
process.exit(0);

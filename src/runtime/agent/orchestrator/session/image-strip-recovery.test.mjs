import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import {
  IMAGE_STRIP_PLACEHOLDER,
  confirmedImageRejection,
  isImageProcessingError,
  isLikelyImageBodyRejected,
  persistsConfirmedImageRejection,
  promptHasInlineImages,
  shouldStripImagesForRetry,
  stripFailingImage,
  stripInlineImages,
  stripInlineImagesFromLatestTurn,
} from './image-strip-recovery.mjs';
import { isRetryableStreamErrorEvent } from '../providers/retry-classifier.mjs';

function imageParts(messages) {
  return messages.flatMap((message) => {
    let content = [];
    if (Array.isArray(message?.content)) content = message.content;
    else if (Array.isArray(message?.content?.content)) content = message.content.content;
    return content.filter((part) => part?.type === 'image');
  });
}

test('strips user image parts to the Grok Build placeholder', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', mimeType: 'image/png', attachmentRef: 'abc' },
      ],
    },
  ];
  assert.equal(promptHasInlineImages(messages), true);
  const { messages: next, stripped } = stripInlineImages(messages);
  assert.equal(stripped, 1);
  assert.equal(next[1].content[1].text, IMAGE_STRIP_PLACEHOLDER);
  assert.equal(messages[1].content[1].type, 'image');
});

test('strips wrapped tool-result images and counts unique payloads', () => {
  const messages = [
    {
      role: 'tool',
      content: {
        content: [
          { type: 'text', text: 'preview' },
          { type: 'image', data: 'broken', mimeType: 'image/png' },
        ],
      },
    },
  ];
  assert.equal(promptHasInlineImages(messages), true);
  const { messages: next, stripped, uniqueImages } = stripInlineImages(messages);
  assert.equal(stripped, 1);
  assert.equal(uniqueImages, 1);
  assert.equal(next[0].content.content[1].text, IMAGE_STRIP_PLACEHOLDER);
});

test('image processing 413/400 phrase/invalid_image trigger strip', () => {
  assert.equal(isImageProcessingError({ status: 413 }), true);
  assert.equal(
    isImageProcessingError({
      httpStatus: 400,
      message: 'Could not process image: bad format',
    }),
    true
  );
  assert.equal(
    isImageProcessingError({
      httpStatus: 500,
      providerErrorCode: 'invalid_image',
    }),
    true
  );
  const openAIInvalid = {
    httpStatus: 400,
    message: 'The image data you provided does not represent a valid image. Please check your input and try again.',
  };
  assert.equal(isImageProcessingError(openAIInvalid), true);
  assert.equal(confirmedImageRejection(openAIInvalid), true);
  assert.equal(isImageProcessingError({ httpStatus: 400, message: 'bad json' }), false);
  assert.equal(isLikelyImageBodyRejected({ code: 'ECONNRESET' }), true);
  assert.equal(shouldStripImagesForRetry({ status: 413 }, { hasImages: true }), true);
  assert.equal(shouldStripImagesForRetry({ status: 413 }, { hasImages: false }), false);
  assert.equal(shouldStripImagesForRetry({ status: 413 }, { hasImages: true, alreadyStripped: true }), false);
});

test('confirmed rejection persistently removes only one newly introduced image', () => {
  const err = {
    httpStatus: 400,
    message: 'The image data you provided does not represent a valid image.',
  };
  const oldImage = { type: 'image', data: 'old', mimeType: 'image/png' };
  const badImage = { type: 'image', data: 'bad', mimeType: 'image/png' };
  const messages = [
    { role: 'user', content: [oldImage] },
    { role: 'assistant', content: 'seen' },
    { role: 'user', content: [{ type: 'text', text: 'next' }, badImage] },
  ];
  const tail = stripInlineImagesFromLatestTurn(messages);
  assert.equal(persistsConfirmedImageRejection(err, tail), true);
  const persisted = stripInlineImages(messages, { ids: new Set(tail.imageIds) }).messages;
  assert.equal(persisted[0].content[0].type, 'image');
  assert.equal(persisted[2].content[1].text, IMAGE_STRIP_PLACEHOLDER);

  const ambiguous = [
    ...messages.slice(0, 2),
    {
      role: 'user',
      content: [badImage, { type: 'image', data: 'other', mimeType: 'image/png' }],
    },
  ];
  assert.equal(persistsConfirmedImageRejection(err, stripInlineImagesFromLatestTurn(ambiguous)), false);
});

test('image retry projection preserves images from already-sent turns', () => {
  const oldImage = { type: 'image', data: 'old', mimeType: 'image/png' };
  const newImage = { type: 'image', data: 'new', mimeType: 'image/png' };
  const messages = [
    { role: 'user', content: [oldImage] },
    { role: 'assistant', content: 'seen' },
    { role: 'user', content: [newImage] },
  ];
  const projected = stripInlineImagesFromLatestTurn(messages);
  assert.equal(projected.stripped, 1);
  assert.equal(projected.messages[0].content[0].type, 'image');
  assert.equal(projected.messages[2].content[0].text, IMAGE_STRIP_PLACEHOLDER);
});

test('agent loop heals one rejected tail image and the next turn stays usable', async () => {
  const tools = [{ name: 'read', inputSchema: { type: 'object', properties: {} } }];
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: [{ type: 'image', data: 'old-valid', mimeType: 'image/png' }] },
    { role: 'assistant', content: 'seen' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'image', data: 'new-bad', mimeType: 'image/png' },
      ],
    },
  ];
  let calls = 0;
  const provider = {
    async send(sentMessages) {
      calls += 1;
      if (calls === 1) {
        assert.equal(imageParts(sentMessages).length, 2);
        throw Object.assign(
          new Error(
            'The image data you provided does not represent a valid image. Please check your input and try again.'
          ),
          { httpStatus: 400 }
        );
      }
      assert.deepEqual(
        imageParts(sentMessages).map((part) => part.data),
        ['old-valid'],
        'retry must preserve cached images and omit only the rejected turn image'
      );
      return { content: 'recovered', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const session = {
    id: 'image-strip-loop-test',
    owner: 'cli',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
  };
  const first = await agentLoop(provider, messages, 'fake-model', tools, null, process.cwd(), {
    session,
    sessionId: session.id,
  });
  assert.equal(first.content, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(
    imageParts(messages).map((part) => part.data),
    ['old-valid']
  );

  messages.push({ role: 'user', content: 'next turn' });
  let nextCalls = 0;
  const next = await agentLoop(
    {
      async send(sentMessages) {
        nextCalls += 1;
        assert.deepEqual(
          imageParts(sentMessages).map((part) => part.data),
          ['old-valid']
        );
        return { content: 'still usable', toolCalls: [], stopReason: 'end_turn' };
      },
    },
    messages,
    'fake-model',
    tools,
    null,
    process.cwd(),
    { session, sessionId: session.id }
  );
  assert.equal(next.content, 'still usable');
  assert.equal(nextCalls, 1);
});

test('an image-strip retry that still overflows re-sends the compacted transcript', async (t) => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-image-strip-compact-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const tools = [{ name: 'read', inputSchema: { type: 'object', properties: {} } }];
  const toolTurn = (id, label) => [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: '{}' }] },
    {
      role: 'tool',
      toolCallId: id,
      content: [
        { type: 'text', text: `${label} screen` },
        { type: 'image', data: `${label}${'A'.repeat(200_000)}`, mimeType: 'image/png' },
      ],
    },
  ];
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'inspect both screens' },
    ...toolTurn('call-old', 'OLD'),
    ...toolTurn('call-new', 'NEW'),
  ];
  const sentImages = [];
  const provider = {
    async send(sentMessages) {
      sentImages.push(imageParts(sentMessages).map((part) => part.data.slice(0, 3)));
      if (sentImages.length < 3) {
        throw Object.assign(new Error('Request exceeds the maximum allowed size of 32 MB'), { httpStatus: 413 });
      }
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const session = {
    id: 'image-strip-compact-test',
    owner: 'cli',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: true },
  };
  const result = await agentLoop(provider, messages, 'fake-model', tools, null, process.cwd(), {
    session,
    sessionId: session.id,
  });
  assert.equal(result.content, 'done');
  // The full request, the latest-turn strip, then the transcript compaction
  // rebuilt — never the strip of the pre-compaction history again.
  assert.deepEqual(sentImages, [['OLD', 'NEW'], ['OLD'], []]);
});

test('agent loop keeps provider tool snapshots turn-local', async () => {
  const oldTool = {
    name: 'shell',
    description: 'old schema',
    inputSchema: { type: 'object', properties: { retired: { type: 'boolean' } } },
  };
  const currentTool = {
    name: 'shell',
    description: 'current schema',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  };
  const nextTool = {
    name: 'shell',
    description: 'next schema',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } } },
  };
  const sentToolDescriptions = [];
  const provider = {
    async send(_messages, _model, tools) {
      sentToolDescriptions.push(tools?.[0]?.description);
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const session = {
    id: 'provider-tool-snapshot-lifetime-test',
    owner: 'cli',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    _providerToolSurfaceSnapshot: [oldTool],
  };
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first turn' },
  ];

  await agentLoop(provider, messages, 'fake-model', [currentTool], null, process.cwd(), {
    session,
    sessionId: session.id,
  });
  assert.equal(Object.hasOwn(session, '_providerToolSurfaceSnapshot'), false);

  messages.push({ role: 'user', content: 'next turn' });
  await agentLoop(provider, messages, 'fake-model', [nextTool], null, process.cwd(), {
    session,
    sessionId: session.id,
  });

  assert.deepEqual(sentToolDescriptions, ['current schema', 'next schema']);
});

test('mid-stream xAI generation crash is retryable even as invalid_request_error', () => {
  const err = new Error('xAI Responses stream error: Internal error during token generation');
  err.providerWireError = true;
  err.providerErrorCode = 'invalid_request_error';
  err.providerError = { type: 'invalid_request_error', message: 'Internal error during token generation' };
  assert.equal(isRetryableStreamErrorEvent(err), true);

  const typed400 = new Error('bad request');
  typed400.providerWireError = true;
  typed400.httpStatus = 400;
  typed400.providerErrorCode = 'invalid_request_error';
  assert.equal(isRetryableStreamErrorEvent(typed400), false);

  const quota = new Error('quota');
  quota.providerWireError = true;
  quota.providerErrorCode = 'insufficient_quota';
  assert.equal(isRetryableStreamErrorEvent(quota), false);
});

test('a failing image named by a preparation error: latest turn is stripped and persisted, an older one is not persisted, a runtime error strips nothing', async () => {
  const { AnthropicImagePreparationError, AnthropicImageRuntimeError } = await import('../providers/lib/anthropic-image-input.mjs');
  const oldImage = { type: 'image', data: 'old', mimeType: 'image/png' };
  const newImage = { type: 'image', data: 'new', mimeType: 'image/png' };
  const messages = [
    { role: 'user', content: [oldImage] },
    { role: 'assistant', content: 'seen' },
    { role: 'user', content: [{ type: 'text', text: 'next' }, newImage] },
  ];
  const latest = new AnthropicImagePreparationError('messages.2.content.1', 'bad', undefined, 'new');
  const strip = stripFailingImage(messages, latest);
  assert.equal(strip.stripped, 1);
  assert.equal(strip.messages[2].content[1].text, IMAGE_STRIP_PLACEHOLDER);
  assert.equal(strip.messages[0].content[0].type, 'image');
  assert.equal(persistsConfirmedImageRejection(latest, strip), true);

  const older = new AnthropicImagePreparationError('messages.0.content.0', 'bad', undefined, 'old');
  const olderStrip = stripFailingImage(messages, older);
  assert.equal(olderStrip.stripped, 1);
  assert.equal(olderStrip.messages[0].content[0].text, IMAGE_STRIP_PLACEHOLDER);
  assert.equal(olderStrip.messages[2].content[1].type, 'image');
  assert.equal(persistsConfirmedImageRejection(older, olderStrip), false);

  // A reloaded history holds the store's content address instead of base64.
  const { createHash } = await import('node:crypto');
  const attachmentRef = createHash('sha256').update(Buffer.from('new', 'base64')).digest('hex');
  const reloaded = [
    messages[0],
    messages[1],
    { role: 'user', content: [{ type: 'text', text: 'next' }, { type: 'image', attachmentRef, mimeType: 'image/png' }] },
  ];
  const refStrip = stripFailingImage(reloaded, latest);
  assert.equal(refStrip.stripped, 1);
  assert.equal(refStrip.messages[2].content[1].text, IMAGE_STRIP_PLACEHOLDER);
  assert.equal(persistsConfirmedImageRejection(latest, refStrip), true);

  const runtime = new AnthropicImageRuntimeError('messages.2.content.1');
  assert.equal(confirmedImageRejection(runtime), false);
  assert.equal(isImageProcessingError(runtime), false);
  assert.equal(stripFailingImage(messages, runtime).stripped, 0);
});

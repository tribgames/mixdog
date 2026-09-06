import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
    prepareAnthropicImages,
    AnthropicImagePreparationError,
} from './lib/anthropic-image-input.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-images-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
const previousProxy = process.env.HTTPS_PROXY;
process.env.MIXDOG_DATA_DIR = dataDir;
// Prevent the OAuth socket prewarm from contacting a live endpoint.
process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
const { AnthropicOAuthProvider } = await import('./anthropic-oauth.mjs');
const { AnthropicProvider } = await import('./anthropic.mjs');
const { materializePromptSubmission, readAttachmentBase64 } = await import('../../../attachments/store.mjs');
const { normalizeContentForOpenAIResponses } = await import('./media-normalization.mjs');

test.after(async () => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousProxy;
    await rm(dataDir, { recursive: true, force: true });
});

async function png(width, height) {
    return (await sharp({
        create: { width, height, channels: 4, background: { r: 30, g: 70, b: 110, alpha: 0.5 } },
    }).png().toBuffer()).toString('base64');
}

function image(data, extra = {}) {
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data }, ...extra };
}

function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
}

function imagesIn(messages) {
    const images = [];
    function content(parts) {
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
            if (part.type === 'image' && part.source?.type === 'base64') images.push(part);
            if (part.type === 'tool_result') content(part.content);
        }
    }
    messages.forEach((message) => content(message.content));
    return images;
}

function reply() {
    return new Response([
        { type: 'message_start', message: { id: 'msg_images', model: 'claude-fable-5-1', role: 'assistant', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
    });
}

function sender(kind, bodies) {
    const oauth = kind === 'anthropic-oauth';
    const provider = Object.assign(Object.create(
        oauth ? AnthropicOAuthProvider.prototype : AnthropicProvider.prototype,
    ), {
        name: kind,
        config: {},
        fastModeBetaHeaderLatched: false,
        ensureAuth: async () => ({ accessToken: 'test-images-token' }),
        scrubTokens: (text) => String(text || ''),
        client: { messages: { create(params) {
            bodies.push(params);
            return { asResponse: async () => reply() };
        } } },
    });
    return (messages) => provider.send(messages, 'claude-fable-5-1', [], oauth ? {
        _doRequestFn: async (_token, _signal, body) => {
            bodies.push(body);
            return { response: reply(), controller: new AbortController(), cancelHandler: null };
        },
    } : {});
}

for (const kind of ['anthropic', 'anthropic-oauth']) {
    test(`${kind} sends safe images from attachments, nested tools, and error screenshots without changing history`, async () => {
        const wide = await png(2400, 600);
        const tall = await png(500, 2400);
        const intake = materializePromptSubmission([{ type: 'image', data: wide, mimeType: 'image/png' }], {});
        const attachment = intake.prompt[0];
        const history = [
            { role: 'user', content: [
                attachment,
                ...Array.from({ length: 9 }, () => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${wide}` } })),
            ] },
            { role: 'assistant', content: '', toolCalls: [
                { id: 'shot', name: 'read', arguments: { file_path: 'shot.png' } },
                { id: 'failed', name: 'read', arguments: { file_path: 'failed.png' } },
            ] },
            { role: 'tool', toolCallId: 'shot', content: { content: [
                { type: 'text', text: 'Screenshot coordinates refer to the original image.' },
                ...Array.from({ length: 11 }, () => ({ type: 'image', data: tall, mimeType: 'image/png' })),
            ] } },
            { role: 'tool', toolCallId: 'failed', toolKind: 'error', content: { content: [
                { type: 'text', text: 'Error: target not found' },
                { type: 'image', data: wide, mimeType: 'image/png' },
            ] } },
            { role: 'user', content: 'try again' },
        ];
        const before = JSON.stringify(history);
        const bodies = [];
        await sender(kind, bodies)(history);
        assert.equal(bodies.length, 1);
        const sent = imagesIn(bodies[0].messages);
        assert.equal(sent.length, 22, 'no screenshot is dropped to satisfy the many-image limit');
        for (const part of sent) {
            const metadata = await sharp(Buffer.from(part.source.data, 'base64')).metadata();
            assert.ok(metadata.width <= 2000 && metadata.height <= 2000);
            assert.ok(part.source.data.length <= 5 * 1024 * 1024);
        }
        assert.equal(JSON.stringify(history), before);
        assert.equal(readAttachmentBase64(attachment), wide, 'stored original remains recoverable');
        // Preparing an Anthropic request must not replace shared bytes used by
        // a later OpenAI request on the same conversation.
        const openai = normalizeContentForOpenAIResponses([attachment]);
        assert.equal(openai[0].image_url, `data:image/png;base64,${wide}`);
    });

    test(`${kind} rejects a corrupt historical image before any request and keeps the original`, async () => {
        const history = [{ role: 'user', content: [image(Buffer.from('not an image').toString('base64'))] }];
        const before = JSON.stringify(history);
        const bodies = [];
        await assert.rejects(sender(kind, bodies)(history), (error) => {
            assert.ok(error instanceof AnthropicImagePreparationError);
            assert.equal(error.status, 400);
            assert.match(error.message, /messages\.0\.content\.0/);
            return true;
        });
        assert.equal(bodies.length, 0);
        assert.equal(JSON.stringify(history), before);
    });
}

test('crossing 20 images preserves earlier renditions, signatures, cache markers, and coordinate notices', async () => {
    const original = await png(2400, 1200);
    const thinking = { type: 'thinking', thinking: 'signed plan', signature: 'signed-by-provider' };
    const marker = { type: 'ephemeral', ttl: '1h' };
    const history = freeze([
        { role: 'assistant', content: [thinking, { type: 'text', text: 'inspect' }] },
        { role: 'user', content: Array.from({ length: 20 }, () => image(original, { cache_control: marker })) },
    ]);
    const first = await prepareAnthropicImages(history);
    const second = await prepareAnthropicImages([...history, { role: 'user', content: [image(original)] }]);
    assert.deepEqual(second.slice(0, first.length), first);
    assert.equal(first[0], history[0]);
    assert.equal(first[0].content[0], thinking);
    assert.equal(imagesIn(second).length, 21);
    for (const part of imagesIn(first)) assert.deepEqual(part.cache_control, marker);
    assert.match(first[1].content[0].text, /2400x1200, displayed at 2000x1000/);
    assert.equal(history[1].content[0].source.data, original);
    assert.equal(await prepareAnthropicImages(first), first, 'preparation is idempotent');
});

test('valid boundary pixels, remote references, PDF bytes and opaque tool input are not rewritten', async () => {
    const original = await png(2000, 1);
    const history = freeze([{ role: 'user', content: [
        image(original),
        { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
        { type: 'image', source: { type: 'file', file_id: 'file_image' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
        { type: 'tool_use', id: 'opaque', name: 'example', input: { content: [image('opaque')] } },
    ] }]);
    assert.equal(await prepareAnthropicImages(history), history);
});

test('empty and oversized image inputs fail locally with a recoverable preparation error', async () => {
    for (const data of ['', 'A'.repeat(Math.ceil(64 * 1024 * 1024 / 3) * 4 + 1)]) {
        await assert.rejects(
            prepareAnthropicImages([{ role: 'user', content: [image(data)] }]),
            (error) => error.code === 'ANTHROPIC_IMAGE_PREPARATION_FAILED' && error.status === 400,
        );
    }
});

test('cancelled image preparation respects the caller abort without rewriting history', async () => {
    const history = freeze([{ role: 'user', content: [image('not-decoded')] }]);
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    controller.abort(reason);
    await assert.rejects(prepareAnthropicImages(history, { signal: controller.signal }), (error) => error === reason);
});

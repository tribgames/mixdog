import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import {
    IMAGE_STRIP_PLACEHOLDER,
    confirmedImageRejection,
    isImageProcessingError,
    isLikelyImageBodyRejected,
    persistenceMessagesForConfirmedImageRejection,
    promptHasInlineImages,
    shouldStripImagesForRetry,
    stripInlineImages,
} from './image-strip-recovery.mjs';
import { isRetryableStreamErrorEvent } from '../providers/retry-classifier.mjs';

test('strips user image parts to the Grok Build placeholder', () => {
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', mimeType: 'image/png', attachmentRef: 'abc' },
        ] },
    ];
    assert.equal(promptHasInlineImages(messages), true);
    const { messages: next, stripped } = stripInlineImages(messages);
    assert.equal(stripped, 1);
    assert.equal(next[1].content[1].text, IMAGE_STRIP_PLACEHOLDER);
    assert.equal(messages[1].content[1].type, 'image');
});

test('strips wrapped tool-result images and counts unique payloads', () => {
    const messages = [{
        role: 'tool',
        content: {
            content: [
                { type: 'text', text: 'preview' },
                { type: 'image', data: 'broken', mimeType: 'image/png' },
            ],
        },
    }];
    assert.equal(promptHasInlineImages(messages), true);
    const { messages: next, stripped, uniqueImages } = stripInlineImages(messages);
    assert.equal(stripped, 1);
    assert.equal(uniqueImages, 1);
    assert.equal(next[0].content.content[1].text, IMAGE_STRIP_PLACEHOLDER);
});

test('image processing 413/400 phrase/invalid_image trigger strip', () => {
    assert.equal(isImageProcessingError({ status: 413 }), true);
    assert.equal(isImageProcessingError({
        httpStatus: 400,
        message: 'Could not process image: bad format',
    }), true);
    assert.equal(isImageProcessingError({
        httpStatus: 500,
        providerErrorCode: 'invalid_image',
    }), true);
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
    const persisted = persistenceMessagesForConfirmedImageRejection(err, messages);
    assert.ok(persisted);
    assert.equal(persisted[0].content[0].type, 'image');
    assert.equal(persisted[2].content[1].text, IMAGE_STRIP_PLACEHOLDER);

    const ambiguous = [...messages.slice(0, 2), {
        role: 'user',
        content: [badImage, { type: 'image', data: 'other', mimeType: 'image/png' }],
    }];
    assert.equal(persistenceMessagesForConfirmedImageRejection(err, ambiguous), null);
});

test('agent loop heals one rejected tail image and the next turn stays usable', async () => {
    const imageParts = (messages) => messages.flatMap((message) => {
        const content = Array.isArray(message?.content)
            ? message.content
            : (Array.isArray(message?.content?.content) ? message.content.content : []);
        return content.filter((part) => part?.type === 'image');
    });
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: [{ type: 'image', data: 'old-valid', mimeType: 'image/png' }] },
        { role: 'assistant', content: 'seen' },
        { role: 'user', content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', data: 'new-bad', mimeType: 'image/png' },
        ] },
    ];
    let calls = 0;
    const provider = {
        async send(sentMessages) {
            calls += 1;
            if (calls === 1) {
                assert.equal(imageParts(sentMessages).length, 2);
                throw Object.assign(
                    new Error('The image data you provided does not represent a valid image. Please check your input and try again.'),
                    { httpStatus: 400 },
                );
            }
            assert.equal(imageParts(sentMessages).length, 0, 'retry must omit request images');
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
    const first = await agentLoop(
        provider,
        messages,
        'fake-model',
        [],
        null,
        process.cwd(),
        { session, sessionId: session.id },
    );
    assert.equal(first.content, 'recovered');
    assert.equal(calls, 2);
    assert.deepEqual(imageParts(messages).map((part) => part.data), ['old-valid']);

    messages.push({ role: 'user', content: 'next turn' });
    let nextCalls = 0;
    const next = await agentLoop(
        {
            async send(sentMessages) {
                nextCalls += 1;
                assert.deepEqual(imageParts(sentMessages).map((part) => part.data), ['old-valid']);
                return { content: 'still usable', toolCalls: [], stopReason: 'end_turn' };
            },
        },
        messages,
        'fake-model',
        [],
        null,
        process.cwd(),
        { session, sessionId: session.id },
    );
    assert.equal(next.content, 'still usable');
    assert.equal(nextCalls, 1);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    IMAGE_STRIP_PLACEHOLDER,
    isImageProcessingError,
    isLikelyImageBodyRejected,
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
    assert.equal(isImageProcessingError({ httpStatus: 400, message: 'bad json' }), false);
    assert.equal(isLikelyImageBodyRejected({ code: 'ECONNRESET' }), true);
    assert.equal(shouldStripImagesForRetry({ status: 413 }, { hasImages: true }), true);
    assert.equal(shouldStripImagesForRetry({ status: 413 }, { hasImages: false }), false);
    assert.equal(shouldStripImagesForRetry({ status: 413 }, { hasImages: true, alreadyStripped: true }), false);
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

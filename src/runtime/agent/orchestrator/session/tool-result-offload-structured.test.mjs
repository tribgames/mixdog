import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    maybeOffloadToolResult,
    maybeOffloadToolResultBatch,
} from './tool-result-offload.mjs';

function withDataDir(name, run) {
    const original = process.env.MIXDOG_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), `mixdog-${name}-`));
    process.env.MIXDOG_DATA_DIR = dataDir;
    return Promise.resolve(run(dataDir)).finally(() => {
        if (original === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = original;
        rmSync(dataDir, { recursive: true, force: true });
    });
}

const image = (data) => ({ type: 'image', data, mimeType: 'image/png' });

test('structured result offloads its oversized text part and keeps every image part', async () => {
    await withDataDir('structured-offload', async () => {
        const body = `{"slides":[${'"shape",'.repeat(20_000)}"end"]}`;
        const result = {
            content: [
                { type: 'text', text: body },
                image('first'),
                image('second'),
            ],
            isError: false,
        };

        const offloaded = await maybeOffloadToolResult('sess-structured', 'call-1', 'office', result);

        assert.notEqual(offloaded, result, 'returns a new object rather than mutating the result');
        assert.deepEqual(result.content[0].text, body, 'input is never mutated');
        assert.equal(offloaded.isError, false, 'other envelope fields survive');
        assert.equal(offloaded.content.length, 3);
        assert.deepEqual(offloaded.content.slice(1), [image('first'), image('second')]);

        const text = offloaded.content[0].text;
        assert.match(text, /^\[tool output offloaded: office → /);
        assert.ok(text.length < body.length / 10, 'the part is materially smaller than the body');

        const path = text.match(/→ (.+?) \(/)?.[1];
        assert.ok(path);
        assert.equal(readFileSync(path, 'utf8'), body, 'the artifact holds the exact bytes');
        assert.match(text, new RegExp(`sha256 ${createHash('sha256').update(body).digest('hex')}`));
    });
});

test('structured result under the tool budget is returned untouched', async () => {
    await withDataDir('structured-small', async () => {
        const result = { content: [{ type: 'text', text: 'ok' }, image('shot')] };
        assert.equal(
            await maybeOffloadToolResult('sess-small', 'call-2', 'office', result),
            result,
        );
    });
});

test('text parts too small to beat their own pointer stay inline', async () => {
    await withDataDir('structured-floor', async () => {
        const parts = Array.from({ length: 40 }, () => ({ type: 'text', text: 'x'.repeat(1_500) }));
        const result = { content: [...parts, image('shot')] };
        assert.equal(
            await maybeOffloadToolResult('sess-floor', 'call-3', 'office', result),
            result,
            'aggregate text is over the budget but no single part pays for a pointer',
        );
    });
});

test('the per-message budget counts structured text and reduces it', async () => {
    await withDataDir('structured-aggregate', async () => {
        const body = 'y'.repeat(40_000);
        const structured = { content: [{ type: 'text', text: body }, image('shot')] };
        const states = await maybeOffloadToolResultBatch(
            'sess-aggregate',
            [
                { toolCallId: 'call-4', toolName: 'office', result: structured },
                { toolCallId: 'call-5', toolName: 'grep', result: 'small' },
            ],
            { applyPerToolLimits: false, maxAggregateChars: 10_000 },
        );

        assert.equal(states[0].error, null);
        assert.match(states[0].result.content[0].text, /^\[tool output offloaded: office → /);
        assert.deepEqual(states[0].result.content[1], image('shot'));
        assert.equal(states[1].result, 'small', 'a result inside the budget is left alone');
    });
});

test('a non-structured object result is still returned as-is', async () => {
    await withDataDir('structured-other', async () => {
        const result = { ok: true, pages: 7 };
        assert.equal(
            await maybeOffloadToolResult('sess-other', 'call-6', 'office', result),
            result,
        );
    });
});

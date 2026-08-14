import assert from 'node:assert/strict';
import test from 'node:test';
import { toAnthropicMessages } from './anthropic-messages.mjs';
import { toGeminiContents } from './gemini-schema.mjs';
import { toOpenAIMessages, toXaiResponsesInput } from './openai-compat-wire.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-payload.mjs';

const IMAGE_DATA = 'AAECAw==';

function mixedImageContent(text = 'Image read successfully') {
    return {
        content: [
            { type: 'text', text },
            { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
        ],
    };
}

function imageHistory(content = mixedImageContent()) {
    return [
        { role: 'user', content: 'inspect the image' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'read', arguments: { file_path: 'shot.png' } }],
        },
        { role: 'tool', toolCallId: 'call_1', toolKind: 'normal', content },
    ];
}

function occurrences(value, needle) {
    return JSON.stringify(value).split(needle).length - 1;
}

test('OpenAI Responses keeps text, image, and file in one function output', () => {
    const content = mixedImageContent();
    content.content.push({
        type: 'file',
        data: 'JVBERi0xLjQ=',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
    });
    const history = imageHistory(content);
    const before = JSON.stringify(history);
    const input = convertMessagesToResponsesInput(history);
    const output = input.find((item) => item.type === 'function_call_output')?.output;
    assert.deepEqual(output, [
        { type: 'input_text', text: 'Image read successfully' },
        { type: 'input_image', image_url: `data:image/png;base64,${IMAGE_DATA}` },
        {
            type: 'input_file',
            filename: 'report.pdf',
            file_data: 'data:application/pdf;base64,JVBERi0xLjQ=',
        },
    ]);
    assert.equal(input.filter((item) => item?.role === 'user').length, 1);
    assert.equal(occurrences(input, 'Image read successfully'), 1);
    assert.equal(JSON.stringify(history), before);
});

test('OpenAI Chat-compatible sends tool text once and media-only user content', () => {
    const history = imageHistory();
    const messages = toOpenAIMessages(history, 'openai');
    const tool = messages.find((message) => message.role === 'tool');
    const media = messages.filter((message) => message.role === 'user').at(-1);
    assert.equal(tool.content, 'Image read successfully');
    assert.deepEqual(media.content, [{
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${IMAGE_DATA}` },
    }]);
    assert.equal(occurrences(messages, 'Image read successfully'), 1);
});

test('xAI Responses keeps text output and sends image-only user content', () => {
    const history = imageHistory();
    const { input } = toXaiResponsesInput(history, {
        xaiResponses: { previousResponseId: 'resp_1', seenMessageCount: 0, model: 'grok-4' },
    }, { model: 'grok-4' });
    const tool = input.find((item) => item.type === 'function_call_output');
    const media = input.filter((item) => item?.role === 'user').at(-1);
    assert.equal(tool.output, 'Image read successfully');
    assert.deepEqual(media.content, [{
        type: 'input_image',
        image_url: `data:image/png;base64,${IMAGE_DATA}`,
    }]);
    assert.equal(occurrences(input, 'Image read successfully'), 1);
});

test('Anthropic retains one structured tool_result with text and image', () => {
    const history = imageHistory();
    const messages = toAnthropicMessages(history);
    const toolResult = messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((part) => part?.type === 'tool_result');
    assert.equal(toolResult.content[0].text, 'Image read successfully');
    assert.equal(toolResult.content[1].type, 'image');
    assert.equal(toolResult.content[1].source.data, IMAGE_DATA);
    assert.equal(occurrences(messages, 'Image read successfully'), 1);
});

test('Gemini 3 nests media and IDs inside one function-response turn', () => {
    const contents = toGeminiContents(imageHistory(), 'gemini-3-pro-preview');
    const functionCall = contents[1].parts[0].functionCall;
    const functionResponse = contents[2].parts[0].functionResponse;
    assert.equal(functionCall.id, 'call_1');
    assert.equal(functionResponse.id, 'call_1');
    assert.equal(functionResponse.response.result, 'Image read successfully');
    assert.equal(functionResponse.parts[0].inlineData.data, IMAGE_DATA);
    assert.equal(contents.length, 3);
    assert.equal(occurrences(contents, 'Image read successfully'), 1);
});

test('Gemini 2 merges parallel responses, omits IDs, then sends media', () => {
    const history = [
        { role: 'user', content: 'inspect both' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [
                { id: 'call_1', name: 'read', arguments: { file_path: 'shot.png' } },
                { id: 'call_2', name: 'list', arguments: { path: 'src' } },
            ],
        },
        { role: 'tool', toolCallId: 'call_1', content: mixedImageContent() },
        { role: 'tool', toolCallId: 'call_2', content: 'second result' },
    ];
    const contents = toGeminiContents(history, 'gemini-2.5-pro');
    assert.equal(contents[1].parts.length, 2);
    assert.equal('id' in contents[1].parts[0].functionCall, false);
    assert.equal(contents[2].parts.length, 2);
    assert.equal(contents[2].parts.every((part) => part?.functionResponse), true);
    assert.equal('id' in contents[2].parts[0].functionResponse, false);
    assert.equal('parts' in contents[2].parts[0].functionResponse, false);
    assert.deepEqual(contents[3].parts, [{
        inlineData: {
            mimeType: 'image/png',
            data: IMAGE_DATA,
            displayName: 'tool_media_1',
        },
    }]);
    assert.equal(occurrences(contents, 'Image read successfully'), 1);
});

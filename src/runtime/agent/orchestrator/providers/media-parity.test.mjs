import assert from 'node:assert/strict';
import test from 'node:test';
import { toAnthropicMessages } from './anthropic-messages.mjs';
import { toGeminiContents } from './gemini-schema.mjs';
import { toOpenAIMessages, toXaiResponsesInput } from './openai-compat-wire.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-payload.mjs';
import { sanitizeContentForStoredHistory } from './media-normalization.mjs';
import { estimateMessageTokens } from '../session/context-utils.mjs';

const IMAGE_DATA = 'AAECAw==';

function mixedImageContent(text = 'Image read successfully') {
    return {
        content: [
            { type: 'text', text },
            { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
        ],
    };
}

function readPdfContent(data) {
    return {
        content: [{
            type: 'document',
            source: {
                type: 'base64',
                media_type: 'application/pdf',
                data,
            },
        }],
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

test('read PDF document stays native media without base64 text, storage, or token inflation', () => {
    // Matches the incident shape closely enough to catch dense-ASCII pricing:
    // this used to become a 206k-token input_text and trigger a second compact.
    const pdfData = 'A'.repeat(412_408);
    const content = readPdfContent(pdfData);
    const history = imageHistory(content);

    const responses = convertMessagesToResponsesInput(history);
    const responsesOutput = responses.find((item) => item.type === 'function_call_output')?.output;
    assert.equal(responsesOutput.length, 1);
    assert.equal(responsesOutput[0].type, 'input_file');
    assert.equal(responsesOutput[0].filename, 'document.pdf');
    assert.equal(responsesOutput[0].file_data, `data:application/pdf;base64,${pdfData}`);

    const anthropic = toAnthropicMessages(history);
    const anthropicToolResult = anthropic
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((part) => part?.type === 'tool_result');
    assert.equal(anthropicToolResult.content.length, 1);
    assert.equal(anthropicToolResult.content[0].type, 'document');
    assert.equal(anthropicToolResult.content[0].source.data, pdfData);

    const gemini = toGeminiContents(history, 'gemini-3-pro-preview');
    const geminiFunctionResponse = gemini[2].parts[0].functionResponse;
    assert.equal(geminiFunctionResponse.parts[0].inlineData.mimeType, 'application/pdf');
    assert.equal(geminiFunctionResponse.parts[0].inlineData.data, pdfData);

    const xai = toXaiResponsesInput(history, {
        xaiResponses: { previousResponseId: 'resp_1', seenMessageCount: 0, model: 'grok-4' },
    }, { model: 'grok-4' });
    const xaiOutput = xai.input.find((item) => item.type === 'function_call_output')?.output;
    assert.equal(xaiOutput, '[tool result included document content unavailable to xAI Responses]');

    const stored = sanitizeContentForStoredHistory(content);
    assert.deepEqual(stored, {
        content: [{ type: 'text', text: '[File omitted from stored history: application/pdf]' }],
    });
    assert.equal(JSON.stringify(stored).includes(pdfData), false);

    const estimatedTokens = estimateMessageTokens(history[2]);
    assert.ok(estimatedTokens > 19_000, `expected PDF allowance, got ${estimatedTokens}`);
    assert.ok(estimatedTokens < 25_000, `base64 leaked into token estimate: ${estimatedTokens}`);
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

test('Anthropic error tool_result stays text-only and hoists the screenshot as a sibling block', () => {
    const history = imageHistory(mixedImageContent('Error: click target not found'));
    history[2].toolKind = 'error';
    history.push({ role: 'user', content: 'try again' });
    const messages = toAnthropicMessages(history);
    const resultTurn = messages[2];
    assert.equal(resultTurn.role, 'user');
    const [toolResult, sibling] = resultTurn.content;
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(toolResult.is_error, true);
    assert.ok(toolResult.content.every((part) => part.type === 'text'));
    assert.match(toolResult.content[0].text, /^Error: click target not found/);
    assert.equal(sibling.type, 'image');
    assert.equal(sibling.source.data, IMAGE_DATA);
    assert.equal(occurrences(messages, IMAGE_DATA), 1);
    // The follow-up user text is not folded into an error result whose tail is media.
    assert.equal(messages[3].role, 'user');
});

test('Anthropic error tool_result with text only is left untouched', () => {
    const history = imageHistory('Error: bridge unavailable');
    history[2].toolKind = 'error';
    const toolResult = toAnthropicMessages(history)[2].content[0];
    assert.equal(toolResult.is_error, true);
    assert.equal(toolResult.content, 'Error: bridge unavailable');
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

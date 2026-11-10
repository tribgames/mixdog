// A media attachment sent by reference is saved in history as a text part that
// also carries `attachmentReference` (the attachment's metadata: ref, kind,
// size, pages). That field is internal: the Messages API rejects any key a
// text block does not define ("messages.N.content.M.text.attachmentReference:
// Extra inputs are not permitted"), and a saved history replays the same
// request on every retry. Both Anthropic providers lower history through the
// shared toAnthropicMessages, so the field must be gone from the wire body
// while staying on the saved messages.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-anthropic-attachment-reference-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { _buildRequestBodyForCacheSmoke } = await import('./anthropic-oauth.mjs');
const { buildAnthropicApiRequest } = await import('./anthropic-api-request.mjs');
const { mediaPartToReference } = await import('../../../attachments/attachment-reference.mjs');
const { attachmentFilePath } = await import('../../../attachments/store.mjs');

const MODEL = 'claude-sonnet-4-5';
const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
const ref = (n) => n.toString(16).padStart(64, '0');

// The parts exactly as the reference rewrite stores them.
const imageReference = mediaPartToReference({
  type: 'image',
  attachmentRef: ref(1),
  mimeType: 'image/png',
  filename: 'shot.png',
  sizeBytes: 2048,
});
const pdfReference = mediaPartToReference({
  type: 'file',
  attachmentRef: ref(2),
  mimeType: 'application/pdf',
  filename: 'scan.pdf',
  sizeBytes: 5 * 1024 * 1024,
  pageCount: 37,
  textPages: 0,
});

const builders = {
  'anthropic-oauth': async (messages) => _buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, {}),
  anthropic: async (messages) =>
    (
      await buildAnthropicApiRequest({
        name: 'anthropic',
        config: {},
        messages,
        useModel: MODEL,
        tools: TOOLS,
        opts: {},
        fastModeLatched: false,
      })
    ).params,
};

// Every JSON path under `value` that holds an `attachmentReference` key.
function leakedPaths(value, path = 'body') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'attachmentReference' ? [`${path}.${key}`] : []),
    ...leakedPaths(child, `${path}.${key}`),
  ]);
}

function textBlocks(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(textBlocks);
  return [...(value.type === 'text' ? [value] : []), ...textBlocks(value.content)];
}

const history = () => [
  { role: 'system', content: 'rules' },
  // Message index 0 on the wire; the reference is content.2, the failing path.
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Compare these.' },
      { type: 'text', text: 'Both attached.' },
      imageReference,
      pdfReference,
    ],
  },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { file_path: 'a.pdf' } }] },
  // A reference inside a tool result's own content.
  {
    role: 'tool',
    toolCallId: 'call_1',
    toolKind: 'normal',
    content: [{ type: 'text', text: 'read ok' }, imageReference],
  },
  { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
];

for (const [provider, build] of Object.entries(builders)) {
  test(`${provider}: attachment reference metadata never reaches the wire body`, async () => {
    assert.ok(imageReference.attachmentReference && pdfReference.attachmentReference, 'fixtures are real references');
    const messages = history();
    const saved = structuredClone(messages);
    const body = await build(messages);

    assert.deepEqual(leakedPaths(body), []);
    assert.deepEqual(messages, saved, 'saved history keeps the metadata');
    assert.ok(messages[1].content[2].attachmentReference);
  });

  test(`${provider}: the reference text still reaches the model, top level and inside a tool result`, async () => {
    const body = await build(history());

    const [user] = body.messages;
    assert.equal(user.content[2].type, 'text');
    assert.equal(user.content[2].text, imageReference.text);
    assert.equal(user.content[3].text, pdfReference.text);
    assert.deepEqual(Object.keys(user.content[2]).sort(), ['text', 'type']);
    assert.match(user.content[2].text, new RegExp(attachmentFilePath(ref(1)).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.match(user.content[3].text, /scan\.pdf" \(PDF, 37 pages, no text layer \(scanned pages\)/);

    const toolResult = body.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    assert.ok(toolResult, 'tool result is on the wire');
    // The user turn after the tool result folds into the result's last text
    // block (here the reference part), so the reference text leads that block.
    const nested = textBlocks(toolResult.content).find((b) => b.text.startsWith(imageReference.text));
    assert.ok(nested, 'nested tool-result content carries the reference text');
    assert.match(nested.text, /\n\nand now\?$/);
    assert.deepEqual(Object.keys(nested).sort(), ['text', 'type']);
  });
}

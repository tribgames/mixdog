// A proxied model call runs on the PC, whose attachment store does not hold
// the daemon's blobs: every stored reference must reach the PC inline.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-attachments-'));
process.env.MIXDOG_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { materializePromptSubmission } = await import('../../../attachments/store.mjs');
const { ModelProxyProvider, inlineModelProxyAttachments } = await import('./model-proxy-provider.mjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
const LONG_TEXT = 'server log line\n'.repeat(200);

function storedPrompt() {
  const { prompt } = materializePromptSubmission([
    { type: 'text', text: LONG_TEXT },
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'file', data: PDF, mimeType: 'application/pdf', filename: 'report.pdf' },
  ]);
  return prompt;
}

function capturingChannel() {
  const calls = [];
  return {
    calls,
    request: async (call) => {
      calls.push(call);
      return { content: 'ok' };
    },
  };
}

test('a proxied send carries stored attachments inline, not as daemon references', async () => {
  const prompt = storedPrompt();
  assert.ok(
    prompt.every((part) => typeof part.attachmentRef === 'string'),
    'intake stored every part'
  );
  const channel = capturingChannel();
  const provider = new ModelProxyProvider('anthropic', {}, channel);
  const messages = [
    { role: 'user', content: prompt },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [prompt[1]] }],
    },
  ];
  await provider.send(messages, 'model-x', [], {});
  const [sent] = channel.calls;
  const [text, image, file] = sent.messages[0].content;
  assert.deepEqual(text, { type: 'text', text: LONG_TEXT });
  assert.deepEqual(image, { type: 'image', mimeType: 'image/png', data: PNG });
  assert.deepEqual(file, { type: 'file', mimeType: 'application/pdf', filename: 'report.pdf', data: PDF });
  assert.deepEqual(sent.messages[1].content[0].content, [{ type: 'image', mimeType: 'image/png', data: PNG }]);
  // The session's own history keeps its references.
  assert.equal(typeof messages[0].content[1].attachmentRef, 'string');
});

test('a blob the daemon no longer has stays a reference for the PC to report as unavailable', () => {
  const missing = { type: 'image', mimeType: 'image/png', attachmentRef: 'a'.repeat(64), sizeBytes: 10 };
  const messages = [{ role: 'user', content: [missing] }];
  assert.equal(inlineModelProxyAttachments(messages), messages);
});

test('the inline budget goes to the newest attachments first', () => {
  const prompt = storedPrompt();
  const pngBytes = Buffer.from(PNG, 'base64').length;
  const older = { role: 'user', content: [prompt[1]] };
  const newer = { role: 'user', content: [prompt[1]] };
  const out = inlineModelProxyAttachments([older, newer], { maxBytes: pngBytes });
  assert.equal(out[0].content[0].attachmentRef, prompt[1].attachmentRef, 'past the budget: still a reference');
  assert.equal(out[1].content[0].data, PNG);
});

test('messages without stored references pass through unchanged', () => {
  const messages = [
    { role: 'user', content: 'plain' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ];
  assert.equal(inlineModelProxyAttachments(messages), messages);
});

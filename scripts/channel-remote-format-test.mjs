import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordBackend } from '../src/runtime/channels/backends/discord.mjs';
import { OutputForwarder } from '../src/runtime/channels/lib/output-forwarder.mjs';

test('transcript drain leaves one blank line between preambles and tool cards', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mixdog-forwarder-blocks-'));
  try {
    const transcript = join(stateDir, 'sess-spacing.jsonl');
    const entries = [
      {
        type: 'assistant',
        sessionId: 'sess-spacing',
        message: { content: [{ type: 'text', text: 'Inspect first.' }] },
      },
      {
        type: 'assistant',
        sessionId: 'sess-spacing',
        message: {
          content: [{ type: 'tool_use', name: 'shell', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'assistant',
        sessionId: 'sess-spacing',
        message: {
          content: [{
            type: 'tool_use',
            name: 'apply_patch',
            input: { file_path: 'src/example.mjs' },
          }],
        },
      },
      {
        type: 'assistant',
        sessionId: 'sess-spacing',
        message: {
          content: [
            { type: 'text', text: 'Inline preamble.' },
            { type: 'tool_use', name: 'read', input: { path: 'src/example.mjs' } },
          ],
        },
      },
    ];
    writeFileSync(transcript, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const forwarder = new OutputForwarder({}, { read: () => ({}) });
    forwarder.setContext('remote-channel', transcript, { replayFromStart: true });

    const { text } = forwarder.extractNewText(true);
    assert.match(text, /^Inspect first\.\n\n● \*\*Run\*\*/);
    assert.match(text, /● \*\*Run\*\*[^\n]*\n\n● \*\*Update\*\*/);
    assert.ok(text.includes(
      '● **Update**\n```\nsrc/example.mjs\n```\n\nInline preamble.\n\n● **Explorer**',
    ), 'a tool card may keep its body while the next semantic block gets one blank line');
    assert.doesNotMatch(text, /\n{3,}/, 'semantic blocks use exactly one blank line');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('remote continuation spacing belongs to the active transcript turn', async () => {
  const sends = [];
  const forwarder = new OutputForwarder({
    formatOutgoing: (text) => text,
    send: async (_channelId, text, options) => {
      sends.push({ text, options });
      return { sentIds: [String(sends.length)] };
    },
  }, { read: () => ({}) });
  forwarder.channelId = 'remote-channel';

  await forwarder.deliverQueueItem({
    type: 'text',
    text: 'first\n\nparagraph',
    nextFileSize: 0,
  });
  await forwarder.deliverQueueItem({
    type: 'toolLog',
    text: 'second',
    nextFileSize: 0,
    preformatted: true,
  });
  forwarder.reset();
  await forwarder.deliverQueueItem({
    type: 'text',
    text: 'next turn',
    nextFileSize: 0,
  });

  assert.deepEqual(sends.map(({ text }) => text), [
    'first\n\nparagraph',
    'second',
    'next turn',
  ], 'the forwarder must preserve the original paragraph newlines');
  assert.deepEqual(sends.map(({ options }) => options.continuation), [
    false,
    true,
    false,
  ], 'only a later item in the same transcript turn is a continuation');
});

test('daemon-global Discord backend obeys explicit continuation and retry state only', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mixdog-discord-format-'));
  try {
    const payloads = [];
    const backend = new DiscordBackend({
      token: 'test-token',
      mainChannelId: 'remote-channel',
      accessMode: 'static',
      access: {},
    }, stateDir);
    backend.fetchAllowedChannel = async () => ({
      send: async (payload) => {
        payloads.push(payload.content);
        return { id: String(payloads.length) };
      },
    });
    backend.loadAccess = () => ({ textChunkLimit: 2_000, replyToMode: 'off' });
    backend.noteSent = () => {};

    // An unrelated daemon send cannot make the active session's first response
    // acquire continuation spacing.
    await backend.sendMessage('remote-channel', 'scheduler', {});
    await backend.sendMessage('remote-channel', 'first\n\nparagraph', {
      continuation: false,
    });
    await backend.sendMessage('remote-channel', 'second', {
      continuation: true,
    });
    await backend.sendMessage('remote-channel', 'next turn', {
      continuation: false,
    });

    // Retry state freezes the original prefix decision even if the caller's
    // current turn state now says otherwise.
    const retried = '\u3164\nretry';
    await backend.sendMessage('remote-channel', 'retry', {
      continuation: false,
      resumeToken: {
        hash: createHash('md5').update(retried).digest('hex'),
        nextChunkIdx: 0,
        sentIds: [],
        prefixed: true,
        limit: 2_000,
      },
    });

    assert.deepEqual(payloads, [
      'scheduler',
      'first\n\nparagraph',
      '\u3164\nsecond',
      'next turn',
      retried,
    ]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

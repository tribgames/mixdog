// Isolate Mixdog user data in a temp dir before any module under test loads.
import '../../../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuiltinTool } from '../tools/builtin.mjs';
import { handleExecMessage, sendToolResult } from './cursor-wire-exec.mjs';
import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { toGeminiContents } from './gemini-schema.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { geminiSendResult } from './gemini-response.mjs';

test('Cursor native grep round-trips real single-file and directory results and limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-cursor-grep-'));
  try {
    await writeFile(join(root, 'a.txt'), 'needle one\nother\nneedle two\n');
    await writeFile(join(root, 'b.txt'), 'needle three\n');
    // Every fixture exists before the first search: the native search server learns
    // of files created afterwards only through an asynchronous filesystem watcher,
    // which on macOS (FSEvents) can trail a create by longer than this test waits.
    // The marker line deliberately lacks 'needle' so the needle counts stay unchanged.
    await writeFile(join(root, 'a-12-b.txt'), 'filename-marker only\n');
    for (const path of ['a.txt', '.']) {
      for (const outputMode of ['content', 'count', 'files_with_matches']) {
        let call;
        const frames = [];
        const bridge = { write: (bytes) => frames.push(bytes) };
        handleExecMessage(
          bridge,
          {
            id: 1,
            execId: 'grep',
            grepArgs: { path, pattern: 'needle', outputMode, headLimit: 20, toolCallId: 'g' },
          },
          [{ name: 'grep' }],
          '',
          (value) => {
            call = value;
          }
        );
        const args = JSON.parse(call.decodedArgs);
        assert.equal(args.limit, 20);
        assert.equal(args.context, 0);
        const result = await executeBuiltinTool('grep', args, root);
        sendToolResult(bridge, call, { content: result }, true);
        const wire = decodeMessage('AgentClientMessage', frames[0].subarray(5));
        const output = wire.execClientMessage.grepResult.success.workspaceResults[path];
        const expectedCount = path === 'a.txt' ? 2 : 3;
        if (outputMode === 'content') {
          assert.equal(output.content.totalMatchedLines, expectedCount);
          assert.deepEqual(
            output.content.matches.flatMap((file) => file.matches.map((match) => match.content)).sort(),
            (path === 'a.txt' ? ['needle one', 'needle two'] : ['needle one', 'needle two', 'needle three']).sort()
          );
        } else if (outputMode === 'count') {
          assert.equal(output.count.totalMatches, expectedCount);
        } else {
          assert.equal(output.files.totalFiles, path === 'a.txt' ? 1 : 2);
        }
      }
    }
    let call;
    handleExecMessage(
      {},
      { grepArgs: { path: '.', pattern: 'needle', headLimit: 1 } },
      [{ name: 'grep' }],
      '',
      (value) => {
        call = value;
      }
    );
    const frames = [];
    const result = await executeBuiltinTool('grep', JSON.parse(call.decodedArgs), root);
    sendToolResult({ write: (bytes) => frames.push(bytes) }, call, { content: result }, true);
    const output = decodeMessage('AgentClientMessage', frames[0].subarray(5));
    assert.equal(output.execClientMessage.grepResult.success.workspaceResults['.'].content.totalMatchedLines, 1);
    let filenameCall;
    const filenameFrames = [];
    handleExecMessage(
      {},
      { grepArgs: { path: '.', pattern: 'filename-marker', outputMode: 'content' } },
      [{ name: 'grep' }],
      '',
      (value) => {
        filenameCall = value;
      }
    );
    const filenameResult = await executeBuiltinTool('grep', JSON.parse(filenameCall.decodedArgs), root);
    sendToolResult({ write: (bytes) => filenameFrames.push(bytes) }, filenameCall, { content: filenameResult }, true);
    const filenameWire = decodeMessage('AgentClientMessage', filenameFrames[0].subarray(5));
    const filenameMatches = filenameWire.execClientMessage.grepResult.success.workspaceResults['.'].content.matches;
    assert.equal(filenameMatches.length, 1);
    assert.equal(filenameMatches[0].file.replace(/^\.\//, ''), 'a-12-b.txt');
    assert.deepEqual(filenameMatches[0].matches, [{ lineNumber: 1, content: 'filename-marker only' }]);
    for (const outputMode of ['content', 'count', 'files_with_matches']) {
      let emptyCall;
      const writes = [];
      handleExecMessage(
        {},
        { grepArgs: { path: '.', pattern: 'absent-pattern', outputMode } },
        [{ name: 'grep' }],
        '',
        (value) => {
          emptyCall = value;
        }
      );
      const empty = await executeBuiltinTool('grep', JSON.parse(emptyCall.decodedArgs), root);
      sendToolResult({ write: (bytes) => writes.push(bytes) }, emptyCall, { content: empty }, true);
      const wire = decodeMessage('AgentClientMessage', writes[0].subarray(5));
      const value = wire.execClientMessage.grepResult.success.workspaceResults['.'];
      if (outputMode === 'content') assert.equal(value.content.totalMatchedLines ?? 0, 0);
      else if (outputMode === 'count') assert.equal(value.count.totalMatches ?? 0, 0);
      else assert.equal(value.files.totalFiles ?? 0, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Gemini preserves parallel calls and pairs bridge results by their wire names and ids', () => {
  const parts = [
    { functionCall: { name: 'call_tool', args: { name: 'read' }, id: 'wire-a' }, thoughtSignature: 'opaque' },
    { functionCall: { name: 'grep', args: { pattern: 'needle' }, id: 'wire-b' } },
  ];
  const history = [
    { role: 'user', content: 'both' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'read', arguments: {} },
        { id: 'b', name: 'grep', arguments: {} },
      ],
      providerReplay: createProviderReplay('gemini', parts),
    },
    { role: 'tool', toolCallId: 'a', content: 'read result' },
    { role: 'tool', toolCallId: 'b', content: 'grep result' },
  ];
  const original = structuredClone(history);
  const contents = toGeminiContents(history, 'gemini-3.1-pro');
  assert.deepEqual(contents[1].parts, parts);
  assert.deepEqual(
    contents[2].parts.map(({ functionResponse: r }) => [r.id, r.name]),
    [
      ['wire-a', 'call_tool'],
      ['wire-b', 'grep'],
    ]
  );
  assert.deepEqual(history, original);
});

test('Gemini records response model and rebuilds calls without foreign model signatures', () => {
  const parsed = {
    content: '',
    citations: [],
    toolCalls: [{ id: 'a', name: 'read', arguments: {}, thoughtSignature: 'source' }],
    providerReplay: createProviderReplay('gemini', [
      { functionCall: { id: 'a', name: 'read', args: {} }, thoughtSignature: 'source' },
    ]),
  };
  const result = geminiSendResult(parsed, 'gemini-3.1-pro', {}, null);
  assert.equal(result.providerReplay.requestContext.model, 'gemini-3.1-pro');
  const history = [
    { role: 'user', content: 'read' },
    { role: 'assistant', ...result },
  ];
  assert.equal(toGeminiContents(history, 'gemini-3.1-pro')[1].parts[0].thoughtSignature, 'source');
  assert.equal(
    toGeminiContents(history, 'gemini-3-flash')[1].parts[0].thoughtSignature,
    'skip_thought_signature_validator'
  );
  assert.equal(history[1].providerReplay.items[0].thoughtSignature, 'source');
});

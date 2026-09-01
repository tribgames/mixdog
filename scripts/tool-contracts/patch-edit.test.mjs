// apply_patch and edit behaviors: dry-run validation, absorption, compacted
// placeholder guard, edit-string semantics, and OpenAI custom-tool wire shape.
import './_env.mjs';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './_env.mjs';
import { assertOk } from './_helpers.mjs';
import { executeBuiltinTool } from '../../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { executePatchTool } from '../../src/runtime/agent/orchestrator/tools/patch.mjs';
import { PATCH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { buildRequestBody, sendViaHttpSse } from '../../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';

// Malformed-but-unambiguous patch openings must be absorbed (dry-run, so no
// write). Each targets the same known-good smoke.mjs line.
const smokeBody = `@@
-process.stdout.write('smoke passed ✓\\n');
+process.stdout.write('smoke passed ok\\n');
*** End Patch
`;

test('apply_patch dry-run validates current context and rejects stale hunks', async () => {
  const patchOut = await executePatchTool('apply_patch', {
    base_path: root,
    dry_run: true,
    fuzzy: false,
    patch: `*** Begin Patch
*** Update File: scripts/smoke.mjs
@@
-process.stdout.write('smoke passed ✓\\n');
+process.stdout.write('smoke passed ok\\n');
*** End Patch
`,
  }, root);
  assertOk('apply_patch dry_run', patchOut, /checked|validated|dry|OK/i);

  const stalePatchOut = await executePatchTool('apply_patch', {
    base_path: root,
    dry_run: true,
    fuzzy: false,
    patch: `*** Begin Patch
*** Update File: scripts/smoke.mjs
@@
-definitely-not-current-smoke-line
+definitely-not-current-smoke-line-2
*** End Patch
`,
  }, root);
  if (!/^Error[\s:[]/.test(String(stalePatchOut)) || !/apply_patch/i.test(String(stalePatchOut))) {
    throw new Error(`apply_patch stale context must return an Error result, not throw or pass:\n${stalePatchOut}`);
  }
});

test('edit exact-string semantics: replace_all, ambiguity, create, no-op', async () => {
  const editTmp = mkdtempSync(join(tmpdir(), 'mixdog-edit-tool-'));
  try {
    const target = join(editTmp, 'target.txt');
    writeFileSync(target, 'alpha beta alpha\n', 'utf8');
    const replaceAllOut = await executeBuiltinTool('edit', {
      file_path: 'target.txt',
      old_string: 'alpha',
      new_string: 'omega',
      replace_all: true,
    }, editTmp, { sessionId: `tool-contracts-edit-${process.pid}` });
    assertOk('edit replace_all', replaceAllOut, /2 replacements/);
    if (readFileSync(target, 'utf8') !== 'omega beta omega\n') {
      throw new Error('edit replace_all must replace every occurrence');
    }
    const ambiguousOut = await executeBuiltinTool('edit', {
      file_path: 'target.txt',
      old_string: 'omega',
      new_string: 'alpha',
    }, editTmp, { sessionId: `tool-contracts-edit-${process.pid}` });
    if (!/^Error[\s:[]/.test(String(ambiguousOut)) || !/found 2 times|ambiguous/i.test(String(ambiguousOut))) {
      throw new Error(`edit must reject ambiguous old_string:\n${ambiguousOut}`);
    }
    const createOut = await executeBuiltinTool('edit', {
      file_path: 'created.txt',
      old_string: '',
      new_string: 'created\n',
    }, editTmp, { sessionId: `tool-contracts-edit-${process.pid}` });
    assertOk('edit create', createOut, /Created/);
    if (readFileSync(join(editTmp, 'created.txt'), 'utf8') !== 'created\n') {
      throw new Error('edit empty old_string must create a missing file');
    }
    const noOpOut = await executeBuiltinTool('edit', {
      file_path: 'target.txt',
      old_string: 'omega',
      new_string: 'omega',
      replace_all: true,
    }, editTmp, { sessionId: `tool-contracts-edit-${process.pid}` });
    if (!/^Error[\s:[]/.test(String(noOpOut)) || !/exactly the same/i.test(String(noOpOut))) {
      throw new Error(`edit must reject no-op replacements:\n${noOpOut}`);
    }
  } finally {
    rmSync(editTmp, { recursive: true, force: true });
  }
});

test('apply_patch absorbs unambiguous malformed openings', async () => {
  const absorbCases = [
    ['leading blank lines', `\n\n*** Begin Patch\n*** Update File: scripts/smoke.mjs\n${smokeBody}`],
    ['decorated begin header', `*** Begin Patch (V4A) ***\n*** Update File: scripts/smoke.mjs\n${smokeBody}`],
    ['bare file path opening', `*** Begin Patch\nscripts/smoke.mjs\n${smokeBody}`],
    ['File: prefixed opening', `*** Begin Patch\nFile: scripts/smoke.mjs\n${smokeBody}`],
    ['unified body in envelope', `*** Begin Patch\n--- scripts/smoke.mjs\n+++ scripts/smoke.mjs\n${smokeBody}`],
  ];
  for (const [label, patch] of absorbCases) {
    const out = await executePatchTool('apply_patch', { base_path: root, dry_run: true, fuzzy: false, patch }, root);
    assertOk(`apply_patch absorbs ${label}`, out, /checked|validated|dry|OK/i);
  }

  const ambiguousPatchOut = await executePatchTool('apply_patch', {
    base_path: root,
    dry_run: true,
    fuzzy: false,
    patch: `*** Begin Patch\nthis line is not a valid opening\n${smokeBody}`,
  }, root);
  if (!/^Error[\s:[]/.test(String(ambiguousPatchOut)) || !/before a file header|V4A/i.test(String(ambiguousPatchOut))) {
    throw new Error(`apply_patch must keep erroring on genuinely ambiguous openings:\n${ambiguousPatchOut}`);
  }

  // Unified-looking first body line but real V4A file sections appear later: the
  // envelope must NOT be stripped to unified — it stays ambiguous and errors.
  const mixedPatchOut = await executePatchTool('apply_patch', {
    base_path: root,
    dry_run: true,
    fuzzy: false,
    patch: `*** Begin Patch\n--- scripts/smoke.mjs\n*** Update File: scripts/smoke.mjs\n${smokeBody}`,
  }, root);
  if (!/^Error[\s:[]/.test(String(mixedPatchOut)) || !/before a file header|V4A/i.test(String(mixedPatchOut))) {
    throw new Error(`apply_patch must keep erroring on mixed unified/V4A openings:\n${mixedPatchOut}`);
  }
});

test('apply_patch rejects compacted-history placeholders before dispatch', async () => {
  // Compacted-history placeholder guard: EVERY [mixdog compacted …] variant must
  // be rejected with the corrective message BEFORE format dispatch/salvage, both
  // as the first line and standalone mid-body (after a *** Begin Patch header).
  const compactedGuardCases = [
    ['legacy key: prefix', '[mixdog compacted patch: 4096 chars, sha256:deadbeefdeadbeef]\n*** Begin Patch\n*** Update File: a.txt\n+x\n*** End Patch\n'],
    ['variant key form', '[mixdog compacted patch v4a, sha256:deadbeefdeadbeef]\n*** Begin Patch\n*** Update File: a.txt\n+x\n*** End Patch\n'],
    ['no chars/sha detail', '[mixdog compacted old_string]\n'],
    ['mid-body standalone', '*** Begin Patch\n*** Update File: a.txt\n[mixdog compacted patch v4a, sha256:deadbeefdeadbeef]\n*** End Patch\n'],
  ];
  for (const [label, patch] of compactedGuardCases) {
    const out = await executePatchTool('apply_patch', { base_path: root, dry_run: true, fuzzy: false, patch }, root);
    if (!/^Error[\s:[]/.test(String(out))
        || !/compacted-history placeholder/i.test(String(out))
        || !/submit real patch text/i.test(String(out))
        || /re-read|fresh full patch/i.test(String(out))) {
      throw new Error(`apply_patch must reject compacted placeholder (${label}):\n${out}`);
    }
  }
  // A legit unified edit whose body content mentions the literal text on a diff
  // line (+/-/space) must still parse — the guard only trips on non-diff lines.
  const compactedFalsePositiveOut = await executePatchTool('apply_patch', {
    base_path: root,
    dry_run: true,
    fuzzy: false,
    patch: `*** Begin Patch\n*** Add File: compacted-note.txt\n+[mixdog compacted patch: 10 chars, sha256:abc]\n*** End Patch\n`,
  }, root);
  assertOk('apply_patch keeps diff-line placeholder text', compactedFalsePositiveOut, /checked|validated|dry|OK/i);
});

test('apply_patch serializes as an OpenAI custom grammar tool on the wire', () => {
  const patchTool = PATCH_TOOL_DEFS[0];
  const rawPatch = '*** Begin Patch\n*** Add File: custom-wire.txt\n+ok\n*** End Patch\n';
  const body = buildRequestBody(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'patch please' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: rawPatch }, nativeType: 'custom_tool_call' }],
      },
      { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
    ],
    'gpt-5.5',
    PATCH_TOOL_DEFS,
    {},
  );
  const wirePatchTool = body.tools?.find((tool) => tool.name === 'apply_patch');
  if (wirePatchTool?.type !== 'custom' || wirePatchTool?.format?.syntax !== 'lark') {
    throw new Error(`OpenAI Responses apply_patch must serialize as a custom grammar tool: ${JSON.stringify(wirePatchTool)}`);
  }
  if (wirePatchTool.description !== patchTool.freeformDescription) {
    throw new Error(`OpenAI Responses apply_patch must use freeform description: ${JSON.stringify(wirePatchTool)}`);
  }
  const customCall = body.input?.find((item) => item.type === 'custom_tool_call');
  const customOutput = body.input?.find((item) => item.type === 'custom_tool_call_output');
  if (customCall?.input !== rawPatch || customCall?.call_id !== 'call_patch_1') {
    throw new Error(`custom apply_patch replay must keep raw patch input: ${JSON.stringify(body.input)}`);
  }
  if (customOutput?.call_id !== 'call_patch_1' || customOutput?.output !== 'OK') {
    throw new Error(`custom apply_patch output must replay as custom_tool_call_output: ${JSON.stringify(body.input)}`);
  }
});

test('apply_patch SSE parser emits internal patch args from custom tool calls', async () => {
  const rawPatch = '*** Begin Patch\n*** Add File: custom-parser.txt\n+ok\n*** End Patch\n';
  const encoder = new TextEncoder();
  const frames = [
    { type: 'response.created', response: { id: 'resp_custom_patch', model: 'gpt-5.5' } },
    { type: 'response.custom_tool_call_input.delta', delta: rawPatch.slice(0, 16) },
    { type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'call_patch_sse', name: 'apply_patch', input: rawPatch } },
    { type: 'response.completed', response: { id: 'resp_custom_patch', model: 'gpt-5.5', usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
  ];
  const bodyText = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  let emitted = null;
  const response = await sendViaHttpSse({
    auth: { access_token: 'fake-token', account_id: '' },
    body: { model: 'gpt-5.5', input: [], stream: true },
    opts: {},
    onToolCall: (call) => { emitted = call; },
    externalSignal: null,
    poolKey: 'tool-contracts-custom-patch',
    cacheKey: 'tool-contracts-custom-patch',
    iteration: 1,
    useModel: 'gpt-5.5',
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(bodyText));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const call = response.toolCalls?.[0];
  if (call?.nativeType !== 'custom_tool_call' || call?.name !== 'apply_patch' || call?.arguments?.patch !== rawPatch) {
    throw new Error(`custom apply_patch SSE parser must produce internal patch args: ${JSON.stringify(response.toolCalls)}`);
  }
  if (emitted?.arguments?.patch !== rawPatch) {
    throw new Error(`custom apply_patch SSE parser must eager-emit patch args: ${JSON.stringify(emitted)}`);
  }
});

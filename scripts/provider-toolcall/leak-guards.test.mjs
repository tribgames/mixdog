import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compatParseToolCalls,
  compatParseResponsesToolCalls,
  consumeCompatResponsesStream,
  consumeCompatChatCompletionStream,
  createGeminiTextLeakGuard,
  anthropicParseSSEStream,
  anthropicSseResponse,
  compatResponsesEventStream,
  LEAK_TOOLS,
  textDeltaEvents,
  OAI_LEAK_TOOLS,
  chatCompletionStream,
  responsesTextStream,
} from './_shared.mjs';


test('gemini leak guard: leaked <invoke> in part.text for known tool → recovered, no leak', () => {
    const leaked = 'Sure.\n<function_calls>\n<invoke name="read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const guard = createGeminiTextLeakGuard({
        knownToolNames: LEAK_TOOLS,
        onTextDelta: (t) => texts.push(t),
        onToolCall: (c) => captured.push(c),
    });
    guard.feedText(leaked);
    guard.finalize();
    const content = guard.scrubAssistantText(leaked);
    const emitted = texts.join('');
    assert.equal(/<invoke|<function_calls|<parameter/.test(emitted), false);
    assert.equal(/<invoke|<function_calls|<parameter/.test(content), false);
    assert.ok(emitted.includes('Sure.'));
    assert.ok(content.includes('Sure.'));
    const leakedCalls = guard.getLeakedToolCalls();
    assert.equal(leakedCalls.length, 1);
    assert.equal(leakedCalls[0].name, 'read');
    assert.deepEqual(leakedCalls[0].arguments, { path: 'a.txt' });
    assert.match(leakedCalls[0].id, /^gemini_leaked_/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
});

test('gemini leak guard: unknown tool name → text flushed, no synthetic call', () => {
    const leaked = '<function_calls>\n<invoke name="nonexistent_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</function_calls>';
    const captured = [];
    const guard = createGeminiTextLeakGuard({
        knownToolNames: LEAK_TOOLS,
        onToolCall: (c) => captured.push(c),
    });
    guard.feedText(leaked);
    guard.finalize();
    const content = guard.scrubAssistantText(leaked);
    assert.equal(guard.getLeakedToolCalls().length, 0);
    assert.equal(captured.length, 0);
    assert.ok(content.includes('nonexistent_tool'));
});

test('anthropic(-oauth) leak guard: leaked <function_calls>/<invoke> for known tool → recovered, no leak', async () => {
    const leaked = 'Sure.\n<function_calls>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([leaked])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    const emitted = texts.join('');
    // Tags never reached the visible stream nor the returned content.
    assert.equal(/<invoke|<function_calls|<parameter/.test(emitted), false);
    assert.equal(/<invoke|<function_calls|<parameter/.test(result.content), false);
    assert.ok(emitted.includes('Sure.'));
    assert.ok(result.content.includes('Sure.'));
    // A real, dispatched tool call was synthesized.
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'shell');
    assert.deepEqual(result.toolCalls[0].arguments, { command: 'ls -la' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'shell');
    assert.deepEqual(captured[0].arguments, { command: 'ls -la' });
});

test('anthropic(-oauth) leak guard: tags split across two text_delta chunks still detected', async () => {
    const a = '<invoke name="sh';
    const b = 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([a, b])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'shell');
    assert.deepEqual(result.toolCalls[0].arguments, { command: 'pwd' });
    assert.deepEqual(captured[0].arguments, { command: 'pwd' });
});

test('anthropic(-oauth) leak guard: unknown tool name → text flushed, no synthetic call', async () => {
    const leaked = '<function_calls>\n<invoke name="nonexistent_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([leaked])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    // Not a known tool: nothing recovered, and the text is preserved (never lost).
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('nonexistent_tool'));
    assert.ok(result.content.includes('nonexistent_tool'));
});

test('anthropic(-oauth) leak guard: benign prose <function> mention preserved, not swallowed', async () => {
    const prose = 'Use the <function> keyword in JavaScript to declare a function.';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([prose])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.equal(texts.join(''), prose);
    assert.equal(result.content, prose);
});

test('openai-compat (chat) leak guard: leaked <invoke> for known tool → recovered, no leak', async () => {
    const leaked = 'Sure.\n<function_calls>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([leaked]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    const emitted = texts.join('');
    assert.equal(/<invoke|<function_calls|<parameter/.test(emitted), false);
    assert.equal(/<invoke|<function_calls|<parameter/.test(out.content), false);
    assert.ok(emitted.includes('Sure.'));
    assert.ok(out.content.includes('Sure.'));
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'shell');
    assert.deepEqual(out.toolCalls[0].arguments, { command: 'ls -la' });
    assert.match(out.toolCalls[0].id, /^call_leaked_/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'shell');
    assert.deepEqual(captured[0].arguments, { command: 'ls -la' });
});

test('openai-compat (chat) leak guard: leaked harmony <|channel|>...<|call|> for known tool → recovered', async () => {
    const leaked = '<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a.txt"}<|call|>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream(['ok ', leaked]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(/<\|channel\|>|to=functions|<\|call\|>/.test(texts.join('')), false);
    assert.equal(/<\|channel\|>|<\|call\|>/.test(out.content), false);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'read');
    assert.deepEqual(out.toolCalls[0].arguments, { path: 'a.txt' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
});

test('openai-compat (chat) leak guard: XML tags split across two content deltas still detected', async () => {
    const a = '<invoke name="sh';
    const b = 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([a, b]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'shell');
    assert.deepEqual(out.toolCalls[0].arguments, { command: 'pwd' });
    assert.deepEqual(captured[0].arguments, { command: 'pwd' });
});

test('openai-compat (chat) leak guard: unknown tool → text preserved, no synthetic call', async () => {
    const leaked = '<function_calls>\n<invoke name="nonexistent_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([leaked]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('nonexistent_tool'));
    assert.ok(out.content.includes('nonexistent_tool'));
});

test('openai-compat (chat) leak guard: benign prose preserved, native tool_calls path intact', async () => {
    const prose = 'Use the <function> keyword in JavaScript.';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([prose]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.equal(texts.join(''), prose);
    assert.equal(out.content, prose);
});

test('openai-compat (chat) leak guard: native structured tool_calls still work with guard enabled', async () => {
    const captured = [];
    const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } },
    ];
    const out = await consumeCompatChatCompletionStream(compatResponsesEventStream(events), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'read', arguments: { path: 'x' } }]);
    assert.deepEqual(captured, [{ id: 'call_1', name: 'read', arguments: { path: 'x' } }]);
});

test('openai-compat (responses) leak guard: leaked <invoke> in output_text.delta → recovered', async () => {
    const leaked = 'Working.\n<invoke name="shell">\n<parameter name="command">whoami</parameter>\n</invoke>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatResponsesStream(responsesTextStream([leaked]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(/<invoke|<parameter/.test(out.content), false);
    assert.ok(out.content.includes('Working.'));
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'shell');
    assert.deepEqual(out.toolCalls[0].arguments, { command: 'whoami' });
    assert.match(out.toolCalls[0].id, /^call_leaked_/);
    assert.equal(captured.length, 1);
});

test('openai-compat (responses) leak guard: harmony syntax split across two deltas → recovered', async () => {
    const a = '<|channel|>commentary to=functions.read <|message|>{"path":';
    const b = '"b.txt"}<|call|>';
    const captured = [];
    const out = await consumeCompatResponsesStream(responsesTextStream([a, b]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'read');
    assert.deepEqual(out.toolCalls[0].arguments, { path: 'b.txt' });
    assert.equal(captured.length, 1);
});

test('openai-compat (responses) leak guard: benign prose preserved, no synthetic call', async () => {
    const prose = 'Just some prose about functions and channels.';
    const captured = [];
    const out = await consumeCompatResponsesStream(responsesTextStream([prose]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(out.content.includes('Just some prose'));
});

// === 7. Reviewer fixes: fence gating, cross-path dedupe, bare-antml ========

// --- Fix 1: code-fence / inline-code gating (Anthropic path) ---------------
// A complete <invoke> written inside a ```code fence``` or inline `code` span
// is a documentation example, not a real call: it must stream as visible text
// and NOT dispatch. The control (same tag OUTSIDE a fence) still recovers.
test('anthropic leak guard (fence): <invoke> inside a fenced code block → emitted as text, NOT dispatched', async () => {
    const fenced = 'Example:\n```\n<invoke name="read"><parameter name="path">a</parameter></invoke>\n```\ndone';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([fenced])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('<invoke name="read">'));
    assert.ok(result.content.includes('<invoke name="read">'));
});

test('anthropic leak guard (fence): fence OPENS in one delta and CLOSES in a later one, tag between → NOT dispatched', async () => {
    const chunks = ['Here is an example:\n```json\n', '<invoke name="read"><parameter name="path">a</parameter></invoke>\n', '```\nEnd.'];
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents(chunks)),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('<invoke name="read">'));
});

test('anthropic leak guard (fence): <invoke> inside an inline `code` span → NOT dispatched', async () => {
    const inline = 'Call it like `<invoke name="read"><parameter name="path">a</parameter></invoke>` in the docs.';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([inline])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('<invoke name="read">'));
});

test('anthropic leak guard (fence CONTROL): same <invoke> OUTSIDE any fence → still recovered/dispatched', async () => {
    const outside = 'Sure.\n<invoke name="read"><parameter name="path">a</parameter></invoke>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([outside])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a' });
    assert.equal(captured.length, 1);
});

// --- Fix 1: harmony example inside a fence (OpenAI chat path) → NOT dispatched
test('openai-compat (chat) leak guard (fence): harmony example inside a ```fence``` → emitted as text, NOT dispatched', async () => {
    const fenced = 'Doc:\n```\n<|channel|>commentary to=functions.read <|message|>{"path":"a"}<|call|>\n```\n';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([fenced]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('to=functions.read'));
});

// --- Fix 2: duplicate dispatch (text-leaked + identical native) → ONE fire --
test('anthropic leak guard (dedupe): text-leaked call + identical native tool_use → onToolCall fires ONCE', async () => {
    const leaked = '<invoke name="shell"><parameter name="command">ls</parameter></invoke>';
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: leaked } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null, () => {}, () => {}, (c) => captured.push(c), {}, () => {}, LEAK_TOOLS,
    );
    // Exactly one dispatch for the identical (name,args) fingerprint.
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'shell');
    assert.deepEqual(captured[0].arguments, { command: 'ls' });
    // ...and the RETURNED array carries exactly one — else the loop would
    // execute the side-effecting tool twice (Fix 2 array side).
    assert.equal(result.toolCalls.length, 1);
});

test('openai-compat (chat) leak guard (dedupe): text-leaked call + identical native tool_calls → onToolCall fires ONCE', async () => {
    const leaked = '<invoke name="read"><parameter name="path">a</parameter></invoke>';
    const events = [
        { choices: [{ delta: { content: leaked } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } },
    ];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(compatResponsesEventStream(events), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
    assert.deepEqual(captured[0].arguments, { path: 'a' });
    // The RETURNED array is deduped too (Fix 2 array side): the agent loop
    // executes returned toolCalls, so a synthetic+native duplicate here would
    // run the side-effecting tool twice. Exactly one must survive.
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'read');
});

// --- Fix 3: bare `antml:invoke` in prose (no `<`) → streamed, not held ------
test('anthropic leak guard (bare-antml): literal "antml:invoke" in prose → streamed promptly, no dispatch', async () => {
    const prose = 'The tag antml:invoke is used internally; here we just mention it in a sentence.';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([prose])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    // Streamed promptly (not held to final) and content intact.
    assert.equal(texts.join(''), prose);
    assert.equal(result.content, prose);
});

test('anthropic leak guard (bare-antml CONTROL): <invoke> bracket form still recovers', async () => {
    const leaked = 'ok\n<invoke name="read"><parameter name="path">z</parameter></invoke>';
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([leaked])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, () => {}, LEAK_TOOLS,
    );
    assert.equal(result.toolCalls.length, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
    assert.deepEqual(captured[0].arguments, { path: 'z' });
});

// --- Reviewer Medium: suppressed call args must NOT poison fence state -------
// A recovered/suppressed leaked call whose args contain an unmatched backtick
// must not leave the markdown fence "open" and wrongly suppress a LATER real
// leaked call as if it were inside a code span.
test('anthropic leak guard (fence): unmatched backtick inside a suppressed call\'s args does not swallow a later real call', async () => {
    // First leaked call carries a lone backtick in its arg value; second is a
    // clean leaked call that MUST still be recovered.
    const first = '<invoke name="read"><parameter name="path">a`b</parameter></invoke>';
    const between = ' some visible prose ';
    const second = '<invoke name="shell"><parameter name="command">ls</parameter></invoke>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([first + between + second])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    // BOTH leaked calls recovered — the stray backtick in call #1's args did
    // not open a fence that suppressed call #2.
    assert.equal(captured.length, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.deepEqual(captured.map((c) => c.name), ['read', 'shell']);
    // The in-between prose streamed; the tag/arg text did not leak.
    assert.equal(texts.join('').includes('some visible prose'), true);
    assert.equal(texts.join('').includes('<invoke'), false);
    assert.equal(texts.join('').includes('`'), false);
});

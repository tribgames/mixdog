// A browser fill marked sensitive (a verification code from a mail) runs with
// its value, and no stored copy of the transcript holds it: not the call, the
// provider's echo of it, the mail result before it, or a result after it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-sensitive-values-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const { agentLoop } = await import('./agent-loop.mjs');
const { setInternalToolsProvider } = await import('../internal-tools.mjs');
const { _sessionForDisk } = await import('./store/serialize.mjs');
const { _buildWirePayload } = await import('./store/save-delta.mjs');
const {
  onSensitiveValuesMarked,
  redactSensitiveText: redactSensitive,
  redactSettledText,
  rememberSensitiveValues,
  sensitiveValuesVersion,
} = await import('./sensitive-values.mjs');
const { redactSensitiveMessage } = await import('./sensitive-projection.mjs');
const { validateBrowserToolArgs } = await import('../../../browser-bridge/action-schema.mjs');

const CODE = '682419';
const CODE_ALONE = new RegExp(CODE);
const markFill = (sessionId, text) =>
  rememberSensitiveValues(sessionId, [
    { name: 'browser', arguments: { action: 'fill', input: { ref: 'p1-s1-e3', text, sensitive: true } } },
  ]);

test('a sensitive fill’s value never appears in the stored transcript, before or after the call', async (t) => {
  const scopeId = 'sensitive-values';
  const schema = { type: 'object', properties: {} };
  const tools = [
    { name: 'mail_probe', description: 'Mail.', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'browser', description: 'Browser.', inputSchema: { type: 'object' } },
  ];
  const executed = [];
  t.after(
    setInternalToolsProvider({
      scopeId,
      tools,
      executor: async (name, args) => {
        executed.push({ name, args });
        // The mail carries the code; a page that echoes it is redacted by the desktop, and here again.
        return name === 'mail_probe'
          ? `Your verification code is ${CODE}. Request 7682419 is unrelated.`
          : `Filled.\n- textbox "Code" value=${CODE}`;
      },
    })
  );
  const session = {
    id: 'sensitive-session',
    provider: 'openrouter',
    mcpScopeId: scopeId,
    cwd: process.cwd(),
    toolSpec: 'full',
    compaction: { auto: false },
    deferredProviderMode: 'canonical',
    toolExposureMode: 'bridge-v1',
    tools: [],
    deferredToolCatalog: tools,
    messages: [],
  };
  const fill = { action: 'fill', input: { ref: 'p1-s1-e3', text: CODE, sensitive: true } };
  const requests = [];
  const provider = {
    name: 'openrouter',
    async send(messages) {
      requests.push(JSON.stringify(messages));
      if (requests.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'M', name: 'call_tool', arguments: { name: 'mail_probe', arguments: {} } }],
        };
      }
      if (requests.length === 2) {
        const call = { id: 'F', name: 'call_tool', arguments: { name: 'browser', arguments: fill } };
        return {
          content: '',
          toolCalls: [call],
          assistantBlocks: [{ type: 'tool_use', id: 'F', name: 'call_tool', input: call.arguments }],
        };
      }
      return { content: 'Verified.', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const messages = [{ role: 'user', content: 'Finish the sign-up.' }];
  await agentLoop(provider, messages, 'fixture-model', session.tools, null, session.cwd, {
    session,
    sessionId: session.id,
  });

  assert.equal(executed.at(-1).name, 'browser');
  assert.equal(executed.at(-1).args.input.text, CODE, 'the fill itself runs with the code');
  assert.match(requests[1], CODE_ALONE, 'the model read the code before using it');
  // The live transcript keeps the prefix the provider was sent (the loop ran
  // to its end); what the store writes is redacted.
  const disk = _sessionForDisk({ ...session, messages });
  assert.doesNotMatch(JSON.stringify(disk), CODE_ALONE, 'the stored transcript never holds it');
  const result = (id) => disk.messages.find((message) => message.toolCallId === id).content;
  // Exact substring: wherever the value occurs, inside a longer number too.
  assert.match(result('M'), /code is \[redacted\]\. Request 7\[redacted\] is unrelated/, 'the mail before the call');
  assert.match(result('F'), /value=\[redacted\]/, 'the page reply after it');
  const call = disk.messages.find((message) => message.toolCalls?.some((entry) => entry.id === 'F'));
  assert.equal(call.toolCalls[0].arguments.arguments.input.text, '[redacted]', 'the call');
  assert.equal(call.toolCalls[0].id, 'F', 'its id');
  assert.equal(call.assistantBlocks, undefined, "the provider's echo of the unredacted call is not kept");
});

test('only text is redacted: argument JSON stays valid, ids, timestamps and media stay as they are', () => {
  const id = 'sensitive-shape';
  markFill(id, CODE);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `iVBOR${CODE}w0KGgo=` } };
  const reference = { type: 'image', attachmentRef: `sha256-${CODE}`, mimeType: 'image/png' };
  const assistant = {
    role: 'assistant',
    id: `msg_${CODE}`,
    createdAt: 1_700_000_682_419,
    content: [
      { type: 'text', text: `Entering ${CODE}.` },
      { type: 'tool_result', tool_use_id: `toolu_${CODE}`, content: [{ type: 'text', text: `code ${CODE}` }] },
    ],
    toolCalls: [
      { id: `call_${CODE}`, name: 'browser', arguments: JSON.stringify({ n: Number(CODE), input: { text: CODE } }) },
      { id: 'call_b', name: 'probe', arguments: { nested: JSON.stringify({ code: CODE, count: 2 }), keep: 7 } },
    ],
    thinkingBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
  };
  const stored = redactSensitiveMessage(id, assistant);
  assert.equal(stored.id, assistant.id);
  assert.equal(stored.createdAt, assistant.createdAt);
  assert.equal(stored.role, 'assistant');
  assert.deepEqual(
    stored.toolCalls.map((call) => call.id),
    [`call_${CODE}`, 'call_b'],
    'call ids untouched'
  );
  assert.equal(stored.content[0].text, 'Entering [redacted].', 'a text block');
  assert.equal(stored.content[1].tool_use_id, `toolu_${CODE}`);
  assert.equal(stored.content[1].content[0].text, 'code [redacted]', 'tool-result text');
  assert.deepEqual(JSON.parse(stored.toolCalls[0].arguments), { n: '[redacted]', input: { text: '[redacted]' } });
  assert.deepEqual(stored.toolCalls[1].arguments, {
    nested: JSON.stringify({ code: '[redacted]', count: 2 }),
    keep: 7,
  });
  assert.equal(stored.thinkingBlocks, undefined, 'replay state made for the unredacted message is dropped');

  const media = { role: 'user', ts: 1_700_000_000_000, content: [image, reference, { type: 'text', text: 'see' }] };
  assert.equal(redactSensitiveMessage(id, media), media, 'media encodings and references are no text');
  const result = { role: 'tool', toolCallId: `call_${CODE}`, content: `{"n":${CODE},"ok":true}` };
  const storedResult = redactSensitiveMessage(id, result);
  assert.equal(storedResult.toolCallId, `call_${CODE}`);
  assert.deepEqual(JSON.parse(storedResult.content), { n: '[redacted]', ok: true }, 'JSON text stays JSON');
  // JSON is judged by its decoded values: escapes that spell the code are no hiding place.
  const escaped = `{"text":"${[...CODE].map((digit) => `\\u00${digit.charCodeAt(0).toString(16)}`).join('')}"}`;
  assert.equal(JSON.parse(escaped).text, CODE, 'the probe decodes to the code');
  const probe = redactSensitiveMessage(id, {
    role: 'assistant',
    content: escaped,
    toolCalls: [
      { id: 'call_e', name: 'probe', arguments: escaped },
      { id: 'call_n', name: 'probe', arguments: { outer: JSON.stringify({ inner: escaped }) } },
    ],
  });
  assert.deepEqual(JSON.parse(probe.content), { text: '[redacted]' }, 'JSON content');
  assert.deepEqual(JSON.parse(probe.toolCalls[0].arguments), { text: '[redacted]' }, 'JSON-form arguments');
  const outer = JSON.parse(probe.toolCalls[1].arguments.outer);
  assert.deepEqual(JSON.parse(outer.inner), { text: '[redacted]' }, 'an escaped value nested in JSON strings');
  assert.doesNotMatch(JSON.stringify(probe), new RegExp(CODE));
  const replayOnly = { role: 'assistant', content: 'Done.', reasoningContent: `the code ${CODE}` };
  assert.deepEqual(redactSensitiveMessage(id, replayOnly), { role: 'assistant', content: 'Done.' });
});

test('a transcript saved before the code was marked is written again in full', () => {
  const id = 'sensitive-delta';
  const session = { id, messages: [{ role: 'tool', toolCallId: 'M', content: 'Your code is 482913.' }] };
  assert.ok(_buildWirePayload(id, session).session, 'the first save is a full one');
  session.messages = [...session.messages, { role: 'assistant', content: 'Entering it.' }];
  assert.ok(_buildWirePayload(id, session).delta, 'an append ships only the tail');
  markFill(id, '482913');
  session.messages = [...session.messages, { role: 'tool', toolCallId: 'F', content: 'Filled.' }];
  const payload = _buildWirePayload(id, session);
  assert.ok(payload.session, 'the worker’s copy of the earlier messages is replaced');
  assert.doesNotMatch(JSON.stringify(payload.session), /482913/);
});

test('every value stays known for the session; none is evicted', () => {
  const id = 'sensitive-many';
  const values = Array.from({ length: 200 }, (_, index) => `code-${String(index).padStart(4, '0')}`);
  for (const value of values) markFill(id, value);
  assert.equal(sensitiveValuesVersion(id), values.length);
  assert.equal(redactSensitive(id, `first ${values[0]}, last ${values.at(-1)}`), 'first [redacted], last [redacted]');
  // The longer value is replaced whole, never split by a shorter one inside it.
  markFill(id, 'abcd');
  markFill(id, 'xxabcdxx');
  assert.equal(redactSensitive(id, 'xxabcdxx'), '[redacted]');
});

test('a marker is opaque to redaction: twice is once, the desktop’s marker survives, a value beside one is redacted', () => {
  const twice = (id, text) => {
    const once = redactSensitive(id, text);
    assert.equal(redactSensitive(id, once), once, `redacting twice changes ${JSON.stringify(text)}`);
    return once;
  };
  // A one-character value: the letters of a marker already written are not the value.
  const single = 'sensitive-marker-single';
  markFill(single, 'e');
  assert.equal(twice(single, 'e [redacted] e'), '[redacted] [redacted] [redacted]');
  assert.equal(twice(single, 'see [saved login]'), 's[redacted][redacted] [saved login]', 'the desktop’s marker');
  assert.equal(twice(single, 'e[redacted]e[saved login]e'), '[redacted][redacted][redacted][saved login][redacted]');
  // Overlapping values: a later one never matches inside the marker an earlier one wrote.
  const overlapping = 'sensitive-marker-overlap';
  for (const value of ['abc', 'bcd', 'red', 'cted']) markFill(overlapping, value);
  assert.equal(twice(overlapping, 'abcd red'), '[redacted]d [redacted]');
  assert.equal(
    twice(overlapping, 'abc red [redacted] cted [saved login]'),
    '[redacted] [redacted] [redacted] [redacted] [saved login]'
  );
  // The stored form of a message is as stable.
  const stored = redactSensitiveMessage(single, { role: 'tool', toolCallId: 'T', content: '{"k":"e [saved login]"}' });
  assert.deepEqual(JSON.parse(stored.content), { k: '[redacted] [saved login]' });
  assert.deepEqual(redactSensitiveMessage(single, stored), stored);
});

test('a value that contains or spans marker text is still redacted, and redacting twice is once', () => {
  const id = 'sensitive-marker-contained';
  markFill(id, 'prefix[redacted]suffix');
  markFill(id, 'e');
  markFill(id, 'k[saved');
  const twice = (text) => {
    const once = redactSensitive(id, text);
    assert.equal(redactSensitive(id, once), once, `redacting twice changes ${JSON.stringify(text)}`);
    return once;
  };
  assert.equal(twice('pw=prefix[redacted]suffix'), 'pw=[redacted]');
  assert.equal(twice('pw=prefix[redacted]suffix e [redacted]'), 'pw=[redacted] [redacted] [redacted]');
  assert.equal(twice('k[saved login]'), '[redacted]', 'a marker the value overlaps is taken in whole');
  const stored = redactSensitiveMessage(id, { role: 'tool', toolCallId: 'T', content: 'pw=prefix[redacted]suffix' });
  assert.equal(stored.content, 'pw=[redacted]');
});

test('a replacement that rebuilds a value is redacted again until none shows outside the markers', () => {
  const twice = (id, text) => {
    const once = redactSensitive(id, text);
    assert.equal(redactSensitive(id, once), once, `redacting twice changes ${JSON.stringify(text)}`);
    return once;
  };
  // The marker that replaces the second `a[redacted]` joins the `a` before it.
  const rebuilt = 'sensitive-marker-rebuilt';
  markFill(rebuilt, 'a[redacted]');
  assert.equal(twice(rebuilt, 'aa[redacted]'), '[redacted]');
  assert.equal(twice(rebuilt, 'aaaa[redacted] x'), '[redacted] x');
  // A value that only partly overlaps a marker takes it in whole; none is left broken.
  const partial = 'sensitive-marker-partial';
  markFill(partial, 'd]x');
  assert.equal(twice(partial, 'a [redacted]x'), 'a [redacted]');
  assert.equal(twice(partial, 'a [saved login]d]x'), 'a [saved login][redacted]');
  // A value found only across two adjacent markers is made of marker text, not of a value.
  markFill(partial, 'd][r');
  assert.equal(twice(partial, '[redacted][redacted]'), '[redacted][redacted]');
  // A value that starts with a marker.
  const prefixed = 'sensitive-marker-prefixed';
  markFill(prefixed, '[redacted]suffix');
  markFill(prefixed, 'e');
  assert.equal(twice(prefixed, 'x [redacted]suffix e [redacted]'), 'x [redacted] [redacted] [redacted]');
  // The marker written for the value joins the text after it into the value again.
  assert.equal(twice(prefixed, '[redacted]suffixsuffix'), '[redacted]');
});

// Every prefix of `text` settled, the way a stream is journaled: each result starts the
// next, and none shows what the whole text's redaction hides. Returns the last.
const settledAcrossPrefixes = (id, text) => {
  const redacted = redactSensitive(id, text);
  let previous = '';
  for (let length = 0; length <= text.length; length += 1) {
    const settled = redactSettledText(id, text.slice(0, length));
    const at = `${JSON.stringify(text.slice(0, length))} of ${JSON.stringify(text)}`;
    assert.ok(settled.startsWith(previous), `${JSON.stringify(settled)} does not continue ${JSON.stringify(previous)} at ${at}`);
    assert.ok(redacted.startsWith(settled), `${JSON.stringify(settled)} shows what ${JSON.stringify(redacted)} hides at ${at}`);
    previous = settled;
  }
  return previous;
};

test('settled streaming text only ever grows, and holds back what later text can still turn into a value', () => {
  // A value that starts with a marker: the marker is held until the value is whole, and after it.
  const suffixed = 'sensitive-settled-suffixed';
  markFill(suffixed, '[redacted]suffix');
  for (const text of ['[redacted]', '[redacted]s', '[redacted]suffix']) assert.equal(redactSettledText(suffixed, text), '');
  assert.equal(settledAcrossPrefixes(suffixed, 'pw [redacted]suffix tail'), 'pw [redacted] tail');

  // A replacement that joins the text before it: that text is held too.
  const rebuilt = 'sensitive-settled-rebuilt';
  markFill(rebuilt, 'a[redacted]');
  assert.equal(redactSettledText(rebuilt, 'xaa'), 'x');
  assert.equal(redactSettledText(rebuilt, 'xaa[redacted'), 'x');
  assert.equal(settledAcrossPrefixes(rebuilt, 'xaa[redacted] y'), 'x[redacted] y');

  // A one-character value, in text that writes a marker letter by letter.
  const single = 'sensitive-settled-single';
  markFill(single, 'e');
  assert.equal(redactSettledText(single, 'see [red'), 's[redacted][redacted] ');
  assert.equal(
    settledAcrossPrefixes(single, 'see [redacted] there'),
    's[redacted][redacted] [redacted] th[redacted]r[redacted]'
  );

  // Values that overlap: a longer one that completes later takes back what a shorter one replaced.
  const overlapping = 'sensitive-settled-overlap';
  markFill(overlapping, 'abc');
  markFill(overlapping, 'bcde');
  assert.equal(redactSettledText(overlapping, 'xabc'), 'x');
  assert.equal(settledAcrossPrefixes(overlapping, 'xabcde y'), 'xa[redacted] y');

  // A value that holds marker text, and the markers the held part starts in.
  const contained = 'sensitive-settled-contained';
  for (const value of ['prefix[redacted]suffix', 'k[saved', 'e']) markFill(contained, value);
  assert.equal(
    settledAcrossPrefixes(contained, 'pw=prefix[redacted]suffix k[saved login] e'),
    'pw=[redacted] [redacted] [redacted]'
  );
  const closing = 'sensitive-settled-closing';
  markFill(closing, ']ab');
  assert.equal(redactSettledText(closing, 'code [redacted]'), 'code ', 'a replacement would take the marker in whole');
  assert.equal(redactSettledText(closing, 'code [saved login]'), 'code ');
  assert.equal(redactSettledText(closing, 'code [redacted] ]a'), 'code [redacted] ');
  assert.equal(settledAcrossPrefixes(closing, 'code [redacted] ]ab and ]'), 'code [redacted] [redacted] and ');
});

test('marking notifies the session’s listeners before returning, once per new value', () => {
  const id = 'sensitive-listen';
  const seen = [];
  const stop = onSensitiveValuesMarked(id, (version) => seen.push(version));
  assert.equal(markFill(id, '551177'), true);
  assert.equal(markFill(id, '551177'), false, 'a known value is no news');
  onSensitiveValuesMarked('another-session', () => seen.push('other'));
  markFill(id, '661188');
  stop();
  markFill(id, '771199');
  assert.deepEqual(seen, [1, 2]);
});

test('a sensitive fill of any non-empty length is accepted and its value redacted; an empty one is refused', () => {
  const fill = (input) => validateBrowserToolArgs({ action: 'fill', input });
  assert.equal(fill({ ref: 'p1-s1-e3', text: '123', sensitive: true }).ok, true);
  assert.equal(
    fill({
      fields: [
        { ref: 'p1-s1-e3', text: '1234' },
        { ref: 'p1-s1-e4', text: '12' },
      ],
      sensitive: true,
    }).ok,
    true
  );
  assert.match(fill({ ref: 'p1-s1-e3', text: '', sensitive: true }).error, /must not be empty/);
  assert.equal(fill({ ref: 'p1-s1-e3', text: '12' }).ok, true, 'an ordinary fill is unaffected');
  const id = 'sensitive-short';
  assert.equal(markFill(id, '731'), true);
  assert.equal(redactSensitive(id, 'cvv 731 ok'), 'cvv [redacted] ok');
});

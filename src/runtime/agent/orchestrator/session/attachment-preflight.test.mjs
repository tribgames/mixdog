// Issue #150: eight 37-page scans attached to one message overflowed the
// window on the first send, and the failed turn kept the message, so every
// retry overflowed again. Attachments over the inline budget now travel by
// reference (path, pages, text-layer status) and the model reads the pages it
// needs; the PDF estimate follows the provider's per-page billing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-attachment-preflight-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { estimateMessagesTokens, messageAttachmentBreakdown, pdfPartAllowance } = await import('./context-utils.mjs');
const { referenceOversizedAttachments, messageAttachmentTokens, attachmentInlineBudget } = await import(
  './attachment-preflight.mjs'
);
const { runPreSendCompactPass } = await import('./pre-send-compact.mjs');
const { runFreshContextCompact } = await import('./loop/fresh-context.mjs');
const { attachmentFilePath } = await import('../../../attachments/store.mjs');
const { presentErrorText } = await import('../../../shared/err-text.mjs');

const ref = (n) => n.toString(16).padStart(64, '0');
const scan = (n, pages = 37) => ({
  type: 'file',
  attachmentRef: ref(n),
  mimeType: 'application/pdf',
  filename: `scan-${n}.pdf`,
  sizeBytes: 5 * 1024 * 1024,
  pageCount: pages,
  textPages: 0,
  textChars: 0,
});
const textPdf = (n, pages = 5) => ({
  type: 'file',
  attachmentRef: ref(n),
  mimeType: 'application/pdf',
  filename: `notes-${n}.pdf`,
  sizeBytes: 80_000,
  pageCount: pages,
  textPages: pages,
  textChars: pages * 2_000,
});
const eightScans = () => ({
  role: 'user',
  content: [{ type: 'text', text: 'Summarize these contracts.' }, ...Array.from({ length: 8 }, (_, i) => scan(i + 1))],
});

test('estimate: a page costs its page image plus its text, never its file size', () => {
  assert.equal(pdfPartAllowance(scan(1)), 37 * 1_568, 'a scan is its page images only');
  assert.equal(pdfPartAllowance(textPdf(2, 10)), 10 * 1_568 + 10_000, 'text at two characters per token');
  const { textChars: _chars, ...unmeasured } = textPdf(3, 10);
  assert.equal(pdfPartAllowance(unmeasured), 25_000, 'unmeasured pages keep the documented mid-range');
  const { pageCount: _pages, textPages: _t, textChars: _c, ...unknown } = { ...scan(4), sizeBytes: 1024 * 1024 };
  assert.equal(pdfPartAllowance(unknown), 65_536, 'only an unpaged PDF is sized by bytes');
  assert.equal(pdfPartAllowance(scan(5), { nativePdf: false }), 37 * 1_568);
  // The eight scans of the report: ~464k, not the ~770k the old meter claimed.
  assert.equal(messageAttachmentBreakdown(eightScans()).tokens, 8 * 37 * 1_568);
});

for (const contextWindow of [500_000, 900_000]) {
  test(`preflight: eight 37-page scans go by reference at a ${contextWindow / 1000}k window`, () => {
    const messages = [{ role: 'system', content: 'rules' }, eightScans()];
    const outcome = referenceOversizedAttachments(messages, { contextWindow, nativePdf: true });
    assert.equal(outcome.changed, true);
    assert.equal(outcome.budgetTokens, attachmentInlineBudget(contextWindow));
    const latest = messages[1];
    assert.equal(latest.content[0].text, 'Summarize these contracts.', 'the request itself is untouched');
    assert.equal(latest.content.filter((part) => part.type === 'file').length, 0);
    assert.equal(messageAttachmentTokens(latest), 0);
    const first = latest.content[1];
    assert.equal(first.attachmentReference.attachmentRef, ref(1), 'the blob stays named, so it is kept');
    assert.match(first.text, /"scan-1\.pdf" \(PDF, 37 pages, no text layer \(scanned pages\), 5\.0 MB\)/);
    assert.ok(first.text.includes(`Path: ${attachmentFilePath(ref(1))}`));
    assert.match(first.text, /pages="1-5"/);
    assert.ok(estimateMessagesTokens(messages) < 5_000);
    assert.equal(referenceOversizedAttachments(messages, { contextWindow }).changed, false, 'idempotent');
  });
}

test('a reopened conversation shows the request, not the model-facing reference text', async () => {
  const { restoredUserText } = await import('./transcript-restore/user-text.mjs');
  const messages = [eightScans()];
  referenceOversizedAttachments(messages, { contextWindow: 500_000 });
  assert.equal(restoredUserText(messages[0].content), 'Summarize these contracts.');
});

test('preflight: attachments under the budget stay inline', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'compare' }, textPdf(1), textPdf(2)] }];
  const before = structuredClone(messages);
  assert.equal(referenceOversizedAttachments(messages, { contextWindow: 200_000 }).changed, false);
  assert.deepEqual(messages, before);
});

test('preflight: the oldest attachment messages go first when the transcript holds too many', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }, scan(1, 20)] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'second' }, scan(2, 20)] },
  ];
  // 2 x 31,360 against a 50,000 budget: one must go, the older one.
  const outcome = referenceOversizedAttachments(messages, { contextWindow: 200_000 });
  assert.equal(outcome.referencedMessages, 1);
  assert.ok(messages[0].content[1].attachmentReference);
  assert.equal(messages[2].content[1].type, 'file');
});

test('preflight: a text-only model never gets a scan inline (its text form is empty)', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'read' }, scan(1, 2)] }];
  assert.equal(referenceOversizedAttachments(messages, { contextWindow: 1_000_000, nativePdf: false }).changed, true);
  assert.match(messages[0].content[1].text, /OCR text when the model is text-only/);
  const native = [{ role: 'user', content: [{ type: 'text', text: 'read' }, scan(1, 2)] }];
  assert.equal(referenceOversizedAttachments(native, { contextWindow: 1_000_000, nativePdf: true }).changed, false);
});

test('preflight: images share the budget and go by reference with their message', () => {
  const image = { type: 'image', attachmentRef: ref(9), mimeType: 'image/png', sizeBytes: 2048, filename: 'shot.png' };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, image, ...eightScans().content.slice(1)] },
  ];
  referenceOversizedAttachments(messages, { contextWindow: 500_000 });
  assert.match(messages[0].content[1].text, /^\[Image kept on disk, not inlined: "shot\.png" \(image\/png, 2 KB\)/);
  assert.equal(messages[0].content[1].attachmentReference.kind, 'image');
});

function stuckSession(contextWindow) {
  // The persisted state a failed first send left behind: the attachment
  // message is the latest request.
  return {
    id: `stuck-${contextWindow}`,
    provider: 'stuck-test',
    model: 'stuck-model',
    contextWindow,
    compaction: {},
    messages: [{ role: 'system', content: 'SYSTEM_RULES' }, eightScans()],
  };
}

for (const contextWindow of [500_000, 900_000]) {
  test(`stuck conversation recovers on the next send at a ${contextWindow / 1000}k window`, async () => {
    const session = stuckSession(contextWindow);
    const before = estimateMessagesTokens(session.messages);
    assert.ok(before > contextWindow * 0.5, 'the attachments alone crowd the window');
    const result = await runPreSendCompactPass({
      sessionRef: session,
      sessionId: session.id,
      messages: session.messages,
      requestTools: [],
      opts: {},
    });
    assert.equal(result.providerStateCleared, true);
    const latest = session.messages.at(-1);
    assert.equal(
      latest.content.some((part) => part.type === 'file'),
      false
    );
    assert.equal(latest.content.filter((part) => part.attachmentReference).length, 8);
    assert.ok(estimateMessagesTokens(session.messages) < 10_000);
    // The rewrite is in the live transcript itself, which is what a failed
    // turn persists: a retry starts from the reference form.
    const again = await runPreSendCompactPass({
      sessionRef: session,
      sessionId: session.id,
      messages: session.messages,
      requestTools: [],
      opts: {},
    });
    assert.equal(again.compactChanged, false);
  });
}

// The provider prefix guard: earlier messages may only change at a
// compaction-class boundary. Each "turn" runs the pre-send pass with fresh loop
// options and then projects the request against the previous turn's snapshot,
// as the send phase does.
async function guardedTurn(session, previousGuard) {
  const { projectProviderRequest } = await import('./loop/request-projection.mjs');
  const opts = {};
  const pass = await runPreSendCompactPass({
    sessionRef: session,
    sessionId: session.id,
    messages: session.messages,
    requestTools: [],
    opts,
  });
  const { prefixGuardCandidate } = projectProviderRequest({
    messages: session.messages,
    sendTools: [],
    opts,
    provider: { name: session.provider },
    sessionRef: session,
    sessionId: session.id,
    model: session.model,
    iteration: 1,
    prefixGuardState: previousGuard,
    cacheBreakTraceKeys: new Set(),
  });
  return { pass, opts, guard: prefixGuardCandidate };
}

function guardSession(contextWindow, firstMessage) {
  return {
    id: `guard-${contextWindow}`,
    provider: 'guard-test',
    model: 'guard-model',
    contextWindow,
    compaction: {},
    messages: [{ role: 'system', content: 'SYSTEM_RULES' }, firstMessage],
  };
}

test('prefix guard (a): attachments under the share never touch earlier messages, turn to turn', async () => {
  const session = guardSession(200_000, {
    role: 'user',
    content: [{ type: 'text', text: 'compare' }, textPdf(1), textPdf(2)],
  });
  const first = await guardedTurn(session, null);
  const earlier = JSON.stringify(session.messages);
  session.messages.push({ role: 'assistant', content: 'compared' }, { role: 'user', content: 'and the totals?' });
  const second = await guardedTurn(session, first.guard);
  assert.equal(second.pass.compactChanged, false);
  assert.equal(second.opts.cacheBreakIntent, undefined, 'no cache break is declared');
  assert.equal(JSON.stringify(session.messages.slice(0, 2)), earlier, 'earlier messages are byte-identical');
  assert.deepEqual(second.guard.messageHashes.slice(0, 2), first.guard.messageHashes, 'same provider prefix');
});

test('prefix guard (b, c): a preflight rewrite of an earlier message passes the guard, once', async () => {
  // 20 scanned pages each: 31,360 inline tokens against a 50,000 budget, so the
  // first message fits alone and the second pushes the oldest out.
  const session = guardSession(200_000, { role: 'user', content: [{ type: 'text', text: 'first' }, scan(1, 20)] });
  const first = await guardedTurn(session, null);
  assert.equal(first.pass.compactChanged, false);
  assert.equal(session.messages[1].content[1].type, 'file', 'still inline on turn one');
  session.messages.push(
    { role: 'assistant', content: 'read it' },
    { role: 'user', content: [{ type: 'text', text: 'second' }, scan(2, 20)] }
  );
  // (b) The rewrite lands in an earlier message and is tagged as compaction.
  const second = await guardedTurn(session, first.guard);
  assert.ok(session.messages[1].content[1].attachmentReference, 'the earlier message was rewritten');
  assert.equal(second.opts.cacheBreakIntent, 'automatic_compaction');
  assert.notEqual(second.guard.messageHashes[1], first.guard.messageHashes[1]);
  // (c) The next turn finds nothing to rewrite: no tag, no change, guard passes.
  const settled = JSON.stringify(session.messages);
  session.messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'thanks' });
  const third = await guardedTurn(session, second.guard);
  assert.equal(third.pass.compactChanged, false);
  assert.equal(third.opts.cacheBreakIntent, undefined);
  assert.equal(JSON.stringify(session.messages.slice(0, 4)), settled);
  assert.deepEqual(third.guard.messageHashes.slice(0, 4), second.guard.messageHashes);
});

test('prefix guard: the same rewrite under a transcript-repair tag would be refused', async () => {
  const { prepareProviderPrefixGuard } = await import('./provider-prefix-guard.mjs');
  const before = [{ role: 'user', content: [{ type: 'text', text: 'first' }, scan(1, 20)] }];
  const previous = prepareProviderPrefixGuard(null, before, {}, {});
  const after = [referenceOversizedAttachmentsCopy(before)];
  assert.throws(
    () => prepareProviderPrefixGuard(previous, after, {}, { cacheBreakIntent: 'transcript_rebuild' }),
    /prefix changed outside compaction/
  );
  assert.doesNotThrow(() =>
    prepareProviderPrefixGuard(previous, after, {}, { cacheBreakIntent: 'automatic_compaction' })
  );
});

function referenceOversizedAttachmentsCopy(messages) {
  const copy = structuredClone(messages);
  referenceOversizedAttachments(copy, { contextWindow: 100_000 });
  return copy[0];
}

test('compaction: a latest request whose attachments do not fit keeps its text and references the files', async () => {
  // The report's model family: its calibrated window holds ~357k of local
  // estimate, below the ~464k the eight scans cost inline.
  const session = { ...stuckSession(500_000), provider: 'anthropic' };
  const result = await runFreshContextCompact({
    config: {},
    sessionRef: session,
    messages: session.messages,
    compactBudgetTokens: 125_000,
    compactPolicy: { contextWindow: session.contextWindow, reserveTokens: 0 },
  });
  const latest = result.messages.at(-1);
  assert.equal(latest.content[0].text, 'Summarize these contracts.');
  assert.equal(latest.content.filter((part) => part.attachmentReference).length, 8);
});

test('compaction: a provider overflow refusal references the latest attachments even when the estimate fit', async () => {
  const session = stuckSession(500_000);
  session.messages[1] = { role: 'user', content: [{ type: 'text', text: 'one file' }, scan(1, 3)] };
  const result = await runFreshContextCompact({
    config: {},
    sessionRef: session,
    messages: session.messages,
    compactBudgetTokens: 125_000,
    compactPolicy: { contextWindow: session.contextWindow, reserveTokens: 0 },
    referenceLatestAttachments: true,
  });
  assert.ok(result.messages.at(-1).content[1].attachmentReference);
});

test('compaction: older attachment messages are carried by reference', async () => {
  const session = stuckSession(500_000);
  session.messages = [
    { role: 'system', content: 'SYSTEM_RULES' },
    { role: 'user', content: [{ type: 'text', text: 'earlier' }, textPdf(1)] },
    { role: 'assistant', content: 'read it' },
    { role: 'user', content: 'LATEST_REQUEST' },
  ];
  const result = await runFreshContextCompact({
    config: {},
    sessionRef: session,
    messages: session.messages,
    compactBudgetTokens: 125_000,
    compactPolicy: { contextWindow: session.contextWindow, reserveTokens: 0 },
  });
  const earlier = result.messages.find((m) => m.content?.[0]?.text === 'earlier');
  assert.ok(earlier.content[1].attachmentReference);
  assert.match(earlier.content[1].text, /text layer on every page/);
});

test('a latest message that cannot fit names its size; a bigger window is not promised', async () => {
  const session = stuckSession(40_000);
  session.messages[1] = { role: 'user', content: `${'pasted log line '.repeat(60_000)}` };
  let error;
  try {
    await runFreshContextCompact({
      config: {},
      sessionRef: session,
      messages: session.messages,
      compactBudgetTokens: 10_000,
      compactPolicy: { contextWindow: session.contextWindow, reserveTokens: 0 },
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, 'LATEST_TURN_EXCEEDS_CONTEXT');
  assert.doesNotMatch(error.message, /Increase the model context size/);
  const shown = presentErrorText(new Error(`agent compact failed (x/y, stage=pre_send): ${error.message}`));
  assert.match(shown, /^The latest message cannot fit this model: it needs about [\d,]+ tokens/);
  assert.match(shown, /helps only if it holds/);
});

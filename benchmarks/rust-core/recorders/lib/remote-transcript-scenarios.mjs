// The cases of apps/desktop/src/main/remote-transcript.test.mjs (b6f10295a), as functions of the modules they drive (the recorder passes
// the Node tree's, the desktop's replay the product's). Each returns what the test asserted on: the projected rows, the lengths and
// positions the test measured, and whether a projection returned the host's own object. Frames the encoder produced are recorded as the
// JSON a phone receives (their byte lengths included where the test bounded them).
const SESSION = `sess_desktop_${'b'.repeat(64)}`;
const SESSION_B = `sess_desktop_${'c'.repeat(64)}`;
const LONG = `HEAD-${'x'.repeat(30_000)}-TAIL exit code: 2`;
const SECRET = 'API_TOKEN=sk-live-0123456789';
const quotedDiff = `diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\n--- "a/caf\\303\\251/.env"\n+++ "b/caf\\303\\251/.env"\n@@ -1 +1 @@\n-${SECRET}\n+${SECRET}2\n`;

function toolSnapshot() {
  return {
    items: [
      { id: 'u1', kind: 'user', text: LONG },
      { id: 't1', kind: 'tool', name: 'shell', args: { command: 'build' }, result: LONG, rawResult: LONG },
      { id: 't2', kind: 'tool', name: 'read', result: 'short', rawResult: 'short' },
      { id: 'agg', kind: 'tool', aggregate: true, result: '', toolMembers: [{ id: 'm1', name: 'read', result: LONG, rawResult: 'raw-short', uiDiff: LONG }, { name: 'grep', result: 'ok' }, { name: 'shell', result: LONG }] },
    ],
  };
}

/** Rows that name secret-bearing files in every field a row can carry a path in. */
const secretRows = [
  { id: 'read-env', kind: 'tool', name: 'read', args: { path: '.env' }, result: SECRET, rawResult: SECRET },
  { id: 'array', kind: 'tool', name: 'read', args: { path: ['src/a.ts', '.env'] }, result: SECRET },
  { id: 'reads', kind: 'tool', name: 'read', args: { reads: [{ path: 'src/a.ts' }, { path: 'deploy/id_ed25519' }] }, result: SECRET },
  { id: 'json', kind: 'tool', name: 'read', args: '{"reads":[{"path":".env.production"}]}', result: SECRET },
  { id: 'quoted', kind: 'tool', name: 'edit', args: {}, result: SECRET, uiDiff: quotedDiff },
  { id: 'write', kind: 'tool', name: 'write', args: { path: '.env', content: SECRET }, result: 'ok' },
  { id: 'abs', kind: 'tool', name: 'read', args: { path: '/home/dev/.ssh/id_rsa' }, result: SECRET },
  { id: 'agg', kind: 'tool', aggregate: true, result: '', toolMembers: [{ id: 'agg-ok', name: 'read', args: { path: 'src/a.ts' }, result: 'fine' }, { id: 'agg-env', name: 'read', args: { path: '.env' }, result: SECRET }] },
];

export function remoteTranscriptScenarios(m) {
  const { createRemoteMethods, encodeRelayClientSessionState, REMOTE_OUTPUT_TRUNCATED_FIELD, REMOTE_PROMPT_HISTORY_BUDGET_CHARS, REMOTE_PROMPT_HISTORY_ENTRY_MAX_CHARS, REMOTE_TOOL_OUTPUT_CAP_CHARS, remotePromptHistory, remoteToolOutput, remoteTranscriptSnapshot, createSnapshotDeltaDecoder, READ_NOT_HELD, READ_NOT_VIEWED } = m;
  const wire = (frame) => JSON.parse(JSON.stringify(frame));
  /** Methods for a connection that views `viewed` and was sent `held` for each. */
  function connection(transcripts, { viewed = [SESSION], held = transcripts, cwd = '/work/app' } = {}) {
    const asked = [];
    const methods = createRemoteMethods(
      { host: { readSessionTranscript: async (sessionId) => { asked.push(sessionId); return transcripts[sessionId] ?? null; }, listSessions: async () => Object.keys(transcripts).map((id) => ({ id, cwd })) } },
      { viewedSessionIds: () => viewed, heldTranscript: (sessionId) => remoteTranscriptSnapshot(held[sessionId]) ?? null },
    );
    return { methods, asked };
  }
  const outcome = (promise) => promise.then((value) => ({ resolved: value }), (error) => ({ rejected: error.message }));
  return {
    'the phone receives the approval outcome fields (expired, withdrawn, interrupted) untouched': async () =>
      [{ id: 'a1', approved: false, device: '', expired: true, at: 1 }, { id: 'a2', approved: false, device: '', withdrawn: true, at: 2 }, { id: 'a3', approved: false, device: '', interrupted: true, at: 3 }].map((toolApprovalResult) => ({
        toolApprovalResult,
        sent: remoteTranscriptSnapshot({ ...toolSnapshot(), toolApproval: null, toolApprovalResult }).toolApprovalResult,
      })),
    'a tool output over the cap keeps its head and tail and says how long it was': async () => {
      const shell = remoteTranscriptSnapshot(toolSnapshot()).items[1];
      const { at, omitted } = shell.remoteOutputNotes.result;
      return {
        underCapPlus64: shell.result.length < REMOTE_TOOL_OUTPUT_CAP_CHARS + 64,
        head: shell.result.slice(0, 8),
        tail: shell.result.slice(-18),
        saysOmitted: /omitted/u.test(shell.result),
        note: shell.remoteOutputNotes.result,
        lengthMatchesNote: shell.result.length === LONG.length - omitted,
        tailFollowsCut: shell.result.slice(at) === LONG.slice(at + omitted),
        rawIsResult: shell.rawResult === shell.result,
        truncatedField: shell[REMOTE_OUTPUT_TRUNCATED_FIELD],
        args: shell.args,
        resultLength: shell.result.length,
      };
    },
    'the cap is structural: short outputs, other row kinds and diffs are untouched': async () => {
      const snapshot = toolSnapshot();
      const projected = remoteTranscriptSnapshot(snapshot);
      const [capped, plain, aggregateShell] = projected.items[3].toolMembers;
      return {
        userRowIsHostObject: projected.items[0] === snapshot.items[0],
        shortRowIsHostObject: projected.items[2] === snapshot.items[2],
        shortRowHasTruncatedField: REMOTE_OUTPUT_TRUNCATED_FIELD in projected.items[2],
        cappedUnderCapPlus64: capped.result.length < REMOTE_TOOL_OUTPUT_CAP_CHARS + 64,
        cappedRaw: capped.rawResult,
        diffSentWhole: capped.uiDiff === LONG,
        hasDiffSummary: 'uiDiffSummary' in capped,
        cappedTruncatedField: capped[REMOTE_OUTPUT_TRUNCATED_FIELD],
        plainIsHostObject: plain === snapshot.items[3].toolMembers[1],
        aggregateShellTruncatedField: aggregateShell[REMOTE_OUTPUT_TRUNCATED_FIELD],
        hostCopyUnmodified: snapshot.items[1].result === LONG,
        rowWithoutIdKept: remoteTranscriptSnapshot({ items: [{ kind: 'tool', result: 'short' }] }).items.length,
      };
    },
    'the cut never splits a surrogate pair and is stable for an unchanged row': async () => {
      const emoji = '😀';
      const text = `${'a'.repeat(6_143)}${emoji}${'b'.repeat(20_000)}${emoji}${'c'.repeat(2_047)}`;
      const { result } = remoteTranscriptSnapshot({ items: [{ id: 't', kind: 'tool', result: text }] }).items[0];
      const snapshot = toolSnapshot();
      return { loneSurrogate: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result), resultLength: result.length, stable: remoteTranscriptSnapshot(snapshot).items[1] === remoteTranscriptSnapshot(snapshot).items[1] };
    },
    "a phone's session baseline carries a bounded prompt history, and a submit still patches it": async () => {
      // Pasted briefs: 48 prompts of ~24 KB behind two typed ones, newest first.
      const pasted = Array.from({ length: 48 }, (_, index) => `brief ${index} ${'z'.repeat(24_000)}`);
      const history = ['typed newest', ...pasted.slice(0, 20), 'typed older', ...pasted.slice(20)];
      const snapshot = { sessionId: SESSION, items: [{ id: 'u1', kind: 'user', text: 'hi' }], promptHistoryList: history };
      const encoders = new Map();
      const baseline = encodeRelayClientSessionState(encoders, SESSION, snapshot, false, true, true);
      const baselineBytes = JSON.stringify(baseline).length;
      const decoder = createSnapshotDeltaDecoder();
      const first = decoder.decode(wire(baseline));
      // A budget cut keeps the newest entries that fit.
      const typed = Array.from({ length: 50 }, (_, index) => `typed ${index} ${'y'.repeat(1_300)}`);
      const kept = remotePromptHistory(typed);
      const short = ['b', 'a'];
      // A short submit travels as a head patch against the bounded copy.
      const next = { ...snapshot, promptHistoryList: ['typed submit', ...history].slice(0, 50) };
      const patch = encodeRelayClientSessionState(encoders, SESSION, next, false, true, true);
      const decoded = decoder.decode(wire(patch));
      return {
        baselineBytes,
        baselineWithinBudget: baselineBytes < REMOTE_PROMPT_HISTORY_BUDGET_CHARS + 4_096,
        wholeHistoryBytes: JSON.stringify(history).length,
        firstOk: first.ok,
        firstHistory: first.snapshot.promptHistoryList,
        hostCopyUnmodified: snapshot.promptHistoryList === history,
        keptCount: kept.length,
        keptIsPrefix: JSON.stringify(kept) === JSON.stringify(typed.slice(0, kept.length)),
        keptWithinBudget: kept.length >= 20 && JSON.stringify(kept).length <= REMOTE_PROMPT_HISTORY_BUDGET_CHARS + 4 * kept.length,
        keptEntriesWithinMax: kept.every((entry) => entry.length <= REMOTE_PROMPT_HISTORY_ENTRY_MAX_CHARS),
        sameProjection: remotePromptHistory(typed) === kept,
        shortIsSameList: remotePromptHistory(short) === short,
        patchBytes: JSON.stringify(patch).length,
        patchUnder1024: JSON.stringify(patch).length < 1_024,
        decodedOk: decoded.ok,
        decodedHistory: decoded.snapshot.promptHistoryList,
      };
    },
    'the full output is found by row id, member id or the renderer member name': async () => {
      const snapshot = toolSnapshot();
      return { t1: remoteToolOutput(snapshot, 't1'), m1: remoteToolOutput(snapshot, 'm1'), aggMember2: remoteToolOutput(snapshot, 'agg:member:2'), userRow: remoteToolOutput(snapshot, 'u1'), missing: remoteToolOutput(snapshot, 'missing'), noSnapshot: remoteToolOutput(null, 't1') };
    },
    'readTranscriptItem returns the uncapped output the phone copy was cut from': async () => {
      const snapshot = toolSnapshot();
      const { methods, asked } = connection({ [SESSION]: snapshot });
      const phoneCopy = remoteTranscriptSnapshot(snapshot).items[1];
      const full = await methods.readTranscriptItem([SESSION, phoneCopy.id]);
      return {
        phoneCopyShorter: phoneCopy.result.length < LONG.length,
        asked,
        fullIsLong: full.result === LONG,
        fullRawIsLong: full.rawResult === LONG,
        gone: await methods.readTranscriptItem([SESSION, 'gone']).catch((error) => error.message),
        goneIsNotHeld: (await methods.readTranscriptItem([SESSION, 'gone']).catch((error) => error.message)) === READ_NOT_HELD,
        numericItem: await outcome(methods.readTranscriptItem([SESSION, 7])),
        notASession: await outcome(methods.readTranscriptItem(['not a session', 't1'])),
      };
    },
    'a connection reads only a session it views and a row it was sent': async () => {
      const secret = { items: [{ id: 'b1', kind: 'tool', name: 'shell', args: { command: 'ls' }, result: LONG }] };
      const { methods, asked } = connection({ [SESSION]: toolSnapshot(), [SESSION_B]: secret });
      const unviewed = await outcome(methods.readTranscriptItem([SESSION_B, 'b1']));
      const askedAfterUnviewed = [...asked];
      const otherSessionsRow = await outcome(methods.readTranscriptItem([SESSION, 'b1']));
      const newer = toolSnapshot();
      const sent = { items: newer.items.filter((item) => item.id !== 't1') };
      const behind = connection({ [SESSION]: newer }, { held: { [SESSION]: sent } });
      const notSentYet = await outcome(behind.methods.readTranscriptItem([SESSION, 't1']));
      const bare = createRemoteMethods({ host: { readSessionTranscript: async () => toolSnapshot() } });
      const noRecord = await outcome(bare.readTranscriptItem([SESSION, 't1']));
      return { unviewed, askedAfterUnviewed, otherSessionsRow, notSentYet, noRecord, notViewedText: READ_NOT_VIEWED, notHeldText: READ_NOT_HELD };
    },
    'a row naming a secret-bearing file reaches the phone as the desktop shows it': async () => {
      const projected = remoteTranscriptSnapshot({ items: secretRows });
      const long = { id: 'long-env', kind: 'tool', name: 'read', args: { path: '.env' }, result: `${SECRET}${LONG}` };
      const [capped] = remoteTranscriptSnapshot({ items: [long] }).items;
      return {
        rows: projected.items.map((row, index) => ({ id: row.id, hostObject: row === secretRows[index], hasNotes: 'remoteOutputNotes' in row })),
        writeArgs: projected.items[5].args,
        quotedDiffWhole: projected.items[4].uiDiff === quotedDiff,
        longStartsWithSecret: capped.result.startsWith(SECRET),
        longNote: capped.remoteOutputNotes.result,
      };
    },
    'the full output of a secret-bearing row is read like any other, from any session folder': async () => {
      const folders = [];
      for (const cwd of ['/work/app', '/home/dev/.ssh/project']) {
        const { methods } = connection({ [SESSION]: { items: secretRows } }, { cwd });
        const results = {};
        for (const id of ['read-env', 'array', 'reads', 'json', 'abs', 'agg-env']) results[id] = (await methods.readTranscriptItem([SESSION, id])).result;
        folders.push({ cwd, results, quotedDiff: (await methods.readTranscriptItem([SESSION, 'quoted'])).uiDiff });
      }
      return folders;
    },
    'the session state a phone is sent carries secret-bearing rows whole, baseline and delta': async () => {
      const encoders = new Map();
      const held = [{ id: 'u1', kind: 'user', text: 'read the settings' }];
      const baseline = encodeRelayClientSessionState(encoders, SESSION, { items: held });
      const delta = encodeRelayClientSessionState(encoders, SESSION, { items: [...held, ...secretRows] });
      const decoder = createSnapshotDeltaDecoder();
      const baselineDecoded = decoder.decode(wire(baseline));
      const decoded = decoder.decode(wire(delta));
      return { baseline: wire(baseline), delta: wire(delta), secondFrameIsDelta: Object.hasOwn(delta, '__itemsPatch'), baselineOk: baselineDecoded.ok, decodedOk: decoded.ok, decodedItems: decoded.snapshot.items };
    },
    'a relative path is projected at once, whatever folder the session runs in': async () => {
      const row = { id: 'rel', kind: 'tool', name: 'read', args: { path: 'src/a.ts' }, result: 'code' };
      return { hostObject: remoteTranscriptSnapshot({ items: [row] }).items[0] === row };
    },
  };
}

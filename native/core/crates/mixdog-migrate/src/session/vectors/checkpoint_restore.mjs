// A turn checkpoint whose context state v1.4.5 captured, and the session v1.4.5 recovery
// leaves from it (`turn-checkpoint.mjs:488-503`: splice, `restoreTurnCheckpointContextState`,
// `providerPrefixBaseline`, `activeTurnCheckpoint` deleted), for `splice.rs`. Run from this
// directory against a v1.4.5 checkout with its node_modules:
//   node checkpoint_restore.mjs <v145>/src > checkpoint_restore.json
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.argv[2];
// One stored text attachment, read by the signatures from the data dir's blob store.
const blobText = 'pasted notes\nline 2';
const blobRef = createHash('sha256').update(blobText).digest('hex');
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-restore-golden-'));
const blobDir = join(process.env.MIXDOG_DATA_DIR, 'prompt-attachments', 'sha256', blobRef.slice(0, 2));
mkdirSync(blobDir, { recursive: true });
writeFileSync(join(blobDir, blobRef), blobText);
const mod = (rel) => import(pathToFileURL(join(root, 'runtime/agent/orchestrator/session/manager', rel)).href);
const { checkpointDisposition, captureTurnCheckpointContextState, restoreTurnCheckpointContextState } =
  await mod('turn-checkpoint.mjs');
const { finalizeTurnInterruptionSnapshot } = await mod('turn-interruption.mjs');

const image = { type: 'image', attachmentRef: 'ab'.repeat(32), mimeType: 'image/png', width: 100, height: 50 };
const durableMessages = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'text', attachmentRef: blobRef, textKind: 'file', filename: 'notes.txt' },
      image,
    ],
  },
  { role: 'assistant', content: 'a1' },
];
const turnMessages = [
  { role: 'user', content: 'q' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'x' } }] },
  { role: 'tool', content: 'body', toolCallId: 'c1' },
];
const durable = {
  id: 'sess_r',
  provider: 'anthropic',
  model: 'm1',
  transcriptEpoch: 'e1',
  activeTurnCheckpoint: { turnToken: 't1' },
  compaction: { lastStage: 'idle', boundaryTokens: 90 },
  contextPressureUnanchoredAfterRestart: true,
  contextPressureUnanchoredReason: 'checkpoint_context_mismatch',
  messages: durableMessages,
};
// The turn's working session when its context was captured: the provider's reading covers
// the prompt and the call (4 messages).
const working = {
  ...durable,
  contextPressureBaselineMessageCount: 4,
  contextPressureBaselineTokens: 1234.4,
  contextPressureBaselineOutputTokens: 34,
  contextPressureBaselineToolSignature: 'tools-sig',
  contextPressureBaselineRequestReserveTokens: 12,
  contextPressureBaselineBoundary: 'request',
  contextPressureBaselineUpdatedAt: 5000,
  lastContextTokens: 1180,
  compaction: { boundaryTokens: 100, triggerTokens: 200, lastStage: 'x' },
  providerPrefixBaseline: { hash: 'p1', count: 3 },
};
const contextState = captureTurnCheckpointContextState(working, [...durableMessages, ...turnMessages], 2);
const checkpoint = {
  version: 1,
  sessionId: 'sess_r',
  turnToken: 't1',
  startedAt: 4000,
  base: { epoch: 'e1', length: 2 },
  boundary: 2,
  turnMessages,
  interruption: { responseStarted: true, phase: 'tools' },
  contextState,
};

const disposition = checkpointDisposition(durable, checkpoint);
if (disposition.action !== 'replay') throw new Error(disposition.action);
const finalized = finalizeTurnInterruptionSnapshot({
  turnOutgoing: checkpoint.turnMessages,
  snapshot: checkpoint.interruption,
  abortReason: 'process-crash',
});
const session = structuredClone(durable);
session.messages = [...durable.messages.slice(0, disposition.boundary), ...finalized.messages];
const anchored = restoreTurnCheckpointContextState(session, checkpoint);
if (checkpoint.contextState?.prefixBaseline) session.providerPrefixBaseline = checkpoint.contextState.prefixBaseline;
delete session.activeTurnCheckpoint;
const { messages, ...header } = session;
process.stdout.write(
  `${JSON.stringify({ blob: blobText, durable, checkpoint, anchored, messages, header }, null, 1)}\n`
);

// An agent definition's kind (isContactAgentId reads it), decided read-only —
// the one rule for the runtime and the desktop (which reads `kind` from the
// runtime's catalog rows). Nothing is ever stamped on disk.
//
// An explicit frontmatter `kind` wins (`bot` from the bot dialog and Mixy's
// setup tool, `agent` from the Workflows page and other chats). v1.3.0 wrote
// no marker for bots, and v1.2.6 agents have none either, so an unmarked
// user-made agent is a bot only on evidence that only a v1.3.0 bot creation
// produced:
//   T1  its home thread holds the creation greeting (agentGreetingKickoff,
//       sent only to bots a dialog or the host greeted on creation; agents
//       older than 1.3 were recorded without one);
//   T2  its agent.json has an `avatar` (the bot dialog always sent one) AND
//       its AGENT.md body is the bot dialog's default (agentBodyFromBrief).
// Anything else is a workflow agent, as in v1.2.6.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agentHomeSessionId } from '../agent/orchestrator/session/agent-home.mjs';
import { readMarkdownDocument } from './markdown-frontmatter.mjs';
import { BOT_AGENT_KIND } from './agent-route-config.mjs';
import { botStoreActive, isStoreBot } from './agent-store.mjs';

const RUNTIME_MARKER = '[mixdog-runtime]';
/** The creation greeting's opening (shared/agent-greeting.ts, v1.3.0 on). */
const CREATION_GREETING = /(^|\n)\[mixdog-runtime\] The user just created you as /;
/** The closing lines of the bot dialog's default AGENT.md (agentBodyFromBrief). */
const DIALOG_BODY_TAIL = [
  /^- Help the user( with this role)? in a natural, friendly conversation, in the language they write in\.$/,
  /^- Ask a short question when a request is unclear, and say plainly when something is outside what you do\.$/,
  /^- Keep replies as short or as detailed as the moment needs\.$/,
];

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .join('\n');
}

const NO_HOME = Object.freeze({ exists: false, greeted: false, chatted: false });
// Per session file, keyed by its size and mtime: a home thread is read once
// until it changes.
const homeEvidenceCache = new Map();

/** What `agentId`'s home thread (sessions/sess_home_<id>.json) holds:
 *  whether it exists, whether it has the creation greeting, and whether the
 *  user and the agent talked (any user message that is not a runtime turn,
 *  or any assistant message). A missing or unreadable file holds nothing. */
export function homeThreadEvidence(dataDir, agentId) {
  const sessionId = agentHomeSessionId(agentId);
  if (!dataDir || !sessionId) return NO_HOME;
  const file = join(dataDir, 'sessions', `${sessionId}.json`);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return NO_HOME;
  }
  const cached = homeEvidenceCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
  let messages = [];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(doc?.messages)) messages = doc.messages;
  } catch {
    // unreadable: it proves nothing
  }
  let greeted = false;
  let chatted = false;
  for (const message of messages) {
    if (message?.role === 'assistant') chatted = true;
    if (message?.role !== 'user') continue;
    const text = messageText(message.content);
    if (CREATION_GREETING.test(text)) greeted = true;
    else if (text.trim() && !text.trimStart().startsWith(RUNTIME_MARKER)) chatted = true;
  }
  const value = Object.freeze({ exists: true, greeted, chatted });
  homeEvidenceCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

function isDialogDefaultBody(body) {
  const lines = String(body || '')
    .trim()
    .split(/\r?\n/);
  const tail = lines.slice(-DIALOG_BODY_TAIL.length);
  return tail.length === DIALOG_BODY_TAIL.length && DIALOG_BODY_TAIL.every((line, index) => line.test(tail[index]));
}

/** The definition's kind: the explicit frontmatter kind (lower-cased); else,
 *  for an unmarked user-made agent (`dataDir`/`id` given, not a shipped role),
 *  `bot` on T1 or T2 evidence; else null (a workflow agent). `manifest` and
 *  `body` are the user copy's agent.json and AGENT.md body. */
export function agentDefinitionKind(definition) {
  const { dataDir, id } = definition;
  // Once bots have their own store the folder decides: bots/ holds bots,
  // agents/ workflow agents (an explicit marker still read as written).
  if (dataDir && id && isStoreBot(dataDir, id)) return BOT_AGENT_KIND;
  if (dataDir && botStoreActive(dataDir)) return explicitKind(definition.frontmatterKind);
  return evidenceKind(definition);
}

const explicitKind = (frontmatterKind) =>
  (typeof frontmatterKind === 'string' ? frontmatterKind.trim().toLowerCase() : '') || null;

/** The pre-store rule alone (the split's decision input): the explicit kind,
 *  else `bot` on T1/T2 evidence for an unmarked user-made agent, else null. */
export function evidenceKind({ frontmatterKind, dataDir, shippedRoot, id, manifest, body }) {
  const explicit = explicitKind(frontmatterKind);
  if (explicit) return explicit;
  if (!dataDir || !id || id === 'lead') return null;
  if (shippedRoot && existsSync(join(shippedRoot, 'agents', id, 'AGENT.md'))) return null;
  if (manifest?.avatar && isDialogDefaultBody(body)) return BOT_AGENT_KIND;
  return homeThreadEvidence(dataDir, id).greeted ? BOT_AGENT_KIND : null;
}

/** agentDefinitionKind from the user copy on disk, for readers that have no
 *  loaded definition at hand: a store bot (bots/<id>/) is a bot; any other id
 *  is read from agents/<id>/, else from the shipped role. */
export function readAgentDefinitionKind({ dataDir, shippedRoot, id }) {
  if (isStoreBot(dataDir, id)) return BOT_AGENT_KIND;
  const dir = join(dataDir, 'agents', id);
  let doc;
  try {
    doc = readMarkdownDocument(readFileSync(join(dir, 'AGENT.md'), 'utf8'));
  } catch {
    // No user copy: the shipped role's own frontmatter decides.
    try {
      return agentDefinitionKind({
        frontmatterKind: readMarkdownDocument(readFileSync(join(shippedRoot, 'agents', id, 'AGENT.md'), 'utf8'))
          .frontmatter.kind,
      });
    } catch {
      return null;
    }
  }
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) || {};
  } catch {
    manifest = {};
  }
  return agentDefinitionKind({
    frontmatterKind: doc.frontmatter.kind,
    dataDir,
    shippedRoot,
    id,
    manifest,
    body: doc.body,
  });
}

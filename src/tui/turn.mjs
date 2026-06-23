/**
 * src/tui/turn.mjs — drive ONE engine turn into the pi-tui component tree.
 *
 * Bridge between OUR engine (agentLoop) and pi-tui's differential renderer. The
 * engine is consumed exactly as the REPL consumes it (same contract) — only the
 * *sink* changes: instead of writing to stdout we mutate pi-tui components and
 * call tui.requestRender().
 *
 * Claude-Code shape (refs/claude-code):
 *   onTextDelta  → stream into a `● <markdown>` assistant block (live).
 *   onToolCall   → add a `● tool(args)` card; once the tool's result lands in
 *                  `messages` (keyed by toolCallId) attach the `  ⎿  result` tree.
 *   onUsageDelta → applyUsageDelta + re-render the bottom statusline.
 *   spacing      → a Spacer separates turns, matching CC's vertical rhythm.
 *
 * Robustness: never throws into the TUI. Engine errors render as an error line.
 */
import { Spacer } from '../../vendor/pi/packages/tui/dist/index.js';

import { cyan, dim, red } from '../ui/ansi.mjs';
import { applyUsageDelta, renderStatusline } from '../ui/statusline.mjs';
import {
  createAssistantMarkdown,
  createToolCard,
  createNoticeText,
} from './components.mjs';
import { TURN_MARKER, colors } from './theme.mjs';

/**
 * Insert a component just above the trailing chrome (editor + statusline),
 * mirroring chat-simple.ts's splice but accounting for our two trailing comps.
 */
function insertBeforeTrailing(tui, trailing, component) {
  const children = tui.children;
  const idx = Math.max(0, children.length - trailing);
  children.splice(idx, 0, component);
}

/** Extract a printable string from a tool-result message content field. */
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  // Some tools return structured content arrays ({type,text}); join their text.
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Scan `messages` for tool-result entries and attach each to its card's `⎿`
 * tree (matched by toolCallId). Idempotent: a card whose result is already set
 * is skipped via the `done` set.
 */
function flushToolResults(messages, cardsById, done, tui) {
  let changed = false;
  for (const m of messages) {
    if (!m || m.role !== 'tool') continue;
    const id = m.toolCallId ?? m.tool_call_id ?? m.id;
    if (!id || done.has(id)) continue;
    const card = cardsById.get(id);
    if (!card) continue;
    const isError = m.isError === true || /^\s*\[?error/i.test(toolResultText(m.content));
    card.setResult(toolResultText(m.content), isError);
    done.add(id);
    changed = true;
  }
  if (changed) tui.requestRender();
}

/**
 * Run a single turn.
 *
 * @param {object} ctx — see app.mjs for the wiring.
 */
export async function runTurn({
  tui,
  trailing,
  provider,
  model,
  tools,
  messages,
  stats,
  statusText,
  cwd,
  providerName,
  agentLoop,
}) {
  // Leading spacer so each assistant turn is visually separated from the prior
  // block (CC vertical rhythm).
  insertBeforeTrailing(tui, trailing, new Spacer(1));

  const assistant = createAssistantMarkdown('');
  insertBeforeTrailing(tui, trailing, assistant.component);
  tui.requestRender();

  // Tool cards keyed by toolCallId, plus the set of ids whose `⎿` result is in.
  const cardsById = new Map();
  const resultsDone = new Set();

  const refreshStatus = async () => {
    try {
      const line = await renderStatusline({ provider: providerName, model, cwd, stats });
      statusText.setText(line);
      tui.requestRender();
    } catch {
      // Statusline must never break a turn.
    }
  };

  try {
    const result = await agentLoop(
      provider,
      messages,
      model,
      tools,
      // onToolCall(iter, calls): render a card per call, then flush any results
      // that have already landed for previous calls.
      async (_iter, calls) => {
        for (const c of calls || []) {
          const card = createToolCard(c);
          if (c?.id) cardsById.set(c.id, card);
          insertBeforeTrailing(tui, trailing, card.component);
        }
        flushToolResults(messages, cardsById, resultsDone, tui);
        tui.requestRender();
      },
      cwd,
      {
        sessionId: 'mixdog-cli-tui',
        maxOutputTokens: 8000,
        onTextDelta: (chunk) => {
          // A text delta after tool calls means their results are now in
          // `messages` — attach the `⎿` trees before streaming the next text.
          flushToolResults(messages, cardsById, resultsDone, tui);
          assistant.append(chunk);
          tui.requestRender();
        },
        onUsageDelta: (delta) => {
          applyUsageDelta(stats, delta);
          void refreshStatus();
        },
      },
    );

    // Final pass: attach any remaining tool results.
    flushToolResults(messages, cardsById, resultsDone, tui);

    const finalText = (result?.content != null && String(result.content)) || assistant.get();
    if (finalText) {
      assistant.set(finalText);
    } else if (cardsById.size === 0) {
      // No text and no tools — leave a subtle marker rather than an empty block.
      assistant.set(dim('(no response)'));
    }

    messages.push({ role: 'assistant', content: result?.content ?? finalText ?? '' });

    stats.turns = (stats.turns || 0) + 1;
    await refreshStatus();
    tui.requestRender();
  } catch (error) {
    insertBeforeTrailing(
      tui,
      trailing,
      createNoticeText(`${colors.errorMarker(TURN_MARKER)} ${red(`[error] ${error?.message || error}`)}`),
    );
    tui.requestRender();
  }
}

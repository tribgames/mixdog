#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getDefaultPreset, getPreset } from '../src/runtime/agent/orchestrator/config.mjs';
import { initProviders, getProvider } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import { loadSession } from '../src/runtime/agent/orchestrator/session/store.mjs';
import { compactMessages, semanticCompactMessages } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
let memoryModule = null;

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function textOfResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content.map((part) => part?.type === 'text' ? part.text || '' : JSON.stringify(part)).join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result ?? '', null, 2);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'image') return '[image]';
      return part?.text || '';
    }).filter(Boolean).join('\n');
  }
  try { return JSON.stringify(content ?? ''); } catch { return String(content ?? ''); }
}

function renderMessages(messages) {
  return (messages || [])
    .map((m, i) => `# message ${i + 1} role=${m.role}\n${messageText(m.content)}`.trim())
    .join('\n\n');
}

function coverageScore(sourceText, candidateText) {
  const terms = [...new Set(String(sourceText || '').toLowerCase().match(/[\p{L}\p{N}_./:-]{4,}/gu) || [])]
    .filter((term) => !/^(https?|that|this|with|from|have|there|would|could|should)$/i.test(term))
    .slice(0, 5000);
  if (!terms.length) return 0;
  const hay = String(candidateText || '').toLowerCase();
  let hit = 0;
  for (const term of terms) if (hay.includes(term)) hit += 1;
  return Number((hit / terms.length).toFixed(4));
}

async function timed(label, timings, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    timings[label] = Date.now() - startedAt;
  }
}

async function providerFromConfig(config, { providerName, modelName }) {
  await initProviders(config.providers || {});
  let provider = providerName;
  let model = modelName;
  if (!provider || !model) {
    const presetName = arg('preset', null);
    const preset = presetName ? getPreset(config, presetName) : getDefaultPreset(config);
    provider ||= preset?.provider;
    model ||= preset?.model;
  }
  if (!provider || !model) throw new Error('provider/model required; pass --provider and --model or configure a default preset');
  const impl = getProvider(provider);
  if (!impl) throw new Error(`provider not available: ${provider}`);
  return { provider, model, impl };
}

async function judgePair(provider, model, sourceText, semanticText, candidateBText, candidateBLabel) {
  const safeLabel = String(candidateBLabel || 'candidate_b').replace(/[^a-z0-9_]+/gi, '_').toLowerCase() || 'candidate_b';
  const prompt = `You are judging two context-compression strategies for continuing a coding session.\n\nEvaluate which preserves actionable state better for the next assistant turn. Prefer factual coverage, exact constraints, file paths, decisions, and current task continuity.\n\nReturn strict JSON: {"winner":"semantic"|"${safeLabel}"|"tie","semantic_score":1-10,"${safeLabel}_score":1-10,"reason":"short"}.\n\n# Original session excerpt\n${sourceText.slice(0, 30000)}\n\n# Candidate A: semantic compact\n${semanticText.slice(0, 30000)}\n\n# Candidate B: ${safeLabel}\n${candidateBText.slice(0, 30000)}`;
  const response = await provider.send([
    { role: 'system', content: 'Judge compression quality. Output JSON only.' },
    { role: 'user', content: prompt },
  ], model, undefined, { effort: 'low', fast: true, maxOutputTokens: 800 });
  const text = String(response?.content || '').trim();
  try { return JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()); }
  catch { return { raw: text }; }
}

async function main() {
  if (flag('help') || flag('h')) {
    process.stdout.write('usage: node scripts/session-context-bench.mjs --session <sessionId> [--provider p --model m] [--preset name] [--budget n] [--judge]\n');
    return;
  }
  const sessionId = arg('session');
  if (!sessionId) throw new Error('usage: node scripts/session-context-bench.mjs --session <sessionId> [--provider p --model m] [--judge]');
  const session = loadSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (!messages.length) throw new Error(`session has no messages: ${sessionId}`);

  const config = loadConfig();
  const { provider, model, impl } = await providerFromConfig(config, {
    providerName: arg('provider', session.provider || null),
    modelName: arg('model', session.model || null),
  });

  const timings = {};
  const budget = Number(arg('budget', 16000)) || 16000;
  const semantic = await timed('semantic_compact_ms', timings, () => semanticCompactMessages(impl, messages, model, budget, {
    force: true,
    sessionId,
    providerName: provider,
    tailTurns: Number(arg('tail-turns', 2)) || 2,
    timeoutMs: Number(arg('timeout-ms', 60000)) || 60000,
  }));
  const semanticText = renderMessages(semantic.messages);
  const sourceText = renderMessages(messages);
  const candidateB = String(arg('candidate-b', 'recall_roots') || 'recall_roots').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  let candidateBText = '';
  let candidateBMeta = null;
  if (candidateB === 'deterministic') {
    const deterministic = await timed('deterministic_compact_ms', timings, async () => compactMessages(messages, budget, { force: true }));
    candidateBText = renderMessages(deterministic);
    candidateBMeta = { messages: deterministic.length, tokens: estimateMessagesTokens(deterministic), chars: candidateBText.length, lexicalCoverage: coverageScore(sourceText, candidateBText) };
  } else {
    memoryModule = await import('../src/runtime/memory/index.mjs');
    await timed('memory_init_ms', timings, () => memoryModule.init());
    await timed('recall_ingest_ms', timings, () => memoryModule.handleToolCall('memory', {
      action: 'ingest_session',
      sessionId,
      cwd: session.cwd || ROOT,
      messages,
      limit: Number(arg('ingest-limit', 500)) || 500,
    }));
    await timed('recall_cycle1_ms', timings, () => memoryModule.handleToolCall('memory', {
      action: 'cycle1',
      min_batch: 1,
      session_cap: 1,
      batch_size: Math.max(1, Math.min(200, Number(arg('batch-size', messages.length)) || messages.length)),
    }));
    const recallDumpResult = await timed('recall_dump_ms', timings, () => memoryModule.handleToolCall('memory', {
      action: 'dump_session_roots',
      sessionId,
      includeRaw: true,
      limit: Number(arg('limit', 1000)) || 1000,
    }));
    candidateBText = textOfResult(recallDumpResult);
    candidateBMeta = { chars: candidateBText.length, lexicalCoverage: coverageScore(sourceText, candidateBText) };
  }

  const report = {
    sessionId,
    provider,
    model,
    timings,
    source: { messages: messages.length, tokens: estimateMessagesTokens(messages), chars: sourceText.length },
    semantic: { messages: semantic.messages.length, tokens: estimateMessagesTokens(semantic.messages), chars: semanticText.length, lexicalCoverage: coverageScore(sourceText, semanticText), usage: semantic.usage || null },
    candidateB: { label: candidateB, ...candidateBMeta },
    judge: null,
  };
  if (flag('judge')) {
    report.judge = await timed('judge_ms', timings, () => judgePair(impl, model, sourceText, semanticText, candidateBText, candidateB));
  }

  const outDir = resolve(arg('out', join(ROOT, '.mixdog-bench', `session-context-${sessionId}`)));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'source.txt'), sourceText, 'utf8');
  writeFileSync(join(outDir, 'semantic.txt'), semanticText, 'utf8');
  writeFileSync(join(outDir, `${candidateB}.txt`), candidateBText, 'utf8');
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\noutputs: ${outDir}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (memoryModule?.stop) await memoryModule.stop();
    } catch {}
  });

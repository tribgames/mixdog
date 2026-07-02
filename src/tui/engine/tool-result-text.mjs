/**
 * src/tui/engine/tool-result-text.mjs - flatten tool-result content shapes into
 * display text, plus collapsed-detail/grouped fallbacks and error framing.
 * Extracted from engine.mjs; toolResultText/toolAggregateDetailFallback/
 * toolGroupedDisplayFallback remain part of engine.mjs's public surface.
 */
import { presentErrorText } from '../../runtime/shared/err-text.mjs';

export function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => toolResultPartText(c)).filter((t) => t !== '').join('\n');
  }
  if (typeof content === 'object') {
    if (Array.isArray(content.content)) {
      const nested = content.content.map((c) => toolResultPartText(c)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    } else if (content.content != null && typeof content.content === 'object') {
      const nested = toolResultPartText(content.content);
      if (nested) return nested;
    }
    if (Array.isArray(content.parts)) {
      const nested = content.parts.map((c) => toolResultPartText(c)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    }
    const fromPart = toolResultPartText(content);
    if (fromPart) return fromPart;
    if (content?.type === 'tool_result') return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

const TOOL_RESULT_PART_MAX_DEPTH = 12;
const TOOL_RESULT_JSON_FALLBACK_MAX = 480;
// Absolute cap for a collapsed tool detail line (the second row under the ⎿
// gutter). Terminal-width independent so a wide terminal never lets a long line
// stretch the row; lockstep with ToolExecution RESULT_LINE_HARD_MAX (80).
const TOOL_DETAIL_LINE_MAX = 80;

function compactToolResultObjectFallback(obj) {
  if (obj?.type === 'tool_result') return '';
  try {
    const json = JSON.stringify(obj);
    if (!json || json === '{}') return '';
    if (json.length <= TOOL_RESULT_JSON_FALLBACK_MAX) return json;
    return `${json.slice(0, TOOL_RESULT_JSON_FALLBACK_MAX - 1)}…`;
  } catch {
    return String(obj);
  }
}

export function toolResultPartText(part, depth = 0) {
  if (part == null) return '';
  if (depth > TOOL_RESULT_PART_MAX_DEPTH) return '';
  if (typeof part === 'string') return part;
  if (part?.type === 'image' || part?.type === 'input_image') {
    return `[image: ${part.mimeType || part.mediaType || part.source?.media_type || 'image'}]`;
  }
  if (part?.type === 'tool_result') {
    const inner = part.content;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) {
      return inner.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
    }
    if (inner != null && typeof inner === 'object') {
      return toolResultPartText(inner, depth + 1);
    }
    return '';
  }
  if (part?.type === 'text' || part?.type === 'output_text' || part?.type === 'input_text') {
    return part.text ?? '';
  }
  if (Array.isArray(part)) {
    return part.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
  }
  if (typeof part === 'object') {
    if (Array.isArray(part.content)) {
      const nested = part.content.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    }
    if (part.content != null && typeof part.content === 'object') {
      const nested = toolResultPartText(part.content, depth + 1);
      if (nested) return nested;
    }
    if (Array.isArray(part.parts)) {
      const nested = part.parts.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    }
    if (typeof part.text === 'string' && part.text) return part.text;
    if (typeof part.output === 'string' && part.output) return part.output;
    if (typeof part.message === 'string' && part.message) return part.message;
    if (typeof part.content === 'string') return part.content;
    if (part.source?.type === 'base64' && part.source?.data) {
      return `[image: ${part.source.media_type || part.source.mediaType || 'base64'}]`;
    }
    return compactToolResultObjectFallback(part);
  }
  return '';
}

export function toolAggregateDetailFallback(detailText, rawResult) {
  if (String(detailText || '').trim()) return detailText;
  const raw = String(rawResult || '').replace(/\s+$/, '').trim();
  if (!raw) return detailText;
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return detailText;
  return line.length > TOOL_DETAIL_LINE_MAX ? `${line.slice(0, TOOL_DETAIL_LINE_MAX - 3)}…` : line;
}

export function toolGroupedDisplayFallback(resultText, text, rawText) {
  if (String(resultText || '').trim()) return resultText;
  const body = String(text || rawText || '').trim();
  if (body) return text || rawText;
  return resultText;
}

export function toolErrorDisplay(value, surface = 'tool') {
  const text = presentErrorText(value, { surface });
  if (/^(?:Search failed|Fetch failed|No first response|The .+ went stale|(?:Web search agent|Agent|Tool) (?:stopped|was cancelled))/i.test(text)) {
    return text;
  }
  return /^error\s*:/i.test(text) ? text : `Error: ${text}`;
}

// A provider 400 that names one tool's input schema (Anthropic
// `tools.3.custom.input_schema`, OpenAI `Invalid schema for function 'x'` /
// `tools[3].parameters`, Gemini `function_declarations[3]`): which tool of the
// request it is, so the session can drop it instead of failing every turn.
import { providerToolExclusionReason } from './loop/provider-tool-exclusions.mjs';
import { providerNativeToolPrefixCount } from '../runtime-core/provider-request-tools.mjs';

const MAX_REASON_CHARS = 240;

const text = (value) => (typeof value === 'string' ? value : '');

// Provider-structured places a rejection names its field, best evidence first:
// OpenAI `param` (also nested under `error`), Anthropic / OpenAI `error.message`,
// Google `details[].fieldViolations[].field`, then a JSON body, then the
// error's own message.
function evidence(error) {
  const nested = [error?.error, error?.providerError, error?.response?.data?.error, error?.response?.data];
  const violations = [error?.details, error?.error?.details, error?.errorDetails]
    .flatMap((details) => (Array.isArray(details) ? details : []))
    .flatMap((detail) => (Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []))
    .flatMap((violation) => [text(violation?.field), text(violation?.description)]);
  const bodies = [error?.body, error?.responseBody].map((body) => {
    if (typeof body !== 'string') return [];
    try {
      const parsed = JSON.parse(body);
      return [text(parsed?.error?.param), text(parsed?.error?.message), text(parsed?.message)];
    } catch {
      return [body];
    }
  });
  return [
    error?.param,
    ...nested.map((entry) => entry?.param),
    ...nested.map((entry) => entry?.message),
    ...violations,
    ...bodies.flat(),
    error?.message,
    error?.cause?.message,
  ].filter((entry) => typeof entry === 'string' && entry);
}

// One piece of evidence -> which tool: a wire index (`byIndex`, with the
// OpenAI Responses hosted-tool offset when `shifted`) or a function name.
function target(entry) {
  let match = /\btools\.(\d+)\.(?:custom\.)?input_schema/.exec(entry);
  if (match) return { index: Number(match[1]) };
  match = /\btools(?:\[(\d+)\]|\.(\d+))\.(?:function\.)?parameters/.exec(entry);
  if (match) return { index: Number(match[1] ?? match[2]), shifted: true };
  match = /\b(?:function_declarations|functionDeclarations)(?:\[(\d+)\]|\.(\d+))/.exec(entry);
  if (match) return { index: Number(match[1] ?? match[2]) };
  match = /Invalid schema for function ['"`]([^'"`]+)['"`]/.exec(entry);
  if (match) return { name: match[1] };
  return null;
}

/** `{ name, pointer, reason }` of the tool a schema 400 points at, or null (any
 *  other error, or a tool that is not part of the request's own tools). */
export function rejectedToolSchema(error, { sendTools, sessionRef, opts }) {
  if ((error?.httpStatus ?? error?.status ?? error?.statusCode) !== 400) return null;
  const tools = Array.isArray(sendTools) ? sendTools : [];
  const nativeCount = providerNativeToolPrefixCount(tools);
  // The wire list: the request's tools minus those the wire left out.
  const wire = tools.filter((tool) => !providerToolExclusionReason(sessionRef, tool?.name));
  const hosted =
    sessionRef?.wireRoute?.wire !== 'chat' && Array.isArray(opts?.nativeTools) ? opts.nativeTools.length : 0;
  const entries = evidence(error);
  let name = '';
  for (const entry of entries) {
    const found = target(entry);
    if (!found) continue;
    const shift = found.shifted ? hosted : 0;
    const tool = found.name ? wire.find((t) => t?.name === found.name) : wire[found.index - shift];
    name = typeof tool?.name === 'string' ? tool.name : '';
    if (name) break;
  }
  if (!name || tools.findIndex((t) => t?.name === name) < nativeCount) return null;
  const detail = entries.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
  return { name, pointer: '/', reason: `the provider rejected it with HTTP 400: ${detail}` };
}

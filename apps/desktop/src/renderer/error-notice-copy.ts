import { t } from './i18n';
import { localizedTurnFailureReason } from './transcript-failure-text';

// Runtime phrases use explicit translation keys so catalog extraction keeps
// them even though the failure classifier itself runs outside the renderer.
const copy = new Map<string, () => string>([
  ['An attached image exceeds the provider limit.', () => t('An attached image exceeds the provider limit.')],
  [
    'Reduce the image dimensions or number of images, then try again.',
    () => t('Reduce the image dimensions or number of images, then try again.'),
  ],
  ['The request exceeds the size limit.', () => t('The request exceeds the size limit.')],
  [
    'Reduce the attachments or request size, then try again.',
    () => t('Reduce the attachments or request size, then try again.'),
  ],
  ['The provider usage limit was reached.', () => t('The provider usage limit was reached.')],
  [
    'Wait for the limit to reset or choose another account.',
    () => t('Wait for the limit to reset or choose another account.'),
  ],
  ['Check the connection, then try again.', () => t('Check the connection, then try again.')],
  ['Check your sign-in or API key, then try again.', () => t('Check your sign-in or API key, then try again.')],
  ['The provider rejected this request.', () => t('The provider rejected this request.')],
  ['Review the request details before trying again.', () => t('Review the request details before trying again.')],
  ['Sign-in expired.', () => t('Sign-in expired.')],
  ['Sign in again from Providers.', () => t('Sign in again from Providers.')],
  ['Something went wrong.', () => t('Something went wrong.')],
  ['The provider is busy right now.', () => t('The provider is busy right now.')],
  ['Try again later or choose another model.', () => t('Try again later or choose another model.')],
  [
    'The provider is temporarily rate-limiting requests.',
    () => t('The provider is temporarily rate-limiting requests.'),
  ],
  ['Try again shortly.', () => t('Try again shortly.')],
  ["This model isn't included in your plan.", () => t("This model isn't included in your plan.")],
  [
    'Upgrade your plan, or choose another model or provider.',
    () => t('Upgrade your plan, or choose another model or provider.'),
  ],
  [
    'The provider account is out of credits or at its spend limit.',
    () => t('The provider account is out of credits or at its spend limit.'),
  ],
  [
    'Check your billing with the provider, then try again.',
    () => t('Check your billing with the provider, then try again.'),
  ],
  ["You don't have access to this resource.", () => t("You don't have access to this resource.")],
  [
    'Check your account permissions, or choose another model.',
    () => t('Check your account permissions, or choose another model.'),
  ],
  ['The conversation is too long for this model.', () => t('The conversation is too long for this model.')],
  ['Compact the conversation or start a new one.', () => t('Compact the conversation or start a new one.')],
  [
    'The provider refused this request under its safety policy.',
    () => t('The provider refused this request under its safety policy.'),
  ],
  ['Rephrase the request or choose another model.', () => t('Rephrase the request or choose another model.')],
  [
    'The requested service tier is unavailable right now.',
    () => t('The requested service tier is unavailable right now.'),
  ],
  ['Switch to the standard tier or try again later.', () => t('Switch to the standard tier or try again later.')],
]);

const TOOL_SURFACE_CODE = 'TOOL_SURFACE_EXCEEDS_CONTEXT';
const TOOL_SURFACE_MARK = new RegExp(`\\(${TOOL_SURFACE_CODE}\\)`);

// The runtime words this error in English with the sizes inline (and compaction
// cannot fix it). Each line is matched by shape and re-spoken through keyed
// copy; a line that does not match stays as the runtime wrote it.
const tokenCount = (value: string) => t('{{value}} tokens', { value });

const TOOL_SURFACE_HEADLINES = new Map<string, () => string>([
  [
    'Tool definitions and system context leave no room for conversation history',
    () => t('Tool definitions and system context leave no room for conversation history'),
  ],
  [
    'The configured compaction headroom leaves no room for conversation history',
    () => t('The configured compaction headroom leaves no room for conversation history'),
  ],
]);

const TOOL_SURFACE_REMEDIES = new Map<string, () => string>([
  [
    'Lower the configured headroom (compaction.reservedTokens or MIXDOG_AGENT_COMPACT_RESERVED_TOKENS), or use a model with a larger context window.',
    () =>
      t(
        'Lower the configured headroom (compaction.reservedTokens or MIXDOG_AGENT_COMPACT_RESERVED_TOKENS), or use a model with a larger context window.'
      ),
  ],
  [
    'Use a model with a larger context window, or send a smaller eager tool surface (disable MCP servers or custom tools this session does not need).',
    () =>
      t(
        'Use a model with a larger context window, or send a smaller eager tool surface (disable MCP servers or custom tools this session does not need).'
      ),
  ],
  [
    'Use a model with a larger context window, or send a smaller eager tool surface (disable MCP servers or custom tools this session does not need), or configure fewer reserved tokens (compaction.reservedTokens).',
    () =>
      t(
        'Use a model with a larger context window, or send a smaller eager tool surface (disable MCP servers or custom tools this session does not need), or configure fewer reserved tokens (compaction.reservedTokens).'
      ),
  ],
]);

function localizeToolSurfaceLine(line: string): string {
  const window = /^(.+): context window ([\d,]+) tokens, compaction boundary ([\d,]+) tokens\.$/.exec(line);
  if (window) {
    return t('{{target}}: context window {{window}}, compaction boundary {{boundary}}.', {
      target: window[1],
      window: tokenCount(window[2]),
      boundary: tokenCount(window[3]),
    });
  }
  const fixed =
    /^Fixed per-request overhead: tool definitions ([\d,]+) tokens \((\d+) tools\), protected system context ([\d,]+) tokens, configured headroom ([\d,]+) tokens; nothing remains for conversation history\.$/.exec(
      line
    );
  if (fixed) {
    return t(
      'Fixed per-request overhead: tool definitions {{tools}} ({{toolCount}} tools), protected system context {{system}}, configured headroom {{headroom}}; nothing remains for conversation history.',
      {
        tools: tokenCount(fixed[1]),
        toolCount: fixed[2],
        system: tokenCount(fixed[3]),
        headroom: tokenCount(fixed[4]),
      }
    );
  }
  const measured = /^The provider measured the last request at ([\d,]+) tokens\.$/.exec(line);
  if (measured) return t('The provider measured the last request at {{tokens}}.', { tokens: tokenCount(measured[1]) });
  if (line === 'Compacting the conversation history cannot reduce these.') {
    return t('Compacting the conversation history cannot reduce these.');
  }
  const largest = /^Largest tool definitions: (.+)\.$/.exec(line);
  if (largest) {
    const tools = largest[1]
      .split(/, (?=\S+ \([\d,]+ tokens\))/)
      .map((entry) => {
        const match = /^(\S+) \(([\d,]+) tokens\)$/.exec(entry);
        return match ? `${match[1]} (${tokenCount(match[2])})` : entry;
      })
      .join(', ');
    return t('Largest tool definitions: {{tools}}.', { tools });
  }
  return line;
}

/** The fixed tool-surface overflow in the UI language: its headline (with the
 *  typed code), the remedy as the next step, and the sizes as the details.
 *  Null for any other failure. */
export function localizeToolSurfaceError(details: string): { summary: string; recovery: string; body: string } | null {
  if (!TOOL_SURFACE_MARK.test(details)) return null;
  const lines = details
    .replace(/^\s*Error:\s*/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const head = new RegExp(`^(.*) \\(${TOOL_SURFACE_CODE}\\)\\.$`).exec(lines[0] ?? '');
  if (!head) return null;
  const headline = TOOL_SURFACE_HEADLINES.get(head[1])?.() ?? head[1];
  let recovery = '';
  const body: string[] = [];
  for (const line of lines.slice(1)) {
    const remedy = TOOL_SURFACE_REMEDIES.get(line);
    if (remedy) recovery = remedy();
    else body.push(localizeToolSurfaceLine(line));
  }
  return { summary: `${headline} (${TOOL_SURFACE_CODE})`, recovery, body: body.join('\n') };
}

/** The next-step line of a described error, in the UI language. */
export function localizeErrorRecovery(presentation: {
  recovery: string;
  recoveryTemplate?: string;
  params?: Record<string, string> | null;
}): string {
  const { recovery, recoveryTemplate, params } = presentation;
  if (recoveryTemplate === 'Try again in {{wait}}.') return t('Try again in {{wait}}.', params ?? {});
  if (recoveryTemplate === 'It resets at {{time}}. Switch accounts or providers to continue now.') {
    return t('It resets at {{time}}. Switch accounts or providers to continue now.', params ?? {});
  }
  return localizeErrorCopy(recovery);
}

export function localizeErrorCopy(text: string): string {
  return copy.get(text)?.() ?? localizedTurnFailureReason(text);
}

import type { SVGProps } from 'react';

import type { DesktopModelOption } from '../shared/contract';

import { useAutoEffortShown } from './auto-effort-store';
import { t } from './i18n';
// @ts-expect-error Shared runtime ESM intentionally has no separate declaration file.
import { canonicalModelDisplay } from '../../../../src/ui/model-display.mjs';

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic API',
  'anthropic-api': 'Anthropic API',
  'anthropic-oauth': 'Anthropic OAuth',
  deepseek: 'DeepSeek API',
  'deepseek-api': 'DeepSeek API',
  default: 'Default',
  gemini: 'Gemini API',
  'gemini-api': 'Gemini API',
  'grok-oauth': 'Grok OAuth',
  'muse-code-oauth': 'Muse Code',
  'command-code-oauth': 'Command Code',
  'mimo-oauth': 'MiMo',
  'antigravity-oauth': 'Antigravity OAuth',
  'cursor-oauth': 'Cursor OAuth',
  'mixdog-local': 'Local Provider',
  // Media Studio's NanoGPT lane (the key comes from a NanoGPT custom provider).
  'nano-gpt': 'NanoGPT',
  openai: 'OpenAI API',
  'openai-api': 'OpenAI API',
  'openai-oauth': 'OpenAI OAuth',
  'opencode-go-oauth': 'OpenCode Go OAuth',
  openrouter: 'OpenRouter',
  xai: 'xAI API',
  'xai-api': 'xAI API',
};

const PROVIDER_RANKS: Readonly<Record<string, number>> = {
  default: 0,
  'openai-oauth': 10,
  'anthropic-oauth': 20,
  'grok-oauth': 30,
  'muse-code-oauth': 33,
  'command-code-oauth': 33.5,
  'mimo-oauth': 34,
  'antigravity-oauth': 31,
  'cursor-oauth': 32,
  'opencode-go-oauth': 34.5,
  openai: 40,
  'openai-api': 40,
  anthropic: 50,
  'anthropic-api': 50,
  gemini: 60,
  'gemini-api': 60,
  xai: 70,
  'xai-api': 70,
  deepseek: 90,
  'deepseek-api': 90,
  'mixdog-local': 100,
  // OpenRouter lists hundreds of models, so keep it behind every other provider.
  openrouter: 950,
};

export function providerDisplayName(provider: string | null | undefined) {
  const id = String(provider || '').trim();
  if (!id) return t('Unknown provider');
  const normalized = id.toLowerCase();
  const known = PROVIDER_LABELS[normalized];
  if (known) return known;
  return id;
}

export function providerDisplayRank(provider: string | null | undefined) {
  return (
    PROVIDER_RANKS[
      String(provider || '')
        .trim()
        .toLowerCase()
    ] ?? 900
  );
}

function parsedModelVersion(id: string | null | undefined): number[] {
  const text = String(id || '').toLowerCase();
  const claude = text.match(/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/);
  if (claude) return [Number(claude[1]) || 0, Number(claude[2]) || 0];
  const compact = text.match(
    /(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/
  );
  if (compact)
    return compact
      .slice(1)
      .filter((value): value is string => value != null)
      .map((value) => Number(value) || 0);
  const generic = text.match(/(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
  return generic
    ? generic
        .slice(1)
        .filter((value): value is string => value != null)
        .map((value) => Number(value) || 0)
    : [];
}

function releaseTime(model: DesktopModelOption): number {
  if (model.releaseDate) {
    const value = Date.parse(model.releaseDate);
    if (Number.isFinite(value)) return value;
  }
  const created = Number(model.created);
  if (Number.isFinite(created) && created > 0) return created < 1_000_000_000_000 ? created * 1000 : created;
  const dated = model.model.match(/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/);
  return dated ? Date.parse(`${dated[1]}-${dated[2]}-${dated[3]}`) || 0 : 0;
}

function isClaudeModel(model: DesktopModelOption): boolean {
  return model.provider.toLowerCase().includes('anthropic') && /^claude-[a-z]+-/.test(model.model.toLowerCase());
}

function modelVersion(model: DesktopModelOption): number[] {
  const fromId = parsedModelVersion(model.model);
  return fromId.length ? fromId : parsedModelVersion(model.display);
}

function compareModelVersion(left: DesktopModelOption, right: DesktopModelOption): number {
  const leftVersion = modelVersion(left);
  const rightVersion = modelVersion(right);
  if (!leftVersion.length && !rightVersion.length) return 0;
  if (!leftVersion.length) return 1;
  if (!rightVersion.length) return -1;
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
    const delta = (rightVersion[index] || 0) - (leftVersion[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function compareModelRecency(left: DesktopModelOption, right: DesktopModelOption): number {
  if (isClaudeModel(left) && isClaudeModel(right)) {
    if (Boolean(left.latest) !== Boolean(right.latest)) return left.latest ? -1 : 1;
    const versionDelta = compareModelVersion(left, right);
    if (versionDelta) return versionDelta;
    const leftTime = releaseTime(left);
    const rightTime = releaseTime(right);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return (left.display || left.model).localeCompare(right.display || right.model);
  }

  const leftTime = releaseTime(left);
  const rightTime = releaseTime(right);
  const versionDelta = compareModelVersion(left, right);
  if (leftTime > 0 && rightTime > 0 && leftTime !== rightTime) return rightTime - leftTime;
  if (versionDelta) return versionDelta;
  if (Boolean(left.latest) !== Boolean(right.latest)) return left.latest ? -1 : 1;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return (left.display || left.model).localeCompare(right.display || right.model);
}

function modelFamily(model: DesktopModelOption): string {
  const text = String(model.model || model.display || '').toLowerCase();
  const claude = text.match(/^claude-([a-z]+)/);
  if (claude) return claude[1];
  if (model.family) return model.family.toLowerCase();
  return text.match(/^[a-z]+(?:-[a-z]+)?/)?.[0] || 'model';
}

function modelFamilyLimit(provider: string, family: string): number {
  if (!provider.toLowerCase().includes('anthropic')) return 8;
  return family === 'opus' ? 3 : 1;
}

/** Mirrors the model set and ordering presented by the TUI /model picker. */
export function normalizeModelOptions(models: readonly DesktopModelOption[]): DesktopModelOption[] {
  const providers = new Map<string, Map<string, DesktopModelOption[]>>();
  for (const model of models) {
    if (!model?.provider || !model?.model) continue;
    const families = providers.get(model.provider) || new Map<string, DesktopModelOption[]>();
    const family = modelFamily(model);
    const familyModels = families.get(family) || [];
    familyModels.push(model);
    families.set(family, familyModels);
    providers.set(model.provider, families);
  }

  const normalized: DesktopModelOption[] = [];
  for (const [provider, families] of providers) {
    const providerModels: DesktopModelOption[] = [];
    for (const [family, familyModels] of families) {
      providerModels.push(
        ...familyModels.slice().sort(compareModelRecency).slice(0, modelFamilyLimit(provider, family))
      );
    }
    normalized.push(...providerModels.sort(compareModelRecency));
  }
  return normalized;
}

export function modelFastAvailable(
  model: DesktopModelOption | undefined,
  effort?: string,
  modelParameters: Record<string, string> = {}
): boolean {
  if (!model?.fastCapable) return false;
  if (Array.isArray(model.parameterVariants) && model.parameterVariants.length) {
    return model.parameterVariants.some(
      (variant) =>
        variant.fast === 'true' &&
        (!effort || !variant.effort || variant.effort === effort) &&
        Object.entries(modelParameters).every(([key, value]) => !variant[key] || variant[key] === value)
    );
  }
  if (!Array.isArray(model.fastEfforts) || model.fastEfforts.length === 0) return true;
  return model.fastEfforts.includes(
    String(effort || '')
      .trim()
      .toLowerCase()
  );
}

export function modelContextWindow(model: DesktopModelOption): number {
  const value = Number(model.contextWindow);
  const explicit = Number.isFinite(value) && value > 0 ? value : 0;
  // Provider metadata is authoritative when it is present.  The Claude
  // fallback below only exists for older catalog entries that did not expose
  // a context window at all; inflating an explicit 200k entry to 1M makes the
  // desktop picker disagree with the TUI and with the provider response.
  if (explicit > 0) return explicit;
  const provider = model.provider.toLowerCase();
  const id = model.model.toLowerCase();
  const version = parsedModelVersion(id);
  if (provider.includes('anthropic') && /^claude-[a-z]+-/.test(id)) {
    if ((version[0] || 0) >= 5) return 1_000_000;
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/.test(id)) return 1_000_000;
  }
  return 0;
}

export function modelMaxContextWindow(model: DesktopModelOption): number {
  const current = modelContextWindow(model);
  const raw = Number(model.maxContextWindow);
  return Math.max(current, Number.isFinite(raw) && raw > 0 ? raw : 0);
}

export function formatContextWindow(tokens: number): string {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  const unit = value >= 1024 && (value & (value - 1)) === 0 ? 1024 : 1000;
  const mega = unit * unit;
  if (value >= mega) {
    const millions = value / mega;
    const label = Number.isInteger(millions)
      ? millions.toFixed(0)
      : millions.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${label}M Context`;
  }
  return `${Math.round(value / unit)}k Context`;
}

export function modelOptionDescription(model: DesktopModelOption): string {
  // Context belongs in the model's internal tuning menu, not the model list.
  const description = String(model.description || '')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s*·\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' · ')
    .filter((part) => !/^\d+(?:\.\d+)?\s*[km]\s+context window$/i.test(part))
    .join(' · ');
  return [description, model.fastCapable ? t('Fast Available') : ''].filter(Boolean).join(' · ');
}

// A hint is curated when it is not merely the id re-spaced/re-cased; curated
// hints (user aliases, catalog names with extra meaning) win over the rule.
function displayKey(text: string) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function modelDisplayName(model: string | null | undefined, provider = '', displayHint = '') {
  const raw = String(model || '').trim();
  const id = raw.includes('/') ? raw.split('/').filter(Boolean).at(-1) || raw : raw;
  const hint = String(displayHint || '').trim();
  if (String(provider || '').toLowerCase() === 'cursor-oauth' && hint) return hint;
  if (hint && id && displayKey(hint) !== displayKey(id)) return hint;
  if (id) {
    const canonical = canonicalModelDisplay(id);
    if (canonical && canonical !== id) return canonical;
  }
  if (hint) return hint;
  return id ? canonicalModelDisplay(id) || id : '';
}

export function modelRouteDisplayParts(
  model: string | null | undefined,
  effort: string | null | undefined = '',
  fast = false,
  effortLabel = ''
) {
  const effortValue = String(effort || '').trim();
  const rawEffortLabel = String(effortLabel || effortValue).trim();
  let compactEffort = '';
  if (effortValue.toLowerCase() === 'xhigh' || /^(?:extra[\s-]*high|xhigh)$/i.test(rawEffortLabel)) {
    compactEffort = 'XHigh';
  } else if (rawEffortLabel) {
    compactEffort = `${rawEffortLabel.slice(0, 1).toLocaleUpperCase()}${rawEffortLabel.slice(1)}`;
  }
  return {
    model: String(model || '').trim(),
    effort: compactEffort,
    fast: fast ? 'Fast' : '',
  };
}

/** The route's Daybreak Blue model parameter id; the runtime offers it only on models that accept Blue. */
export const DAYBREAK_PARAMETER_ID = 'daybreak';

/** Blue is on for this route: the toggle is set and, when the model's
 *  parameter options are known, the model actually offers it. */
export function routeDaybreakBlue(
  modelParameters: Record<string, string> | null | undefined,
  options?: DesktopModelOption['modelParameterOptions']
): boolean {
  if (String(modelParameters?.[DAYBREAK_PARAMETER_ID] || '').toLowerCase() !== 'on') return false;
  return !options || options.some((parameter) => parameter.id === DAYBREAK_PARAMETER_ID);
}

export function ModelRouteLabel({
  model,
  effort = '',
  fast = false,
  blue = false,
  effortLabel = '',
  autoEffortCapable = false,
  autoEffort,
  ultra = false,
}: {
  model: string | null | undefined;
  effort?: string | null | undefined;
  fast?: boolean;
  /** The fast route runs the Ultrafast service tier: shown as an orange "Ultrafast". */
  ultra?: boolean;
  /** Daybreak Blue is on: shown right after the model ("GPT-6 Sol Blue XHigh"). */
  blue?: boolean;
  effortLabel?: string;
  /** The model supports Auto reasoning: with the master switch on and this route not opted out, it replaces the saved level. */
  autoEffortCapable?: boolean;
  /** The route's own Auto flag; only `false` opts out, absent means on. */
  autoEffort?: boolean | null;
}) {
  const autoShown = useAutoEffortShown(autoEffortCapable, String(effort || ''), autoEffort);
  const parts = autoShown
    ? modelRouteDisplayParts(model, '', fast, 'Auto')
    : modelRouteDisplayParts(model, effort, fast, effortLabel);
  return (
    <span className="model-route-label">
      {parts.model && <span className="model-route-label-model">{parts.model}</span>}
      {blue && (
        <>
          {parts.model && ' '}
          <span className="model-route-label-blue">Blue</span>
        </>
      )}
      {parts.effort && (
        <>
          {(parts.model || blue) && ' '}
          <span className="model-route-label-effort">{parts.effort}</span>
        </>
      )}
      {parts.fast && (
        <>
          {(parts.model || blue || parts.effort) && ' '}
          {ultra ? (
            <span className="model-route-label-ultra">Ultrafast</span>
          ) : (
            <span className="model-route-label-fast">{parts.fast}</span>
          )}
        </>
      )}
    </span>
  );
}

type ProviderIconKind =
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'google'
  | 'cursor'
  | 'opencode'
  | 'meta'
  | 'xiaomi'
  | 'commandcode'
  | 'deepseek'
  | 'openrouter'
  | 'antigravity'
  | 'local'
  | 'synthetic';

function providerIconKind(provider: string): ProviderIconKind {
  const normalized = provider.toLowerCase();
  if (normalized === 'cursor-oauth') return 'cursor';
  if (normalized.startsWith('muse-code')) return 'meta';
  if (normalized.startsWith('mimo')) return 'xiaomi';
  if (normalized === 'command-code-oauth') return 'commandcode';
  if (normalized === 'antigravity-oauth') return 'antigravity';
  if (normalized === 'opencode-go-oauth') return 'opencode';
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'mixdog-local') return 'local';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('openai') || normalized.includes('codex')) return 'openai';
  if (normalized.includes('anthropic') || normalized.includes('claude')) return 'anthropic';
  if (normalized.includes('xai') || normalized.includes('grok')) return 'xai';
  if (normalized.includes('google') || normalized.includes('gemini')) return 'google';
  return 'synthetic';
}

export function ProviderIcon({ provider, ...props }: SVGProps<SVGSVGElement> & { provider: string }) {
  const kind = providerIconKind(provider);
  return (
    <svg {...props} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false" data-provider-icon={kind}>
      {kind === 'openai' && (
        <path
          fill="currentColor"
          d="M32.84 17.28a8 8 0 0 0-8.72-9.75A8 8 0 0 0 11.28 10.16a8 8 0 0 0-4.13 12.56 8 8 0 0 0 8.72 9.75 8 8 0 0 0 12.84-2.63 8 8 0 0 0 4.13-12.56Zm-11.25 15.75a5.58 5.58 0 0 1-3.66-1.31l6.19-3.57a.8.8 0 0 0 .47-.84v-8.44l2.53 1.5v6.94a5.53 5.53 0 0 1-5.53 5.72ZM9.5 27.87a5.58 5.58 0 0 1-.66-3.75l6.19 3.57c.29.14.63.14.94 0l7.31-4.22v2.91l-6.09 3.56a5.53 5.53 0 0 1-7.69-2.07ZM7.9 14.84a5.58 5.58 0 0 1 2.91-2.44v7.13c0 .37.1.66.47.84l7.31 4.22-2.53 1.5-6-3.47a5.53 5.53 0 0 1-2.16-7.78Zm20.72 4.78-7.31-4.22 2.53-1.5 6 3.47a5.53 5.53 0 0 1-.84 10.13v-7.13c0-.37-.1-.66-.38-.75Zm2.53-3.75-6.19-3.56a.95.95 0 0 0-.94 0l-7.31 4.22v-2.91l6.09-3.56a5.53 5.53 0 0 1 8.35 5.81ZM15.4 21.12l-2.53-1.5v-7.03a5.53 5.53 0 0 1 9.19-4.31l-6.19 3.56a.95.95 0 0 0-.47.84v8.44Zm1.31-3 3.28-1.87 3.28 1.87v3.75l-3.28 1.88-3.28-1.88v-3.75Z"
        />
      )}
      {kind === 'anthropic' && (
        <path
          fill="currentColor"
          d="M26.96 9.88h-4.83l8.65 21.9h4.71l-8.53-21.9Zm-13.93 0L4.49 31.78h4.83l1.91-4.6h8.99l1.79 4.49h4.83L18.08 9.88h-5.05Zm-.45 13.26 2.92-7.75 3.03 7.75h-5.95Z"
        />
      )}
      {kind === 'xai' && (
        <path
          fill="currentColor"
          d="m12.46 15.6 13.69 19.4h-6.08L6.37 15.6h6.09Zm-.01 10.78 3.05 4.31L12.46 35H6.36l6.09-8.62ZM33.64 7.16V35h-4.99V14.22l4.99-7.06Zm0-2.16L20.07 24.22l-3.05-4.31L27.55 5h6.09Z"
        />
      )}
      {kind === 'google' && (
        <path
          fill="currentColor"
          d="M37 20.03C27.88 20.58 20.58 27.88 20.03 37h-.06C19.42 27.88 12.12 20.58 3 20.03v-.06C12.12 19.42 19.42 12.12 19.97 3h.06C20.58 12.12 27.88 19.42 37 19.97v.06Z"
        />
      )}
      {kind === 'cursor' && (
        <g transform="translate(3.8 3.8) scale(1.35)">
          <path fill="currentColor" opacity=".45" d="m11.925 24 10.425-6-10.425-6L1.5 18l10.425 6Z" />
          <path fill="currentColor" opacity=".7" d="M22.35 18V6L11.925 0v12l10.425 6Z" />
          <path
            fill="currentColor"
            d="M11.925 0 1.5 6v12l10.425-6V0Zm10.425 6L11.925 24V12L22.35 6Zm0 0-10.425 6L1.5 6h20.85Z"
          />
        </g>
      )}
      {kind === 'opencode' && (
        <g transform="scale(.078125)">
          <path fill="currentColor" opacity=".45" d="M320 224v128H192V224h128Z" />
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M384 416H128V96h256v320Zm-64-256H192v192h128V160Z"
            clipRule="evenodd"
          />
        </g>
      )}
      {/* Official brand marks below are 24-unit source paths placed in the shared 30-unit box. */}
      {/* Muse Code is Meta's: the Meta mark. */}
      {kind === 'meta' && (
        <g transform="translate(5 5) scale(1.25)">
          <path
            fill="currentColor"
            d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"
          />
        </g>
      )}
      {/* MiMo is Xiaomi's: the Xiaomi mark. */}
      {kind === 'xiaomi' && (
        <g transform="translate(5 5) scale(1.25)">
          <path
            fill="currentColor"
            d="M12 0C8.016 0 4.756.255 2.493 2.516.23 4.776 0 8.033 0 12.012c0 3.98.23 7.235 2.494 9.497C4.757 23.77 8.017 24 12 24c3.983 0 7.243-.23 9.506-2.491C23.77 19.247 24 15.990 24 12.012c0-3.984-.233-7.243-2.502-9.504C19.234.252 15.978 0 12 0zM4.906 7.405h5.624c1.47 0 3.007.068 3.764.827.746.746.827 2.233.83 3.676v4.54a.15.15 0 0 1-.152.147h-1.947a.15.15 0 0 1-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15 0 0 0-.151.147v6.98a.15.15 0 0 1-.152.148H4.906a.15.15 0 0 1-.15-.148V7.554a.15.15 0 0 1 .15-.149zm12.131 0h1.949a.15.15 0 0 1 .15.15v8.892a.15.15 0 0 1-.15.148h-1.949a.15.15 0 0 1-.151-.148V7.554a.15.15 0 0 1 .151-.149zM8.92 10.948h2.046c.083 0 .15.066.15.147v5.352a.15.15 0 0 1-.15.148H8.92a.15.15 0 0 1-.152-.148v-5.352a.15.15 0 0 1 .152-.147Z"
          />
        </g>
      )}
      {kind === 'deepseek' && (
        <g transform="translate(5 5) scale(1.25)">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.670.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
          />
        </g>
      )}
      {kind === 'openrouter' && (
        <g transform="translate(5 5) scale(1.25)">
          <path
            fill="currentColor"
            d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"
          />
        </g>
      )}
      {kind === 'antigravity' && (
        <g transform="translate(5 5) scale(1.25)">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
          />
        </g>
      )}
      {/* Local Provider has no brand: this PC, as a monitor. */}
      {kind === 'local' && (
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="7" width="30" height="20" rx="4" />
          <path d="M14 33h12M20 27v6" />
        </g>
      )}
      {/* Command Code: a terminal prompt (chevron and cursor) in a rounded square. */}
      {kind === 'commandcode' && (
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="5" width="30" height="30" rx="8" />
          <path d="m12.5 14.5 6 5.5-6 5.5M21.5 26h7" />
        </g>
      )}
      {kind === 'synthetic' && (
        <path
          fill="currentColor"
          d="m20 4 2.24 7.76L30 14l-7.76 2.24L20 24l-2.24-7.76L10 14l7.76-2.24L20 4Zm10 18 1.12 3.88L35 27l-3.88 1.12L30 32l-1.12-3.88L25 27l3.88-1.12L30 22ZM11 24l1.4 4.6L17 30l-4.6 1.4L11 36l-1.4-4.6L5 30l4.6-1.4L11 24Z"
        />
      )}
    </svg>
  );
}

/**
 * Pure model display-name helpers shared by the TUI snap path and statusline.
 * No I/O, catalog, or gateway imports — safe for static TUI bundling.
 */

export function titleModelPart(part) {
  const text = String(part || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  if (lower === 'gpt') return 'GPT';
  if (lower === 'api') return 'API';
  if (lower === 'v4') return 'V4';
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function stripModelId(model) {
  const text = String(model || '').trim();
  if (!text) return '';
  return text.includes('/') ? (text.split('/').filter(Boolean).at(-1) || text) : text;
}

function normalizeDisplayHint(displayHint) {
  if (displayHint == null || displayHint === '') return '';
  if (typeof displayHint === 'object') {
    return String(displayHint.displayName || displayHint.display || displayHint.name || '').trim();
  }
  return String(displayHint).trim();
}

export function canonicalModelDisplay(model, provider) {
  void provider;
  const raw = String(model || '')
    .trim()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
  if (!raw) return '';

  const gpt = raw.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (gpt) {
    const suffix = gpt[2]
      ? '-' + gpt[2].split('-').map(titleModelPart).filter(Boolean).join('-')
      : '';
    return `GPT-${gpt[1]}${suffix}`;
  }

  if (/^gpt-/i.test(raw)) {
    return raw
      .split('-')
      .map((part, index) => (index === 0 ? part.toUpperCase() : titleModelPart(part)))
      .filter(Boolean)
      .join('-');
  }

  const openaiO = raw.match(/^o(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (openaiO) {
    const tail = openaiO[2]
      ? ' ' + openaiO[2].split('-').map(titleModelPart).filter(Boolean).join(' ')
      : '';
    return `O${openaiO[1]}${tail}`;
  }

  const codex = raw.match(/^codex-(.+)$/i);
  if (codex) {
    return `Codex ${codex[1].split('-').map(titleModelPart).filter(Boolean).join(' ')}`;
  }

  const deepseek = raw.match(/^deepseek-(.+)$/i);
  if (deepseek) {
    return `DeepSeek ${deepseek[1].split('-').map(titleModelPart).filter(Boolean).join(' ')}`;
  }

  const grok = raw.match(/^grok-(.+)$/i);
  if (grok) {
    return `Grok ${grok[1].split('-').map(titleModelPart).filter(Boolean).join(' ')}`;
  }

  const claudeLegacy = raw.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku|fable)(?:-|$)/i);
  if (claudeLegacy) {
    const version = `${claudeLegacy[1]}${claudeLegacy[2] ? `.${claudeLegacy[2]}` : ''}`;
    return `Claude ${titleModelPart(claudeLegacy[3])} ${version}`;
  }

  const claude = raw.match(/^claude-(opus|sonnet|haiku|fable)-(.+)$/i);
  if (claude) {
    return `Claude ${titleModelPart(claude[1])} ${claude[2].replace(/-/g, '.')}`;
  }

  const gemini = raw.match(/^gemini-(\d+(?:\.\d+)?)-(.+)$/i);
  if (gemini) {
    return `Gemini ${gemini[1]} ${gemini[2].split('-').map(titleModelPart).filter(Boolean).join(' ')}`;
  }

  const geminiLoose = raw.match(/^gemini-(.+)$/i);
  if (geminiLoose) {
    return `Gemini ${geminiLoose[1].split('-').map(titleModelPart).filter(Boolean).join(' ')}`;
  }

  return gatewayBrandDisplay(raw) || raw;
}

// Gateway brands (OpenCode Go and similar) whose ids carry the version
// inside the first token (kimi-k2.7-code, qwen3.8-max, glm-5.3-flash).
// Output follows the models.dev naming so online/offline labels match.
const SPACED_BRANDS = [
  [/^kimi-(.+)$/i, 'Kimi', ' '],
  [/^qwen(\d.*)$/i, 'Qwen', ''],
  [/^mimo-(.+)$/i, 'MiMo', ' '],
  [/^muse-spark-(.+)$/i, 'Muse Spark', ' '],
  [/^hy(\d.*)$/i, 'Hy', ''],
];
const HYPHENATED_BRANDS = [
  [/^glm-(.+)$/i, 'GLM'],
  [/^minimax-(.+)$/i, 'MiniMax'],
  [/^longcat-(.+)$/i, 'LongCat'],
];

// Program-tier tokens the gateway appends to the id but that say nothing
// about the model itself (muse-spark-1.3-contributor → "Muse Spark 1.3").
const BRAND_NOISE_TOKENS = new Set(['contributor']);

function brandVersionPart(part) {
  const text = String(part || '').trim();
  if (!text || BRAND_NOISE_TOKENS.has(text.toLowerCase())) return '';
  // Version-ish tokens (k2.7, v2.5, 3.8, m3) upper-case a single leading
  // letter; word tokens (code, max, flash, contributor) title-case.
  return /^[a-z]?\d/i.test(text) ? text.toUpperCase() : titleModelPart(text);
}

export function gatewayBrandDisplay(raw) {
  for (const [re, brand, joiner] of SPACED_BRANDS) {
    const m = raw.match(re);
    if (!m) continue;
    const tail = m[1].split('-').map(brandVersionPart).filter(Boolean).join(' ');
    return `${brand}${joiner}${tail}`;
  }
  for (const [re, brand] of HYPHENATED_BRANDS) {
    const m = raw.match(re);
    if (!m) continue;
    const tail = m[1].split('-').map(brandVersionPart).filter(Boolean).join('-');
    return `${brand}-${tail}`;
  }
  return '';
}

// A hint is "curated" when it is not merely the id re-spaced/re-cased
// ("Claude Sonnet 4.5" for claude-sonnet-4-5 is not; "Muse Spark 1.3" for
// muse-spark-1.3-contributor is). Curated hints — user aliases and catalog
// names with real extra meaning — win over the id-derived rule.
function displayKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function isCuratedHint(hint, id) {
  return !!hint && !!id && displayKey(hint) !== displayKey(id);
}

export function displayModelName(model, provider = '', displayHint = '') {
  const id = stripModelId(model);
  const hint = normalizeDisplayHint(displayHint);

  if (isCuratedHint(hint, id)) return hint;
  if (id) {
    const canonical = canonicalModelDisplay(id, provider);
    if (canonical && canonical !== id) return canonical;
  }
  if (hint) return hint;
  if (id) return canonicalModelDisplay(id, provider) || id;
  return '';
}

export function shortenModelName(name, cols) {
  let out = String(name || 'model').replace(/\s*\(1M context\)/i, ' (1M)');
  out = out.replace(/^Claude\s+/i, '');
  out = out.replace(/^OpenAI\s+/i, '');
  if (cols < 80 && out.length > 18) return out.slice(0, 17) + '…';
  if (cols < 120 && out.length > 28) return out.slice(0, 27) + '…';
  return out;
}

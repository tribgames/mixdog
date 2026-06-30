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

  const claudeLegacy = raw.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-|$)/i);
  if (claudeLegacy) {
    const version = `${claudeLegacy[1]}${claudeLegacy[2] ? `.${claudeLegacy[2]}` : ''}`;
    return `Claude ${titleModelPart(claudeLegacy[3])} ${version}`;
  }

  const claude = raw.match(/^claude-(opus|sonnet|haiku)-(.+)$/i);
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

  return raw;
}

export function displayModelName(model, provider = '', displayHint = '') {
  const id = stripModelId(model);
  const hint = normalizeDisplayHint(displayHint);

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

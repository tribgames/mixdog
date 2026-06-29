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

export function canonicalModelDisplay(model, provider) {
  const raw = String(model || '').trim().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (!raw) return '';

  const gpt = raw.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (gpt) {
    const suffix = gpt[2]
      ? '-' + gpt[2].split('-').map(titleModelPart).filter(Boolean).join('-')
      : '';
    return `GPT-${gpt[1]}${suffix}`;
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

  const claude = raw.match(/^claude-(opus|sonnet|haiku)-(.+)$/i);
  if (claude) {
    return `Claude ${titleModelPart(claude[1])} ${claude[2].replace(/-/g, '.')}`;
  }

  return raw;
}

export function shortenModelName(name, cols) {
  let out = String(name || 'model').replace(/\s*\(1M context\)/i, ' (1M)');
  out = out.replace(/^Claude\s+/i, '');
  out = out.replace(/^OpenAI\s+/i, '');
  if (cols < 80 && out.length > 18) return out.slice(0, 17) + '…';
  if (cols < 120 && out.length > 28) return out.slice(0, 27) + '…';
  return out;
}

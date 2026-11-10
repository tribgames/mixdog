import stringWidth from 'string-width';

export function truncatePanelText(value, width) {
  const text = String(value || '');
  if (!(width > 0)) return '';
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return '…'.repeat(Math.max(0, width));
  let out = '';
  for (const ch of text) {
    if (stringWidth(`${out}${ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
}

export function padPanelCells(value, width) {
  const text = String(value || '');
  return `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`;
}

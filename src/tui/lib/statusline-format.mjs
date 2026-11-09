// The footer's small formatting primitives (elapsed labels, numeric coercion, terminal width).
import { formatElapsed } from '../../../packages/protocol-client/src/rows/time-format.mjs';

export { formatElapsed };

export function terminalColumns() {
  const cols = Number(process.stdout?.columns);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 120;
}

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Epoch ms from a number or a date string; 0 when neither parses. */
export function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

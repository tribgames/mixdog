/**
 * figures.mjs — TUI glyph constants.
 *
 * Claude Code uses Unicode markers heavily. Modern terminals render these well;
 * set MIXDOG_ASCII_UI=1 to downgrade structural UI markers for legacy/codepage
 * terminals. Content text remains Unicode-capable elsewhere.
 */

import { asciiUiEnabled } from './safe-text.mjs';

const ASCII_UI = asciiUiEnabled();

export const BLACK_CIRCLE = ASCII_UI ? '*' : process.platform === 'darwin' ? '⏺' : '●';
export const BULLET_OPERATOR = ASCII_UI ? '.' : '∙';
export const TEARDROP_ASTERISK = ASCII_UI ? '*' : '✻';
export const UP_ARROW = ASCII_UI ? '^' : '↑';
export const DOWN_ARROW = ASCII_UI ? 'v' : '↓';
export const LIGHTNING_BOLT = ASCII_UI ? '!' : '↯';
export const EFFORT_LOW = ASCII_UI ? 'L' : '○';
export const EFFORT_MEDIUM = ASCII_UI ? 'M' : '◐';
export const EFFORT_HIGH = ASCII_UI ? 'H' : '●';
export const EFFORT_MAX = ASCII_UI ? 'X' : '◉';

// Media/trigger status indicators
export const PLAY_ICON = ASCII_UI ? '>' : '▶';
export const PAUSE_ICON = ASCII_UI ? '|' : '⏸';

// MCP subscription indicators
export const REFRESH_ARROW = ASCII_UI ? '~' : '↻';
export const CHANNEL_ARROW = ASCII_UI ? '<' : '←';
export const INJECTED_ARROW = ASCII_UI ? '>' : '→';
export const FORK_GLYPH = ASCII_UI ? 'Y' : '⑂';

// Review status indicators
export const DIAMOND_OPEN = ASCII_UI ? '*' : '◇';
export const DIAMOND_FILLED = ASCII_UI ? '*' : '◆';
export const REFERENCE_MARK = ASCII_UI ? '*' : '※';

// Issue flag indicator
export const FLAG_ICON = ASCII_UI ? '!' : '⚑';

// Blockquote indicator
export const BLOCKQUOTE_BAR = ASCII_UI ? '|' : '▎';
export const HEAVY_HORIZONTAL = ASCII_UI ? '-' : '━';

// The "therefore" sign — Claude Code's collapsed-thinking prefix (∴ Thinking).
export const THEREFORE = ASCII_UI ? '*' : '∴';

// Prompt pointer (CC uses figures.pointer ❯ for the input glyph).
export const POINTER = ASCII_UI ? '>' : '❯';

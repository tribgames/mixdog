/**
 * components/AnsiText.jsx — render ANSI SGR text as ink <Text> spans.
 *
 * Parses ANSI into styled Text nodes instead of relying on raw
 * escape passthrough. This keeps markdown emphasis/code colors stable when an
 * inner span resets color back to the default.
 */
import React from 'react';
import { Text } from 'ink';
import { theme, getThemeVersion } from '../theme.mjs';

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

// Resolve the named SGR (30-37/90-97) → theme color map at call time so a
// live `/theme` switch is honored. `theme` is mutated in-place on switch, so
// reading the keys per parse keeps colors in sync without a module reload.
function ansiColorMap() {
  return {
    30: theme.subtle,
    31: theme.error,
    32: theme.success,
    33: theme.warning,
    34: theme.code,
    35: 'ansi:magenta',
    36: 'ansi:cyan',
    37: theme.text,
    90: theme.subtle,
    91: theme.error,
    92: theme.success,
    93: theme.warning,
    94: theme.code,
    95: 'ansi:magentaBright',
    96: 'ansi:cyanBright',
    97: theme.statusText,
  };
}

const ANSI_BG_COLORS = {
  40: 'ansi:black',
  41: 'ansi:red',
  42: 'ansi:green',
  43: 'ansi:yellow',
  44: 'ansi:blue',
  45: 'ansi:magenta',
  46: 'ansi:cyan',
  47: 'ansi:white',
  100: 'ansi:blackBright',
  101: 'ansi:redBright',
  102: 'ansi:greenBright',
  103: 'ansi:yellowBright',
  104: 'ansi:blueBright',
  105: 'ansi:magentaBright',
  106: 'ansi:cyanBright',
  107: 'ansi:whiteBright',
};

function defaultState(defaultColor) {
  return {
    color: defaultColor,
    backgroundColor: undefined,
    bold: false,
    dimColor: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function cloneState(state) {
  return { ...state };
}

// xterm-256 indexes 0-15 are the named SGR colors, so they resolve through the
// same theme maps as `31`/`41` instead of a hard-coded palette.
const ANSI_256_NAMED = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
const ANSI_256_NAMED_BG = [40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107];

// 16-231 is the 6×6×6 color cube, 232-255 the 24-step gray ramp.
function xterm256Rgb(index) {
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray},${gray},${gray})`;
  }
  const offset = index - 16;
  const level = (step) => (step ? 55 + step * 40 : 0);
  return `rgb(${level(Math.floor(offset / 36))},${level(Math.floor(offset / 6) % 6)},${level(offset % 6)})`;
}

// `38`/`48` carry either the truecolor form `;2;r;g;b` or the 256-color form
// `;5;n`. Both are decoded here, with the number of trailing codes the caller
// must skip: an undecoded `;5;n` used to fall through to the named-color
// default, where neither `5` nor `n` matches and the color was dropped.
function extendedColor(codes, index, palette) {
  const kind = codes[index + 1];
  if (kind === 2) {
    const r = codes[index + 2];
    const g = codes[index + 3];
    const b = codes[index + 4];
    if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
    return { color: `rgb(${r},${g},${b})`, consumed: 4 };
  }
  if (kind === 5) {
    const value = codes[index + 2];
    if (!Number.isFinite(value) || value < 0 || value > 255) return null;
    return { color: palette(value), consumed: 2 };
  }
  return null;
}

function applySgr(state, codes, defaultColor, ansiColors) {
  if (!codes.length) codes = [0];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    switch (code) {
      case 0:
        Object.assign(state, defaultState(defaultColor));
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.dimColor = true;
        break;
      case 3:
        state.italic = true;
        break;
      case 4:
        state.underline = true;
        break;
      case 7:
        state.inverse = true;
        break;
      case 22:
        state.bold = false;
        state.dimColor = false;
        break;
      case 23:
        state.italic = false;
        break;
      case 24:
        state.underline = false;
        break;
      case 27:
        state.inverse = false;
        break;
      case 38: {
        const resolved = extendedColor(codes, i, (value) =>
          value < 16 ? ansiColors[ANSI_256_NAMED[value]] : xterm256Rgb(value)
        );
        if (resolved) {
          state.color = resolved.color;
          i += resolved.consumed;
        }
        break;
      }
      case 48: {
        const resolved = extendedColor(codes, i, (value) =>
          value < 16 ? ANSI_BG_COLORS[ANSI_256_NAMED_BG[value]] : xterm256Rgb(value)
        );
        if (resolved) {
          state.backgroundColor = resolved.color;
          i += resolved.consumed;
        }
        break;
      }
      case 39:
        state.color = defaultColor;
        break;
      case 49:
        state.backgroundColor = undefined;
        break;
      default:
        if (ansiColors[code]) {
          state.color = ansiColors[code];
        } else if (ANSI_BG_COLORS[code]) {
          state.backgroundColor = ANSI_BG_COLORS[code];
        }
        break;
    }
  }
}

function parseAnsi(text, defaultColor) {
  const source = String(text ?? '');
  const spans = [];
  const state = defaultState(defaultColor);
  const ansiColors = ansiColorMap();
  let lastIndex = 0;

  for (const match of source.matchAll(ANSI_RE)) {
    if (match.index > lastIndex) {
      spans.push({ text: source.slice(lastIndex, match.index), style: cloneState(state) });
    }
    const codes = String(match[1] || '')
      .split(';')
      .filter(Boolean)
      .map((n) => Number(n));
    applySgr(state, codes, defaultColor, ansiColors);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    spans.push({ text: source.slice(lastIndex), style: cloneState(state) });
  }

  return spans;
}

export function AnsiText({ children, defaultColor, wrap }) {
  // ansiColorMap() reads live theme.* keys, so the parsed spans depend on the
  // active theme. Include the theme version in the memo deps so a /theme switch
  // re-parses with the new palette instead of reusing stale span colors.
  const themeVersion = getThemeVersion();
  const spans = React.useMemo(() => parseAnsi(children, defaultColor), [children, defaultColor, themeVersion]);

  return (
    <Text wrap={wrap}>
      {spans.map((span, index) => (
        <Text
          key={index}
          color={span.style.color}
          backgroundColor={span.style.backgroundColor}
          // Honor SGR bold only on spans that chalk/markdown set (e.g. **strong**,
          // headings). Do not force bold globally — avoids fuzzy Korean body text
          // when models emit no bold codes.
          bold={span.style.bold}
          dimColor={span.style.dimColor}
          italic={span.style.italic}
          underline={span.style.underline}
          inverse={span.style.inverse}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

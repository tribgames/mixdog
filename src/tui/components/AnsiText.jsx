/**
 * components/AnsiText.jsx — render ANSI SGR text as ink <Text> spans.
 *
 * Parses ANSI into styled Text nodes instead of relying on raw
 * escape passthrough. This keeps markdown emphasis/code colors stable when an
 * inner span resets color back to the default.
 */
import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.mjs';

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

function rgbCode(codes, index) {
  if (codes[index + 1] !== 2) return null;
  const r = codes[index + 2];
  const g = codes[index + 3];
  const b = codes[index + 4];
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  return `rgb(${r},${g},${b})`;
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
        const color = rgbCode(codes, i);
        if (color) {
          state.color = color;
          i += 4;
        }
        break;
      }
      case 48: {
        const color = rgbCode(codes, i);
        if (color) {
          state.backgroundColor = color;
          i += 4;
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
  let match;

  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(source)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ text: source.slice(lastIndex, match.index), style: cloneState(state) });
    }
    const codes = String(match[1] || '')
      .split(';')
      .filter(Boolean)
      .map((n) => Number(n));
    applySgr(state, codes, defaultColor, ansiColors);
    lastIndex = ANSI_RE.lastIndex;
  }

  if (lastIndex < source.length) {
    spans.push({ text: source.slice(lastIndex), style: cloneState(state) });
  }

  return spans;
}

export function AnsiText({ children, defaultColor, wrap }) {
  const spans = React.useMemo(
    () => parseAnsi(children, defaultColor),
    [children, defaultColor],
  );

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

// use-global-key-input/shift-arrow.mjs
// Decoding of the grid-selection move chord. Terminals that do not set the
// shift flag deliver the chord as a raw CSI sequence instead, so both shapes
// have to be recognised before the handler can claim the keypress.
const RAW_SHIFT_ARROWS = {
  up: ['\x1b[1;2A', '\x1b[a', '[1;2A', '\x1b[1;6A', '[1;6A'],
  down: ['\x1b[1;2B', '\x1b[b', '[1;2B', '\x1b[1;6B', '[1;6B'],
  right: ['\x1b[1;2C', '\x1b[c', '[1;2C', '\x1b[1;6C', '[1;6C'],
  left: ['\x1b[1;2D', '\x1b[d', '[1;2D', '\x1b[1;6D', '[1;6D'],
};

/**
 * { isChord, move } for a keypress: `isChord` is whether this is a
 * grid-selection move chord at all, `move` the direction it asks for.
 */
export function decodeSelectionMoveChord(input, key) {
  const rawDirection = Object.keys(RAW_SHIFT_ARROWS).find((direction) => RAW_SHIFT_ARROWS[direction].includes(input));
  const isChord = Boolean(
    rawDirection ||
      (key.shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end))
  );
  let move = null;
  if (key.leftArrow || rawDirection === 'left') move = 'left';
  else if (key.rightArrow || rawDirection === 'right') move = 'right';
  else if (key.upArrow || rawDirection === 'up') move = 'up';
  else if (key.downArrow || rawDirection === 'down') move = 'down';
  else if (key.home) move = 'lineStart';
  else if (key.end) move = 'lineEnd';
  return { isChord, move };
}

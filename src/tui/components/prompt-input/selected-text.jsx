/**
 * components/prompt-input/selected-text.jsx — render a draft slice with its
 * selection range highlighted. Shared by the prompt input and the inline
 * text-entry panel so both paint a selection identically.
 */
import { Text } from 'ink';
import { theme } from '../../theme.mjs';

export function renderSelectedText(displayValue, range, trailingSpace = false) {
  if (!range) return trailingSpace ? `${displayValue} ` : displayValue;
  const start = Math.max(0, Math.min(displayValue.length, range.start));
  const end = Math.max(start, Math.min(displayValue.length, range.end));
  return (
    <>
      {start > 0 ? displayValue.slice(0, start) : null}
      {end > start ? (
        <Text color={theme.selectionText} backgroundColor={theme.selectionBackground}>
          {displayValue.slice(start, end)}
        </Text>
      ) : null}
      {displayValue.slice(end)}
      {trailingSpace ? ' ' : ''}
    </>
  );
}

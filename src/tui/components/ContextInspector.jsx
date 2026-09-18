import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { buildContextMap } from '../../ui/context-inspection.mjs';
import { theme } from '../theme.mjs';

const COLORS = { system: 'gray', tools: 'green', mcp: 'magenta', agents: 'magenta', memory: 'cyan', skills: 'yellow', user: 'blue', assistant: 'blueBright', toolResults: 'greenBright', attachments: 'redBright', free: 'gray' };

function fitLine(text, width) {
  let result = '';
  for (const character of String(text)) {
    if (stringWidth(result + character) > width) break;
    result += character;
  }
  return result;
}

export function ContextInspector({ inspection, columns, rows = 16, windowTokens, onInspect, onRefresh }) {
  const [category, setCategory] = useState('');
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState(null);
  const [scroll, setScroll] = useState(0);
  const [fit, setFit] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const width = Math.max(4, columns - 4);
  const choices = category ? inspection.entries.filter((entry) => entry.category === category) : inspection.categories;
  const visibleRows = Math.max(1, rows - (category ? 3 : 7));
  const previewRows = Math.max(1, rows - 2);
  const lines = preview ? wrapAnsi(preview.text || '', width, { hard: true, trim: false }).split('\n') : [];
  const openEntry = async () => {
    const entry = choices[index];
    if (!entry) return;
    if (!category) {
      setCategory(entry.key);
      setIndex(0);
      return;
    }
    const token = ++request.current;
    setScroll(0);
    setPreview({ text: 'Loading preview…' });
    try {
      const result = await onInspect(entry.id, inspection.revision);
      if (request.current !== token) return;
      setPreview(result?.stale
        ? { text: 'Context changed. Press R to refresh.' }
        : result || { text: 'Preview unavailable.' });
    } catch {
      if (request.current === token) setPreview({ text: 'Preview unavailable. Press R to retry.' });
    }
  };
  useInput((input, key) => {
    if (input === 'r') { void onRefresh?.(); return; }
    if (input === 'z' && !category && !preview) { setFit((value) => !value); return; }
    if (key.backspace || key.leftArrow) {
      request.current += 1;
      if (preview) setPreview(null);
      else { setCategory(''); setIndex(0); }
      return;
    }
    if (key.return && !preview) { void openEntry(); return; }
    const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -visibleRows : key.pageDown ? visibleRows : 0;
    if (!delta) return;
    if (preview) setScroll((value) => Math.max(0, Math.min(Math.max(0, lines.length - previewRows), value + delta)));
    else setIndex((value) => Math.max(0, Math.min(choices.length - 1, value + delta)));
  });
  const mapColumns = Math.max(4, Math.min(32, width));
  const map = buildContextMap(inspection.categories, { windowTokens, cells: mapColumns * 3, fit });
  const start = Math.max(0, index - visibleRows + 1);
  return (
    <Box flexDirection="column" height={Math.max(1, rows)} overflow="hidden">
      <Text color={theme.subtle}>{fitLine('↑↓ select · Enter inspect · ← back · Z zoom · R refresh', width)}</Text>
      {preview ? (
        <>
          <Text color={theme.subtle}>{fitLine(preview.truncated ? 'Preview limited to 32,000 characters.' : 'Local preview · opaque data excluded', width)}</Text>
          {lines.slice(scroll, scroll + previewRows).map((line, lineIndex) => <Text key={lineIndex}>{line || ' '}</Text>)}
        </>
      ) : (
        <>
          {!category && (
            <>
              <Text color={theme.subtle}>{fitLine(`Estimated composition · ${fit ? 'Fit' : 'Window'}${map.overflow ? ' · over window' : ''}`, width)}</Text>
              {[0, 1, 2].map((row) => (
                <Text key={row}>
                  {map.cells.slice(row * mapColumns, (row + 1) * mapColumns).map((key, cell) =>
                    <Text key={cell} color={COLORS[key]}>{key === 'free' ? '·' : '■'}</Text>
                  )}
                </Text>
              ))}
              <Text color={theme.subtle}>{fitLine('· free', width)}</Text>
              <Text color={theme.subtle}>
                {fitLine(
                  inspection.calibration?.source === 'provider'
                    ? `Scaled to measured ${Number(inspection.calibration.measuredTokens || 0).toLocaleString()} (×${Number(inspection.calibration.ratio || 1).toFixed(2)}) · raw ≈${Number(inspection.calibration.estimatedTokens || 0).toLocaleString()}`
                    : 'Local estimates · no provider reading covers this transcript yet',
                  width
                )}
              </Text>
            </>
          )}
          {category && <Text bold>{fitLine(inspection.categories.find((row) => row.key === category)?.label || '', width)}</Text>}
          {choices.slice(start, start + visibleRows).map((row, offset) => (
            <Text key={row.id || row.key} color={index === start + offset ? theme.accent : row.state === 'deferred' ? theme.subtle : theme.text}>
              {fitLine(
                `${index === start + offset ? '›' : ' '} ${row.label} · ${row.state === 'deferred' ? 'deferred' : `≈${row.tokens.toLocaleString()}`}` +
                  `${row.state && row.state !== 'deferred' && row.state !== 'active' ? ` · ${row.state}` : ''}` +
                  `${row.toolResults?.length ? ` · ${row.toolResults.map((result) => result.name).join(', ')}` : ''}` +
                  `${row.count !== undefined ? ` · ${row.count} items` : ''}`,
                width
              )}
            </Text>
          ))}
          {!choices.length && <Text color={theme.subtle}>No entries.</Text>}
        </>
      )}
    </Box>
  );
}

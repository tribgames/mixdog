/**
 * components/BtwPanel.jsx — transient `/btw` side-question panel above the prompt.
 */
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.mjs';
import { Markdown } from './Markdown.jsx';
import { BTW_CHROME_ROWS, btwContentRows, btwScrollMax, btwScrollOffset } from '../app/btw-controller.mjs';

export function BtwPanel({ panel, columns = 80, panelRows, themeEpoch = 0 }) {
  const bodyRows = Math.max(1, (panelRows ?? BTW_CHROME_ROWS + 1) - BTW_CHROME_ROWS);
  const total = btwContentRows(panel, columns);
  const maxOffset = btwScrollMax(total, bodyRows);
  const [offset, setOffset] = useState(0);
  const top = Math.min(offset, maxOffset);
  const scrollable = maxOffset > 0;

  // A new question or a settled answer starts from the top.
  useEffect(() => {
    setOffset(0);
  }, [panel.question, panel.status]);

  useInput((_input, key) => {
    if (!scrollable || (!key.pageUp && !key.pageDown)) return;
    setOffset((current) => btwScrollOffset(key, current, bodyRows, total));
  });

  let body;
  if (panel.status === 'pending') body = <Text color={theme.inactive}>answering… (Esc to cancel)</Text>;
  else if (panel.status === 'error') body = <Text color={theme.error}>{panel.text}</Text>;
  else
    body = (
      <Markdown themeEpoch={themeEpoch} columns={columns}>
        {panel.text}
      </Markdown>
    );
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%" flexDirection="column">
        <Text color={theme.panelTitle} wrap="truncate-end">{`btw · ${panel.question}`}</Text>
        <Box flexDirection="column" height={bodyRows} overflow="hidden">
          <Box flexDirection="column" flexShrink={0} marginTop={-top}>
            {body}
          </Box>
        </Box>
        <Text color={theme.inactive}>
          {scrollable ? `PgUp/PgDn scroll (${top + 1}-${Math.min(total, top + bodyRows)}/${total}) · ` : ''}
          Esc to close · not saved to the conversation
        </Text>
      </Box>
    </Box>
  );
}

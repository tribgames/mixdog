/**
 * components/Markdown.jsx — markdown → ink, hybrid renderer.
 *
 * Ported from Claude Code (refs/claude-code/src/components/Markdown.tsx):
 *   - marked.lexer() produces the token stream (same lib + config as CC).
 *   - Non-table tokens are rendered to ANSI strings via formatToken and emitted
 *     as <Text> (CC uses <Ansi>; ink 7's <Text> passes ANSI escapes through).
 *   - Tables are rendered by the MarkdownTable component (proper Box layout).
 *   - Adjacent non-table tokens are coalesced into one <Text> (CC's
 *     nonTableContent buffer) so block spacing matches.
 *
 * Syntax-highlight + token cache + streaming-split from CC are dropped: we emit
 * whole messages at once (no streaming) and have no highlighter dependency.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';
import { formatToken } from '../markdown/format-token.mjs';
import { MarkdownTable } from './MarkdownTable.jsx';
import { theme } from '../theme.mjs';

let _configured = false;
function configureMarked() {
  if (_configured) return;
  _configured = true;
  // Disable strikethrough: models use ~ for "approximate" (~100), not <del>.
  marked.use({ tokenizer: { del() { return undefined; } } });
}

export function Markdown({ children }) {
  const elements = React.useMemo(() => {
    try {
      configureMarked();
      const tokens = marked.lexer(String(children ?? ''));
      const result = [];
      let buffer = '';
      let idx = 0;
      const flush = () => {
        if (buffer) {
          // CC trims the coalesced non-table block (MarkdownBody: nonTableContent
          // .trim()) so leading/trailing blank lines from token EOLs don't bleed
          // into the surrounding gap={1} spacing. color={theme.text} makes plain
          // (un-ANSI'd) body text white instead of the terminal's default gray;
          // inline spans that carry their own SGR (codespan, bold, etc.) keep it.
          result.push(<Text key={`md_${idx++}`} color={theme.text}>{buffer.trim()}</Text>);
          buffer = '';
        }
      };
      for (const token of tokens) {
        if (token.type === 'table') {
          flush();
          result.push(<MarkdownTable key={`md_${idx++}`} token={token} />);
        } else {
          buffer += formatToken(token);
        }
      }
      flush();
      return result;
    } catch {
      // Never throw into the render tree — fall back to raw text.
      return [<Text key="md_0">{String(children ?? '')}</Text>];
    }
  }, [children]);

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  );
}

/**
 * components/SignInUrl.jsx — a sign-in URL shown OUTSIDE any bordered panel.
 *
 * Inside a bordered panel a wrapped URL carries the `│` border and padding on
 * every row, so a terminal selection copies junk. Here the rows are plain text
 * with no border, the URL is an OSC 8 hyperlink whose target is the complete
 * URL (click it, or "Copy link" in the terminal), and `copyKey` copies the exact
 * URL through the clipboard helper. `layout` (sign-in-url-layout.mjs) may shorten
 * the visible label to fit the panel; the link target and the copy stay complete.
 */
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { copyToClipboard } from '../app/clipboard.mjs';

const SAFE_URL_RE = /^https?:\/\//i;

const linkedUrl = (url, label) => (SAFE_URL_RE.test(url) ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label);

const STATUS_TEXT = {
  copied: 'URL copied',
  sent: 'Sent to terminal clipboard (not confirmed)',
  failed: 'Copy failed: no clipboard available, use the link above',
};

/** The copy-key note, or what the last copy did. */
export const signInUrlNote = (copyKey, status) => STATUS_TEXT[status] || `${copyKey} copies the full URL`;

/** { copy, status } — status is '', 'copied', 'sent' (OSC 52 only) or 'failed'. */
export function useCopyUrl(url, copyText = (text) => copyToClipboard(text, { confirm: true })) {
  const [status, setStatus] = useState('');
  const copy = () => {
    if (!url) return;
    Promise.resolve()
      .then(() => copyText(url))
      .then((how) => setStatus(how === 'terminal' ? 'sent' : 'copied'))
      .catch(() => setStatus('failed'));
  };
  return { copy, status };
}

export function SignInUrl({ url, layout, copyKey, status = '' }) {
  const text = String(url || '').trim();
  if (!text || layout.rows === 0) return null;
  return (
    <Box flexDirection="column" width="100%">
      <Text color={theme.text} wrap={layout.compact ? 'truncate-end' : 'wrap'}>
        {linkedUrl(text, layout.label)}
      </Text>
      {layout.hint ? (
        <Text color={theme.subtle} wrap="truncate-end">
          {signInUrlNote(copyKey, status)}
        </Text>
      ) : null}
    </Box>
  );
}

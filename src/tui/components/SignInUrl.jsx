/**
 * components/SignInUrl.jsx — a sign-in URL shown OUTSIDE any bordered panel.
 *
 * Inside a bordered panel a wrapped URL carries the `│` border and padding on
 * every row, so a terminal selection copies junk. Here the rows are plain text
 * with no border, the URL is an OSC 8 hyperlink whose target is the complete
 * URL (click it, or "Copy link" in the terminal), and SIGN_IN_COPY_KEY copies the
 * exact URL through the clipboard helper. `layout` (sign-in-url-layout.mjs) may shorten
 * the visible label to fit the panel; the link target and the copy stay complete.
 */
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { copyToClipboard } from '../app/clipboard.mjs';

const SAFE_URL_RE = /^https?:\/\//i;

// OSC 8 needs no support probe: a terminal that does not know the hyperlink
// sequence ignores it and shows the label (its documented fallback). Only
// http(s) targets are linked.
const linkedUrl = (url, label) => (SAFE_URL_RE.test(url) ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label);

const STATUS_TEXT = {
  copied: 'URL copied',
  sent: 'Sent to terminal clipboard (not confirmed)',
  failed: 'Copy failed: no clipboard available, use the link above',
};

/** The one key that copies a sign-in URL in every panel, with or without a focused text input. */
const SIGN_IN_COPY_KEY = 'Ctrl+Y';
export const isSignInCopyKey = (input, key) => Boolean(key?.ctrl) && String(input || '').toLowerCase() === 'y';

/** The copy-key note, or what the last copy did. */
export const signInUrlNote = (status) => STATUS_TEXT[status] || `${SIGN_IN_COPY_KEY} copies the full URL`;

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

export function SignInUrl({ url, layout, status = '' }) {
  const text = String(url || '').trim();
  if (!text || layout.rows === 0) return null;
  return (
    // flexShrink 0 everywhere: the layout reserved exactly these rows, and in a
    // height-constrained panel (fillHeight) yoga would otherwise shrink the
    // wrapped URL Text below its row count, so the hint row lands on the
    // URL's last row. The panel's bordered box gives the rows up instead.
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Text color={theme.text} wrap={layout.compact ? 'truncate-end' : 'wrap'} flexShrink={0}>
        {linkedUrl(text, layout.label)}
      </Text>
      {layout.hint ? (
        <Text color={theme.subtle} wrap="truncate-end" flexShrink={0}>
          {signInUrlNote(status)}
        </Text>
      ) : null}
    </Box>
  );
}

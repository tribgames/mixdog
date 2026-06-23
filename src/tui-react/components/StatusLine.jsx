/**
 * components/StatusLine.jsx — the vendored mixdog L1/L2 statusline footer.
 *
 * renderStatusline() (src/ui/statusline.mjs) is async (it awaits the vendored
 * statusline-lib that may query the gateway). We recompute it whenever the
 * stats/model change and print the returned ANSI string verbatim — ink's <Text>
 * passes embedded SGR through, so the original L1/L2 look is preserved exactly.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

// Loaded at RUNTIME (not bundled) so its vendored statusline-lib relative
// imports resolve from the real src/ui location, not the dist/ bundle dir.
// esbuild leaves dynamic-import string specifiers alone.
const STATUSLINE_MODULE = '../../ui/statusline.mjs';

export function StatusLine({ provider, model, cwd, stats, resizeEpoch }) {
  const [line, setLine] = useState('');

  useEffect(() => {
    let alive = true;
    import(STATUSLINE_MODULE)
      .then((m) => m.renderStatusline({ provider, model, cwd, stats }))
      .then((s) => {
        if (!alive) return;
        // Rework L1's leading segment: the vendored lib emits
        // `<cyan>◆<reset> <bold>MODEL<reset> …` — the model inherits the cyan.
        // Drop the `◆` glyph AND its cyan, and recolor the model name white.
        // We replace the leading `(SGR)*◆(SGR)*` run with a white SGR so the
        // following space + bold model render white; the rest is untouched.
        // Strip the leading `◆ ` glyph + its SGR AND the following space — the
        // 2-cell left pad is provided by the Box paddingLeft instead. Recolor
        // the model name white.
        const cleaned = s
          .replace(/\n+$/, '')
          .replace(/^(?:\x1b\[[0-9;]*m)*◆(?:\x1b\[[0-9;]*m)*\s?/, '\x1b[97m');
        setLine(cleaned);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [provider, model, cwd, stats, resizeEpoch]);

  if (!line) return null;
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {line.split('\n').map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  planInlineScriptHoist,
  planLongInlineScriptFileTransport,
  planLongShellScriptFileTransport,
} from '../shell-analysis.mjs';

// Inline-script hoisting. The body is written verbatim and the invocation
// becomes a file run, so the host shell never has to carry the script through
// its quoting layer. planInlineScriptHoist refuses every case where file
// semantics would differ, so this is a transport change only.
// A trailing `&` (or anything else the shell treats as an operator) is NEVER
// detected, stripped or rewritten: the command reaches the shell byte for
// byte. Work that detaches is caught after the fact, from the process group /
// process tree the run leaves behind.
export function hoistInlineScript(command, shellType) {
  const transport = { platform: process.platform, shellType };
  const hoist =
    planInlineScriptHoist(command) ||
    planLongInlineScriptFileTransport(command, transport) ||
    planLongShellScriptFileTransport(command, transport);
  if (!hoist) return { command, hoistPath: null };
  try {
    const file = pathJoin(tmpdir(), `mixdog-inline-${process.pid}-${Date.now().toString(36)}${hoist.extension}`);
    // Windows PowerShell 5.1 interprets UTF-8 without BOM as the active ANSI
    // codepage. Preserve non-ASCII command text when the transport changes a
    // long command into a .ps1 file.
    const fileBody = hoist.extension === '.ps1' ? `\uFEFF${hoist.body}` : hoist.body;
    writeFileSync(file, fileBody, 'utf8');
    return { command: hoist.replace(file.replace(/\\/g, '/')), hoistPath: file };
  } catch {
    return { command, hoistPath: null };
  }
}

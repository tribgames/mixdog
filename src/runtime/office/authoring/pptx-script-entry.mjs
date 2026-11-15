#!/usr/bin/env node
// Entry the native core runs for a pptxgenjs authoring script:
//   <runtime executable> pptx-script-entry.mjs
// with one JSON request on standard input: { script, output, cwd }.
// The answer of runPptxAuthoringScript is written as one JSON line on
// standard output, after the marker below; nothing else the script or a
// module prints can be taken for it.

// Before anything can import sharp: Electron on Linux must use its wasm build.
await import('../../shared/sharp-electron-linux.mjs');
// Node mode belongs to this process only; whatever the script starts is a
// normal child again.
delete process.env.ELECTRON_RUN_AS_NODE;

export const PPTX_SCRIPT_ANSWER_MARKER = '\u0000mixdog-pptx-script-answer\u0000';

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let answer;
try {
  const request = await readRequest();
  const { runPptxAuthoringScript } = await import('./pptx-script-runner.mjs');
  answer = await runPptxAuthoringScript(request.script, request.output, { cwd: request.cwd });
} catch (error) {
  // What runPptxAuthoringScript throws (an empty script) is the caller's to throw again.
  answer = { thrown: error?.message || String(error) };
}
process.stdout.write(`${PPTX_SCRIPT_ANSWER_MARKER}${JSON.stringify(answer)}\n`, () => process.exit(0));
